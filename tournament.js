/**
 * ============================================================================
 * 풋살대회 대진표 (tournament.js)
 * ============================================================================
 * - 기본 연동 구글시트:
 *   https://docs.google.com/spreadsheets/d/1c-_A-UnDxHvvDTFOLTwIyyV0trYpZ18j62o_BWRAue0/edit?resourcekey=&gid=541552316#gid=541552316
 * - 구글시트 실제 상태를 그대로 반영 (신청 팀이 0팀이면 남자부 0/8팀, 여자부 0/4팀 빈 슬롯으로 표시)
 * - 상단 좌측: 구글시트 신청 팀 현황 (남자부 8팀 / 여자부 4팀 분리 정리 표시)
 * - 상단 우측: 남자부(8팀) / 여자부(4팀) 대진 추첨 콘솔
 * - 하단: 남자부 토너먼트 대진표 (8강 -> 4강 -> 결승) & 여자부 토너먼트 대진표 (4강 -> 결승) 분리 표시
 * - 각 경기 ‘🏁 경기 종료 확정’ 클릭 시 승패·점수·다음 라운드 진출자 즉시 표시 및 다음 경기 자동 이동
 * ============================================================================
 */

(function (global) {
  'use strict';

  const DEFAULT_GOOGLE_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/1c-_A-UnDxHvvDTFOLTwIyyV0trYpZ18j62o_BWRAue0/edit?resourcekey=&gid=541552316#gid=541552316';
  const DEFAULT_SHEET_ID = '1c-_A-UnDxHvvDTFOLTwIyyV0trYpZ18j62o_BWRAue0';
  const DEFAULT_GID = '541552316';

  const TOURNAMENT_STORAGE_KEY = 'futsal_tournament_v3_sheet_sync';
  const AUDIT_LOG_STORAGE_KEY = 'futsal_tournament_audit_logs';

  // 실시간 동기화 채널 (교사 화면 <-> 학생 화면 0ms 연동)
  const TournamentSyncBus = {
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('futsal_sync_bus') : null,
    post(type, payload = {}) {
      if (this.channel) {
        try {
          this.channel.postMessage({ type, payload, timestamp: Date.now() });
        } catch (err) {
          console.warn('[SyncBus] 메시지 전송 실패:', err.name);
        }
      }
    }
  };

  // ==========================================================================
  // 모듈 (7) 개인정보보호/표시 규칙 모듈 (PrivacyGuardModule)
  // ==========================================================================
  const PrivacyGuardModule = {
    sanitizeSheetRow(rawRow, columnMap, index) {
      if (!rawRow || typeof rawRow !== 'object') return null;

      const keys = Object.keys(rawRow);
      const teamNameCol = this.findMatchingKey(keys, [
        columnMap.teamName, '팀명', '팀 이름', '팀이름', '팀', '참가팀', '신청팀', 'teamName', 'team'
      ]);
      const genderCol = this.findMatchingKey(keys, [
        columnMap.gender, '성별', '부문', '참가부문', '참가 부문', '남/여', '남여', '종별', 'gender'
      ]);

      let rawTeamName = teamNameCol ? String(rawRow[teamNameCol] ?? '').trim() : '';
      let rawGender = genderCol ? String(rawRow[genderCol] ?? '').trim() : '';

      if (!rawGender) {
        for (const k of keys) {
          const v = String(rawRow[k] ?? '').trim();
          if (this.normalizeGender(v) !== '미분류') {
            rawGender = v;
            break;
          }
        }
      }
      if (!rawTeamName) {
        for (const k of keys) {
          // 대표 선수, 선수1~7, 이름, 학번 등은 팀명 후보에서 제외
          if (/타임스탬프|timestamp|학번|이름|성명|연락처|전화|성별|부문|대표|선수/i.test(k)) continue;
          const v = String(rawRow[k] ?? '').trim();
          if (v && this.normalizeGender(v) === '미분류' && !/^\d{4,}/.test(v)) {
            rawTeamName = v;
            break;
          }
        }
      }

      // 헤더 행 자체가 데이터로 들어온 경우 제외
      if (/^(팀명|팀 이름|참가팀|신청팀|team)$/i.test(rawTeamName)) return null;

      const normalizedGender = this.normalizeGender(rawGender);
      const safeTeamName = this.sanitizeTeamName(rawTeamName);

      if (!safeTeamName) return null;

      // ★ 선수 명단 추출 규칙: '대표 선수' 컬럼은 제외하고 '선수1' ~ '선수7'만 선수로 등록 (대표 선수도 선수1~7에 포함됨)
      const rosterPlayers = this.extractPlayers1To7Only(rawRow);

      return {
        teamId: `TEAM_${String(index + 1).padStart(2, '0')}`,
        teamName: safeTeamName,
        gender: normalizedGender,
        rosterPlayers
      };
    },

    /**
     * 구글시트 행에서 '대표 선수(대표자)' 컬럼은 제외하고 오직 '선수1' ~ '선수7' 컬럼만 선수로 추출합니다.
     * (대표 선수도 선수1~7 안에 포함되어 있으므로 중복 등록 방지)
     */
    extractPlayers1To7Only(rawRow) {
      if (!rawRow || typeof rawRow !== 'object') return [];
      const keys = Object.keys(rawRow);
      const players = [];

      for (let slot = 1; slot <= 7; slot++) {
        // '대표 선수'가 포함된 컬럼명은 무조건 제외하고, 정확히 선수1 ~ 선수7 컬럼만 매칭
        const slotRegex = new RegExp(`^(?!.*대표).*선수\\s*0?${slot}(?:\\b|[^0-9]|$)`, 'i');
        const matchedKeys = keys.filter(k => slotRegex.test(k.trim()));

        if (matchedKeys.length === 0) continue;

        let playerName = '';
        let studentNum = '';

        for (const k of matchedKeys) {
          const val = String(rawRow[k] ?? '').trim();
          if (!val) continue;

          if (/학번|번호|id/i.test(k) && !/이름|성명/i.test(k)) {
            studentNum = val;
          } else if (/이름|성명/i.test(k)) {
            playerName = val;
          } else {
            // 단일 컬럼(예: "선수1" -> "10101 김민준" 또는 "김민준(10101)" 또는 "김민준") 파싱
            const numMatch = val.match(/\b(\d{4,6})\b/);
            if (numMatch) {
              studentNum = studentNum || numMatch[1];
              const cleanedName = val
                .replace(numMatch[1], '')
                .replace(/[()[\]\-\/,:]/g, ' ')
                .trim();
              if (cleanedName) playerName = cleanedName;
            } else {
              playerName = val;
            }
          }
        }

        if (playerName) {
          players.push({
            slotNumber: slot,
            number: slot,
            name: playerName.replace(/<[^>]*>?/gm, '').trim(),
            studentNum: studentNum || ''
          });
        }
      }

      return players;
    },

    findMatchingKey(keys, candidates) {
      for (const cand of candidates) {
        if (!cand) continue;
        const exact = keys.find(k => k.trim() === cand.trim());
        if (exact) return exact;
        const partial = keys.find(k => k.replace(/\s+/g, '').includes(cand.replace(/\s+/g, '')));
        if (partial) return partial;
      }
      return null;
    },

    normalizeGender(val) {
      const v = String(val || '').trim().toUpperCase();
      if (!v) return '미분류';
      if (v === '남' || v === '남자' || v === '남성' || v.includes('남자') || v.includes('남성') || v === 'M' || v === 'MALE') return '남';
      if (v === '여' || v === '여자' || v === '여성' || v.includes('여자') || v.includes('여성') || v === 'F' || v === 'FEMALE') return '여';
      return '미분류';
    },

    sanitizeTeamName(name) {
      if (!name) return '';
      return String(name)
        .replace(/<[^>]*>?/gm, '')
        .replace(/\b\d{5}\b/g, '***')
        .trim();
    },

    maskLogMessage(message) {
      if (!message) return '';
      return String(message)
        .replace(/\b\d{5}\b/g, '[학번마스킹]')
        .replace(/(이름|성명|학번)\s*[:=]\s*[^\s,]+/g, '$1:[비공개]');
    }
  };

  // ==========================================================================
  // 모듈 (6) 권한/역할 제어 모듈 (RoleAuthModule)
  // ==========================================================================
  const RoleAuthModule = {
    currentRole: 'teacher',

    initFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const requestedRole = (params.get('role') || '').toLowerCase();

      if (requestedRole === 'student') {
        this.currentRole = 'student';
        this.recordAudit('ACCESS_STUDENT_VIEW', 'student', '학생용 대진표 링크 접속');
      } else {
        this.currentRole = 'teacher';
        this.recordAudit('ACCESS_TEACHER_VIEW', 'teacher', '교사용 대진표 운영 화면 접속');
      }
    },

    assertTeacherPermission(actionName) {
      if (this.currentRole !== 'teacher') {
        const msg = `[권한 차단] 학생 화면에서는 '${actionName}' 기능을 실행할 수 없습니다.`;
        this.recordAudit('PERMISSION_DENIED', this.currentRole, actionName);
        throw new Error(msg);
      }
      this.recordAudit('TEACHER_ACTION', 'teacher', actionName);
      return true;
    },

    setRole(newRole) {
      this.currentRole = newRole === 'student' ? 'student' : 'teacher';
      this.recordAudit('SWITCH_ROLE', this.currentRole, `${this.currentRole} 화면 모드로 전환`);
    },

    recordAudit(eventType, actorRole, detail) {
      try {
        const raw = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
        const logs = raw ? JSON.parse(raw) : [];
        logs.unshift({
          logId: 'LOG_' + Date.now(),
          timestamp: new Date().toISOString(),
          eventType,
          actorRole,
          detail: PrivacyGuardModule.maskLogMessage(detail)
        });
        localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(logs.slice(0, 100)));
      } catch (e) {}
    }
  };

  // ==========================================================================
  // 모듈 (3) 구글시트 연동 모듈 (SheetSyncModule)
  // ==========================================================================
  const SheetSyncModule = {
    defaultColumnMap: {
      studentName: '이름',
      studentId: '학번',
      teamName: '팀명',
      gender: '성별'
    },

    SAMPLE_VALID_ROWS: [
      { '이름': '가짜학생1', '학번': '10101', '팀명': '청룡 FC', '성별': '남자부' },
      { '이름': '가짜학생2', '학번': '10102', '팀명': '백호 유나이티드', '성별': '남자부' },
      { '이름': '가짜학생3', '학번': '10201', '팀명': '스톰 스트라이커즈', '성별': '남자부' },
      { '이름': '가짜학생4', '학번': '10202', '팀명': '썬더 일레븐', '성별': '남자부' },
      { '이름': '가짜학생5', '학번': '10301', '팀명': '골든 이글스', '성별': '남자부' },
      { '이름': '가짜학생6', '학번': '10302', '팀명': '아이언 실드', '성별': '남자부' },
      { '이름': '가짜학생7', '학번': '10401', '팀명': '블루 웨이브', '성별': '남자부' },
      { '이름': '가짜학생8', '학번': '10402', '팀명': '레드 피닉스', '성별': '남자부' },
      { '이름': '가짜학생9', '학번': '20101', '팀명': '퀸즈 스타즈', '성별': '여자부' },
      { '이름': '가짜학생10', '학번': '20201', '팀명': '아테나 FC', '성별': '여자부' },
      { '이름': '가짜학생11', '학번': '20301', '팀명': '빅토리아 윙즈', '성별': '여자부' },
      { '이름': '가짜학생12', '학번': '20401', '팀명': '오로라 레이디스', '성별': '여자부' }
    ],

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

    parseSheetIds(sheetUrl) {
      const trimmed = String(sheetUrl || DEFAULT_GOOGLE_SHEET_URL).trim();
      const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);
      return {
        sheetId: idMatch && idMatch[1] ? idMatch[1] : DEFAULT_SHEET_ID,
        gid: gidMatch && gidMatch[1] ? gidMatch[1] : DEFAULT_GID
      };
    },

    toCsvExportUrl(sheetUrl) {
      const { sheetId, gid } = this.parseSheetIds(sheetUrl);
      return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    },

    parseCsvText(text) {
      const lines = String(text || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      if (lines.length < 1) return [];

      const isTsv = lines[0].includes('\t');
      const splitLine = (line) => {
        if (isTsv) return line.split('\t').map(s => s.trim());
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

      const firstCols = splitLine(lines[0]);
      const hasHeader = firstCols.some(c => /팀|성별|부문|이름|학번|타임스탬프|team|gender/i.test(c));
      const headers = hasHeader ? firstCols : ['이름', '학번', '팀명', '성별'];
      const startIdx = hasHeader ? 1 : 0;

      const rows = [];
      for (let i = startIdx; i < lines.length; i++) {
        const cols = splitLine(lines[i]);
        const rowObj = {};
        headers.forEach((h, idx) => {
          rowObj[h] = cols[idx] !== undefined ? cols[idx] : '';
        });
        rows.push(rowObj);
      }
      return rows;
    },

    fetchViaJsonp(sheetUrl) {
      const { sheetId, gid } = this.parseSheetIds(sheetUrl);
      return new Promise((resolve, reject) => {
        const callbackName = '__futsalGvizCb_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const script = document.createElement('script');
        let timer = setTimeout(() => {
          cleanup();
          reject(new Error('JSONP_TIMEOUT'));
        }, 6000);

        function cleanup() {
          clearTimeout(timer);
          delete window[callbackName];
          if (script.parentNode) script.parentNode.removeChild(script);
        }

        window[callbackName] = (response) => {
          cleanup();
          if (!response || response.status === 'error' || !response.table) {
            reject(new Error('GVIZ_ERROR'));
            return;
          }
          const cols = (response.table.cols || []).map((c, idx) => (c.label || c.id || `COL_${idx}`).trim());
          const rows = (response.table.rows || []).map(r => {
            const obj = {};
            (r.c || []).forEach((cell, idx) => {
              const header = cols[idx] || `COL_${idx}`;
              obj[header] = cell && (cell.f !== undefined && cell.f !== null ? cell.f : cell.v) || '';
            });
            return obj;
          });
          resolve(rows);
        };

        script.onerror = () => {
          cleanup();
          reject(new Error('SCRIPT_LOAD_ERROR'));
        };

        script.src = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?gid=${gid}&tqx=responseHandler:${callbackName}`;
        document.head.appendChild(script);
      });
    },

    /**
     * 원격 구글시트에서 실시간으로 신청 팀 목록을 불러옵니다 (신청 팀이 0팀이어도 그대로 0팀으로 반영!).
     */
    async fetchFromGoogleSheetUrl(sheetUrl, customColumnMap = {}) {
      RoleAuthModule.assertTeacherPermission('구글시트 URL에서 신청 팀 불러오기');

      // 1차 시도: Google Visualization JSONP (0팀인 빈 시트도 정상 반환)
      try {
        const jsonpRows = await this.fetchViaJsonp(sheetUrl);
        if (Array.isArray(jsonpRows)) {
          return this.extractAndValidateTeams(jsonpRows, customColumnMap, '구글시트 실시간 연동 완료');
        }
      } catch (_) {
        // 2차 시도로 폴백
      }

      // 2차 시도: CSV Export Fetch
      const csvUrl = this.toCsvExportUrl(sheetUrl);
      const response = await fetch(csvUrl, { method: 'GET', cache: 'no-store' });
      const text = await response.text();

      if (!response.ok || text.includes('<!DOCTYPE html>') || text.includes('show-login-page')) {
        throw new Error(
          '현재 구글시트가 비공개(로그인 필요) 상태이거나 아직 신청 데이터가 없습니다.\n\n' +
          '💡 실시간 자동 연동을 위해 구글시트 우측 상단 [공유] → 일반 액세스를 [링크가 있는 모든 사용자 (뷰어)]로 설정해 주세요.'
        );
      }

      const rows = this.parseCsvText(text);
      return this.extractAndValidateTeams(rows, customColumnMap, '구글시트 실시간 연동 완료');
    },

    extractAndValidateTeams(rawRows, customColumnMap = {}, sourceLabel = '') {
      RoleAuthModule.assertTeacherPermission('구글시트 팀 목록 불러오기 및 검증');
      const colMap = { ...this.defaultColumnMap, ...customColumnMap };

      const deduplicatedMap = new Map();
      (rawRows || []).forEach((row, idx) => {
        const sanitized = PrivacyGuardModule.sanitizeSheetRow(row, colMap, idx);
        if (sanitized && sanitized.teamName) {
          const key = `${sanitized.gender}_${sanitized.teamName}`;
          if (!deduplicatedMap.has(key)) {
            deduplicatedMap.set(key, {
              teamId: `TEAM_${String(deduplicatedMap.size + 1).padStart(2, '0')}`,
              teamName: sanitized.teamName,
              gender: sanitized.gender,
              rosterPlayers: sanitized.rosterPlayers || [] // 대표 선수 제외, 선수1~7만 등록된 명단
            });
          }
        }
      });

      const teams = Array.from(deduplicatedMap.values());
      const maleTeams = teams.filter(t => t.gender === '남').map((t, i) => ({
        ...t,
        teamId: `M_TEAM_${i + 1}`,
        divisionOrder: i + 1
      }));
      const femaleTeams = teams.filter(t => t.gender === '여').map((t, i) => ({
        ...t,
        teamId: `F_TEAM_${i + 1}`,
        divisionOrder: i + 1
      }));
      const unknownTeams = teams.filter(t => t.gender !== '남' && t.gender !== '여');

      const isMaleValid = maleTeams.length === 8;
      const isFemaleValid = femaleTeams.length === 4;
      const isValid = isMaleValid && isFemaleValid && unknownTeams.length === 0;

      let message = '';
      let guide = '';
      if (isValid) {
        message = `검증 완료: 남자부 8팀, 여자부 4팀 (총 12팀) 신청이 모두 확인되었습니다!`;
        guide = `우측의 [🎲 남자부 / 여자부 대진 추첨] 버튼을 눌러 각 부문별 토너먼트 대진표를 추첨하세요.`;
      } else if (maleTeams.length === 0 && femaleTeams.length === 0) {
        message = `남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 0, 여 0 (현재 구글시트에 신청한 팀이 없습니다)`;
        guide = `학생들이 구글폼(구글시트)에 신청을 완료한 뒤 [🔄 구글시트에서 팀 불러오기]를 누르면 남자부(8팀)·여자부(4팀) 칸에 자동으로 채워집니다.`;
      } else {
        message = `남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 ${maleTeams.length}, 여 ${femaleTeams.length}`;
        const issues = [];
        if (maleTeams.length !== 8) {
          const diff = 8 - maleTeams.length;
          issues.push(diff > 0 ? `남자부 ${diff}팀 추가 신청 대기 중(현재 ${maleTeams.length}/8팀)` : `남자부 ${Math.abs(diff)}팀 초과(현재 ${maleTeams.length}/8팀)`);
        }
        if (femaleTeams.length !== 4) {
          const diff = 4 - femaleTeams.length;
          issues.push(diff > 0 ? `여자부 ${diff}팀 추가 신청 대기 중(현재 ${femaleTeams.length}/4팀)` : `여자부 ${Math.abs(diff)}팀 초과(현재 ${femaleTeams.length}/4팀)`);
        }
        if (unknownTeams.length > 0) {
          issues.push(`성별 미분류 팀 ${unknownTeams.length}개('남자부' 또는 '여자부'로 표기 필요)`);
        }
        guide = `[신청 현황] ${issues.join(' · ')}`;
      }

      return {
        isValid,
        isMaleValid,
        isFemaleValid,
        sourceLabel,
        totalCount: maleTeams.length + femaleTeams.length,
        maleCount: maleTeams.length,
        femaleCount: femaleTeams.length,
        teams: [...maleTeams, ...femaleTeams],
        maleTeams,
        femaleTeams,
        message,
        guide
      };
    }
  };

  // ==========================================================================
  // 모듈 (4) 대진 생성 모듈 (BracketGeneratorModule - 남자부 8강 / 여자부 4강 분리 생성)
  // ==========================================================================
  const BracketGeneratorModule = {
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
     * 추첨 전 빈 대진표 틀(남자부 8강->4강->결승 7경기 + 여자부 4강->결승 3경기)을 생성합니다.
     */
    createEmptyBracketSkeleton() {
      return [
        // 남자부 8강 (4경기)
        { matchId: 'M_M1', division: '남자부', roundNumber: 1, roundName: '남자부 8강', matchNumber: 1, matchLabel: '남자부 8강 제1경기', teamAId: null, teamBId: null, teamASourceLabel: '남자부 추첨 시드 #1', teamBSourceLabel: '남자부 추첨 시드 #8', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_M5', nextSlot: 'A' },
        { matchId: 'M_M2', division: '남자부', roundNumber: 1, roundName: '남자부 8강', matchNumber: 2, matchLabel: '남자부 8강 제2경기', teamAId: null, teamBId: null, teamASourceLabel: '남자부 추첨 시드 #2', teamBSourceLabel: '남자부 추첨 시드 #7', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_M5', nextSlot: 'B' },
        { matchId: 'M_M3', division: '남자부', roundNumber: 1, roundName: '남자부 8강', matchNumber: 3, matchLabel: '남자부 8강 제3경기', teamAId: null, teamBId: null, teamASourceLabel: '남자부 추첨 시드 #3', teamBSourceLabel: '남자부 추첨 시드 #6', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_M6', nextSlot: 'A' },
        { matchId: 'M_M4', division: '남자부', roundNumber: 1, roundName: '남자부 8강', matchNumber: 4, matchLabel: '남자부 8강 제4경기', teamAId: null, teamBId: null, teamASourceLabel: '남자부 추첨 시드 #4', teamBSourceLabel: '남자부 추첨 시드 #5', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_M6', nextSlot: 'B' },
        // 남자부 4강 (2경기)
        { matchId: 'M_M5', division: '남자부', roundNumber: 2, roundName: '남자부 4강', matchNumber: 5, matchLabel: '남자부 4강 제1경기', teamAId: null, teamBId: null, teamASourceLabel: '남자부 8강 1경기 승자', teamBSourceLabel: '남자부 8강 2경기 승자', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_M7', nextSlot: 'A' },
        { matchId: 'M_M6', division: '남자부', roundNumber: 2, roundName: '남자부 4강', matchNumber: 6, matchLabel: '남자부 4강 제2경기', teamAId: null, teamBId: null, teamASourceLabel: '남자부 8강 3경기 승자', teamBSourceLabel: '남자부 8강 4경기 승자', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_M7', nextSlot: 'B' },
        // 남자부 결승 (1경기)
        { matchId: 'M_M7', division: '남자부', roundNumber: 3, roundName: '남자부 결승', matchNumber: 7, matchLabel: '남자부 대망의 결승전', teamAId: null, teamBId: null, teamASourceLabel: '남자부 4강 1경기 승자', teamBSourceLabel: '남자부 4강 2경기 승자', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: null, nextSlot: null },

        // 여자부 4강 (2경기)
        { matchId: 'M_F1', division: '여자부', roundNumber: 1, roundName: '여자부 4강', matchNumber: 1, matchLabel: '여자부 4강 제1경기', teamAId: null, teamBId: null, teamASourceLabel: '여자부 추첨 시드 #1', teamBSourceLabel: '여자부 추첨 시드 #4', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_F3', nextSlot: 'A' },
        { matchId: 'M_F2', division: '여자부', roundNumber: 1, roundName: '여자부 4강', matchNumber: 2, matchLabel: '여자부 4강 제2경기', teamAId: null, teamBId: null, teamASourceLabel: '여자부 추첨 시드 #2', teamBSourceLabel: '여자부 추첨 시드 #3', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: 'M_F3', nextSlot: 'B' },
        // 여자부 결승 (1경기)
        { matchId: 'M_F3', division: '여자부', roundNumber: 2, roundName: '여자부 결승', matchNumber: 3, matchLabel: '여자부 대망의 결승전', teamAId: null, teamBId: null, teamASourceLabel: '여자부 4강 1경기 승자', teamBSourceLabel: '여자부 4강 2경기 승자', status: '대기', scoreA: 0, scoreB: 0, winnerTeamId: null, nextMatchId: null, nextSlot: null }
      ];
    },

    generateTournament(teams, customSeedValue = null) {
      RoleAuthModule.assertTeacherPermission('시드 추첨 및 남·여 토너먼트 대진 생성');

      if (!Array.isArray(teams) || teams.length !== 12) {
        throw new Error(`토너먼트 대진 생성은 정확히 12팀(남 8, 여 4)이어야 합니다. (현재 ${teams ? teams.length : 0}팀)`);
      }

      const maleTeams = teams.filter(t => t.gender === '남');
      const femaleTeams = teams.filter(t => t.gender === '여');
      if (maleTeams.length !== 8 || femaleTeams.length !== 4) {
        throw new Error(`남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 ${maleTeams.length}, 여 ${femaleTeams.length}`);
      }

      const tournamentId = 'TRN_' + Date.now();
      const seedValue = customSeedValue || `SEED-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      const shuffledMales = this.shuffleWithSeed(maleTeams, seedValue + '_MALE').map((t, idx) => ({
        ...t,
        teamId: t.teamId || `M_TEAM_${idx + 1}`,
        seedNumber: idx + 1,
        division: '남자부'
      }));

      const shuffledFemales = this.shuffleWithSeed(femaleTeams, seedValue + '_FEMALE').map((t, idx) => ({
        ...t,
        teamId: t.teamId || `F_TEAM_${idx + 1}`,
        seedNumber: idx + 1,
        division: '여자부'
      }));

      const maleMatches = [
        {
          matchId: 'M_M1',
          division: '남자부',
          tournamentId,
          roundNumber: 1,
          roundName: '남자부 8강',
          matchNumber: 1,
          matchLabel: '남자부 8강 제1경기',
          teamAId: shuffledMales[0].teamId,
          teamBId: shuffledMales[7].teamId,
          status: '진행',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_M5',
          nextSlot: 'A'
        },
        {
          matchId: 'M_M2',
          division: '남자부',
          tournamentId,
          roundNumber: 1,
          roundName: '남자부 8강',
          matchNumber: 2,
          matchLabel: '남자부 8강 제2경기',
          teamAId: shuffledMales[1].teamId,
          teamBId: shuffledMales[6].teamId,
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_M5',
          nextSlot: 'B'
        },
        {
          matchId: 'M_M3',
          division: '남자부',
          tournamentId,
          roundNumber: 1,
          roundName: '남자부 8강',
          matchNumber: 3,
          matchLabel: '남자부 8강 제3경기',
          teamAId: shuffledMales[2].teamId,
          teamBId: shuffledMales[5].teamId,
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_M6',
          nextSlot: 'A'
        },
        {
          matchId: 'M_M4',
          division: '남자부',
          tournamentId,
          roundNumber: 1,
          roundName: '남자부 8강',
          matchNumber: 4,
          matchLabel: '남자부 8강 제4경기',
          teamAId: shuffledMales[3].teamId,
          teamBId: shuffledMales[4].teamId,
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_M6',
          nextSlot: 'B'
        },
        {
          matchId: 'M_M5',
          division: '남자부',
          tournamentId,
          roundNumber: 2,
          roundName: '남자부 4강',
          matchNumber: 5,
          matchLabel: '남자부 4강 제1경기',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '남자부 8강 1경기 승자',
          teamBSourceLabel: '남자부 8강 2경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_M7',
          nextSlot: 'A'
        },
        {
          matchId: 'M_M6',
          division: '남자부',
          tournamentId,
          roundNumber: 2,
          roundName: '남자부 4강',
          matchNumber: 6,
          matchLabel: '남자부 4강 제2경기',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '남자부 8강 3경기 승자',
          teamBSourceLabel: '남자부 8강 4경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_M7',
          nextSlot: 'B'
        },
        {
          matchId: 'M_M7',
          division: '남자부',
          tournamentId,
          roundNumber: 3,
          roundName: '남자부 결승',
          matchNumber: 7,
          matchLabel: '남자부 대망의 결승전',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '남자부 4강 1경기 승자',
          teamBSourceLabel: '남자부 4강 2경기 승자',
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: null,
          nextSlot: null
        }
      ];

      const femaleMatches = [
        {
          matchId: 'M_F1',
          division: '여자부',
          tournamentId,
          roundNumber: 1,
          roundName: '여자부 4강',
          matchNumber: 1,
          matchLabel: '여자부 4강 제1경기',
          teamAId: shuffledFemales[0].teamId,
          teamBId: shuffledFemales[3].teamId,
          status: '진행',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_F3',
          nextSlot: 'A'
        },
        {
          matchId: 'M_F2',
          division: '여자부',
          tournamentId,
          roundNumber: 1,
          roundName: '여자부 4강',
          matchNumber: 2,
          matchLabel: '여자부 4강 제2경기',
          teamAId: shuffledFemales[1].teamId,
          teamBId: shuffledFemales[2].teamId,
          status: '대기',
          scoreA: 0,
          scoreB: 0,
          winnerTeamId: null,
          nextMatchId: 'M_F3',
          nextSlot: 'B'
        },
        {
          matchId: 'M_F3',
          division: '여자부',
          tournamentId,
          roundNumber: 2,
          roundName: '여자부 결승',
          matchNumber: 3,
          matchLabel: '여자부 대망의 결승전',
          teamAId: null,
          teamBId: null,
          teamASourceLabel: '여자부 4강 1경기 승자',
          teamBSourceLabel: '여자부 4강 2경기 승자',
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
          currentMatchId: 'M_M1'
        },
        seed: {
          tournamentId,
          seedValue,
          maleSeedValue: seedValue + '_MALE',
          femaleSeedValue: seedValue + '_FEMALE'
        },
        teams: [...shuffledMales, ...shuffledFemales],
        maleTeams: shuffledMales,
        femaleTeams: shuffledFemales,
        matches: [...maleMatches, ...femaleMatches]
      };
    }
  };

  // ==========================================================================
  // 모듈 (5) 경기 확정/상태 전이 모듈 (MatchTransitionModule)
  // ==========================================================================
  const MatchTransitionModule = {
    confirmMatchResult(tournamentState, { matchId, scoreA, scoreB, tieBreakerWinnerId = null }) {
      const startTime = performance.now();

      if (!tournamentState || !Array.isArray(tournamentState.matches)) {
        throw new Error('생성된 토너먼트 대진표가 없습니다.');
      }

      const match = tournamentState.matches.find(m => m.matchId === matchId);
      if (!match) {
        throw new Error(`경기(${matchId})를 찾을 수 없습니다.`);
      }

      if (match.status === '확정') {
        throw new Error(`이미 종료 확정된 경기입니다(${match.matchLabel}). 중복 확정은 허용되지 않습니다.`);
      }

      if (!match.teamAId || !match.teamBId) {
        throw new Error(`아직 대진 추첨 전이거나 두 팀이 결정되지 않은 경기입니다(${match.matchLabel}).`);
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

      match.scoreA = parsedA;
      match.scoreB = parsedB;
      match.winnerTeamId = winnerTeamId;
      match.loserTeamId = loserTeamId;
      match.winMethod = winMethod;
      match.status = '확정';
      match.confirmedAt = new Date().toISOString();

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
        advancementText = `🏆 ${match.division} 최종 우승: ${getTeamName(winnerTeamId)}!`;
      }

      const divisionMatches = tournamentState.matches.filter(m => m.division === match.division);
      const nextDivisionActive = divisionMatches.find(m => m.status !== '확정' && m.teamAId && m.teamBId);
      divisionMatches.forEach(m => {
        if (m.status !== '확정') {
          m.status = (nextDivisionActive && m.matchId === nextDivisionActive.matchId) ? '진행' : '대기';
        }
      });

      const anyActive = tournamentState.matches.find(m => m.status === '진행') ||
        tournamentState.matches.find(m => m.status !== '확정' && m.teamAId && m.teamBId);

      if (!tournamentState.tournament) {
        tournamentState.tournament = { tournamentId: 'TRN_' + Date.now(), status: '진행', currentMatchId: null };
      }
      if (anyActive) {
        tournamentState.tournament.currentMatchId = anyActive.matchId;
        tournamentState.tournament.status = '진행';
      } else {
        tournamentState.tournament.currentMatchId = null;
        tournamentState.tournament.status = '종료';
      }

      const elapsedMs = Math.round((performance.now() - startTime) * 100) / 100;

      const summary = {
        matchId: match.matchId,
        division: match.division,
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
        nextMatchLabel: nextRoundMatch ? nextRoundMatch.matchLabel : `${match.division} 최종 우승`,
        nextRoundName: nextRoundMatch ? nextRoundMatch.roundName : '결승 종료(우승)',
        advancementText,
        nextScheduledMatchId: nextDivisionActive ? nextDivisionActive.matchId : (anyActive ? anyActive.matchId : null),
        nextScheduledMatchLabel: nextDivisionActive ? nextDivisionActive.matchLabel : (anyActive ? anyActive.matchLabel : null),
        nextScheduledTeamAName: nextDivisionActive ? getTeamName(nextDivisionActive.teamAId) : (anyActive ? getTeamName(anyActive.teamAId) : null),
        nextScheduledTeamBName: nextDivisionActive ? getTeamName(nextDivisionActive.teamBId) : (anyActive ? getTeamName(anyActive.teamBId) : null),
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
  // 상태 저장소 헬퍼
  // ==========================================================================
  const TournamentStore = {
    state: {
      sheetUrl: DEFAULT_GOOGLE_SHEET_URL,
      validationResult: null,
      tournament: null,
      seed: null,
      teams: [],
      maleTeams: [],
      femaleTeams: [],
      matches: [],
      lastConfirmedSummary: null
    },

    load() {
      try {
        // 이전 버전의 가짜 샘플 캐시가 남아있지 않도록 정리
        localStorage.removeItem('futsal_tournament_v1_state');
        localStorage.removeItem('futsal_tournament_v2_gender_split');

        const raw = localStorage.getItem(TOURNAMENT_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.state = { ...this.state, ...parsed };
        }
      } catch (e) {}
      return this.state;
    },

    save(broadcastType = 'TOURNAMENT_UPDATE') {
      try {
        this.state.updatedAt = Date.now();
        localStorage.setItem(TOURNAMENT_STORAGE_KEY, JSON.stringify(this.state));
        TournamentSyncBus.post(broadcastType, this.state);
      } catch (e) {}
    },

    getTeamName(teamId) {
      if (!teamId) return '미정(대기 중)';
      const found = (this.state.teams || []).find(t => t.teamId === teamId);
      return found ? PrivacyGuardModule.sanitizeTeamName(found.teamName) : '미정';
    },

    getSeedNumber(teamId) {
      const found = (this.state.teams || []).find(t => t.teamId === teamId);
      return found && found.seedNumber ? found.seedNumber : null;
    }
  };

  // ==========================================================================
  // UI 컨트롤러
  // ==========================================================================
  const TournamentAppController = {
    async init() {
      RoleAuthModule.initFromLocation();
      TournamentStore.load();

      // ★ 최초 로드 시 가짜 팀을 임의로 채우지 않고, 구글시트의 실제 상태(현재 0팀이면 남 0/8팀, 여 0/4팀)와 빈 대진표 틀로 시작!
      if (!TournamentStore.state.validationResult) {
        const prevRole = RoleAuthModule.currentRole;
        RoleAuthModule.currentRole = 'teacher';
        TournamentStore.state.validationResult = SheetSyncModule.extractAndValidateTeams([], {}, '구글시트 신청 대기 중');
        TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
        RoleAuthModule.currentRole = prevRole;
      }

      this.bindEvents();
      this.renderAll();

      // 페이지 열릴 때 지정된 구글시트에서 실제 신청 데이터 자동 조회
      if (RoleAuthModule.currentRole === 'teacher') {
        try {
          const sheetUrl = document.getElementById('googleSheetUrlInput')?.value || DEFAULT_GOOGLE_SHEET_URL;
          const liveRes = await SheetSyncModule.fetchFromGoogleSheetUrl(sheetUrl, this.readColumnMapInputs());
          if (liveRes) {
            TournamentStore.state.validationResult = liveRes;
            // 만약 시트에 실제로 신청한 팀이 0팀이면 대진표도 미추첨 빈 대진표 상태로 유지
            if (liveRes.totalCount === 0 && !TournamentStore.state.seed) {
              TournamentStore.state.teams = [];
              TournamentStore.state.maleTeams = [];
              TournamentStore.state.femaleTeams = [];
              TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
            }
            TournamentStore.save();
            this.renderAll();
          }
        } catch (_) {
          // 시트가 비공개이거나 아직 응답이 없으면 0팀 대기 상태 유지
        }
      }

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
      document.getElementById('switchTeacherRoleBtn')?.addEventListener('click', () => {
        RoleAuthModule.setRole('teacher');
        this.renderAll();
      });
      document.getElementById('switchStudentRoleBtn')?.addEventListener('click', () => {
        RoleAuthModule.setRole('student');
        this.renderAll();
      });

      // 구글시트에서 실시간 불러오기
      document.getElementById('fetchGoogleSheetBtn')?.addEventListener('click', async () => {
        const urlInput = document.getElementById('googleSheetUrlInput');
        const csvPasteInput = document.getElementById('googleSheetCsvPasteInput');
        const colMap = this.readColumnMapInputs();

        try {
          if (csvPasteInput && csvPasteInput.value.trim()) {
            const rows = SheetSyncModule.parseCsvText(csvPasteInput.value.trim());
            const res = SheetSyncModule.extractAndValidateTeams(rows, colMap, '붙여넣은 시트 데이터 반영됨');
            TournamentStore.state.validationResult = res;
            if (res.totalCount === 0) {
              TournamentStore.state.seed = null;
              TournamentStore.state.teams = [];
              TournamentStore.state.maleTeams = [];
              TournamentStore.state.femaleTeams = [];
              TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
            }
            TournamentStore.save();
            this.renderAll();
            return;
          }
          const targetUrl = (urlInput && urlInput.value.trim()) || DEFAULT_GOOGLE_SHEET_URL;
          const res = await SheetSyncModule.fetchFromGoogleSheetUrl(targetUrl, colMap);
          TournamentStore.state.validationResult = res;
          if (res.totalCount === 0) {
            TournamentStore.state.seed = null;
            TournamentStore.state.teams = [];
            TournamentStore.state.maleTeams = [];
            TournamentStore.state.femaleTeams = [];
            TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
          }
          TournamentStore.save();
          this.renderAll();
        } catch (err) {
          // 비공개 시트이거나 아직 신청한 팀이 없을 때 0팀 상태로 초기화하여 표시
          const emptyRes = SheetSyncModule.extractAndValidateTeams([], colMap, '구글시트 신청 대기 중');
          TournamentStore.state.validationResult = emptyRes;
          TournamentStore.state.seed = null;
          TournamentStore.state.teams = [];
          TournamentStore.state.maleTeams = [];
          TournamentStore.state.femaleTeams = [];
          TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
          TournamentStore.save();
          this.renderAll();
          alert(err.message);
        }
      });

      // 신청 목록 비우기 (0팀 초기 대기 상태로 복귀)
      document.getElementById('clearSheetTeamsBtn')?.addEventListener('click', () => {
        try {
          const colMap = this.readColumnMapInputs();
          const emptyRes = SheetSyncModule.extractAndValidateTeams([], colMap, '구글시트 신청 대기 중');
          TournamentStore.state.validationResult = emptyRes;
          TournamentStore.state.seed = null;
          TournamentStore.state.teams = [];
          TournamentStore.state.maleTeams = [];
          TournamentStore.state.femaleTeams = [];
          TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
          TournamentStore.save();
          this.renderAll();
        } catch (err) {
          alert(err.message);
        }
      });

      // (선택) 샘플 12팀(남8+여4) 연습용 채우기
      document.getElementById('loadSample12TeamsBtn')?.addEventListener('click', () => {
        try {
          const colMap = this.readColumnMapInputs();
          const res = SheetSyncModule.extractAndValidateTeams(
            SheetSyncModule.SAMPLE_VALID_ROWS,
            colMap,
            '연습용 샘플 12팀(남8+여4)'
          );
          TournamentStore.state.validationResult = res;
          TournamentStore.save();
          this.renderAll();
        } catch (err) {
          alert(err.message);
        }
      });

      // (선택) 부족(남7+여3) 오류 테스트
      document.getElementById('loadInvalidTeamsTestBtn')?.addEventListener('click', () => {
        try {
          const colMap = this.readColumnMapInputs();
          const res = SheetSyncModule.extractAndValidateTeams(
            SheetSyncModule.SAMPLE_INVALID_ROWS,
            colMap,
            '오류 검증용 데이터(남7+여3)'
          );
          TournamentStore.state.validationResult = res;
          TournamentStore.save();
          this.renderAll();
        } catch (err) {
          alert(err.message);
        }
      });

      // 대진 추첨 실행
      const executeDraw = (mode = 'ALL') => {
        try {
          const val = TournamentStore.state.validationResult;
          if (!val || !val.isValid) {
            alert(val ? val.message : '먼저 신청 팀(남자 8팀, 여자 4팀)이 모두 신청되어야 대진 추첨이 가능합니다.');
            return;
          }
          const generated = BracketGeneratorModule.generateTournament(val.teams);

          if (mode === 'MALE_ONLY' && TournamentStore.state.matches && TournamentStore.state.matches.length > 0) {
            const existingFemaleMatches = TournamentStore.state.matches.filter(m => m.division === '여자부');
            const newMaleMatches = generated.matches.filter(m => m.division === '남자부');
            TournamentStore.state.maleTeams = generated.maleTeams;
            TournamentStore.state.teams = [...generated.maleTeams, ...(TournamentStore.state.femaleTeams || generated.femaleTeams)];
            TournamentStore.state.matches = [...newMaleMatches, ...existingFemaleMatches];
            TournamentStore.state.seed = generated.seed;
          } else if (mode === 'FEMALE_ONLY' && TournamentStore.state.matches && TournamentStore.state.matches.length > 0) {
            const existingMaleMatches = TournamentStore.state.matches.filter(m => m.division === '남자부');
            const newFemaleMatches = generated.matches.filter(m => m.division === '여자부');
            TournamentStore.state.femaleTeams = generated.femaleTeams;
            TournamentStore.state.teams = [...(TournamentStore.state.maleTeams || generated.maleTeams), ...generated.femaleTeams];
            TournamentStore.state.matches = [...existingMaleMatches, ...newFemaleMatches];
            TournamentStore.state.seed = generated.seed;
          } else {
            TournamentStore.state.tournament = generated.tournament;
            TournamentStore.state.seed = generated.seed;
            TournamentStore.state.teams = generated.teams;
            TournamentStore.state.maleTeams = generated.maleTeams;
            TournamentStore.state.femaleTeams = generated.femaleTeams;
            TournamentStore.state.matches = generated.matches;
          }

          TournamentStore.state.lastConfirmedSummary = null;
          TournamentStore.save();
          this.renderAll();
        } catch (err) {
          alert(err.message);
        }
      };

      document.getElementById('drawSeedsAndGenerateBtn')?.addEventListener('click', () => executeDraw('ALL'));
      document.getElementById('drawMaleOnlyBtn')?.addEventListener('click', () => executeDraw('MALE_ONLY'));
      document.getElementById('drawFemaleOnlyBtn')?.addEventListener('click', () => executeDraw('FEMALE_ONLY'));

      document.getElementById('copyStudentLinkBtn')?.addEventListener('click', () => {
        const studentUrl = new URL(window.location.href);
        studentUrl.searchParams.set('role', 'student');
        navigator.clipboard?.writeText(studentUrl.toString()).catch(() => {});
        const feedback = document.getElementById('studentLinkCopyFeedback');
        if (feedback) {
          feedback.textContent = `✅ 학생용 대진표 링크 복사 완료: ${studentUrl.toString()}`;
          setTimeout(() => { feedback.textContent = ''; }, 4000);
        }
      });

      const bracketRoot = document.getElementById('tournamentBracketContainer');
      if (bracketRoot) {
        bracketRoot.addEventListener('click', (e) => {
          const confirmBtn = e.target.closest('[data-confirm-match-id]');
          if (confirmBtn) {
            const matchId = confirmBtn.getAttribute('data-confirm-match-id');
            this.handleConfirmMatchFromCard(matchId);
          }
        });
      }

      document.getElementById('exportTournamentJsonBtn')?.addEventListener('click', () => {
        try {
          RoleAuthModule.assertTeacherPermission('대진표 데이터 백업');
          const blob = new Blob([JSON.stringify(TournamentStore.state, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `풋살대회_대진표_백업_${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(err.message);
        }
      });

      document.getElementById('purgeTournamentDataBtn')?.addEventListener('click', () => {
        try {
          RoleAuthModule.assertTeacherPermission('대진표 초기화');
          localStorage.removeItem(TOURNAMENT_STORAGE_KEY);
          TournamentStore.state.validationResult = SheetSyncModule.extractAndValidateTeams([], {}, '구글시트 신청 대기 중');
          TournamentStore.state.tournament = null;
          TournamentStore.state.seed = null;
          TournamentStore.state.teams = [];
          TournamentStore.state.maleTeams = [];
          TournamentStore.state.femaleTeams = [];
          TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
          TournamentStore.state.lastConfirmedSummary = null;
          TournamentStore.save();
          this.renderAll();
        } catch (err) {
          alert(err.message);
        }
      });

      document.getElementById('runAutomatedTestsBtn')?.addEventListener('click', () => {
        const report = TournamentTestSuite.runAll();
        this.renderTestReport(report);
      });

      document.getElementById('closeConfirmResultModalBtn')?.addEventListener('click', () => {
        document.getElementById('tournamentConfirmResultModal')?.classList.add('hidden');
      });

      document.querySelectorAll('[data-policy-modal]').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.openPolicyModal(link.getAttribute('data-policy-modal'));
        });
      });
      document.getElementById('closePolicyDocModalBtn')?.addEventListener('click', () => {
        document.getElementById('policyDocModal')?.classList.add('hidden');
      });
    },

    readColumnMapInputs() {
      return {
        studentName: document.getElementById('colMapName')?.value.trim() || '이름',
        studentId: document.getElementById('colMapStudentId')?.value.trim() || '학번',
        teamName: document.getElementById('colMapTeamName')?.value.trim() || '팀명',
        gender: document.getElementById('colMapGender')?.value.trim() || '성별'
      };
    },

    handleConfirmMatchFromCard(matchId) {
      const m = (TournamentStore.state.matches || []).find(item => item.matchId === matchId);
      if (!m) return;

      const scoreAInput = document.getElementById(`scoreA_input_${matchId}`);
      const scoreBInput = document.getElementById(`scoreB_input_${matchId}`);
      const scoreA = scoreAInput ? parseInt(scoreAInput.value, 10) : m.scoreA;
      const scoreB = scoreBInput ? parseInt(scoreBInput.value, 10) : m.scoreB;

      this.executeMatchConfirm(matchId, scoreA, scoreB);
    },

    executeMatchConfirm(matchId, scoreA, scoreB, tieBreakerWinnerId = null) {
      try {
        const targetMatch = (TournamentStore.state.matches || []).find(m => m.matchId === matchId);
        if (!targetMatch) return null;

        let chosenTieWinner = tieBreakerWinnerId;
        if (scoreA === scoreB && !chosenTieWinner) {
          const teamAName = TournamentStore.getTeamName(targetMatch.teamAId);
          const teamBName = TournamentStore.getTeamName(targetMatch.teamBId);
          const pickA = confirm(
            `현재 점수가 ${scoreA} : ${scoreB} 동점입니다.\n[${targetMatch.matchLabel}] 다음 라운드 진출팀(승부차기 승리)으로 [${teamAName}] 팀을 확정하시겠습니까?\n(취소를 누르면 [${teamBName}] 팀이 진출합니다.)`
          );
          chosenTieWinner = pickA ? targetMatch.teamAId : targetMatch.teamBId;
        }

        const { resultSummary } = MatchTransitionModule.confirmMatchResult(
          TournamentStore.state,
          { matchId, scoreA, scoreB, tieBreakerWinnerId: chosenTieWinner }
        );

        TournamentStore.state.lastConfirmedSummary = resultSummary;
        TournamentStore.save('MATCH_CONFIRMED_EVENT');

        this.renderAll();
        this.showConfirmResultModal(resultSummary);
        return resultSummary;
      } catch (err) {
        alert(err.message);
        return null;
      }
    },

    showConfirmResultModal(summary) {
      const modal = document.getElementById('tournamentConfirmResultModal');
      if (!modal || !summary) return;

      document.getElementById('confirmModalRoundBadge').textContent =
        `${summary.division} • ${summary.matchLabel} 확정 완료 (${summary.responseTimeMs}ms)`;
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
        `🎉 [${summary.division}] ${summary.winnerTeamName} 승리! (${summary.winMethod})`;
      document.getElementById('confirmModalAdvancementText').textContent =
        `🚀 다음 라운드 진출자: ${summary.advancementText}`;

      const nextMatchGuide = document.getElementById('confirmModalNextMatchGuide');
      if (nextMatchGuide) {
        if (summary.nextScheduledMatchId) {
          nextMatchGuide.innerHTML =
            `⏭️ <strong>다음 진행 경기로 자동 이동됨:</strong> [${summary.nextScheduledMatchLabel}] <strong>${summary.nextScheduledTeamAName}</strong> vs <strong>${summary.nextScheduledTeamBName}</strong>`;
        } else {
          nextMatchGuide.innerHTML =
            `🏁 <strong>모든 경기가 종료 확정되었습니다!</strong>`;
        }
      }

      modal.classList.remove('hidden');
    },

    renderAll() {
      const isTeacher = RoleAuthModule.currentRole === 'teacher';

      const roleIndicator = document.getElementById('currentRoleIndicatorBadge');
      if (roleIndicator) {
        roleIndicator.textContent = isTeacher ? '👨‍🏫 교사(운영자) 화면' : '🙋‍♂️ 학생(참관/확인자) 화면';
        roleIndicator.className = 'role-indicator-pill ' + (isTeacher ? 'role-teacher' : 'role-student');
      }

      document.getElementById('switchTeacherRoleBtn')?.classList.toggle('active-role-btn', isTeacher);
      document.getElementById('switchStudentRoleBtn')?.classList.toggle('active-role-btn', !isTeacher);

      document.querySelectorAll('.teacher-only-section').forEach(el => {
        el.style.display = isTeacher ? '' : 'none';
      });

      this.renderOrganizedTeamsAndDrawConsole();
      this.renderRecentBanner();
      this.renderSeparateGenderBrackets();
      this.renderTeacherProgressDashboard();
    },

    renderOrganizedTeamsAndDrawConsole() {
      const val = TournamentStore.state.validationResult;
      const statusBox = document.getElementById('teamValidationStatusBox');
      const maleListEl = document.getElementById('maleTeamsOrganizedList');
      const femaleListEl = document.getElementById('femaleTeamsOrganizedList');
      const maleCountBadge = document.getElementById('maleTeamCountBadge');
      const femaleCountBadge = document.getElementById('femaleTeamCountBadge');
      const drawSummaryEl = document.getElementById('drawnMatchupsSummaryBox');

      const drawAllBtn = document.getElementById('drawSeedsAndGenerateBtn');
      const drawMaleBtn = document.getElementById('drawMaleOnlyBtn');
      const drawFemaleBtn = document.getElementById('drawFemaleOnlyBtn');

      if (!val) return;

      if (statusBox) {
        statusBox.className = 'validation-alert-box ' + (val.isValid ? 'valid' : (val.totalCount === 0 ? 'neutral' : 'invalid'));
        statusBox.innerHTML = `
          <div class="val-title">${val.isValid ? '✅' : (val.totalCount === 0 ? '📋' : '⚠️')} ${val.message}</div>
          <div class="val-guide">${val.guide}</div>
        `;
      }

      if (drawAllBtn) drawAllBtn.disabled = !val.isValid;
      if (drawMaleBtn) drawMaleBtn.disabled = !val.isValid;
      if (drawFemaleBtn) drawFemaleBtn.disabled = !val.isValid;

      if (maleCountBadge) {
        maleCountBadge.textContent = `${val.maleCount} / 8팀`;
        maleCountBadge.className = 'division-count-pill ' + (val.maleCount === 8 ? 'count-ok' : 'count-warn');
      }
      if (femaleCountBadge) {
        femaleCountBadge.textContent = `${val.femaleCount} / 4팀`;
        femaleCountBadge.className = 'division-count-pill ' + (val.femaleCount === 4 ? 'count-ok' : 'count-warn');
      }

      if (maleListEl) {
        const seededMales = TournamentStore.state.maleTeams || [];
        const slotsHtml = [];
        for (let i = 0; i < 8; i++) {
          const team = val.maleTeams[i];
          if (team) {
            const seeded = seededMales.find(s => s.teamName === team.teamName);
            const seedTag = seeded ? `<span class="slot-seed-badge">추첨 시드 #${seeded.seedNumber}</span>` : `<span class="slot-seed-badge unseeded">추첨 대기</span>`;
            slotsHtml.push(`
              <li class="organized-team-slot filled-slot">
                <span class="slot-index">남자 ${i + 1}팀</span>
                <strong class="slot-team-name">${PrivacyGuardModule.sanitizeTeamName(team.teamName)}</strong>
                ${seedTag}
              </li>
            `);
          } else {
            slotsHtml.push(`
              <li class="organized-team-slot empty-slot">
                <span class="slot-index">남자 ${i + 1}팀</span>
                <span class="slot-team-name">신청 대기 중...</span>
                <span class="slot-seed-badge unseeded">미신청</span>
              </li>
            `);
          }
        }
        maleListEl.innerHTML = slotsHtml.join('');
      }

      if (femaleListEl) {
        const seededFemales = TournamentStore.state.femaleTeams || [];
        const slotsHtml = [];
        for (let i = 0; i < 4; i++) {
          const team = val.femaleTeams[i];
          if (team) {
            const seeded = seededFemales.find(s => s.teamName === team.teamName);
            const seedTag = seeded ? `<span class="slot-seed-badge female-seed">추첨 시드 #${seeded.seedNumber}</span>` : `<span class="slot-seed-badge unseeded">추첨 대기</span>`;
            slotsHtml.push(`
              <li class="organized-team-slot filled-slot female-slot">
                <span class="slot-index">여자 ${i + 1}팀</span>
                <strong class="slot-team-name">${PrivacyGuardModule.sanitizeTeamName(team.teamName)}</strong>
                ${seedTag}
              </li>
            `);
          } else {
            slotsHtml.push(`
              <li class="organized-team-slot empty-slot">
                <span class="slot-index">여자 ${i + 1}팀</span>
                <span class="slot-team-name">신청 대기 중...</span>
                <span class="slot-seed-badge unseeded">미신청</span>
              </li>
            `);
          }
        }
        femaleListEl.innerHTML = slotsHtml.join('');
      }

      if (drawSummaryEl) {
        const matches = TournamentStore.state.matches || [];
        const maleR1 = matches.filter(m => m.division === '남자부' && m.roundNumber === 1 && m.teamAId && m.teamBId);
        const femaleR1 = matches.filter(m => m.division === '여자부' && m.roundNumber === 1 && m.teamAId && m.teamBId);

        if (maleR1.length === 0 && femaleR1.length === 0) {
          drawSummaryEl.innerHTML = `
            <div class="empty-draw-msg">
              <strong>🎲 대진 추첨 대기 중</strong><br>
              구글시트에 남자부 8팀, 여자부 4팀 신청이 완료되면 위 추첨 버튼이 활성화되며, 추첨 시 남자부 8강(4경기)·여자부 4강(2경기) 대진 결과가 여기에 표시됩니다.
            </div>
          `;
        } else {
          drawSummaryEl.innerHTML = `
            <div class="draw-result-columns">
              <div class="draw-result-group">
                <div class="draw-group-title male-title">🟦 남자부 8강 대진 추첨 결과 (8팀)</div>
                <ul class="draw-matchup-list">
                  ${maleR1.map(m => `
                    <li>
                      <span class="dm-label">${m.matchLabel}</span>
                      <strong>${TournamentStore.getTeamName(m.teamAId)}</strong>
                      <span class="dm-vs">VS</span>
                      <strong>${TournamentStore.getTeamName(m.teamBId)}</strong>
                    </li>
                  `).join('')}
                </ul>
              </div>
              <div class="draw-result-group">
                <div class="draw-group-title female-title">🟥 여자부 4강 대진 추첨 결과 (4팀)</div>
                <ul class="draw-matchup-list">
                  ${femaleR1.map(m => `
                    <li>
                      <span class="dm-label">${m.matchLabel}</span>
                      <strong>${TournamentStore.getTeamName(m.teamAId)}</strong>
                      <span class="dm-vs">VS</span>
                      <strong>${TournamentStore.getTeamName(m.teamBId)}</strong>
                    </li>
                  `).join('')}
                </ul>
              </div>
            </div>
          `;
        }
      }
    },

    renderRecentBanner() {
      const banner = document.getElementById('currentTournamentMatchBanner');
      if (!banner) return;

      const lastSummary = TournamentStore.state.lastConfirmedSummary;
      if (!lastSummary) {
        banner.innerHTML = '';
        return;
      }

      banner.innerHTML = `
        <div class="recent-confirmed-strip">
          <span class="strip-tag">최근 경기 확정 결과</span>
          <span><strong>[${lastSummary.matchLabel}]</strong> ${lastSummary.teamAName} <strong>${lastSummary.scoreA} : ${lastSummary.scoreB}</strong> ${lastSummary.teamBName}</span>
          <span class="strip-winner">🏆 ${lastSummary.winnerTeamName} 승리</span>
          <span class="strip-advance">🚀 ${lastSummary.advancementText}</span>
        </div>
      `;
    },

    renderSeparateGenderBrackets() {
      const container = document.getElementById('tournamentBracketContainer');
      const seedBadge = document.getElementById('currentTournamentSeedBadge');
      if (!container) return;

      if (!TournamentStore.state.matches || TournamentStore.state.matches.length === 0) {
        TournamentStore.state.matches = BracketGeneratorModule.createEmptyBracketSkeleton();
      }
      const matches = TournamentStore.state.matches;

      if (seedBadge) {
        seedBadge.textContent = TournamentStore.state.seed
          ? `추첨 코드: ${TournamentStore.state.seed.seedValue} (남자부 8팀 · 여자부 4팀)`
          : '대진 추첨 대기 중 (남자부 8강 · 여자부 4강)';
      }

      const maleMatches = matches.filter(m => m.division === '남자부');
      const femaleMatches = matches.filter(m => m.division === '여자부');

      const maleRounds = [
        { roundNumber: 1, title: '남자부 8강 (1라운드 · 4경기)', subtitle: '남자 8팀 대진 · 승자 남자부 4강 진출' },
        { roundNumber: 2, title: '남자부 4강 (준결승 · 2경기)', subtitle: '8강 승자 대결 · 승자 결승 진출' },
        { roundNumber: 3, title: '남자부 결승전 (최종 1경기)', subtitle: '남자부 최종 우승팀 결정전' }
      ];

      const femaleRounds = [
        { roundNumber: 1, title: '여자부 4강 (1라운드 · 2경기)', subtitle: '여자 4팀 대진 · 승자 여자부 결승 진출' },
        { roundNumber: 2, title: '여자부 결승전 (최종 1경기)', subtitle: '여자부 최종 우승팀 결정전' }
      ];

      const maleColsHtml = maleRounds.map(r => {
        const rMatches = maleMatches.filter(m => m.roundNumber === r.roundNumber);
        return `
          <div class="bracket-round-col male-round-col">
            <div class="bracket-round-header">
              <h4>${r.title}</h4>
              <span>${r.subtitle}</span>
            </div>
            <div class="bracket-matches-list">
              ${rMatches.map(m => this.createMatchCardHtml(m)).join('')}
            </div>
          </div>
        `;
      }).join('');

      const femaleColsHtml = femaleRounds.map(r => {
        const rMatches = femaleMatches.filter(m => m.roundNumber === r.roundNumber);
        return `
          <div class="bracket-round-col female-round-col">
            <div class="bracket-round-header">
              <h4>${r.title}</h4>
              <span>${r.subtitle}</span>
            </div>
            <div class="bracket-matches-list">
              ${rMatches.map(m => this.createMatchCardHtml(m)).join('')}
            </div>
          </div>
        `;
      }).join('');

      const maleFinal = maleMatches.find(m => m.matchId === 'M_M7');
      const femaleFinal = femaleMatches.find(m => m.matchId === 'M_F3');
      const maleChamp = maleFinal && maleFinal.winnerTeamId ? `🏆 남자부 우승: ${TournamentStore.getTeamName(maleFinal.winnerTeamId)}` : (TournamentStore.state.seed ? '경기 진행 중' : '대진 추첨 대기');
      const femaleChamp = femaleFinal && femaleFinal.winnerTeamId ? `🏆 여자부 우승: ${TournamentStore.getTeamName(femaleFinal.winnerTeamId)}` : (TournamentStore.state.seed ? '경기 진행 중' : '대진 추첨 대기');

      container.innerHTML = `
        <!-- 1. 남자부 토너먼트 대진표 (8팀) -->
        <div class="division-bracket-block male-bracket-block">
          <div class="division-bracket-banner male-banner">
            <div>
              <span class="div-badge male-badge">MEN'S DIVISION (8 TEAMS)</span>
              <h3>🟦 남자부 토너먼트 대진표 (8강 → 4강 → 결승)</h3>
            </div>
            <span class="div-champ-status">${maleChamp}</span>
          </div>
          <div class="bracket-three-columns-grid">
            ${maleColsHtml}
          </div>
        </div>

        <!-- 2. 여자부 토너먼트 대진표 (4팀) -->
        <div class="division-bracket-block female-bracket-block">
          <div class="division-bracket-banner female-banner">
            <div>
              <span class="div-badge female-badge">WOMEN'S DIVISION (4 TEAMS)</span>
              <h3>🟥 여자부 토너먼트 대진표 (4강 → 결승)</h3>
            </div>
            <span class="div-champ-status">${femaleChamp}</span>
          </div>
          <div class="bracket-two-columns-grid">
            ${femaleColsHtml}
          </div>
        </div>
      `;
    },

    createMatchCardHtml(m) {
      const teamAName = m.teamAId ? TournamentStore.getTeamName(m.teamAId) : (m.teamASourceLabel || '추첨 대기');
      const teamBName = m.teamBId ? TournamentStore.getTeamName(m.teamBId) : (m.teamBSourceLabel || '추첨 대기');
      const seedA = m.teamAId ? TournamentStore.getSeedNumber(m.teamAId) : null;
      const seedB = m.teamBId ? TournamentStore.getSeedNumber(m.teamBId) : null;

      const isReady = Boolean(m.teamAId && m.teamBId);
      const isConfirmed = m.status === '확정';
      const isInProgress = m.status === '진행' && isReady;

      let statusBadgeHtml = '';
      if (isConfirmed) {
        statusBadgeHtml = `<span class="m-status-pill status-confirmed">✅ 확정 완료</span>`;
      } else if (isInProgress) {
        statusBadgeHtml = `<span class="m-status-pill status-live">🔥 진행 중</span>`;
      } else {
        statusBadgeHtml = `<span class="m-status-pill status-waiting">⏳ 대기</span>`;
      }

      const isAWinner = isConfirmed && m.winnerTeamId === m.teamAId;
      const isBWinner = isConfirmed && m.winnerTeamId === m.teamBId;

      let advancementFooterHtml = '';
      if (isConfirmed) {
        const winnerName = TournamentStore.getTeamName(m.winnerTeamId);
        const loserName = TournamentStore.getTeamName(m.loserTeamId);
        const nextMatch = m.nextMatchId
          ? (TournamentStore.state.matches || []).find(nx => nx.matchId === m.nextMatchId)
          : null;
        const nextDesc = nextMatch
          ? `${nextMatch.roundName} [${nextMatch.matchLabel}] 진출`
          : `🏆 ${m.division} 최종 우승!`;

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
            ${m.roundNumber === 1 ? '대진 추첨 완료 시 팀명이 배정됩니다.' : '이전 라운드 경기 확정 시 진출팀이 자동으로 채워집니다.'}
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
                <span class="slot-letter">${seedA ? '#' + seedA : 'A'}</span>
                <span class="t-name">${teamAName}</span>
                ${isAWinner ? '<span class="win-crown">🏆 승리</span>' : ''}
              </div>
              <span class="t-score">${isConfirmed ? m.scoreA : '-'}</span>
            </div>

            <div class="match-team-row ${isBWinner ? 'row-winner' : ''} ${!m.teamBId ? 'row-tbd' : ''}">
              <div class="team-name-cell">
                <span class="slot-letter">${seedB ? '#' + seedB : 'B'}</span>
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
      const inProgressCount = matches.filter(m => m.status === '진행' && m.teamAId && m.teamBId).length;
      const waitingCount = matches.length - confirmedCount - inProgressCount;

      if (summaryStats) {
        summaryStats.textContent = `전체 ${matches.length}경기 (남자부 7경기 + 여자부 3경기) 중 확정 ${confirmedCount} / 진행 ${inProgressCount} / 대기 ${waitingCount}`;
      }

      tbody.innerHTML = matches.map(m => {
        const tA = m.teamAId ? TournamentStore.getTeamName(m.teamAId) : (m.teamASourceLabel || '추첨 대기');
        const tB = m.teamBId ? TournamentStore.getTeamName(m.teamBId) : (m.teamBSourceLabel || '추첨 대기');
        const isConfirmed = m.status === '확정';
        const isReady = Boolean(m.teamAId && m.teamBId);
        const statusText = isConfirmed ? '확정' : (m.status === '진행' && isReady ? '진행' : '대기');
        const winnerName = isConfirmed ? TournamentStore.getTeamName(m.winnerTeamId) : '-';
        const scoreStr = isConfirmed ? `${m.scoreA} : ${m.scoreB}` : '-';
        const nextTarget = m.nextMatchId ? `${m.nextMatchId}(${m.nextSlot}슬롯)` : `${m.division} 최종 우승`;

        return `
          <tr class="${statusText === '진행' ? 'dash-row-live' : ''} ${isConfirmed ? 'dash-row-done' : ''}">
            <td><span class="gender-tag ${m.division === '남자부' ? 'gender-m' : 'gender-f'}">${m.division}</span> <strong>${m.matchLabel}</strong></td>
            <td>${tA} vs ${tB}</td>
            <td><span class="m-status-pill ${isConfirmed ? 'status-confirmed' : (statusText === '진행' ? 'status-live' : 'status-waiting')}">${statusText}</span></td>
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
        title.textContent = '개인정보 처리방침 (초안)';
        body.innerHTML = `
          <div class="policy-doc-content">
            <h4>1. 처리 목적</h4>
            <p>풋살대회 신청 팀(남자부 8팀, 여자부 4팀) 정리, 대진 추첨 및 경기 결과 확정을 목적으로 합니다.</p>
            <h4>2. 처리 항목 및 화면 노출 원칙</h4>
            <p>구글시트에 이름·학번이 있더라도 화면에는 오직 <strong>팀명</strong>만 노출합니다.</p>
            <h4>3. 보유 기간 및 책임자</h4>
            <p>보유 기간: <mark>(선생님 확인 필요)</mark> / 책임자 및 담당부서: <mark>(선생님 확인 필요)</mark></p>
          </div>
        `;
      } else if (type === 'terms') {
        title.textContent = '이용약관 (초안)';
        body.innerHTML = `
          <div class="policy-doc-content">
            <h4>제1조 (목적)</h4>
            <p>본 서비스는 교내 풋살대회 대진표 생성 및 경기 결과 확인을 지원하는 교육용 무료 웹 서비스입니다.</p>
          </div>
        `;
      } else {
        title.textContent = '문의/담당자 · 기관명 · 시행일';
        body.innerHTML = `
          <div class="policy-doc-content">
            <ul>
              <li><strong>기관명:</strong> <mark>(선생님 확인 필요)</mark></li>
              <li><strong>문의/담당자:</strong> <mark>(선생님 확인 필요)</mark></li>
              <li><strong>시행일/변경일:</strong> 2026-11-06</li>
            </ul>
          </div>
        `;
      }
      modal.classList.remove('hidden');
    }
  };

  // ==========================================================================
  // 필수 테스트 기준 4종 자동 검증 스위트
  // ==========================================================================
  const TournamentTestSuite = {
    runAll() {
      const results = [];
      const prevRole = RoleAuthModule.currentRole;

      try {
        RoleAuthModule.currentRole = 'teacher';
        const validCheck = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_VALID_ROWS);
        const invalidCheck = SheetSyncModule.extractAndValidateTeams(SheetSyncModule.SAMPLE_INVALID_ROWS);
        const test1Pass = validCheck.isValid === true &&
          validCheck.maleCount === 8 &&
          validCheck.femaleCount === 4 &&
          invalidCheck.isValid === false &&
          invalidCheck.message.includes('남자 8팀, 여자 4팀이 필요합니다. 현재 남/여 팀 수: 남 7, 여 3');

        results.push({
          name: '1) 팀 검증 테스트 (남자부 8팀, 여자부 4팀 정리 및 검증)',
          passed: test1Pass,
          detail: test1Pass
            ? `정상 데이터(남8, 여4) 통과 및 부족 데이터("${invalidCheck.message}") 오류 차단 확인`
            : '팀 수 검증 실패'
        });

        const gen = BracketGeneratorModule.generateTournament(validCheck.teams, 'TEST-SEED-2026');
        const maleR1Teams = gen.matches.filter(m => m.division === '남자부' && m.roundNumber === 1).flatMap(m => [m.teamAId, m.teamBId]);
        const femaleR1Teams = gen.matches.filter(m => m.division === '여자부' && m.roundNumber === 1).flatMap(m => [m.teamAId, m.teamBId]);
        const uniqueTeams = new Set([...maleR1Teams, ...femaleR1Teams].filter(Boolean));
        const test2Pass = gen.maleTeams.length === 8 &&
          gen.femaleTeams.length === 4 &&
          uniqueTeams.size === 12 &&
          gen.matches.length === 10;

        results.push({
          name: '2) 대진 생성 테스트 (남자부 8강[7경기] + 여자부 4강[3경기] 분리 생성 및 12팀 누락 없음)',
          passed: test2Pass,
          detail: test2Pass
            ? `남자부 8팀(7경기) + 여자부 4팀(3경기) = 고유 ${uniqueTeams.size}팀 전원 누락 없이 배정 완료`
            : '대진 연결 누락 발생'
        });

        const confirmOut = MatchTransitionModule.confirmMatchResult(gen, {
          matchId: 'M_M1',
          scoreA: 3,
          scoreB: 1
        });
        const m5After = gen.matches.find(m => m.matchId === 'M_M5');
        const m2After = gen.matches.find(m => m.matchId === 'M_M2');
        let duplicateBlocked = false;
        try {
          MatchTransitionModule.confirmMatchResult(gen, { matchId: 'M_M1', scoreA: 2, scoreB: 0 });
        } catch (_) {
          duplicateBlocked = true;
        }
        const test3Pass = confirmOut.resultSummary.responseTimeMs < 5000 &&
          m5After.teamAId === confirmOut.resultSummary.winnerTeamId &&
          m2After.status === '진행' &&
          duplicateBlocked;

        results.push({
          name: '3) 경기 확정 테스트 (5초 이내 표시, 중복 확정 방지, 다음 라운드 진출 및 다음 경기 이동)',
          passed: test3Pass,
          detail: test3Pass
            ? `응답 속도 ${confirmOut.resultSummary.responseTimeMs}ms, 승자(${confirmOut.resultSummary.winnerTeamName}) 남자부 4강(M_M5) 진출, M_M2 '진행' 자동 전이 완료`
            : '경기 확정 전이 오류'
        });

        RoleAuthModule.currentRole = 'student';
        let studentBlocked = false;
        try {
          BracketGeneratorModule.generateTournament(validCheck.teams);
        } catch (authErr) {
          studentBlocked = authErr.message.includes('권한 차단');
        }
        results.push({
          name: '4) 권한 테스트 (학생 화면에서 대진 추첨/생성 호출 차단)',
          passed: studentBlocked,
          detail: studentBlocked
            ? '학생 권한에서 대진 추첨 호출 시 RoleAuthModule이 즉시 차단 완료'
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
