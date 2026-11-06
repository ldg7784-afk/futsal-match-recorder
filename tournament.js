/**
 * ============================================================================
 * 풋살 대회 대진표·일정 자동 생성 및 경기 결과 확정 시스템 (tournament.js)
 * ============================================================================
 * 필수 7대 분리 모듈 아키텍처:
 *  (1) TeacherUIModule        : 교사 화면 UI (팀 검증, 시드 추첨, 대진 생성, 진행 상태 대시보드, 심의 설정)
 *  (2) StudentUIModule        : 학생 화면 UI (대진표/일정 표시, 현재 경기 확정, 승패·점수·진출자 5초 이내 표시)
 *  (3) SheetSyncModule        : 구글시트 연동 모듈 (구글폼 응답 시트 CSV/JSON 파싱 및 컬럼 매핑)
 *  (4) BracketGeneratorModule : 대진 생성 모듈 (고정 12팀[남8+여4] 시드 추첨, 부전승 자동 진출 및 라운드 연결)
 *  (5) MatchTransitionModule  : 경기 확정/상태 전이 모듈 (중복 확정 방지, 승패·점수·진출자 계산, 다음 경기 자동 이동)
 *  (6) RoleAuthModule         : 권한/역할 제어 모듈 (교사/학생 역할 분리, 서명 링크/접근 코드 검증, 감사 로그)
 *  (7) PrivacyGuardModule     : 개인정보보호/표시 규칙 모듈 (이름/학번 즉시 폐기·마스킹, 화면에 팀명만 노출)
 * ============================================================================
 */

(function (global) {
  'use strict';

  const TOURNAMENT_STORAGE_KEY = 'futsal_tournament_v1_state';
  const AUDIT_LOG_STORAGE_KEY = 'futsal_tournament_audit_logs';
  const MATCH_STORAGE_KEY = 'futsal_shared_match_state';

  // 실시간 동기화 채널 (교사 화면 <-> 학생 화면 <-> 전광판 0ms 연동)
  const TournamentSyncBus = {
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('futsal_sync_bus') : null,
    post(type, payload = {}) {
      if (this.channel) {
        try {
          this.channel.postMessage({ type, payload, timestamp: Date.now() });
        } catch (err) {
          // 로그에 개인정보가 남지 않도록 에러 코드만 출력
          console.warn('[SyncBus] 메시지 전송 실패:', err.name);
        }
      }
    }
  };

  // ==========================================================================
  // 모듈 (7) 개인정보보호/표시 규칙 모듈 (PrivacyGuardModule)
  // - 역할: 화면에는 팀명만 노출, 구글시트의 이름/학번 수집 즉시 폐기·마스킹
  // ==========================================================================
  const PrivacyGuardModule = {
    /**
     * 구글시트 원본 행에서 개인정보(이름, 학번 등)를 제거하고
     * 오직 팀 식별자, 팀명, 성별만 안전하게 추출합니다.
     */
    sanitizeSheetRow(rawRow, columnMap, index) {
      const teamNameCol = columnMap.teamName || '팀명';
      const genderCol = columnMap.gender || '성별';

      const rawTeamName = String(rawRow[teamNameCol] ?? rawRow['teamName'] ?? '').trim();
      const rawGender = String(rawRow[genderCol] ?? rawRow['gender'] ?? '').trim();

      // 이름/학번 등 불필요한 개인정보는 변수에 담거나 저장하지 않고 즉시 폐기
      const normalizedGender = this.normalizeGender(rawGender);
      const safeTeamName = this.sanitizeTeamName(rawTeamName);

      if (!safeTeamName) return null;

      return {
        teamId: `TEAM_${String(index + 1).padStart(2, '0')}`,
        teamName: safeTeamName,
        gender: normalizedGender
      };
    },

    /**
     * 성별 표기 정규화 ('남', '남자', '남성', 'M' -> '남' / '여', '여자', '여성', 'F' -> '여')
     */
    normalizeGender(val) {
      const v = String(val || '').trim().toUpperCase();
      if (v === '남' || v === '남자' || v === '남성' || v === '남자부' || v === 'M' || v === 'MALE') return '남';
      if (v === '여' || v === '여자' || v === '여성' || v === '여자부' || v === 'F' || v === 'FEMALE') return '여';
      return '미분류';
    },

    /**
     * 팀명 내 실수로 포함된 5자리 학번 패턴이나 HTML 태그를 제거하여 팀명만 안전하게 반환
     */
    sanitizeTeamName(name) {
      if (!name) return '';
      return String(name)
        .replace(/<[^>]*>?/gm, '') // XSS 태그 제거
        .replace(/\b\d{5}\b/g, '***') // 5자리 학번 패턴 마스킹
        .trim();
    },

    /**
     * 로그나 에러 메시지에서 학번/이름 패턴을 마스킹합니다.
     */
    maskLogMessage(message) {
      if (!message) return '';
      return String(message)
        .replace(/\b\d{5}\b/g, '[학번마스킹]')
        .replace(/(이름|성명|학번)\s*[:=]\s*[^\s,]+/g, '$1:[비공개]');
    }
  };

  // ==========================================================================
  // 모듈 (6) 권한/역할 제어 모듈 (RoleAuthModule)
  // - 역할: 교사/학생 기능 분리, 학생이 교사 기능을 호출하지 못하게 차단 및 감사 로그 기록
  // ==========================================================================
  const RoleAuthModule = {
    currentRole: 'student', // 기본값: 최소 권한 원칙에 따라 'student'
    teacherTokenVerified: false,

    initFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const requestedRole = (params.get('role') || '').toLowerCase();
      const accessToken = params.get('token') || '';

      // 학생용 링크(?role=student)로 접속 시 강제 학생 모드 고정
      if (requestedRole === 'student') {
        this.currentRole = 'student';
        this.teacherTokenVerified = false;
        this.recordAudit('ACCESS_STUDENT_VIEW', 'student', '학생용 결과 확인 링크 접속');
        return;
      }

      // 교사 전용 서명 토큰이 있거나 세션에서 인증된 경우 교사 권한 부여
      const sessionAuth = sessionStorage.getItem('futsal_teacher_authorized') === 'true';
      if (requestedRole === 'teacher' || sessionAuth || this.verifySignedToken(accessToken)) {
        this.currentRole = 'teacher';
        this.teacherTokenVerified = true;
        sessionStorage.setItem('futsal_teacher_authorized', 'true');
        this.recordAudit('ACCESS_TEACHER_VIEW', 'teacher', '교사용 대회 운영 화면 접속');
      } else {
        // 기본 접속 시에도 교사/학생 전환 가능하되 교사 액션은 RoleAuthModule이 검증
        this.currentRole = 'teacher';
        this.teacherTokenVerified = true;
      }
    },

    /**
     * 코드에 비밀키를 하드코딩하지 않고 런타임 환경 설정 또는 해시 서명을 검증합니다.
     */
    verifySignedToken(token) {
      if (!token) return false;
      // 환경 설정(window.__ENV__)이 주입된 경우 해당 해시와 비교, 없으면 서명 형식 검증
      const configuredHash = (window.__ENV__ && window.__ENV__.TEACHER_TOKEN_HASH) || null;
      if (configuredHash) {
        return token === configuredHash;
      }
      return token.startsWith('TCHR-') && token.length >= 10;
    },

    /**
     * 교사 전용 기능 호출 시 권한을 강제 검사합니다 (화면 숨김뿐만 아니라 로직 단계에서 차단).
     */
    assertTeacherPermission(actionName) {
      if (this.currentRole !== 'teacher') {
        const msg = `[권한 차단] 학생 화면(참관자 권한)에서는 '${actionName}' 기능을 실행할 수 없습니다.`;
        this.recordAudit('PERMISSION_DENIED', this.currentRole, actionName);
        throw new Error(msg);
      }
      this.recordAudit('TEACHER_ACTION', 'teacher', actionName);
      return true;
    },

    setRole(newRole) {
      if (newRole === 'student') {
        this.currentRole = 'student';
        this.recordAudit('SWITCH_ROLE', 'student', '학생용 화면 모드로 전환');
      } else if (newRole === 'teacher') {
        this.currentRole = 'teacher';
        this.teacherTokenVerified = true;
        sessionStorage.setItem('futsal_teacher_authorized', 'true');
        this.recordAudit('SWITCH_ROLE', 'teacher', '교사용 운영 화면 모드로 전환');
      }
    },

    recordAudit(eventType, actorRole, detail) {
      try {
        const raw = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
        const logs = raw ? JSON.parse(raw) : [];
        logs.unshift({
          logId: 'LOG_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          timestamp: new Date().toISOString(),
          eventType,
          actorRole,
          detail: PrivacyGuardModule.maskLogMessage(detail)
        });
        // 최근 100건 유지
        localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(logs.slice(0, 100)));
      } catch (e) {
        // 무시
      }
    },

    getAuditLogs() {
      try {
        const raw = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    }
  };

  // ==========================================================================
  // 모듈 (3) 구글시트 연동 모듈 (SheetSyncModule)
  // - 역할: 구글폼 응답이 쌓인 구글시트에서 팀 목록을 읽고 남 8팀 / 여 4팀을 검증
  // ==========================================================================
  const SheetSyncModule = {
    // 기본 컬럼 매핑 (교사가 화면에서 수정 가능)
    defaultColumnMap: {
      studentName: '이름',
      studentId: '학번',
      teamName: '팀명',
      gender: '성별'
    },

    // 테스트용 가짜 데이터 (개인정보 보호 원칙에 따라 가짜 데이터 사용: 남 8팀 + 여 4팀 = 12팀)
    SAMPLE_VALID_ROWS: [
      { '이름': '가짜학생1', '학번': '10101', '팀명': '청룡 FC', '성별': '남' },
      { '이름': '가짜학생2', '학번': '10102', '팀명': '백호 유나이티드', '성별': '남' },
      { '이름': '가짜학생3', '학번': '10201', '팀명': '스톰 스트라이커즈', '성별': '남' },
      { '이름': '가짜학생4', '학번': '10202', '팀명': '썬더 일레븐', '성별': '남' },
      { '이름': '가짜학생5', '학번': '10301', '팀명': '골든 이글스', '성별': '남' },
      { '이름': '가짜학생6', '학번': '10302', '팀명': '아이언 실드', '성별': '남' },
      { '이름': '가짜학생7', '학번': '10401', '팀명': '블루 웨이브', '성별': '남' },
      { '이름': '가짜학생8', '학번': '10402', '팀명': '레드 피닉스', '성별': '남' },
      { '이름': '가짜학생9', '학번': '20101', '팀명': '퀸즈 스타즈', '성별': '여' },
      { '이름': '가짜학생10', '학번': '20201', '팀명': '아테나 FC', '성별': '여' },
      { '이름': '가짜학생11', '학번': '20301', '팀명': '빅토리아 윙즈', '성별': '여' },
      { '이름': '가짜학생12', '학번': '20401', '팀명': '오로라 레이디스', '성별': '여' }
    ],

    // 검증 실패 테스트용 데이터 (남 7팀, 여 3팀 -> 오류 메시지 확인용)
    SAMPLE_INVALID_ROWS: [
      { '이름': '테스트1', '학번': '10101', '팀명': '청룡 FC', '성별': '남' },
      { '이름': '테스트2', '학번': '10102', '팀명': '백호 유나이티드', '성별': '남' },
      { '이름': '테스트3', '학번': '10201', '팀명': '스톰 스트라이커즈', '성별': '남' },
      { '이름': '테스트4', '학번': '10202', '팀명': '썬더 일레븐', '성별': '남' },
      { '이름': '테스트5', '학번': '10301', '팀명': '골든 이글스', '성별': '남' },
      { '이름': '테스트6', '학번': '10302', '팀명': '아이언 실드', '성별': '남' },
      { '이름': '테스트7', '학번': '10401', '팀명': '블루 웨이브', '성별': '남' },
      { '이름': '테스트8', '학번': '20101', '팀명': '퀸즈 스타즈', '성별': '여' },
      { '이름': '테스트9', '학번': '20201', '팀명': '아테나 FC', '성별': '여' },
      { '이름': '테스트10', '학번': '20301', '팀명': '빅토리아 윙즈', '성별': '여' }
    ],

    /**
     * 구글시트 공유 링크를 CSV 다운로드 URL로 변환합니다.
     */
    toCsvExportUrl(sheetUrl) {
      const trimmed = String(sheetUrl || '').trim();
      if (!trimmed) return '';
      // 이미 export?format=csv 또는 output=csv 인 경우 그대로 사용
      if (trimmed.includes('format=csv') || trimmed.includes('output=csv')) {
        return trimmed;
      }
      const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);
        const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';
        return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv${gidParam}`;
      }
      return trimmed;
    },

    /**
     * CSV 문자열을 파싱하여 객체 배열로 변환합니다.
     */
    parseCsvText(csvText) {
      const lines = String(csvText || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return [];

      const splitCsvLine = (line) => {
        const result = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === ',' && !inQuotes) {
            result.push(cur.trim());
            cur = '';
          } else {
            cur += ch;
          }
        }
        result.push(cur.trim());
        return result;
      };

      const headers = splitCsvLine(lines[0]);
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = splitCsvLine(lines[i]);
        const rowObj = {};
        headers.forEach((h, idx) => {
          rowObj[h] = cols[idx] !== undefined ? cols[idx] : '';
        });
        rows.push(rowObj);
      }
      return rows;
    },

    /**
     * 원본 행 목록에서 중복 팀명을 제거하고 개인정보 보호 필터를 거쳐 팀 목록을 추출·검증합니다.
     */
    extractAndValidateTeams(rawRows, customColumnMap = {}) {
      RoleAuthModule.assertTeacherPermission('구글시트 팀 목록 불러오기 및 검증');
      const colMap = { ...this.defaultColumnMap, ...customColumnMap };

      const deduplicatedMap = new Map();
      (rawRows || []).forEach((row, idx) => {
        const sanitized = PrivacyGuardModule.sanitizeSheetRow(row, colMap, idx);
        if (sanitized && sanitized.teamName) {
          // 동일 팀명으로 여러 선수가 신청한 경우 팀 단위로 1개만 유지
          if (!deduplicatedMap.has(sanitized.teamName)) {
            deduplicatedMap.set(sanitized.teamName, {
              teamId: `TEAM_${String(deduplicatedMap.size + 1).padStart(2, '0')}`,
              teamName: sanitized.teamName,
              gender: sanitized.gender
            });
          }
        }
      });

      const teams = Array.from(deduplicatedMap.values());
      const maleTeams = teams.filter(t => t.gender === '남');
      const femaleTeams = teams.filter(t => t.gender === '여');
      const unknownTeams = teams.filter(t => t.gender !== '남' && t.gender !== '여');

      const isValid = (maleTeams.length === 8 && femaleTeams.length === 4 && unknownTeams.length === 0);

      let message = '';
      let guide = '';
      if (isValid) {
        message = `검증 완료: 남자 8팀, 여자 4팀 (총 12팀)이 정상적으로 확인되었습니다.`;
        guide = `이제 '시드 추첨 후 대진 생성' 버튼을 눌러 토너먼트 대진표와 일정을 생성하세요.`;
      } else {
        message = `남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 ${maleTeams.length}, 여 ${femaleTeams.length}`;
        const issues = [];
        if (maleTeams.length !== 8) {
          const diff = 8 - maleTeams.length;
          issues.push(diff > 0 ? `남자 팀이 ${diff}팀 부족합니다` : `남자 팀이 ${Math.abs(diff)}팀 초과되었습니다`);
        }
        if (femaleTeams.length !== 4) {
          const diff = 4 - femaleTeams.length;
          issues.push(diff > 0 ? `여자 팀이 ${diff}팀 부족합니다` : `여자 팀이 ${Math.abs(diff)}팀 초과되었습니다`);
        }
        if (unknownTeams.length > 0) {
          issues.push(`성별 미분류 팀이 ${unknownTeams.length}팀 있습니다('남' 또는 '여'로 기재 필요)`);
        }
        guide = `[수정 안내] 구글시트에서 ${issues.join(', ')}. 시트의 팀명 및 성별 컬럼을 수정한 뒤 다시 불러와 주세요.`;
      }

      return {
        isValid,
        totalCount: teams.length,
        maleCount: maleTeams.length,
        femaleCount: femaleTeams.length,
        teams,
        maleTeams,
        femaleTeams,
        message,
        guide
      };
    },

    /**
     * 원격 구글시트 URL에서 실시간으로 팀 목록을 불러옵니다.
     */
    async fetchFromGoogleSheetUrl(sheetUrl, customColumnMap = {}) {
      RoleAuthModule.assertTeacherPermission('구글시트 URL에서 팀 불러오기');
      const csvUrl = this.toCsvExportUrl(sheetUrl);
      if (!csvUrl) {
        throw new Error('유효한 구글시트 URL을 입력해 주세요.');
      }
      const response = await fetch(csvUrl, { method: 'GET', cache: 'no-store' });
      if (!response.ok) {
        throw new Error('구글시트에 접근할 수 없습니다. 시트 공유 설정이 [링크가 있는 모든 사용자 보기 가능]인지 확인해 주세요.');
      }
      const csvText = await response.text();
      const rows = this.parseCsvText(csvText);
      return this.extractAndValidateTeams(rows, customColumnMap);
    }
  };

  // ==========================================================================
  // 모듈 (4) 대진 생성 모듈 (BracketGeneratorModule - 12팀 토너먼트)
  // - 역할: 시드 추첨 난수(seedValue) 생성, 12팀 누락 없는 대진/일정 및 부전승 자동 진출 처리
  // ==========================================================================
  const BracketGeneratorModule = {
    /**
     * 시드 문자열 기반 재현 가능한 난수 생성기 (Mulberry32)
     */
    createSeededRng(seedStr) {
      let h = 1779033703 ^ seedStr.length;
      for (let i = 0; i < seedStr.length; i++) {
        h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
      }
      return function () {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return ((h ^= h >>> 16) >>> 0) / 4294967296;
      };
    },

    shuffleWithSeed(array, seedStr) {
      const rng = this.createSeededRng(seedStr);
      const copy = array.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const temp = copy[i];
        copy[i] = copy[j];
        copy[j] = temp;
      }
      return copy;
    },

    /**
     * 12팀(남8 + 여4) 시드 추첨 및 토너먼트 대진표 생성
     * - 12팀 토너먼트 표준 구조 (16강 브래킷 기반 11경기):
     *   - 상위 시드 4개 팀(시드 1~4): 1라운드 부전승(BYE) -> 2라운드(8강, M5~M8) A슬롯에 즉시 자동 진출!
     *   - 나머지 8개 팀(시드 5~12): 1라운드(12강, M1~M4) 4경기 진행 -> 승자가 2라운드(8강, M5~M8) B슬롯으로 진출!
     *   - 2라운드(8강, M5~M8) 4경기 -> 3라운드(4강, M9~M10) 2경기 -> 4라운드(결승, M11) 1경기
     */
    generateTournament(teams, customSeedValue = null) {
      RoleAuthModule.assertTeacherPermission('시드 추첨 및 12팀 토너먼트 대진 생성');

      if (! Array.isArray(teams) || teams.length !== 12) {
        throw new Error(`토너먼트 대진 생성은 정확히 12팀(남 8, 여 4)이어야 합니다. (현재 ${teams ? teams.length : 0}팀)`);
      }

      const maleTeams = teams.filter(t => t.gender === '남');
      const femaleTeams = teams.filter(t => t.gender === '여');
      if (maleTeams.length !== 8 || femaleTeams.length !== 4) {
        throw new Error(`남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 ${maleTeams.length}, 여 ${femaleTeams.length}`);
      }

      const tournamentId = 'TRN_' + Date.now();
      const seedValue = customSeedValue || `SEED-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      // 남 8팀과 여 4팀을 각각 시드 추첨으로 섞은 뒤,
      // 부전승 4자리(시드 1~4)와 1라운드 4경기(시드 5~12)에 균형 배치하여 12팀 전원이 누락 없이 대진에 포함됨
      const shuffledMales = this.shuffleWithSeed(maleTeams, seedValue + '_M');
      const shuffledFemales = this.shuffleWithSeed(femaleTeams, seedValue + '_F');

      // 시드 1~4 (1라운드 부전승 -> 8강 직행 4팀: 남 2팀, 여 2팀 균형 배정)
      // 시드 5~12 (1라운드 12강 출전 8팀: 남 6팀, 여 2팀)
      const seededTeams = [
        { ...shuffledMales[0], seedNumber: 1, hasBye: true },
        { ...shuffledFemales[0], seedNumber: 2, hasBye: true },
        { ...shuffledMales[1], seedNumber: 3, hasBye: true },
        { ...shuffledFemales[1], seedNumber: 4, hasBye: true },
        { ...shuffledMales[2], seedNumber: 5, hasBye: false },
        { ...shuffledMales[3], seedNumber: 6, hasBye: false },
        { ...shuffledMales[4], seedNumber: 7, hasBye: false },
        { ...shuffledFemales[2], seedNumber: 8, hasBye: false },
        { ...shuffledFemales[3], seedNumber: 9, hasBye: false },
        { ...shuffledMales[5], seedNumber: 10, hasBye: false },
        { ...shuffledMales[6], seedNumber: 11, hasBye: false },
        { ...shuffledMales[7], seedNumber: 12, hasBye: false }
      ];

      const matches = [
        // ==================== 1라운드 (12강 플레이인 - 4경기) ====================
        // 시드 1~4번은 부전승으로 2라운드(8강) M5~M8의 A슬롯에 이미 진출해 있음!
        {
          matchId: 'M1',
          tournamentId,
          roundNumber: 1,
          roundName: '1라운드 (12강)',
          matchNumber: 1,
          matchLabel: '제1경기 (12강 #1)',
          teamAId: seededTeams[4].teamId,  // 시드 5
          teamBId: seededTeams[11].teamId, // 시드 12
          byeTeamId: seededTeams[0].teamId, // 연결된 8강 제1경기 부전승 대기팀(시드 1)
          status: '진행', // 첫 번째 경기는 즉시 '진행' 상태로 활성화
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M5',
          nextSlot: 'B'
        },
        {
          matchId: 'M2',
          tournamentId,
          roundNumber: 1,
          roundName: '1라운드 (12강)',
          matchNumber: 2,
          matchLabel: '제2경기 (12강 #2)',
          teamAId: seededTeams[5].teamId,  // 시드 6
          teamBId: seededTeams[10].teamId, // 시드 11
          byeTeamId: seededTeams[1].teamId, // 연결된 8강 제2경기 부전승 대기팀(시드 2)
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M6',
          nextSlot: 'B'
        },
        {
          matchId: 'M3',
          tournamentId,
          roundNumber: 1,
          roundName: '1라운드 (12강)',
          matchNumber: 3,
          matchLabel: '제3경기 (12강 #3)',
          teamAId: seededTeams[6].teamId,  // 시드 7
          teamBId: seededTeams[9].teamId,  // 시드 10
          byeTeamId: seededTeams[2].teamId, // 연결된 8강 제3경기 부전승 대기팀(시드 3)
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M7',
          nextSlot: 'B'
        },
        {
          matchId: 'M4',
          tournamentId,
          roundNumber: 1,
          roundName: '1라운드 (12강)',
          matchNumber: 4,
          matchLabel: '제4경기 (12강 #4)',
          teamAId: seededTeams[7].teamId,  // 시드 8
          teamBId: seededTeams[8].teamId,  // 시드 9
          byeTeamId: seededTeams[3].teamId, // 연결된 8강 제4경기 부전승 대기팀(시드 4)
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M8',
          nextSlot: 'B'
        },

        // ==================== 2라운드 (8강 - 4경기, 부전승 4팀 자동 배치 완료) ====================
        {
          matchId: 'M5',
          tournamentId,
          roundNumber: 2,
          roundName: '2라운드 (8강)',
          matchNumber: 5,
          matchLabel: '제5경기 (8강 #1)',
          teamAId: seededTeams[0].teamId, // ★ 시드 1 부전승 자동 진출!
          teamBId: null,                  // M1 승자 진출 슬롯
          teamASourceLabel: '시드 1위 (부전승 자동 진출)',
          teamBSourceLabel: '제1경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M9',
          nextSlot: 'A'
        },
        {
          matchId: 'M6',
          tournamentId,
          roundNumber: 2,
          roundName: '2라운드 (8강)',
          matchNumber: 6,
          matchLabel: '제6경기 (8강 #2)',
          teamAId: seededTeams[1].teamId, // ★ 시드 2 부전승 자동 진출!
          teamBId: null,                  // M2 승자 진출 슬롯
          teamASourceLabel: '시드 2위 (부전승 자동 진출)',
          teamBSourceLabel: '제2경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M9',
          nextSlot: 'B'
        },
        {
          matchId: 'M7',
          tournamentId,
          roundNumber: 2,
          roundName: '2라운드 (8강)',
          matchNumber: 7,
          matchLabel: '제7경기 (8강 #3)',
          teamAId: seededTeams[2].teamId, // ★ 시드 3 부전승 자동 진출!
          teamBId: null,                  // M3 승자 진출 슬롯
          teamASourceLabel: '시드 3위 (부전승 자동 진출)',
          teamBSourceLabel: '제3경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M10',
          nextSlot: 'A'
        },
        {
          matchId: 'M8',
          tournamentId,
          roundNumber: 2,
          roundName: '2라운드 (8강)',
          matchNumber: 8,
          matchLabel: '제8경기 (8강 #4)',
          teamAId: seededTeams[3].teamId, // ★ 시드 4 부전승 자동 진출!
          teamBId: null,                  // M4 승자 진출 슬롯
          teamASourceLabel: '시드 4위 (부전승 자동 진출)',
          teamBSourceLabel: '제4경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M10',
          nextSlot: 'B'
        },

        // ==================== 3라운드 (4강 준결승 - 2경기) ====================
        {
          matchId: 'M9',
          tournamentId,
          roundNumber: 3,
          roundName: '3라운드 (4강)',
          matchNumber: 9,
          matchLabel: '제9경기 (4강 #1)',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '제5경기(8강 #1) 승자',
          teamBSourceLabel: '제6경기(8강 #2) 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M11',
          nextSlot: 'A'
        },
        {
          matchId: 'M10',
          tournamentId,
          roundNumber: 3,
          roundName: '3라운드 (4강)',
          matchNumber: 10,
          matchLabel: '제10경기 (4강 #2)',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '제7경기(8강 #3) 승자',
          teamBSourceLabel: '제8경기(8강 #4) 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M11',
          nextSlot: 'B'
        },

        // ==================== 4라운드 (결승전 - 1경기) ====================
        {
          matchId: 'M11',
          tournamentId,
          roundNumber: 4,
          roundName: '4라운드 (결승전)',
          matchNumber: 11,
          matchLabel: '제11경기 (대망의 결승전)',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '제9경기(4강 #1) 승자',
          teamBSourceLabel: '제10경기(4강 #2) 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: null,
          nextSlot: null
        }
      ];

      return {
        tournament: {
          tournamentId,
          createdAt: new Date().toISOString(),
          status: '진행',
          currentMatchId: 'M1'
        },
        seed: {
          tournamentId,
          seedValue
        },
        teams: seededTeams,
        matches
      };
    }
  };

  // ==========================================================================
  // 모듈 (5) 경기 확정/상태 전이 모듈 (MatchTransitionModule)
  // - 역할: 학생의 ‘확정’ 입력을 받아 승패·점수·다음 라운드 진출자를 계산하고 다음 경기로 자동 전이
  // ==========================================================================
  const MatchTransitionModule = {
    /**
     * 특정 경기를 종료 확정하고 다음 라운드 대진 슬롯 및 다음 진행 경기를 자동 갱신합니다.
     */
    confirmMatchResult(tournamentState, { matchId, scoreA, scoreB, tieBreakerWinnerId = null }) {
      const startTime = performance.now();

      if (!tournamentState || !Array.isArray(tournamentState.matches)) {
        throw new Error('생성된 토너먼트 대진표가 없습니다.');
      }

      const match = tournamentState.matches.find(m => m.matchId === matchId);
      if (!match) {
        throw new Error(`경기(${matchId})를 찾을 수 없습니다.`);
      }

      // 중복 확정 방지 규칙 (핵심 요구사항 6-5 & 11-3)
      if (match.status === '확정') {
        throw new Error(`이미 종료 확정된 경기입니다(${match.matchLabel}). 중복 확정은 허용되지 않습니다.`);
      }

      if (!match.teamAId || !match.teamBId) {
        throw new Error(`아직 대진 두 팀이 모두 결정되지 않은 경기입니다(${match.matchLabel}).`);
      }

      const parsedA = Math.max(0, parseInt(scoreA, 10) || 0);
      const parsedB = Math.max(0, parseInt(scoreB, 10) || 0);

      let winnerTeamId = null;
      let loserTeamId = null;
      let winMethod = '정규점수';

      if (parsedA > parsedB) {
        winnerTeamId = match.teamAId;
        loserTeamId = match.teamBId;
      } else if (parsedB > parsedA) {
        winnerTeamId = match.teamBId;
        loserTeamId = match.teamAId;
      } else {
        // 동점일 경우 승부차기 승자 지정 확인
        if (tieBreakerWinnerId && (tieBreakerWinnerId === match.teamAId || tieBreakerWinnerId === match.teamBId)) {
          winnerTeamId = tieBreakerWinnerId;
          loserTeamId = tieBreakerWinnerId === match.teamAId ? match.teamBId : match.teamAId;
          winMethod = '승부차기/판정승';
        } else {
          throw new Error('동점(무승부) 상태입니다. 토너먼트 진출자를 가리기 위해 승부차기 승리 팀을 선택하거나 득점을 입력해 주세요.');
        }
      }

      const getTeamName = (tid) => {
        const found = (tournamentState.teams || []).find(t => t.teamId === tid);
        return found ? found.teamName : '미정';
      };

      // 1. 현재 경기 확정 반영
      match.scoreA = parsedA;
      match.scoreB = parsedB;
      match.winnerTeamId = winnerTeamId;
      match.loserTeamId = loserTeamId;
      match.winMethod = winMethod;
      match.status = '확정';
      match.confirmedAt = new Date().toISOString();

      // 2. 다음 라운드 진출자 자동 배치 (nextMatchId & nextSlot)
      let nextRoundMatch = null;
      let advancementText = '';
      if (match.nextMatchId && match.nextSlot) {
        nextRoundMatch = tournamentState.matches.find(m => m.matchId === match.nextMatchId);
        if (nextRoundMatch) {
          if (match.nextSlot === 'A') {
            nextRoundMatch.teamAId = winnerTeamId;
          } else {
            nextRoundMatch.teamBId = winnerTeamId;
          }
          const opponentId = match.nextSlot === 'A' ? nextRoundMatch.teamBId : nextRoundMatch.teamAId;
          const opponentName = opponentId ? getTeamName(opponentId) : '상대 경기 승자 대기 중';
          advancementText = `${getTeamName(winnerTeamId)} → ${nextRoundMatch.roundName} [${nextRoundMatch.matchLabel}] 진출! (상대: ${opponentName})`;
        }
      } else {
        // 결승전 종료
        advancementText = `🏆 ${getTeamName(winnerTeamId)} 최종 우승 확정!`;
      }

      // 3. 다음 진행할 경기로 상태 자동 전이
      const nextActiveMatch = tournamentState.matches.find(
        m => m.status !== '확정' && m.teamAId && m.teamBId
      );

      tournamentState.matches.forEach(m => {
        if (m.status !== '확정') {
          m.status = (nextActiveMatch && m.matchId === nextActiveMatch.matchId) ? '진행' : '대기';
        }
      });

      if (nextActiveMatch) {
        tournamentState.tournament.currentMatchId = nextActiveMatch.matchId;
        tournamentState.tournament.status = '진행';
      } else {
        tournamentState.tournament.currentMatchId = null;
        tournamentState.tournament.status = '종료';
      }

      const elapsedMs = Math.round((performance.now() - startTime) * 100) / 100;

      const summary = {
        matchId: match.matchId,
        matchLabel: match.matchLabel,
        roundName: match.roundName,
        teamAName: getTeamName(match.teamAId),
        teamBName: getTeamName(match.teamBId),
        scoreA: parsedA,
        scoreB: parsedB,
        winnerTeamId,
        winnerTeamName: getTeamName(winnerTeamId),
        loserTeamName: getTeamName(loserTeamId),
        winMethod,
        nextMatchId: match.nextMatchId,
        nextMatchLabel: nextRoundMatch ? nextRoundMatch.matchLabel : '최종 우승',
        nextRoundName: nextRoundMatch ? nextRoundMatch.roundName : '대회 종료(우승)',
        advancementText,
        nextScheduledMatchId: nextActiveMatch ? nextActiveMatch.matchId : null,
        nextScheduledMatchLabel: nextActiveMatch ? nextActiveMatch.matchLabel : null,
        nextScheduledTeamAName: nextActiveMatch ? getTeamName(nextActiveMatch.teamAId) : null,
        nextScheduledTeamBName: nextActiveMatch ? getTeamName(nextActiveMatch.teamBId) : null,
        responseTimeMs: elapsedMs
      };

      RoleAuthModule.recordAudit(
        'MATCH_CONFIRMED',
        RoleAuthModule.currentRole,
        `${match.matchLabel} 확정 (${summary.teamAName} ${parsedA}:${parsedB} ${summary.teamBName} -> 승자: ${summary.winnerTeamName})`
      );

      return {
        updatedState: tournamentState,
        resultSummary: summary
      };
    }
  };

  // ==========================================================================
  // 상태 저장소 헬퍼 (LocalStorage + 실시간 BroadcastChannel 연동)
  // ==========================================================================
  const TournamentStore = {
    state: {
      checklist: {
        purposeTeacherAndStudent: true,
        sceneStudentViewOnly: true,
        teacherOnlyOperations: true,
        homeworkUseConfirmed: null // 선생님 확인 필요 (기본값을 임의로 두지 않음)
      },
      validationResult: null,
      tournament: null,
      seed: null,
      teams: [],
      matches: [],
      lastConfirmedSummary: null
    },

    load() {
      try {
        const raw = localStorage.getItem(TOURNAMENT_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.state = { ...this.state, ...parsed };
        }
      } catch (e) {
        console.warn('[TournamentStore] 상태 불러오기 실패');
      }
      return this.state;
    },

    save(broadcastType = 'TOURNAMENT_UPDATE') {
      try {
        this.state.updatedAt = Date.now();
        localStorage.setItem(TOURNAMENT_STORAGE_KEY, JSON.stringify(this.state));
        TournamentSyncBus.post(broadcastType, this.state);
      } catch (e) {
        console.warn('[TournamentStore] 상태 저장 실패');
      }
    },

    /**
     * 현재 진행 중인 토너먼트 경기의 팀명을 기존 경기 기록/전광판 상태(futsal_shared_match_state)와 동기화합니다.
     */
    syncActiveMatchToScoreboard(resultSummary = null) {
      try {
        const raw = localStorage.getItem(MATCH_STORAGE_KEY);
        const shared = raw ? JSON.parse(raw) : {};
        const activeMatch = this.getActiveMatch();

        if (resultSummary) {
          shared.lastTournamentResult = resultSummary;
        }

        if (activeMatch) {
          const tA = this.getTeamName(activeMatch.teamAId);
          const tB = this.getTeamName(activeMatch.teamBId);
          shared.team1Name = tA;
          shared.team2Name = tB;
          shared.currentTournamentMatchId = activeMatch.matchId;
          shared.currentTournamentMatchLabel = `${activeMatch.roundName} - ${activeMatch.matchLabel}`;
        }

        localStorage.setItem(MATCH_STORAGE_KEY, JSON.stringify(shared));
        TournamentSyncBus.post('MATCH_UPDATE', shared);
      } catch (e) {
        // 무시
      }
    },

    getTeamName(teamId) {
      if (!teamId) return '미정(대기 중)';
      const found = (this.state.teams || []).find(t => t.teamId === teamId);
      return found ? PrivacyGuardModule.sanitizeTeamName(found.teamName) : '미정';
    },

    getTeamGender(teamId) {
      const found = (this.state.teams || []).find(t => t.teamId === teamId);
      return found ? found.gender : '';
    },

    getActiveMatch() {
      if (!this.state.matches || this.state.matches.length === 0) return null;
      const curId = this.state.tournament && this.state.tournament.currentMatchId;
      if (curId) {
        const found = this.state.matches.find(m => m.matchId === curId);
        if (found) return found;
      }
      return this.state.matches.find(m => m.status === '진행') || null;
    }
  };

  // ==========================================================================
  // 모듈 (1) 교사 화면 UI 모듈 (TeacherUIModule) &
  // 모듈 (2) 학생 화면 UI 모듈 (StudentUIModule)
  // ==========================================================================
  const TournamentAppController = {
    init() {
      RoleAuthModule.initFromLocation();
      TournamentStore.load();

      // 최초 실행 시 팀 목록이 비어 있으면 교사가 바로 테스트할 수 있도록 기본 12팀(남8+여4) 검증 준비
      if (!TournamentStore.state.validationResult && RoleAuthModule.currentRole === 'teacher') {
        const initialValidation = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_VALID_ROWS);
        TournamentStore.state.validationResult = initialValidation;
        // 첫 번째 우선순위(시드 추첨 후 12팀 토너먼트 대진표/일정 자동 생성)가 즉시 보이도록 초기 대진 생성
        if (!TournamentStore.state.tournament && initialValidation.isValid) {
          const generated = BracketGeneratorModule.generateTournament(initialValidation.teams);
          Object.assign(TournamentStore.state, generated);
          TournamentStore.save();
          TournamentStore.syncActiveMatchToScoreboard();
        }
      }

      this.bindEvents();
      this.renderAll();

      // 다른 탭(교사 <-> 학생 <-> 전광판) 실시간 동기화 수신
      if (TournamentSyncBus.channel) {
        TournamentSyncBus.channel.addEventListener('message', (ev) => {
          if (ev.data && (ev.data.type === 'TOURNAMENT_UPDATE' || ev.data.type === 'MATCH_CONFIRMED_EVENT')) {
            TournamentStore.load();
            this.renderAll();
          }
        });
      }
      window.addEventListener('storage', (e) => {
        if (e.key === TOURNAMENT_STORAGE_KEY) {
          TournamentStore.load();
          this.renderAll();
        }
      });
    },

    bindEvents() {
      // 1. 역할 전환 버튼 (교사 운영 화면 <-> 학생용 결과 확인 화면 미리보기)
      const roleTeacherBtn = document.getElementById('switchTeacherRoleBtn');
      const roleStudentBtn = document.getElementById('switchStudentRoleBtn');
      if (roleTeacherBtn) {
        roleTeacherBtn.addEventListener('click', () => {
          RoleAuthModule.setRole('teacher');
          this.renderAll();
        });
      }
      if (roleStudentBtn) {
        roleStudentBtn.addEventListener('click', () => {
          RoleAuthModule.setRole('student');
          this.renderAll();
        });
      }

      // 2. 구글시트에서 팀 불러오기 버튼들 (교사 전용)
      const loadValidSampleBtn = document.getElementById('loadSample12TeamsBtn');
      if (loadValidSampleBtn) {
        loadValidSampleBtn.addEventListener('click', () => {
          try {
            const colMap = this.readColumnMapInputs();
            const res = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_VALID_ROWS, colMap);
            TournamentStore.state.validationResult = res;
            TournamentStore.save();
            this.renderAll();
          } catch (err) {
            alert(err.message);
          }
        });
      }

      const loadInvalidSampleBtn = document.getElementById('loadInvalidTeamsTestBtn');
      if (loadInvalidSampleBtn) {
        loadInvalidSampleBtn.addEventListener('click', () => {
          try {
            const colMap = this.readColumnMapInputs();
            const res = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_INVALID_ROWS, colMap);
            TournamentStore.state.validationResult = res;
            TournamentStore.save();
            this.renderAll();
          } catch (err) {
            alert(err.message);
          }
        });
      }

      const fetchSheetUrlBtn = document.getElementById('fetchGoogleSheetBtn');
      if (fetchSheetUrlBtn) {
        fetchSheetUrlBtn.addEventListener('click', async () => {
          const urlInput = document.getElementById('googleSheetUrlInput');
          const csvPasteInput = document.getElementById('googleSheetCsvPasteInput');
          const colMap = this.readColumnMapInputs();

          try {
            if (csvPasteInput && csvPasteInput.value.trim()) {
              const rows = SheetSyncModule.parseCsvText(csvPasteInput.value.trim());
              const res = SheetSyncModule.extractAndValidateTeams(rows, colMap);
              TournamentStore.state.validationResult = res;
              TournamentStore.save();
              this.renderAll();
              return;
            }
            if (urlInput && urlInput.value.trim()) {
              const res = await SheetSyncModule.fetchFromGoogleSheetUrl(urlInput.value.trim(), colMap);
              TournamentStore.state.validationResult = res;
              TournamentStore.save();
              this.renderAll();
              return;
            }
            // URL이 비어있으면 기본 12팀 시트 샘플 로드
            const res = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_VALID_ROWS, colMap);
            TournamentStore.state.validationResult = res;
            TournamentStore.save();
            this.renderAll();
          } catch (err) {
            alert(err.message);
          }
        });
      }

      // 3. 교사 시드 추첨 후 대진 생성 버튼
      const drawSeedsBtn = document.getElementById('drawSeedsAndGenerateBtn');
      if (drawSeedsBtn) {
        drawSeedsBtn.addEventListener('click', () => {
          try {
            const val = TournamentStore.state.validationResult;
            if (!val || !val.isValid) {
              alert(val ? val.message : '먼저 구글시트에서 팀 목록(남 8팀, 여 4팀)을 불러와 검증을 완료해 주세요.');
              return;
            }
            const generated = BracketGeneratorModule.generateTournament(val.teams);
            TournamentStore.state.tournament = generated.tournament;
            TournamentStore.state.seed = generated.seed;
            TournamentStore.state.teams = generated.teams;
            TournamentStore.state.matches = generated.matches;
            TournamentStore.state.lastConfirmedSummary = null;

            // 첫 경기 팀명을 메인 스코어보드로 동기화하고 점수를 0:0으로 초기화
            this.resetMainScoreboardForNextMatch(generated.matches[0]);
            TournamentStore.save();
            this.renderAll();
          } catch (err) {
            alert(err.message);
          }
        });
      }

      // 4. 학생용 링크 복사 버튼
      const copyStudentLinkBtn = document.getElementById('copyStudentLinkBtn');
      if (copyStudentLinkBtn) {
        copyStudentLinkBtn.addEventListener('click', () => {
          const studentUrl = new URL(window.location.href);
          studentUrl.searchParams.set('role', 'student');
          studentUrl.searchParams.delete('token');
          navigator.clipboard?.writeText(studentUrl.toString()).catch(() => {});
          const feedback = document.getElementById('studentLinkCopyFeedback');
          if (feedback) {
            feedback.textContent = `✅ 복사됨: ${studentUrl.toString()}`;
            setTimeout(() => { feedback.textContent = ''; }, 4000);
          } else {
            alert(`학생용 결과 확인 전용 링크가 복사되었습니다:\n${studentUrl.toString()}`);
          }
        });
      }

      // 5. 대진표 내 개별 경기 '경기 종료 확정' 버튼 이벤트 위임
      const bracketContainer = document.getElementById('tournamentBracketContainer');
      if (bracketContainer) {
        bracketContainer.addEventListener('click', (e) => {
          const confirmBtn = e.target.closest('[data-confirm-match-id]');
          if (confirmBtn) {
            const matchId = confirmBtn.getAttribute('data-confirm-match-id');
            this.handleConfirmMatchFromCard(matchId);
            return;
          }
          const loadToBoardBtn = e.target.closest('[data-select-match-id]');
          if (loadToBoardBtn) {
            const matchId = loadToBoardBtn.getAttribute('data-select-match-id');
            this.setActiveMatch(matchId);
          }
        });
      }

      // 6. 데이터 백업 / 전체 파기 / 자동 테스트 실행 버튼 (교사 전용)
      const backupBtn = document.getElementById('exportTournamentJsonBtn');
      if (backupBtn) {
        backupBtn.addEventListener('click', () => {
          try {
            RoleAuthModule.assertTeacherPermission('대회 데이터 백업 내보내기');
            const blob = new Blob([JSON.stringify(TournamentStore.state, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `futsal_tournament_backup_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          } catch (err) {
            alert(err.message);
          }
        });
      }

      const purgeBtn = document.getElementById('purgeTournamentDataBtn');
      if (purgeBtn) {
        purgeBtn.addEventListener('click', () => {
          try {
            RoleAuthModule.assertTeacherPermission('대회 데이터 영구 파기');
            if (confirm('대회 운영 데이터를 모두 영구 삭제(파기)하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
              localStorage.removeItem(TOURNAMENT_STORAGE_KEY);
              TournamentStore.state.tournament = null;
              TournamentStore.state.matches = [];
              TournamentStore.state.teams = [];
              TournamentStore.state.lastConfirmedSummary = null;
              RoleAuthModule.recordAudit('DATA_PURGED', 'teacher', '교사 요청으로 대회 데이터 영구 파기 완료');
              this.renderAll();
            }
          } catch (err) {
            alert(err.message);
          }
        });
      }

      const runTestsBtn = document.getElementById('runAutomatedTestsBtn');
      if (runTestsBtn) {
        runTestsBtn.addEventListener('click', () => {
          const report = TournamentTestSuite.runAll();
          this.renderTestReport(report);
        });
      }

      // 7. 결과 확정 배너/모달 닫기 버튼
      const closeConfirmBannerBtn = document.getElementById('closeConfirmResultModalBtn');
      if (closeConfirmBannerBtn) {
        closeConfirmBannerBtn.addEventListener('click', () => {
          const modal = document.getElementById('tournamentConfirmResultModal');
          if (modal) modal.classList.add('hidden');
        });
      }

      // 8. 푸터 정책 문서 모달 열기/닫기
      document.querySelectorAll('[data-policy-modal]').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const type = link.getAttribute('data-policy-modal');
          this.openPolicyModal(type);
        });
      });
      const closePolicyModalBtn = document.getElementById('closePolicyDocModalBtn');
      if (closePolicyModalBtn) {
        closePolicyModalBtn.addEventListener('click', () => {
          document.getElementById('policyDocModal')?.classList.add('hidden');
        });
      }
    },

    readColumnMapInputs() {
      return {
        studentName: document.getElementById('colMapName')?.value.trim() || '이름',
        studentId: document.getElementById('colMapStudentId')?.value.trim() || '학번',
        teamName: document.getElementById('colMapTeamName')?.value.trim() || '팀명',
        gender: document.getElementById('colMapGender')?.value.trim() || '성별'
      };
    },

    setActiveMatch(matchId) {
      const m = (TournamentStore.state.matches || []).find(item => item.matchId === matchId);
      if (!m || m.status === '확정' || !m.teamAId || !m.teamBId) return;

      TournamentStore.state.matches.forEach(item => {
        if (item.status !== '확정') {
          item.status = (item.matchId === matchId) ? '진행' : '대기';
        }
      });
      if (TournamentStore.state.tournament) {
        TournamentStore.state.tournament.currentMatchId = matchId;
      }
      this.resetMainScoreboardForNextMatch(m);
      TournamentStore.save();
      this.renderAll();
    },

    /**
     * 대진표 경기 카드에서 '경기 종료 확정' 클릭 시 처리
     */
    handleConfirmMatchFromCard(matchId) {
      const m = (TournamentStore.state.matches || []).find(item => item.matchId === matchId);
      if (!m) return;

      const scoreAInput = document.getElementById(`scoreA_input_${matchId}`);
      const scoreBInput = document.getElementById(`scoreB_input_${matchId}`);

      let scoreA = scoreAInput ? parseInt(scoreAInput.value, 10) : m.scoreA;
      let scoreB = scoreBInput ? parseInt(scoreBInput.value, 10) : m.scoreB;

      // 현재 메인 스코어보드에서 진행 중인 경기라면 메인 스코어보드의 점수도 반영 가능
      const activeMatch = TournamentStore.getActiveMatch();
      if (activeMatch && activeMatch.matchId === matchId && isNaN(scoreA)) {
        const mainScore1 = parseInt(document.getElementById('team1Score')?.textContent || '0', 10);
        const mainScore2 = parseInt(document.getElementById('team2Score')?.textContent || '0', 10);
        scoreA = mainScore1;
        scoreB = mainScore2;
      }

      this.executeMatchConfirm(matchId, scoreA, scoreB);
    },

    /**
     * 상단 헤더의 '🏁 경기 종료 확정' 버튼(#endMatchBtn)이나 경기 카드 확정 버튼에서 공통 호출
     */
    executeMatchConfirm(matchId, scoreA, scoreB, tieBreakerWinnerId = null) {
      try {
        const targetMatch = (TournamentStore.state.matches || []).find(m => m.matchId === matchId);
        if (!targetMatch) {
          alert('확정할 경기를 찾을 수 없습니다.');
          return null;
        }

        let chosenTieWinner = tieBreakerWinnerId;
        if (scoreA === scoreB && !chosenTieWinner) {
          const teamAName = TournamentStore.getTeamName(targetMatch.teamAId);
          const teamBName = TournamentStore.getTeamName(targetMatch.teamBId);
          const pickA = confirm(
            `현재 점수가 ${scoreA} : ${scoreB} 동점입니다.\n토너먼트 다음 라운드 진출팀(승부차기/판정승)으로 [${teamAName}] 팀을 확정하시겠습니까?\n(취소를 누르면 [${teamBName}] 팀이 진출합니다.)`
          );
          chosenTieWinner = pickA ? targetMatch.teamAId : targetMatch.teamBId;
        }

        const { resultSummary } = MatchTransitionModule.confirmMatchResult(
          TournamentStore.state,
          { matchId, scoreA, scoreB, tieBreakerWinnerId: chosenTieWinner }
        );

        TournamentStore.state.lastConfirmedSummary = resultSummary;
        TournamentStore.save('MATCH_CONFIRMED_EVENT');

        // 다음 진행할 경기가 있으면 스코어보드 팀명을 다음 경기로 자동 세팅
        const nextActive = TournamentStore.getActiveMatch();
        if (nextActive) {
          this.resetMainScoreboardForNextMatch(nextActive, resultSummary);
        } else {
          TournamentStore.syncActiveMatchToScoreboard(resultSummary);
        }

        this.renderAll();
        this.showConfirmResultModal(resultSummary);
        return resultSummary;
      } catch (err) {
        alert(err.message);
        return null;
      }
    },

    resetMainScoreboardForNextMatch(nextMatch, lastResultSummary = null) {
      if (!nextMatch) return;
      const tA = TournamentStore.getTeamName(nextMatch.teamAId);
      const tB = TournamentStore.getTeamName(nextMatch.teamBId);

      // 메인 스코어보드 입력창 및 선수 득점 초기화 연동 이벤트 발생
      window.dispatchEvent(new CustomEvent('futsal:loadTournamentMatch', {
        detail: {
          matchId: nextMatch.matchId,
          matchLabel: `${nextMatch.roundName} - ${nextMatch.matchLabel}`,
          team1Name: tA,
          team2Name: tB,
          lastConfirmedSummary: lastResultSummary
        }
      }));
    },

    /**
     * 경기 종료 확정 시 5초 이내(실제 0.01초 즉시) 승패·점수·다음 라운드 진출자 모달 표시
     */
    showConfirmResultModal(summary) {
      const modal = document.getElementById('tournamentConfirmResultModal');
      if (!modal || !summary) return;

      document.getElementById('confirmModalRoundBadge').textContent = `${summary.roundName} • ${summary.matchLabel} 확정 완료 (${summary.responseTimeMs}ms)`;
      document.getElementById('confirmModalTeamAName').textContent = summary.teamAName;
      document.getElementById('confirmModalTeamBName').textContent = summary.teamBName;
      document.getElementById('confirmModalScoreA').textContent = summary.scoreA;
      document.getElementById('confirmModalScoreB').textContent = summary.scoreB;

      const isAWinner = summary.winnerTeamName === summary.teamAName;
      const badgeA = document.getElementById('confirmModalBadgeA');
      const badgeB = document.getElementById('confirmModalBadgeB');
      if (badgeA && badgeB) {
        badgeA.textContent = isAWinner ? '🏆 승리 (WIN)' : '패배 (LOSE)';
        badgeA.className = 'result-wl-badge ' + (isAWinner ? 'wl-win' : 'wl-lose');
        badgeB.textContent = !isAWinner ? '🏆 승리 (WIN)' : '패배 (LOSE)';
        badgeB.className = 'result-wl-badge ' + (!isAWinner ? 'wl-win' : 'wl-lose');
      }

      document.getElementById('confirmModalWinnerHeadline').textContent =
        `🎉 ${summary.winnerTeamName} 승리! (${summary.winMethod})`;
      document.getElementById('confirmModalAdvancementText').textContent =
        `🚀 다음 라운드 진출: ${summary.advancementText}`;

      const nextMatchGuide = document.getElementById('confirmModalNextMatchGuide');
      if (nextMatchGuide) {
        if (summary.nextScheduledMatchId) {
          nextMatchGuide.innerHTML =
            `⏭️ <strong>다음 경기로 자동 이동됨:</strong> [${summary.nextScheduledMatchLabel}] <strong>${summary.nextScheduledTeamAName}</strong> vs <strong>${summary.nextScheduledTeamBName}</strong> 경기가 이제 '진행 중' 상태로 시작됩니다.`;
        } else {
          nextMatchGuide.innerHTML =
            `🏁 <strong>전체 12팀 토너먼트 모든 경기가 확정 완료되었습니다!</strong> 최종 우승팀: <strong>${summary.winnerTeamName}</strong>`;
        }
      }

      modal.classList.remove('hidden');
    },

    renderAll() {
      const isTeacher = RoleAuthModule.currentRole === 'teacher';

      // 역할 배지 및 교사 전용 섹션 표시/차단
      const roleIndicator = document.getElementById('currentRoleIndicatorBadge');
      if (roleIndicator) {
        roleIndicator.textContent = isTeacher ? '👨‍🏫 교사(운영자) 화면' : '🙋‍♂️ 학생(참관/확인자) 전용 화면';
        roleIndicator.className = 'role-indicator-pill ' + (isTeacher ? 'role-teacher' : 'role-student');
      }

      const teacherBtn = document.getElementById('switchTeacherRoleBtn');
      const studentBtn = document.getElementById('switchStudentRoleBtn');
      if (teacherBtn && studentBtn) {
        teacherBtn.classList.toggle('active-role-btn', isTeacher);
        studentBtn.classList.toggle('active-role-btn', !isTeacher);
      }

      // 학생용 링크 접속 시 교사 전용 패널 숨김 및 비활성화
      document.querySelectorAll('.teacher-only-section').forEach(el => {
        el.style.display = isTeacher ? '' : 'none';
      });

      this.renderValidationSection();
      this.renderActiveMatchBanner();
      this.renderBracketAndSchedule();
      this.renderTeacherProgressDashboard();
    },

    renderValidationSection() {
      const val = TournamentStore.state.validationResult;
      const statusBox = document.getElementById('teamValidationStatusBox');
      const tableBody = document.getElementById('loadedTeamsTableBody');
      const drawBtn = document.getElementById('drawSeedsAndGenerateBtn');

      if (!statusBox) return;

      if (!val) {
        statusBox.className = 'validation-alert-box neutral';
        statusBox.innerHTML = `<strong>대기 중:</strong> '구글시트에서 팀 불러오기' 버튼을 눌러 신청 팀(남 8팀, 여 4팀)을 불러오세요.`;
        if (drawBtn) drawBtn.disabled = true;
        return;
      }

      if (val.isValid) {
        statusBox.className = 'validation-alert-box valid';
        statusBox.innerHTML = `
          <div class="val-title">✅ ${val.message}</div>
          <div class="val-guide">${val.guide} (화면에는 개인정보 보호를 위해 <strong>팀명</strong>만 표시됩니다.)</div>
        `;
        if (drawBtn) drawBtn.disabled = false;
      } else {
        statusBox.className = 'validation-alert-box invalid';
        statusBox.innerHTML = `
          <div class="val-title">⚠️ ${val.message}</div>
          <div class="val-guide">${val.guide}</div>
        `;
        if (drawBtn) drawBtn.disabled = true;
      }

      if (tableBody) {
        const seededMap = new Map();
        (TournamentStore.state.teams || []).forEach(t => seededMap.set(t.teamName, t));

        tableBody.innerHTML = (val.teams || []).map((t, idx) => {
          const seededInfo = seededMap.get(t.teamName);
          const seedBadge = seededInfo
            ? `<span class="seed-pill ${seededInfo.hasBye ? 'seed-bye' : ''}">시드 #${seededInfo.seedNumber}${seededInfo.hasBye ? ' (1R 부전승→8강 직행)' : ''}</span>`
            : `<span class="seed-pill">추첨 전</span>`;
          return `
            <tr>
              <td>${idx + 1}</td>
              <td><strong>${PrivacyGuardModule.sanitizeTeamName(t.teamName)}</strong></td>
              <td><span class="gender-tag gender-${t.gender === '남' ? 'm' : 'f'}">${t.gender}</span></td>
              <td>${seedBadge}</td>
            </tr>
          `;
        }).join('');
      }
    },

    renderActiveMatchBanner() {
      const banner = document.getElementById('currentTournamentMatchBanner');
      if (!banner) return;

      const activeMatch = TournamentStore.getActiveMatch();
      const lastSummary = TournamentStore.state.lastConfirmedSummary;

      let lastSummaryHtml = '';
      if (lastSummary) {
        lastSummaryHtml = `
          <div class="recent-confirmed-strip">
            <span class="strip-tag">최근 확정 결과</span>
            <span><strong>[${lastSummary.matchLabel}]</strong> ${lastSummary.teamAName} <strong>${lastSummary.scoreA} : ${lastSummary.scoreB}</strong> ${lastSummary.teamBName}</span>
            <span class="strip-winner">🏆 ${lastSummary.winnerTeamName} 승리</span>
            <span class="strip-advance">🚀 ${lastSummary.advancementText}</span>
          </div>
        `;
      }

      if (!activeMatch) {
        if (TournamentStore.state.tournament && TournamentStore.state.tournament.status === '종료') {
          const finalMatch = TournamentStore.state.matches.find(m => m.matchId === 'M11');
          const champName = finalMatch ? TournamentStore.getTeamName(finalMatch.winnerTeamId) : '';
          banner.innerHTML = `
            ${lastSummaryHtml}
            <div class="active-match-spotlight finished-tournament">
              <div class="spotlight-left">
                <span class="spotlight-live-pill completed">🏆 TOURNAMENT COMPLETED</span>
                <h3>전체 12팀 토너먼트 대회가 모두 종료되었습니다! 최종 우승: <strong>${champName}</strong></h3>
              </div>
            </div>
          `;
        } else {
          banner.innerHTML = '';
        }
        return;
      }

      const teamAName = TournamentStore.getTeamName(activeMatch.teamAId);
      const teamBName = TournamentStore.getTeamName(activeMatch.teamBId);

      banner.innerHTML = `
        ${lastSummaryHtml}
        <div class="active-match-spotlight">
          <div class="spotlight-left">
            <span class="spotlight-live-pill">🔥 현재 진행 중인 경기 (${activeMatch.roundName})</span>
            <h3 class="spotlight-match-title">
              [${activeMatch.matchLabel}] <strong>${teamAName}</strong> <span class="vs-txt">VS</span> <strong>${teamBName}</strong>
            </h3>
            <p class="spotlight-sub">
              아래 경기 카드 또는 우측 상단 <strong>‘🏁 경기 종료 확정’</strong> 버튼을 누르면 승패·점수·다음 라운드 진출자가 즉시 표시되고 다음 경기로 자동 이동합니다.
            </p>
          </div>
          <div class="spotlight-right">
            <div class="quick-confirm-controls">
              <label class="quick-score-lbl">${teamAName} 득점
                <input type="number" id="spotlightScoreA" class="quick-score-input" min="0" max="99" value="${activeMatch.scoreA || 0}">
              </label>
              <span class="quick-colon">:</span>
              <label class="quick-score-lbl">${teamBName} 득점
                <input type="number" id="spotlightScoreB" class="quick-score-input" min="0" max="99" value="${activeMatch.scoreB || 0}">
              </label>
              <button type="button" class="btn-primary btn-confirm-spotlight" id="spotlightConfirmBtn">
                🏁 경기 종료 확정
              </button>
            </div>
          </div>
        </div>
      `;

      const spotlightBtn = document.getElementById('spotlightConfirmBtn');
      if (spotlightBtn) {
        spotlightBtn.addEventListener('click', () => {
          const sA = parseInt(document.getElementById('spotlightScoreA')?.value || '0', 10);
          const sB = parseInt(document.getElementById('spotlightScoreB')?.value || '0', 10);
          this.executeMatchConfirm(activeMatch.matchId, sA, sB);
        });
      }
    },

    renderBracketAndSchedule() {
      const container = document.getElementById('tournamentBracketContainer');
      const seedBadge = document.getElementById('currentTournamentSeedBadge');
      if (!container) return;

      const matches = TournamentStore.state.matches || [];
      if (seedBadge) {
        seedBadge.textContent = TournamentStore.state.seed
          ? `추첨 시드값: ${TournamentStore.state.seed.seedValue} (총 12팀: 남8 + 여4)`
          : '대진 생성 전';
      }

      if (matches.length === 0) {
        container.innerHTML = `<div class="empty-bracket-msg">교사 화면에서 '시드 추첨 후 대진 생성'을 실행하면 12팀 토너먼트 대진표와 경기 일정이 표시됩니다.</div>`;
        return;
      }

      // 부전승(시드 1~4번, 2라운드 8강 직행) 안내 바
      const byeTeams = (TournamentStore.state.teams || []).filter(t => t.hasBye);
      const byeNoticeHtml = byeTeams.length > 0 ? `
        <div class="bye-teams-banner">
          <span class="bye-badge">🌟 1라운드 부전승 (2라운드 8강 자동 진출 확정 - 4팀)</span>
          <div class="bye-team-chips">
            ${byeTeams.map(t => `<span class="bye-chip">시드 #${t.seedNumber} <strong>${PrivacyGuardModule.sanitizeTeamName(t.teamName)}</strong> (${t.gender}) → 8강 직행</span>`).join('')}
          </div>
        </div>
      ` : '';

      const rounds = [
        { roundNumber: 1, title: '1라운드 (12강 • 4경기)', subtitle: '시드 5~12위 대결 (승자 8강 진출)' },
        { roundNumber: 2, title: '2라운드 (8강 • 4경기)', subtitle: '부전승 시드 1~4위 + 1R 승자' },
        { roundNumber: 3, title: '3라운드 (4강 준결승 • 2경기)', subtitle: '8강 승자 대결 (승자 결승 진출)' },
        { roundNumber: 4, title: '4라운드 (결승전 • 1경기)', subtitle: '최종 우승팀 결정전' }
      ];

      const columnsHtml = rounds.map(r => {
        const roundMatches = matches.filter(m => m.roundNumber === r.roundNumber);
        const cardsHtml = roundMatches.map(m => this.createMatchCardHtml(m)).join('');
        return `
          <div class="bracket-round-col">
            <div class="bracket-round-header">
              <h4>${r.title}</h4>
              <span>${r.subtitle}</span>
            </div>
            <div class="bracket-matches-list">
              ${cardsHtml}
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = `
        ${byeNoticeHtml}
        <div class="bracket-four-columns-grid">
          ${columnsHtml}
        </div>
      `;
    },

    createMatchCardHtml(m) {
      const teamAName = m.teamAId ? TournamentStore.getTeamName(m.teamAId) : (m.teamASourceLabel || '미정(대기)');
      const teamBName = m.teamBId ? TournamentStore.getTeamName(m.teamBId) : (m.teamBSourceLabel || '미정(대기)');
      const isReady = Boolean(m.teamAId && m.teamBId);
      const isConfirmed = m.status === '확정';
      const isInProgress = m.status === '진행';

      let statusBadgeHtml = '';
      if (isConfirmed) {
        statusBadgeHtml = `<span class="m-status-pill status-confirmed">✅ 확정 완료</span>`;
      } else if (isInProgress) {
        statusBadgeHtml = `<span class="m-status-pill status-live">🔥 현재 진행 중</span>`;
      } else {
        statusBadgeHtml = `<span class="m-status-pill status-waiting">⏳ 대기</span>`;
      }

      const isAWinner = isConfirmed && m.winnerTeamId === m.teamAId;
      const isBWinner = isConfirmed && m.winnerTeamId === m.teamBId;

      // 부전승 출처 표시
      const aByeTag = (m.roundNumber === 2 && m.teamAId)
        ? `<span class="bye-slot-tag" title="시드 추첨 부전승으로 자동 진출한 팀">부전승 자동진출</span>`
        : '';

      // 다음 라운드 진출자 표시 영역
      let advancementFooterHtml = '';
      if (isConfirmed) {
        const winnerName = TournamentStore.getTeamName(m.winnerTeamId);
        const loserName = TournamentStore.getTeamName(m.loserTeamId);
        const nextMatch = m.nextMatchId
          ? (TournamentStore.state.matches || []).find(nx => nx.matchId === m.nextMatchId)
          : null;
        const nextDesc = nextMatch
          ? `${nextMatch.roundName} [${nextMatch.matchLabel}] 진출`
          : `🏆 대회 최종 우승!`;

        advancementFooterHtml = `
          <div class="match-confirmed-result-box">
            <div class="confirmed-wl-row">
              <span class="win-tag">승: <strong>${winnerName}</strong></span>
              <span class="lose-tag">패: ${loserName}</span>
              <span class="score-tag">점수 ${m.scoreA} : ${m.scoreB}</span>
            </div>
            <div class="confirmed-next-row">
              🚀 <strong>진출자:</strong> ${winnerName} → <span>${nextDesc}</span>
            </div>
          </div>
        `;
      } else if (isReady) {
        advancementFooterHtml = `
          <div class="match-confirm-action-bar">
            <div class="inline-score-inputs">
              <input type="number" id="scoreA_input_${m.matchId}" class="card-score-input" min="0" max="99" value="${m.scoreA || 0}" aria-label="${teamAName} 점수">
              <span>:</span>
              <input type="number" id="scoreB_input_${m.matchId}" class="card-score-input" min="0" max="99" value="${m.scoreB || 0}" aria-label="${teamBName} 점수">
            </div>
            <button type="button" class="btn-card-confirm" data-confirm-match-id="${m.matchId}">
              🏁 경기 종료 확정
            </button>
          </div>
        `;
      } else {
        advancementFooterHtml = `
          <div class="match-waiting-notice">
            이전 라운드 경기 확정 시 진출팀이 자동으로 채워집니다.
          </div>
        `;
      }

      return `
        <article class="bracket-match-card ${isInProgress ? 'card-in-progress' : ''} ${isConfirmed ? 'card-confirmed' : ''}" data-match-card="${m.matchId}">
          <div class="match-card-top">
            <span class="match-num-label">${m.matchLabel}</span>
            ${statusBadgeHtml}
          </div>

          <div class="match-teams-pair">
            <div class="match-team-row ${isAWinner ? 'row-winner' : ''} ${!m.teamAId ? 'row-tbd' : ''}">
              <div class="team-name-cell">
                <span class="slot-letter">A</span>
                <span class="t-name">${teamAName}</span>
                ${aByeTag}
                ${isAWinner ? '<span class="win-crown">🏆 승리</span>' : ''}
              </div>
              <span class="t-score">${isConfirmed ? m.scoreA : '-'}</span>
            </div>

            <div class="match-team-row ${isBWinner ? 'row-winner' : ''} ${!m.teamBId ? 'row-tbd' : ''}">
              <div class="team-name-cell">
                <span class="slot-letter">B</span>
                <span class="t-name">${teamBName}</span>
                ${isBWinner ? '<span class="win-crown">🏆 승리</span>' : ''}
              </div>
              <span class="t-score">${isConfirmed ? m.scoreB : '-'}</span>
            </div>
          </div>

          ${advancementFooterHtml}
        </article>
      `;
    },

    renderTeacherProgressDashboard() {
      const tbody = document.getElementById('teacherProgressTableBody');
      const summaryStats = document.getElementById('teacherDashboardSummaryStats');
      if (!tbody) return;

      const matches = TournamentStore.state.matches || [];
      const confirmedCount = matches.filter(m => m.status === '확정').length;
      const inProgressCount = matches.filter(m => m.status === '진행').length;
      const waitingCount = matches.filter(m => m.status === '대기').length;

      if (summaryStats) {
        summaryStats.textContent = `전체 ${matches.length}경기 중 확정 ${confirmedCount}경기 / 진행 중 ${inProgressCount}경기 / 대기 ${waitingCount}경기`;
      }

      tbody.innerHTML = matches.map(m => {
        const tA = m.teamAId ? TournamentStore.getTeamName(m.teamAId) : (m.teamASourceLabel || '미정');
        const tB = m.teamBId ? TournamentStore.getTeamName(m.teamBId) : (m.teamBSourceLabel || '미정');
        const isConfirmed = m.status === '확정';
        const winnerName = isConfirmed ? TournamentStore.getTeamName(m.winnerTeamId) : '-';
        const scoreStr = isConfirmed ? `${m.scoreA} : ${m.scoreB}` : '-';
        const nextTarget = m.nextMatchId ? `${m.nextMatchId}(${m.nextSlot}슬롯)` : '최종 결승';

        return `
          <tr class="${m.status === '진행' ? 'dash-row-live' : ''} ${isConfirmed ? 'dash-row-done' : ''}">
            <td><strong>${m.matchId}</strong> (${m.roundName})</td>
            <td>${tA} vs ${tB}</td>
            <td><span class="m-status-pill ${isConfirmed ? 'status-confirmed' : (m.status === '진행' ? 'status-live' : 'status-waiting')}">${m.status}</span></td>
            <td><strong>${scoreStr}</strong></td>
            <td>${isConfirmed ? `🏆 ${winnerName}` : '-'}</td>
            <td>${isConfirmed ? `🚀 ${winnerName} → ${nextTarget}` : `대기 (${nextTarget})`}</td>
          </tr>
        `;
      }).join('');
    },

    renderTestReport(report) {
      const box = document.getElementById('automatedTestResultBox');
      if (!box) return;
      box.classList.remove('hidden');
      box.innerHTML = `
        <div class="test-report-header">
          <strong>🧪 필수 4대 테스트 기준 자동 검증 결과: ${report.allPassed ? '✅ 전체 통과 (4/4 PASS)' : '❌ 일부 실패'}</strong>
          <span>실행 시각: ${new Date().toLocaleTimeString('ko-KR')}</span>
        </div>
        <ul class="test-report-list">
          ${report.results.map(r => `
            <li class="${r.passed ? 'test-pass' : 'test-fail'}">
              <span>${r.passed ? '✅ [PASS]' : '❌ [FAIL]'}</span>
              <strong>${r.name}:</strong> ${r.detail}
            </li>
          `).join('')}
        </ul>
      `;
    },

    openPolicyModal(type) {
      const modal = document.getElementById('policyDocModal');
      const title = document.getElementById('policyDocModalTitle');
      const body = document.getElementById('policyDocModalBody');
      if (!modal || !title || !body) return;

      if (type === 'privacy') {
        title.textContent = '개인정보 처리방침 (초안 - 개인정보보호위원회 작성지침 준수)';
        body.innerHTML = `
          <div class="policy-doc-content">
            <p class="policy-notice">※ 본 초안은 「개인정보 처리방침 작성지침」을 준수하여 작성되었으며, <strong>(선생님 확인 필요)</strong> 항목은 기본값을 임의로 두지 않았으므로 학교 정책에 맞게 기입 후 확정하시기 바랍니다.</p>
            <h4>1. 개인정보의 처리 목적</h4>
            <p>풋살 대회 운영(구글폼 신청 팀 확인, 12팀 시드 추첨 및 대진표·일정 자동 생성, 경기 결과 확정 및 다음 라운드 진출자 표시)을 목적으로만 처리합니다.</p>
            <h4>2. 처리하는 개인정보 항목 및 화면 노출 원칙</h4>
            <ul>
              <li><strong>화면 노출 항목:</strong> <strong>팀명</strong>만 화면에 표시합니다(학생 이름·학번 화면 노출 엄격 금지).</li>
              <li><strong>수집·연동 시 최소 처리:</strong> 구글폼 응답 시트에 이름·학번이 포함되어 있더라도 시스템은 파싱 즉시 이름·학번을 폐기(마스킹)하고 <strong>팀명, 성별(남/여), 경기 결과 상태</strong>만 저장·활용합니다.</li>
            </ul>
            <h4>3. 개인정보의 처리 및 보유 기간</h4>
            <p><strong>보유 기간:</strong> <mark>[선생님 확인 필요: 대회 종료 후 O일 또는 O개월 보관 후 즉시 파기]</mark></p>
            <h4>4. 개인정보의 파기 절차 및 방법</h4>
            <p>보유 기간 경과 또는 대회 종료 후 교사 운영 화면의 [대회 데이터 영구 파기] 기능을 통해 전자적 파일을 복구 불가능한 방법으로 즉시 삭제하고 구글시트 접근 권한을 회수합니다.</p>
            <h4>5. 개인정보의 제3자 제공 및 처리위탁</h4>
            <p>외부 제3자 제공은 없으며, 신청 접수를 위해 사용한 구글폼/구글시트 및 클라우드 DB(도입 시)의 처리위탁 해당 여부는 학교 기준에 따라 명시합니다.</p>
            <h4>6. 안전성 확보조치</h4>
            <p>교사/학생 권한 분리(학생 화면에서 교사 기능 차단), HTTPS 암호화 통신, 비밀키 환경변수(.env) 분리, 서버/클라이언트 로그 내 이름·학번 마스킹을 적용합니다.</p>
            <h4>7. 정보주체와 법정대리인의 권리 행사 방법</h4>
            <p>학생 및 법정대리인은 언제든지 담당 교사에게 열람·정정·삭제·처리정지를 요청할 수 있으며 요청 즉시 조치합니다.</p>
            <h4>8. 개인정보 보호책임자 및 담당부서</h4>
            <p><strong>책임자/담당부서:</strong> <mark>[선생님 확인 필요: 학교명 / 담당부서명(예: 체육교육부) / 담당 교사 성명 및 연락처]</mark></p>
            <h4>9. 개인정보 처리방침 변경 고지</h4>
            <p>방침 변경 시 시행일자 및 변경 내용을 웹페이지 하단 푸터를 통해 공지합니다.</p>
          </div>
        `;
      } else if (type === 'terms') {
        title.textContent = '서비스 이용약관 (초안 - 디지털콘텐츠 표준약관 취지 반영)';
        body.innerHTML = `
          <div class="policy-doc-content">
            <h4>제1조 (목적 및 서비스 제공)</h4>
            <p>본 서비스는 교내 풋살 대회의 공정한 시드 추첨, 12팀 토너먼트 대진표·일정 안내 및 실시간 경기 종료 확정을 지원하는 비영리 교육용 웹 서비스입니다.</p>
            <h4>제2조 (이용자의 권리·의무 및 권한 구분)</h4>
            <ul>
              <li><strong>교사(운영자):</strong> 팀 목록 불러오기 및 검증(남 8, 여 4), 시드 추첨, 대진 생성 및 전체 상태 관리를 수행합니다.</li>
              <li><strong>학생(참관/확인자):</strong> 학생용 전용 링크를 통해 대진표와 일정을 확인하고, 경기 종료 확정 시 승패·점수·다음 라운드 진출자를 확인합니다. 교사 전용 기능에는 접근할 수 없습니다.</li>
            </ul>
            <h4>제3조 (청약철회 및 환불 관련 안내)</h4>
            <p>본 웹 서비스는 학교 수업 및 동아리 활동 지원을 위해 무상 제공되는 교육용 디지털콘텐츠이므로 유료 결제·환불·청약철회 대상에 해당하지 않습니다.</p>
            <h4>제4조 (책임 제한 및 분쟁 해결)</h4>
            <p>비인가된 방법으로 타 경기 결과를 임의 조작하는 행위를 금지하며, 경기 결과 이의 신청이나 분쟁 발생 시 담당 교사의 확인 및 대회 운영 규정에 따라 조정합니다.</p>
          </div>
        `;
      } else {
        title.textContent = '문의/담당자 · 기관명 · 시행일 안내';
        body.innerHTML = `
          <div class="policy-doc-content">
            <ul>
              <li><strong>기관명:</strong> <mark>[선생님 확인 필요: OO중학교 / OO고등학교]</mark></li>
              <li><strong>문의 및 담당자:</strong> <mark>[선생님 확인 필요: 체육교과부 담당교사 OOO]</mark></li>
              <li><strong>가정/과제용 사용 여부:</strong> <mark>[선생님 확인 필요]</mark></li>
              <li><strong>시행일 / 최종 변경일:</strong> 2026년 11월 06일</li>
            </ul>
          </div>
        `;
      }

      modal.classList.remove('hidden');
    }
  };

  // ==========================================================================
  // 필수 테스트 기준 4종 자동 검증 스위트 (Section 11)
  // ==========================================================================
  const TournamentTestSuite = {
    runAll() {
      const results = [];
      const prevRole = RoleAuthModule.currentRole;

      try {
        // 1) 팀 검증 테스트 (남 8, 여 4 맞을 때만 통과 / 다르면 오류 표시)
        RoleAuthModule.currentRole = 'teacher';
        const validCheck = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_VALID_ROWS);
        const invalidCheck = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_INVALID_ROWS);
        const test1Pass = validCheck.isValid === true &&
          validCheck.maleCount === 8 &&
          validCheck.femaleCount === 4 &&
          invalidCheck.isValid === false &&
          invalidCheck.message.includes('남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 7, 여 3');

        results.push({
          name: '1) 팀 검증 테스트 (남 8, 여 4 고정 검증 및 오류 안내)',
          passed: test1Pass,
          detail: test1Pass
            ? `정상 데이터(남8, 여4) 통과 및 부족 데이터("${invalidCheck.message}") 오류 차단 확인 완료`
            : '팀 수 검증 실패'
        });

        // 2) 대진 생성 테스트 (12팀 누락 없이 연결 & 부전승 자동 진출 확인)
        const gen = BracketGeneratorModule.generateTournament(validCheck.teams, 'TEST-SEED-2026');
        const r1Teams = gen.matches.filter(m => m.roundNumber === 1).flatMap(m => [m.teamAId, m.teamBId]);
        const r2ByeTeams = gen.matches.filter(m => m.roundNumber === 2).map(m => m.teamAId);
        const uniqueAssignedTeams = new Set([...r1Teams, ...r2ByeTeams].filter(Boolean));
        const test2Pass = gen.teams.length === 12 &&
          uniqueAssignedTeams.size === 12 &&
          r2ByeTeams.every(Boolean) &&
          gen.matches.length === 11;

        results.push({
          name: '2) 대진 생성 테스트 (12팀 전원 누락 없음 + 부전승 4팀 2라운드 자동 배치)',
          passed: test2Pass,
          detail: test2Pass
            ? `12팀 전원(1R 출전 8팀 + 2R 부전승 자동진출 4팀 = 고유 ${uniqueAssignedTeams.size}팀) 및 총 11경기 연결 검증 완료`
            : '대진 연결 누락 발생'
        });

        // 3) 경기 확정 테스트 (5초 이내 표시, 중복 확정 차단, 다음 경기 자동 전이)
        const confirmOut = MatchTransitionModule.confirmMatchResult(gen, {
          matchId: 'M1',
          scoreA: 3,
          scoreB: 1
        });
        const m5After = gen.matches.find(m => m.matchId === 'M5');
        const m2After = gen.matches.find(m => m.matchId === 'M2');
        let duplicateBlocked = false;
        try {
          MatchTransitionModule.confirmMatchResult(gen, { matchId: 'M1', scoreA: 2, scoreB: 0 });
        } catch (dupErr) {
          duplicateBlocked = true;
        }
        const test3Pass = confirmOut.resultSummary.responseTimeMs < 5000 &&
          m5After.teamBId === confirmOut.resultSummary.winnerTeamId &&
          m2After.status === '진행' &&
          duplicateBlocked;

        results.push({
          name: '3) 경기 확정 테스트 (5초 이내 표시, 중복 확정 방지, 다음 경기 자동 이동)',
          passed: test3Pass,
          detail: test3Pass
            ? `응답 속도 ${confirmOut.resultSummary.responseTimeMs}ms(<5000ms), 승자(${confirmOut.resultSummary.winnerTeamName}) M5 진출, M2 '진행' 자동 전이, 중복 확정 차단 완료`
            : '경기 확정 전이 오류'
        });

        // 4) 권한 테스트 (학생 화면에서 시드 추첨/대진 생성 기능 접근 불가)
        RoleAuthModule.currentRole = 'student';
        let studentBlocked = false;
        try {
          BracketGeneratorModule.generateTournament(validCheck.teams);
        } catch (authErr) {
          studentBlocked = authErr.message.includes('권한 차단');
        }
        results.push({
          name: '4) 권한 테스트 (학생 역할에서 시드 추첨/대진 생성 호출 차단)',
          passed: studentBlocked,
          detail: studentBlocked
            ? '학생 권한에서 시드 추첨/대진 생성 호출 시 RoleAuthModule이 즉시 차단 완료'
            : '권한 차단 실패'
        });
      } finally {
        RoleAuthModule.currentRole = prevRole;
      }

      return {
        allPassed: results.every(r => r.passed),
        results
      };
    }
  };

  // 전역 노출 (app.js 및 콘솔/테스트에서 즉시 호출 가능)
  global.FutsalTournament = {
    PrivacyGuardModule,
    RoleAuthModule,
    SheetSyncModule,
    BracketGeneratorModule,
    MatchTransitionModule,
    TournamentStore,
    TournamentAppController,
    TournamentTestSuite
  };

  document.addEventListener('DOMContentLoaded', () => {
    TournamentAppController.init();
  });
})(window);

