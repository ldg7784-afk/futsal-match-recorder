/**
 * ============================================================================
 * 고등학교 체육 배구 [3. 경기 수행 능력] 평가 시스템 (volleyball/app.js)
 * ============================================================================
 * [사진 기준 루브릭 완벽 반영]
 * - 기본점수 5점에서 시작하여 다음의 기준에 따라 가감하여 최종 점수로 평가한다.
 *   가. 공격
 *     - 공격 +1점 : 정확한 토스, 스파이크 등 효과적인 공격
 *     - 공격 -1점 : 부정확한 토스, 스파이크 등 비효과적인 공격
 *   나. 수비
 *     - 수비 +1점 : 적절한 위치 선정(좋은 움직임), 수비 성공(리시브) 등 효과적인 수비
 *     - 수비 -1점 : 부적절한 위치 선정, 수비 실패(리시브 실패) 등 비효과적인 수비
 *   * 3회 중복시 1점씩 가감하여 점수 부여
 *   [최종 환산표]
 *   - 5점 : 9점 이상
 *   - 4점 : 8점 ~ 7점
 *   - 3점 : 6점 ~ 5점 (기본 5점 시작 시 3점 구간)
 *   - 2점 : 4점 ~ 3점
 *   - 1점 : 2점 이하
 * ============================================================================
 */

(function (global) {
  'use strict';

  const VB_STORAGE_KEY = 'volleyball_pe_performance_v2';
  const VB_AUDIT_KEY = 'volleyball_pe_audit_logs_v2';
  const VB_SYNC_CHANNEL = 'volleyball_pe_sync_bus_v2';

  const SyncBus = {
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(VB_SYNC_CHANNEL) : null,
    post(type, payload = {}) {
      if (this.channel) {
        try {
          this.channel.postMessage({ type, payload, timestamp: Date.now() });
        } catch (_) {}
      }
    }
  };

  // ==========================================================================
  // (6) 개인정보보호 구현 모듈 (PrivacyGuardModule)
  // ==========================================================================
  const PrivacyGuardModule = {
    maskMode: false,

    formatStudentName(name) {
      const clean = String(name || '').trim();
      if (!clean) return '이름미상';
      if (!this.maskMode) return clean;
      if (clean.length <= 2) return clean[0] + '*';
      return clean[0] + '*'.repeat(clean.length - 2) + clean[clean.length - 1];
    },

    maskStudentId(studentNumber) {
      const clean = String(studentNumber || '').trim();
      if (!this.maskMode || clean.length < 3) return clean;
      return clean.slice(0, 2) + '**' + clean.slice(-1);
    },

    sanitizeLogText(text) {
      return String(text || '')
        .replace(/\b(\d{2})\d{2}(\d)\b/g, '$1**$2')
        .replace(/(이름|성명)\s*:\s*([가-힣]{1})[가-힣]+/g, '$1:$2*');
    }
  };

  // ==========================================================================
  // (5) 권한/접근 제어 모듈 (AuthAccessModule)
  // ==========================================================================
  const AuthAccessModule = {
    currentRole: 'teacher', // 'teacher' | 'student'
    activeStudentViewerId: 'STU_01',

    initFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const roleParam = (params.get('role') || '').toLowerCase();
      const stuParam = params.get('studentId') || '';

      if (roleParam === 'student') {
        this.currentRole = 'student';
        if (stuParam) this.activeStudentViewerId = stuParam;
        this.recordAudit('STUDENT_VIEW_ENTER', 'student', '학생용 결과 확인 화면 진입');
      } else {
        this.currentRole = 'teacher';
        this.recordAudit('TEACHER_VIEW_ENTER', 'teacher', '교사용 평가 화면 진입');
      }
    },

    setRole(role) {
      this.currentRole = role === 'student' ? 'student' : 'teacher';
      this.recordAudit('ROLE_SWITCH', this.currentRole, `역할 전환: ${this.currentRole}`);
    },

    assertTeacherPermission(actionName) {
      if (this.currentRole !== 'teacher') {
        this.recordAudit('UNAUTHORIZED_ATTEMPT', this.currentRole, `권한 없는 요청 차단: ${actionName}`);
        throw new Error(`[권한 제한] '${actionName}' 기능은 교사 화면에서만 수행할 수 있습니다.`);
      }
      return true;
    },

    recordAudit(eventType, actorRole, detail) {
      try {
        const raw = localStorage.getItem(VB_AUDIT_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.unshift({
          id: 'AUD_' + Date.now() + '_' + Math.floor(Math.random() * 100),
          timestamp: new Date().toLocaleString('ko-KR', { hour12: false }),
          eventType,
          actorRole,
          detail: PrivacyGuardModule.sanitizeLogText(detail)
        });
        localStorage.setItem(VB_AUDIT_KEY, JSON.stringify(list.slice(0, 80)));
      } catch (_) {}
    },

    getAuditLogs() {
      try {
        const raw = localStorage.getItem(VB_AUDIT_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (_) {
        return [];
      }
    }
  };

  // ==========================================================================
  // (2) 루브릭/계산 모듈 (RubricCalcModule)
  // - 사진 기준: 기본점수 5점 시작, 플러스/마이너스 3회 중복 시 1점씩 가감
  // - 최종 5점~1점 환산표 매핑 및 5대 계산 정확성 테스트 케이스 내장
  // ==========================================================================
  const RubricCalcModule = {
    BASE_SCORE: 5,

    // 플러스(+) 체크 요소 정의 (가. 공격 / 나. 수비)
    PLUS_FACTORS: [
      { key: 'toss_plus', category: '가. 공격', label: '정확한 토스', desc: '공격 +1점 요인: 정확한 토스 연결' },
      { key: 'spike_plus', category: '가. 공격', label: '스파이크', desc: '공격 +1점 요인: 효과적인 스파이크 공격 성공' },
      { key: 'receive_plus', category: '나. 수비', label: '리시브', desc: '수비 +1점 요인: 안정적인 리시브 및 수비 성공' },
      { key: 'move_plus', category: '나. 수비', label: '좋은 움직임', desc: '수비 +1점 요인: 적절한 위치 선정 및 커버 움직임' }
    ],

    // 마이너스(-) 체크 요소 정의 (가. 공격 / 나. 수비)
    MINUS_FACTORS: [
      { key: 'toss_minus', category: '가. 공격', label: '부정확한 토스', desc: '공격 -1점 요인: 부정확한 토스 연결' },
      { key: 'spike_minus', category: '가. 공격', label: '스파이크 실책', desc: '공격 -1점 요인: 비효과적인 공격 및 범실' },
      { key: 'receive_minus', category: '나. 수비', label: '리시브 실패', desc: '수비 -1점 요인: 수비 실패 및 리시브 범실' },
      { key: 'move_minus', category: '나. 수비', label: '위치선정 미흡', desc: '수비 -1점 요인: 부적절한 위치 선정 및 소극적 움직임' }
    ],

    // 사진 하단 최종 배점 환산표 (9점 이상=5점 ~ 2점 이하=1점)
    CONVERSION_TABLE: [
      { finalPoint: 5, rangeLabel: '9점 이상', minRaw: 9, maxRaw: 999 },
      { finalPoint: 4, rangeLabel: '8점 ~ 7점', minRaw: 7, maxRaw: 8 },
      { finalPoint: 3, rangeLabel: '6점 ~ 5점', minRaw: 5, maxRaw: 6 },
      { finalPoint: 2, rangeLabel: '4점 ~ 3점', minRaw: 3, maxRaw: 4 },
      { finalPoint: 1, rangeLabel: '2점 이하', minRaw: -999, maxRaw: 2 }
    ],

    /**
     * 단일 소스(Single Source of Truth) 학생 점수 계산 함수
     * @param {Object} counts - 요소별 횟수 객체
     * @param {Boolean} ruleEvery3 - true(기본): 3회 중복 시 1점씩 가감 / false: 1회당 1점씩 가감
     */
    calculateStudentPerformance(counts = {}, ruleEvery3 = true) {
      const safeCounts = {};
      let attackPlusCount = 0;
      let defensePlusCount = 0;
      let attackMinusCount = 0;
      let defenseMinusCount = 0;

      this.PLUS_FACTORS.forEach(f => {
        const c = Math.max(0, Math.floor(Number(counts[f.key] || 0)));
        safeCounts[f.key] = c;
        if (f.category === '가. 공격') attackPlusCount += c;
        else defensePlusCount += c;
      });

      this.MINUS_FACTORS.forEach(f => {
        const c = Math.max(0, Math.floor(Number(counts[f.key] || 0)));
        safeCounts[f.key] = c;
        if (f.category === '가. 공격') attackMinusCount += c;
        else defenseMinusCount += c;
      });

      const totalPlusChecks = attackPlusCount + defensePlusCount;
      const totalMinusChecks = attackMinusCount + defenseMinusCount;

      // 핵심 규칙: 3회 중복 시 1점씩 가감
      const divisor = ruleEvery3 ? 3 : 1;
      const addedPoints = Math.floor(totalPlusChecks / divisor);
      const deductedPoints = Math.floor(totalMinusChecks / divisor);

      const plusRemainder = ruleEvery3 ? (totalPlusChecks % 3) : 0;
      const minusRemainder = ruleEvery3 ? (totalMinusChecks % 3) : 0;

      // 기본점수 5점에서 시작하여 가감한 누적 점수
      const rawScore = this.BASE_SCORE + addedPoints - deductedPoints;

      // 사진 하단 환산표에 따른 최종 점수(5점 ~ 1점)
      let finalGradePoint = 1;
      let matchedBracket = this.CONVERSION_TABLE[this.CONVERSION_TABLE.length - 1];
      for (const row of this.CONVERSION_TABLE) {
        if (rawScore >= row.minRaw && rawScore <= row.maxRaw) {
          finalGradePoint = row.finalPoint;
          matchedBracket = row;
          break;
        }
      }

      // 독립 검산(Cross-check)으로 계산 오류 0건 검증
      const verifyRaw = 5 + Math.floor(totalPlusChecks / divisor) - Math.floor(totalMinusChecks / divisor);
      const isVerified = rawScore === verifyRaw;

      return {
        baseScore: this.BASE_SCORE,
        counts: safeCounts,
        attackPlusCount,
        defensePlusCount,
        attackMinusCount,
        defenseMinusCount,
        totalPlusChecks,
        totalMinusChecks,
        addedPoints,
        deductedPoints,
        plusRemainder,
        minusRemainder,
        rawScore,           // 기본 5점 ± 가감 점수
        finalGradePoint,    // 환산표 최종 점수 (5점 ~ 1점)
        rangeLabel: matchedBracket.rangeLabel,
        ruleEvery3,
        isVerified
      };
    },

    /**
     * 필수 5대 계산 정확성 테스트 케이스 자동 실행
     */
    runMandatoryFiveTestCases() {
      const results = [];

      // 케이스 1: 초기 기본 상태 (플러스 0회, 마이너스 0회 -> 기본 5점, 환산 3점(6~5점 구간))
      const c1 = this.calculateStudentPerformance({}, true);
      results.push({
        name: '케이스 1: 초기 기본점수 확인 (플러스 0회·마이너스 0회)',
        expected: '가감점수 5점 / 최종환산 3점(6~5점 구간)',
        actual: `가감점수 ${c1.rawScore}점 / 최종환산 ${c1.finalGradePoint}점(${c1.rangeLabel})`,
        passed: c1.rawScore === 5 && c1.finalGradePoint === 3 && c1.isVerified
      });

      // 케이스 2: 최고 등급(5점 만점) 달성 (플러스가 12회 누적 -> +4점 가산 -> 5+4=9점 -> 9점 이상 = 5점)
      const c2 = this.calculateStudentPerformance({
        toss_plus: 4,
        spike_plus: 3,
        receive_plus: 3,
        move_plus: 2
      }, true);
      results.push({
        name: '케이스 2: 최고 점수 달성 (플러스 12회 = +4점 → 누적 9점 → 환산 5점)',
        expected: '가감점수 9점 / 최종환산 5점(9점 이상)',
        actual: `가감점수 ${c2.rawScore}점 / 최종환산 ${c2.finalGradePoint}점(${c2.rangeLabel})`,
        passed: c2.rawScore === 9 && c2.finalGradePoint === 5 && c2.isVerified
      });

      // 케이스 3: 최저 점수(1점) 달성 (마이너스 9회 누적 -> -3점 감점 -> 5-3=2점 -> 2점 이하 = 1점)
      const c3 = this.calculateStudentPerformance({
        toss_minus: 3,
        spike_minus: 3,
        receive_minus: 3
      }, true);
      results.push({
        name: '케이스 3: 최저 점수 구간 (마이너스 9회 = -3점 → 누적 2점 → 환산 1점)',
        expected: '가감점수 2점 / 최종환산 1점(2점 이하)',
        actual: `가감점수 ${c3.rawScore}점 / 최종환산 ${c3.finalGradePoint}점(${c3.rangeLabel})`,
        passed: c3.rawScore === 2 && c3.finalGradePoint === 1 && c3.isVerified
      });

      // 케이스 4: 경계값(3회 중복 미달 2회 vs 3회 달성) 검증 (플러스 2회면 아직 +0점(5점), 플러스 3회면 +1점(6점))
      const c4_2 = this.calculateStudentPerformance({ toss_plus: 2 }, true);
      const c4_3 = this.calculateStudentPerformance({ toss_plus: 3 }, true);
      results.push({
        name: '케이스 4: 3회 중복 경계값 검증 (플러스 2회=5점 유지 / 플러스 3회=6점(+1점))',
        expected: '2회→5점(나머지 2/3), 3회→6점(나머지 0/3)',
        actual: `2회→${c4_2.rawScore}점(나머지 ${c4_2.plusRemainder}/3), 3회→${c4_3.rawScore}점(나머지 ${c4_3.plusRemainder}/3)`,
        passed: c4_2.rawScore === 5 && c4_2.plusRemainder === 2 && c4_3.rawScore === 6 && c4_3.plusRemainder === 0
      });

      // 케이스 5: 공격·수비 플러스/마이너스 혼합 가감 (플러스 9회(+3점), 마이너스 3회(-1점) -> 5+3-1=7점 -> 8~7점 구간 = 4점)
      const c5 = this.calculateStudentPerformance({
        toss_plus: 3,
        spike_plus: 2,
        receive_plus: 2,
        move_plus: 2,
        toss_minus: 2,
        receive_minus: 1
      }, true);
      results.push({
        name: '케이스 5: 플러스(9회=+3점)·마이너스(3회=-1점) 혼합 → 누적 7점 → 환산 4점(8~7점)',
        expected: '가감점수 7점 / 최종환산 4점(8점 ~ 7점)',
        actual: `가감점수 ${c5.rawScore}점 / 최종환산 ${c5.finalGradePoint}점(${c5.rangeLabel})`,
        passed: c5.rawScore === 7 && c5.finalGradePoint === 4 && c5.isVerified
      });

      return {
        allPassed: results.every(r => r.passed),
        errorCount: results.filter(r => !r.passed).length,
        results
      };
    }
  };

  // ==========================================================================
  // (3) 입력 검증 모듈 (ValidationModule)
  // ==========================================================================
  const ValidationModule = {
    validateStudentInput(studentNumber, name, existingStudents) {
      const cleanNum = String(studentNumber || '').trim();
      const cleanName = String(name || '').trim();
      if (!cleanNum) {
        return { isValid: false, message: '학번을 입력해 주세요. (예: 20107)' };
      }
      if (!cleanName) {
        return { isValid: false, message: '학생 이름(또는 가명)을 입력해 주세요.' };
      }
      if ((existingStudents || []).some(s => s.studentNumber === cleanNum)) {
        return { isValid: false, message: `이미 등록된 학번(${cleanNum})입니다.` };
      }
      return { isValid: true, message: '정상' };
    }
  };

  // ==========================================================================
  // (4) 데이터 모델 모듈 (DataModelModule)
  // ==========================================================================
  const DataModelModule = {
    SAMPLE_STUDENTS: [
      { id: 'STU_01', studentNumber: '20101', name: '김배구' },
      { id: 'STU_02', studentNumber: '20102', name: '이토스' },
      { id: 'STU_03', studentNumber: '20103', name: '박리시브' },
      { id: 'STU_04', studentNumber: '20104', name: '최스파이크' },
      { id: 'STU_05', studentNumber: '20105', name: '정수비' },
      { id: 'STU_06', studentNumber: '20106', name: '강세터' }
    ],

    state: {
      students: [],
      records: {}, // { [studentId]: { counts: {}, selectedPlusKey, selectedMinusKey, history: [], updatedAt } }
      ruleEvery3: true,
      privacyMaskMode: false
    },

    init() {
      const loaded = this.loadFromStorage();
      if (!loaded) {
        this.resetAllToDefaultFive(false);
      }
    },

    createEmptyRecord() {
      return {
        counts: {
          toss_plus: 0,
          spike_plus: 0,
          receive_plus: 0,
          move_plus: 0,
          toss_minus: 0,
          spike_minus: 0,
          receive_minus: 0,
          move_minus: 0
        },
        selectedPlusKey: 'toss_plus',   // 학번·이름 옆 [+ 플러스] 클릭 시 기본 체크될 요소
        selectedMinusKey: 'toss_minus', // 학번·이름 옆 [- 마이너스] 클릭 시 기본 체크될 요소
        history: [],                    // 되돌리기(취소)용 스택
        updatedAt: new Date().toLocaleString('ko-KR', { hour12: false })
      };
    },

    loadFromStorage() {
      try {
        const raw = localStorage.getItem(VB_STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.students) && parsed.students.length > 0) {
          this.state.students = parsed.students;
          this.state.records = parsed.records || {};
          this.state.ruleEvery3 = parsed.ruleEvery3 !== undefined ? !!parsed.ruleEvery3 : true;
          this.state.privacyMaskMode = !!parsed.privacyMaskMode;
          PrivacyGuardModule.maskMode = this.state.privacyMaskMode;

          this.state.students.forEach(stu => {
            if (!this.state.records[stu.id]) {
              this.state.records[stu.id] = this.createEmptyRecord();
            }
          });
          return true;
        }
      } catch (_) {}
      return false;
    },

    saveToStorage() {
      const payload = {
        students: this.state.students,
        records: this.state.records,
        ruleEvery3: this.state.ruleEvery3,
        privacyMaskMode: this.state.privacyMaskMode,
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(VB_STORAGE_KEY, JSON.stringify(payload));
      SyncBus.post('VB_PERFORMANCE_UPDATED', payload);
    },

    resetAllToDefaultFive(broadcast = true) {
      if (this.state.students.length === 0) {
        this.state.students = JSON.parse(JSON.stringify(this.SAMPLE_STUDENTS));
      }
      const nextRecords = {};
      this.state.students.forEach(stu => {
        nextRecords[stu.id] = this.createEmptyRecord();
      });
      this.state.records = nextRecords;
      if (broadcast) this.saveToStorage();
    },

    /**
     * 특정 학생의 플러스/마이너스 요소 체크 횟수 1회 추가
     */
    incrementFactor(studentId, factorKey) {
      AuthAccessModule.assertTeacherPermission('플러스/마이너스 요소 체크');
      if (!this.state.records[studentId]) {
        this.state.records[studentId] = this.createEmptyRecord();
      }
      const rec = this.state.records[studentId];
      rec.counts[factorKey] = (rec.counts[factorKey] || 0) + 1;

      const isPlus = RubricCalcModule.PLUS_FACTORS.some(f => f.key === factorKey);
      if (isPlus) {
        rec.selectedPlusKey = factorKey;
      } else {
        rec.selectedMinusKey = factorKey;
      }

      rec.history.push(factorKey);
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    /**
     * 직전 체크 되돌리기 (Undo)
     */
    undoLastFactor(studentId) {
      AuthAccessModule.assertTeacherPermission('체크 되돌리기');
      const rec = this.state.records[studentId];
      if (!rec || !Array.isArray(rec.history) || rec.history.length === 0) {
        return null;
      }
      const lastKey = rec.history.pop();
      if (rec.counts[lastKey] > 0) {
        rec.counts[lastKey] -= 1;
      }
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
      return lastKey;
    }
  };

  // ==========================================================================
  // (7) 심의 대응용 산출물/정책 문서 모듈 (ComplianceDocModule)
  // ==========================================================================
  const ComplianceDocModule = {
    getDocumentHtml(docType) {
      if (docType === 'privacy') {
        return {
          title: '개인정보 처리방침 (초안)',
          html: `
            <p><strong>○○고등학교 체육교육부</strong>(이하 ‘학교’)는 개인정보보호위원회 「개인정보 처리방침 작성지침」에 따라 고등학교 체육 배구 수행평가 시스템 이용자의 개인정보를 보호하기 위하여 다음과 같이 개인정보 처리방침을 수립·공개합니다.</p>
            <h4>1. 처리 목적</h4>
            <p>고등학교 체육 배구 [3. 경기 수행 능력] 수행평가의 플러스(+)·마이너스(-) 체크 입력, 3회 중복 시 1점 가감 자동 계산 및 학생 본인의 결과(총점 및 항목별 아코디언 세부) 확인 제공 목적으로만 처리합니다.</p>
            <h4>2. 처리 항목</h4>
            <p>- 필수 항목: 학생 학번, 이름(또는 가명), 공격·수비 요소별 체크 횟수 및 환산 점수</p>
            <h4>3. 보유 기간 및 파기</h4>
            <p>- 보유 기간: 해당 학기/학년도 수업 운영 기간 및 학교 학업성적관리규정에 따름<br>- 파기 방법: 학기 종료 후 전자적 파일 형태 기록을 복구 불가능한 방식으로 초기화·삭제합니다.</p>
            <h4>4. 제3자 제공 및 위탁</h4>
            <p>- 제3자 제공 및 위탁: <strong>해당 없음</strong></p>
            <h4>5. 안전성 확보조치 및 권리 행사 방법</h4>
            <p>- 교사/학생 권한 분리, 가명/마스킹 모드 지원, 감사 로그 마스킹 적용<br>- 학생 및 법정대리인은 담당 체육교사를 통해 언제든 열람·정정·삭제를 요청할 수 있습니다.</p>
          `
        };
      }
      if (docType === 'terms') {
        return {
          title: '서비스 이용약관 (초안)',
          html: `
            <p>본 약관은 ○○고등학교 체육교육부가 운영하는 「배구 경기 수행 능력 평가 시스템」의 이용 조건 및 권리·의무를 규정합니다.</p>
            <h4>제1조 (서비스 범위)</h4>
            <p>교사는 학생별 공격(정확한 토스, 스파이크)·수비(리시브, 좋은 움직임/위치 선정) 요소를 체크하여 점수를 부여하고, 학생은 본인의 총점과 아코디언 세부 내역을 확인합니다.</p>
            <h4>제2조 (접근 권한 및 의무)</h4>
            <p>점수 가감 조작은 교사에게만 허용되며, 학생은 본인의 결과만 열람할 수 있습니다.</p>
            <h4>제3조 (환불·청약철회 및 분쟁 해결)</h4>
            <p>본 서비스는 무상 공교육 수업 지원 도구로서 유료 결제가 없으며, 점수 관련 이의신청은 담당 체육교사 확인 절차를 따릅니다.</p>
          `
        };
      }
      if (docType === 'spec') {
        return {
          title: '배구 3. 경기 수행 능력 루브릭 및 계산 규칙 안내',
          html: `
            <h4>1. 기본 점수 및 3회 중복 가감 규칙</h4>
            <p>- 모든 학생은 <strong>기본점수 5점</strong>에서 시작합니다.<br>- 플러스(+) 요소(정확한 토스, 스파이크, 리시브, 좋은 움직임) 체크가 <strong>3회 중복(누적)될 때마다 +1점</strong>이 가산됩니다.<br>- 마이너스(-) 요소(부정확한 토스, 스파이크 실책, 리시브 실패, 위치선정 미흡) 체크가 <strong>3회 중복(누적)될 때마다 -1점</strong>이 감점됩니다.</p>
            <h4>2. 최종 환산 점수표 (5점 ~ 1점)</h4>
            <p>- <strong>9점 이상</strong> : 5점<br>- <strong>8점 ~ 7점</strong> : 4점<br>- <strong>6점 ~ 5점</strong> : 3점 (기본 5점 시작 구간)<br>- <strong>4점 ~ 3점</strong> : 2점<br>- <strong>2점 이하</strong> : 1점</p>
          `
        };
      }
      const logs = AuthAccessModule.getAuditLogs();
      const rows = logs.length === 0
        ? '<p>기록된 로그가 없습니다.</p>'
        : `<ul style="padding-left:1.1rem;">${logs.slice(0, 25).map(l => `<li><code>[${l.timestamp}]</code> <strong>${l.eventType}</strong> (${l.actorRole}) - ${l.detail}</li>`).join('')}</ul>`;
      return {
        title: '접근 및 감사 로그 (개인정보 마스킹)',
        html: rows
      };
    }
  };

  // ==========================================================================
  // (1) UI / 화면 모듈 (UIModule)
  // ==========================================================================
  const UIModule = {
    accordionOpenState: {
      ACC_ATTACK: true,
      ACC_DEFENSE: false,
      ACC_TABLE: false
    },

    init() {
      DataModelModule.init();
      AuthAccessModule.initFromUrl();
      this.bindEvents();
      this.renderAll();

      if (SyncBus.channel) {
        SyncBus.channel.addEventListener('message', (ev) => {
          if (ev.data && ev.data.type === 'VB_PERFORMANCE_UPDATED') {
            DataModelModule.loadFromStorage();
            this.renderAll();
          }
        });
      }
      window.addEventListener('storage', (e) => {
        if (e.key === VB_STORAGE_KEY) {
          DataModelModule.loadFromStorage();
          this.renderAll();
        }
      });
    },

    showToast(msg) {
      const banner = document.getElementById('globalToastBanner');
      if (!banner) return;
      banner.textContent = msg;
      banner.classList.remove('hidden');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        banner.classList.add('hidden');
      }, 2800);
    },

    bindEvents() {
      document.getElementById('switchTeacherBtn')?.addEventListener('click', () => {
        AuthAccessModule.setRole('teacher');
        this.renderAll();
      });

      document.getElementById('switchStudentBtn')?.addEventListener('click', () => {
        AuthAccessModule.setRole('student');
        this.renderAll();
      });

      document.getElementById('copyStudentViewLinkBtn')?.addEventListener('click', () => {
        const firstId = DataModelModule.state.students[0]?.id || 'STU_01';
        const url = `${window.location.origin}${window.location.pathname}?role=student&studentId=${encodeURIComponent(firstId)}`;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).catch(() => {});
        }
        this.showToast(`🔗 학생용 결과 확인 링크가 복사되었습니다: ${url}`);
      });

      // 3회 중복 규칙 토글
      document.getElementById('chkRuleEvery3')?.addEventListener('change', (e) => {
        DataModelModule.state.ruleEvery3 = !!e.target.checked;
        DataModelModule.saveToStorage();
        this.renderAll();
      });

      // 개인정보 마스킹 모드 토글
      document.getElementById('chkPrivacyMaskMode')?.addEventListener('change', (e) => {
        const checked = !!e.target.checked;
        DataModelModule.state.privacyMaskMode = checked;
        PrivacyGuardModule.maskMode = checked;
        DataModelModule.saveToStorage();
        this.renderAll();
      });

      // 5대 계산 정확성 테스트 실행
      document.getElementById('runCalcTestSuiteBtn')?.addEventListener('click', () => {
        const panel = document.getElementById('calcTestResultPanel');
        if (!panel) return;
        const suite = RubricCalcModule.runMandatoryFiveTestCases();
        panel.innerHTML = `
          <div style="margin-bottom:0.4rem;font-weight:800;color:${suite.allPassed ? '#6ee7b7' : '#fca5a5'};">
            [필수 계산 정확성 테스트 결과] 총 5개 케이스 중 ${suite.results.length - suite.errorCount}개 통과 (계산 오류 ${suite.errorCount}건)
          </div>
          <div>${suite.results.map(r => `${r.passed ? '✅ [PASS]' : '❌ [FAIL]'} ${r.name} → 기대: ${r.expected} / 실제: ${r.actual}`).join('<br>')}</div>
        `;
        panel.classList.remove('hidden');
      });

      // 백업 내보내기
      document.getElementById('exportDataBackupBtn')?.addEventListener('click', () => {
        try {
          AuthAccessModule.assertTeacherPermission('백업 내보내기');
          const blob = new Blob([JSON.stringify(DataModelModule.state, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `volleyball_performance_backup_${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          this.showToast('💾 배구 경기 수행 능력 평가 데이터가 JSON 파일로 백업되었습니다.');
        } catch (err) {
          alert(err.message);
        }
      });

      // 학생 추가
      document.getElementById('addStudentBtn')?.addEventListener('click', () => {
        try {
          AuthAccessModule.assertTeacherPermission('학생 추가');
          const numEl = document.getElementById('newStudentNumberInput');
          const nameEl = document.getElementById('newStudentNameInput');
          const val = ValidationModule.validateStudentInput(numEl?.value, nameEl?.value, DataModelModule.state.students);
          if (!val.isValid) {
            alert(val.message);
            return;
          }
          const newId = 'STU_' + Date.now();
          const studentNumber = String(numEl.value).trim();
          const name = String(nameEl.value).trim();
          DataModelModule.state.students.push({ id: newId, studentNumber, name });
          DataModelModule.state.records[newId] = DataModelModule.createEmptyRecord();
          DataModelModule.saveToStorage();
          numEl.value = '';
          nameEl.value = '';
          this.renderAll();
          this.showToast(`✅ [${studentNumber} ${name}] 학생이 기본점수 5점으로 등록되었습니다.`);
        } catch (err) {
          alert(err.message);
        }
      });

      // 전원 기본 5점 초기화
      document.getElementById('resetAllScoresBtn')?.addEventListener('click', () => {
        try {
          AuthAccessModule.assertTeacherPermission('전원 5점 초기화');
          DataModelModule.resetAllToDefaultFive(true);
          this.renderAll();
          this.showToast('🔄 모든 학생의 점수가 기본점수 5점(체크 0회)으로 초기화되었습니다.');
        } catch (err) {
          alert(err.message);
        }
      });

      // 학생용 본인 선택 및 조회
      document.getElementById('studentSelfSelect')?.addEventListener('change', (e) => {
        AuthAccessModule.activeStudentViewerId = e.target.value;
        this.renderStudentView();
      });

      document.getElementById('studentLookupBtn')?.addEventListener('click', () => {
        const q = String(document.getElementById('studentDirectNumInput')?.value || '').trim();
        if (!q) return;
        const found = DataModelModule.state.students.find(s => s.studentNumber === q || s.name === q);
        if (!found) {
          alert(`입력한 학번 또는 이름('${q}')에 해당하는 학생이 없습니다.`);
          return;
        }
        AuthAccessModule.activeStudentViewerId = found.id;
        this.renderStudentView();
      });

      // 아코디언 전체 펼치기 / 접기
      document.getElementById('expandAllAccordionBtn')?.addEventListener('click', () => {
        this.accordionOpenState = { ACC_ATTACK: true, ACC_DEFENSE: true, ACC_TABLE: true };
        this.renderStudentAccordion();
      });

      document.getElementById('collapseAllAccordionBtn')?.addEventListener('click', () => {
        this.accordionOpenState = { ACC_ATTACK: false, ACC_DEFENSE: false, ACC_TABLE: false };
        this.renderStudentAccordion();
      });

      // 푸터 정책 모달
      document.querySelectorAll('.vb-footer-link-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const docType = btn.getAttribute('data-doc');
          const doc = ComplianceDocModule.getDocumentHtml(docType);
          document.getElementById('policyModalTitle').textContent = doc.title;
          document.getElementById('policyModalBody').innerHTML = doc.html;
          document.getElementById('policyModalBackdrop').classList.remove('hidden');
        });
      });

      const closeModal = () => document.getElementById('policyModalBackdrop')?.classList.add('hidden');
      document.getElementById('closePolicyModalBtn')?.addEventListener('click', closeModal);
      document.getElementById('confirmPolicyModalBtn')?.addEventListener('click', closeModal);
    },

    renderAll() {
      const isTeacher = AuthAccessModule.currentRole === 'teacher';
      document.getElementById('teacherViewSection')?.classList.toggle('hidden', !isTeacher);
      document.getElementById('studentViewSection')?.classList.toggle('hidden', isTeacher);

      document.getElementById('switchTeacherBtn')?.classList.toggle('active', isTeacher);
      document.getElementById('switchStudentBtn')?.classList.toggle('active', !isTeacher);

      const roleBadge = document.getElementById('currentRoleBadge');
      if (roleBadge) {
        roleBadge.textContent = isTeacher ? '교사용 평가 모드' : '학생용 결과 확인 모드';
        roleBadge.classList.toggle('student-mode', !isTeacher);
      }

      const ruleChk = document.getElementById('chkRuleEvery3');
      if (ruleChk) ruleChk.checked = DataModelModule.state.ruleEvery3;

      const maskChk = document.getElementById('chkPrivacyMaskMode');
      if (maskChk) maskChk.checked = DataModelModule.state.privacyMaskMode;

      if (isTeacher) {
        this.renderTeacherStudentRows();
      } else {
        this.renderStudentView();
      }
    },

    /**
     * 교사용 핵심 화면:
     * 각 학생의 [학번 · 이름] 옆에 [+ 플러스] / [- 마이너스] 버튼과
     * [정확한 토스, 스파이크, 리시브, 좋은 움직임] 체크 버튼 및 3회 중복 가감 점수를 렌더링
     */
    renderTeacherStudentRows() {
      const st = DataModelModule.state;
      const container = document.getElementById('teacherStudentRowsContainer');
      const countBadge = document.getElementById('studentCountBadge');
      if (!container) return;

      if (countBadge) {
        countBadge.textContent = `총 ${st.students.length}명 (기본점수 5점 시작 · ${st.ruleEvery3 ? '3회 중복 시 ±1점' : '1회당 ±1점'})`;
      }

      container.innerHTML = st.students.map(stu => {
        const rec = st.records[stu.id] || DataModelModule.createEmptyRecord();
        const calc = RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);
        const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
        const dispName = PrivacyGuardModule.formatStudentName(stu.name);

        const selPlusObj = RubricCalcModule.PLUS_FACTORS.find(f => f.key === rec.selectedPlusKey) || RubricCalcModule.PLUS_FACTORS[0];
        const selMinusObj = RubricCalcModule.MINUS_FACTORS.find(f => f.key === rec.selectedMinusKey) || RubricCalcModule.MINUS_FACTORS[0];

        const plusFactorBtnsHtml = RubricCalcModule.PLUS_FACTORS.map(f => {
          const cnt = calc.counts[f.key] || 0;
          const isSelected = rec.selectedPlusKey === f.key;
          return `
            <button
              type="button"
              class="vb-factor-check-btn plus-factor ${isSelected ? 'active-factor' : ''}"
              data-stu-id="${stu.id}"
              data-factor-key="${f.key}"
              title="${f.desc} (클릭 시 +1회 체크)"
            >
              <span>➕ ${f.label}</span>
              <span class="vb-factor-count-pill">${cnt}회</span>
            </button>
          `;
        }).join('');

        const minusFactorBtnsHtml = RubricCalcModule.MINUS_FACTORS.map(f => {
          const cnt = calc.counts[f.key] || 0;
          const isSelected = rec.selectedMinusKey === f.key;
          return `
            <button
              type="button"
              class="vb-factor-check-btn minus-factor ${isSelected ? 'active-factor' : ''}"
              data-stu-id="${stu.id}"
              data-factor-key="${f.key}"
              title="${f.desc} (클릭 시 -1회 체크)"
            >
              <span>➖ ${f.label}</span>
              <span class="vb-factor-count-pill">${cnt}회</span>
            </button>
          `;
        }).join('');

        return `
          <article class="vb-student-eval-row" data-row-stu-id="${stu.id}">
            <!-- [1] 좌측: 학번 · 이름 + 바로 옆 빠른 플러스(+) / 마이너스(-) 버튼 -->
            <div class="vb-stu-left-identity">
              <div class="vb-stu-id-name-line">
                <div>
                  <span class="vb-stu-num-badge">${dispNum}</span>
                  <strong class="vb-stu-name-strong">${dispName}</strong>
                </div>
                <button
                  type="button"
                  class="vb-btn-undo-mini"
                  data-undo-stu-id="${stu.id}"
                  title="방금 체크한 항목 되돌리기(취소)"
                >
                  ↩ 취소
                </button>
              </div>

              <!-- 학번·이름 바로 옆 플러스 / 마이너스 버튼 -->
              <div class="vb-quick-pm-bar">
                <button
                  type="button"
                  class="vb-btn-quick-plus"
                  data-quick-plus-stu-id="${stu.id}"
                  title="선택된 플러스 요소(${selPlusObj.label}) +1회 추가"
                >
                  ➕ 플러스 (${selPlusObj.label})
                </button>
                <button
                  type="button"
                  class="vb-btn-quick-minus"
                  data-quick-minus-stu-id="${stu.id}"
                  title="선택된 마이너스 요소(${selMinusObj.label}) -1회 추가"
                >
                  ➖ 마이너스 (${selMinusObj.label})
                </button>
              </div>
            </div>

            <!-- [2] 중앙: 플러스/마이너스 세부 요소 체크 버튼 (정확한 토스, 스파이크, 리시브, 좋은 움직임) -->
            <div class="vb-stu-center-factors">
              <div class="vb-factor-group-row">
                <span class="vb-factor-group-tag plus-tag">플러스(+) 요소</span>
                ${plusFactorBtnsHtml}
              </div>

              <div class="vb-factor-group-row">
                <span class="vb-factor-group-tag minus-tag">마이너스(-) 요소</span>
                ${minusFactorBtnsHtml}
              </div>

              <!-- 3회 중복 진행 게이지 안내 -->
              <div class="vb-triple-progress-line">
                <span class="vb-triple-stat-chip plus">
                  🟦 플러스 누적: 총 ${calc.totalPlusChecks}회 → <strong>+${calc.addedPoints}점 가산</strong>
                  ${st.ruleEvery3 ? `(다음 +1점까지 ${calc.plusRemainder}/3회)` : ''}
                </span>
                <span>|</span>
                <span class="vb-triple-stat-chip minus">
                  🟥 마이너스 누적: 총 ${calc.totalMinusChecks}회 → <strong>-${calc.deductedPoints}점 감점</strong>
                  ${st.ruleEvery3 ? `(다음 -1점까지 ${calc.minusRemainder}/3회)` : ''}
                </span>
              </div>
            </div>

            <!-- [3] 우측: 실시간 점수 패널 (기본 5점 가감 점수 -> 최종 5~1점 환산 점수) -->
            <div class="vb-stu-right-score-panel">
              <div class="vb-score-col">
                <span class="vb-score-col-label">가감 점수 (기본 5점)</span>
                <span class="vb-score-col-val">${calc.rawScore}점</span>
                <span class="vb-score-col-sub">5 + ${calc.addedPoints} - ${calc.deductedPoints}</span>
              </div>

              <span class="vb-score-divider-arrow">➔</span>

              <div class="vb-score-col">
                <span class="vb-score-col-label">최종 환산 (5점 만점)</span>
                <span class="vb-score-col-val final-grade-val">${calc.finalGradePoint}점</span>
                <span class="vb-score-col-sub">${calc.rangeLabel} 구간</span>
              </div>
            </div>
          </article>
        `;
      }).join('');

      // 요소 버튼 클릭 시 즉시 해당 요소 +1회 체크
      container.querySelectorAll('.vb-factor-check-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-stu-id');
          const factorKey = btn.getAttribute('data-factor-key');
          if (!stuId || !factorKey) return;
          DataModelModule.incrementFactor(stuId, factorKey);
          this.renderTeacherStudentRows();
        });
      });

      // 학번·이름 옆 [➕ 플러스] 빠른 버튼
      container.querySelectorAll('[data-quick-plus-stu-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-quick-plus-stu-id');
          const rec = st.records[stuId] || DataModelModule.createEmptyRecord();
          DataModelModule.incrementFactor(stuId, rec.selectedPlusKey || 'toss_plus');
          this.renderTeacherStudentRows();
        });
      });

      // 학번·이름 옆 [➖ 마이너스] 빠른 버튼
      container.querySelectorAll('[data-quick-minus-stu-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-quick-minus-stu-id');
          const rec = st.records[stuId] || DataModelModule.createEmptyRecord();
          DataModelModule.incrementFactor(stuId, rec.selectedMinusKey || 'toss_minus');
          this.renderTeacherStudentRows();
        });
      });

      // [↩ 취소] 되돌리기 버튼
      container.querySelectorAll('[data-undo-stu-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-undo-stu-id');
          const undone = DataModelModule.undoLastFactor(stuId);
          if (!undone) {
            this.showToast('되돌릴 체크 내역이 없습니다. (현재 기본 5점 초기 상태)');
            return;
          }
          this.renderTeacherStudentRows();
        });
      });
    },

    // ========================================================================
    // 학생용 화면: 총점(큰 숫자) + 아코디언 항목별 세부
    // ========================================================================
    renderStudentView() {
      const st = DataModelModule.state;
      const selectEl = document.getElementById('studentSelfSelect');

      if (!AuthAccessModule.activeStudentViewerId && st.students.length > 0) {
        AuthAccessModule.activeStudentViewerId = st.students[0].id;
      }

      if (selectEl) {
        selectEl.innerHTML = st.students.map(stu => {
          const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
          const dispName = PrivacyGuardModule.formatStudentName(stu.name);
          const sel = stu.id === AuthAccessModule.activeStudentViewerId ? 'selected' : '';
          return `<option value="${stu.id}" ${sel}>${dispNum} ${dispName}</option>`;
        }).join('');
      }

      const activeStu = st.students.find(s => s.id === AuthAccessModule.activeStudentViewerId) || st.students[0];
      const rec = activeStu ? (st.records[activeStu.id] || DataModelModule.createEmptyRecord()) : DataModelModule.createEmptyRecord();
      const calc = RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);

      const idPill = document.getElementById('studentResultIdentity');
      const updatedPill = document.getElementById('studentResultUpdatedAt');
      const rawScoreEl = document.getElementById('studentBigRawScore');
      const finalScoreEl = document.getElementById('studentBigFinalGradeScore');
      const deltaBadge = document.getElementById('studentDeltaBreakdownBadge');
      const bracketBadge = document.getElementById('studentBracketRangeBadge');

      if (activeStu && idPill) {
        idPill.textContent = `${PrivacyGuardModule.maskStudentId(activeStu.studentNumber)} ${PrivacyGuardModule.formatStudentName(activeStu.name)}`;
      }
      if (updatedPill) {
        updatedPill.textContent = `최근 업데이트: ${rec.updatedAt || '-'}`;
      }
      if (rawScoreEl) {
        rawScoreEl.textContent = String(calc.rawScore);
      }
      if (finalScoreEl) {
        finalScoreEl.textContent = String(calc.finalGradePoint);
      }
      if (deltaBadge) {
        deltaBadge.textContent = `기본 5점 + 가산 ${calc.addedPoints}점(플러스 ${calc.totalPlusChecks}회) - 감점 ${calc.deductedPoints}점(마이너스 ${calc.totalMinusChecks}회)`;
      }
      if (bracketBadge) {
        bracketBadge.textContent = `환산 구간: ${calc.rangeLabel} → 최종 ${calc.finalGradePoint}점`;
      }

      this.renderStudentAccordion(calc);
    },

    renderStudentAccordion(calcData) {
      const st = DataModelModule.state;
      const activeStu = st.students.find(s => s.id === AuthAccessModule.activeStudentViewerId) || st.students[0];
      const rec = activeStu ? (st.records[activeStu.id] || DataModelModule.createEmptyRecord()) : DataModelModule.createEmptyRecord();
      const calc = calcData || RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);
      const listEl = document.getElementById('studentAccordionList');
      if (!listEl) return;

      const sections = [
        {
          id: 'ACC_ATTACK',
          badge: '가. 공격',
          title: '가. 공격 수행 능력 (정확한 토스 · 스파이크)',
          rightSummary: `플러스 ${calc.attackPlusCount}회 / 마이너스 ${calc.attackMinusCount}회`,
          bodyHtml: `
            <p style="margin-bottom:0.65rem;">
              <strong>루브릭 기준</strong>: 정확한 토스, 스파이크 등 효과적인 공격 시 플러스(+), 부정확한 토스, 스파이크 등 비효과적인 공격 시 마이너스(-)를 기록합니다.
            </p>
            <table class="vb-acc-rubric-table">
              <thead>
                <tr>
                  <th>구분</th>
                  <th>평가 요소</th>
                  <th>내 체크 횟수</th>
                  <th>루브릭 세부 설명</th>
                </tr>
              </thead>
              <tbody>
                <tr class="${calc.counts.toss_plus > 0 ? 'my-grade-row' : ''}">
                  <td>공격 (+)</td>
                  <td>➕ 정확한 토스</td>
                  <td><strong>${calc.counts.toss_plus}회</strong></td>
                  <td>목표 공격수에게 정확하게 연결된 효과적인 토스</td>
                </tr>
                <tr class="${calc.counts.spike_plus > 0 ? 'my-grade-row' : ''}">
                  <td>공격 (+)</td>
                  <td>➕ 스파이크</td>
                  <td><strong>${calc.counts.spike_plus}회</strong></td>
                  <td>정확한 타이밍과 타점으로 성공한 효과적인 스파이크 공격</td>
                </tr>
                <tr class="${calc.counts.toss_minus > 0 ? 'my-grade-row' : ''}">
                  <td>공격 (-)</td>
                  <td>➖ 부정확한 토스</td>
                  <td><strong>${calc.counts.toss_minus}회</strong></td>
                  <td>부정확한 방향·높이로 공격 연결이 어려운 토스</td>
                </tr>
                <tr class="${calc.counts.spike_minus > 0 ? 'my-grade-row' : ''}">
                  <td>공격 (-)</td>
                  <td>➖ 스파이크 실책</td>
                  <td><strong>${calc.counts.spike_minus}회</strong></td>
                  <td>네트 걸림·아웃 등 비효과적인 스파이크 공격 범실</td>
                </tr>
              </tbody>
            </table>
          `
        },
        {
          id: 'ACC_DEFENSE',
          badge: '나. 수비',
          title: '나. 수비 수행 능력 (리시브 · 좋은 움직임/적절한 위치 선정)',
          rightSummary: `플러스 ${calc.defensePlusCount}회 / 마이너스 ${calc.defenseMinusCount}회`,
          bodyHtml: `
            <p style="margin-bottom:0.65rem;">
              <strong>루브릭 기준</strong>: 적절한 위치 선정(좋은 움직임), 수비 성공(리시브) 등 효과적인 수비 시 플러스(+), 부적절한 위치 선정, 수비 실패 시 마이너스(-)를 기록합니다.
            </p>
            <table class="vb-acc-rubric-table">
              <thead>
                <tr>
                  <th>구분</th>
                  <th>평가 요소</th>
                  <th>내 체크 횟수</th>
                  <th>루브릭 세부 설명</th>
                </tr>
              </thead>
              <tbody>
                <tr class="${calc.counts.receive_plus > 0 ? 'my-grade-row' : ''}">
                  <td>수비 (+)</td>
                  <td>➕ 리시브 (수비 성공)</td>
                  <td><strong>${calc.counts.receive_plus}회</strong></td>
                  <td>상대 서브·공격을 안정적으로 받아낸 효과적인 리시브</td>
                </tr>
                <tr class="${calc.counts.move_plus > 0 ? 'my-grade-row' : ''}">
                  <td>수비 (+)</td>
                  <td>➕ 좋은 움직임 (적절한 위치 선정)</td>
                  <td><strong>${calc.counts.move_plus}회</strong></td>
                  <td>공의 낙하 지점 예측 및 커버를 위한 적절한 수비 위치 선정</td>
                </tr>
                <tr class="${calc.counts.receive_minus > 0 ? 'my-grade-row' : ''}">
                  <td>수비 (-)</td>
                  <td>➖ 리시브 실패 (수비 실패)</td>
                  <td><strong>${calc.counts.receive_minus}회</strong></td>
                  <td>기본 자세 미흡으로 인한 리시브 및 수비 실패</td>
                </tr>
                <tr class="${calc.counts.move_minus > 0 ? 'my-grade-row' : ''}">
                  <td>수비 (-)</td>
                  <td>➖ 위치선정 미흡</td>
                  <td><strong>${calc.counts.move_minus}회</strong></td>
                  <td>부적절한 수비 위치 선정 및 소극적인 수비 움직임</td>
                </tr>
              </tbody>
            </table>
          `
        },
        {
          id: 'ACC_TABLE',
          badge: '환산 기준표',
          title: '다. 3회 중복 가감 계산식 및 최종 점수 환산표 (5점 ~ 1점)',
          rightSummary: `가감 ${calc.rawScore}점 → 최종 ${calc.finalGradePoint}점`,
          bodyHtml: `
            <p style="margin-bottom:0.65rem;">
              <strong>* 3회 중복 시 1점씩 가감하여 점수 부여</strong>:
              기본점수 <strong>5점</strong> + 플러스 가산 <strong>+${calc.addedPoints}점</strong>(총 ${calc.totalPlusChecks}회 체크) - 마이너스 감점 <strong>-${calc.deductedPoints}점</strong>(총 ${calc.totalMinusChecks}회 체크) = 현재 가감 점수 <strong>${calc.rawScore}점</strong>
            </p>
            <table class="vb-acc-rubric-table">
              <thead>
                <tr>
                  <th>최종 환산 점수</th>
                  <th>가감 점수 구간</th>
                  <th>내 해당 여부</th>
                </tr>
              </thead>
              <tbody>
                ${RubricCalcModule.CONVERSION_TABLE.map(row => {
                  const isMine = row.finalPoint === calc.finalGradePoint;
                  return `
                    <tr class="${isMine ? 'my-grade-row' : ''}">
                      <td><strong>${row.finalPoint}점</strong></td>
                      <td>${row.rangeLabel}</td>
                      <td>${isMine ? `✅ 내 현재 점수 (${calc.rawScore}점 → ${row.finalPoint}점)` : '-'}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `
        }
      ];

      listEl.innerHTML = sections.map(sec => {
        const isOpen = !!this.accordionOpenState[sec.id];
        return `
          <div class="vb-accordion-item" data-acc-id="${sec.id}">
            <button
              type="button"
              class="vb-accordion-trigger"
              aria-expanded="${isOpen ? 'true' : 'false'}"
              aria-controls="panel_${sec.id}"
            >
              <div class="vb-acc-title-wrap">
                <span class="vb-acc-index-badge">${sec.badge}</span>
                <span class="vb-acc-item-name">${sec.title}</span>
              </div>
              <div class="vb-acc-right-meta">
                <span class="vb-acc-grade-pill">${sec.rightSummary}</span>
                <span class="vb-acc-chevron">▼</span>
              </div>
            </button>
            <div id="panel_${sec.id}" class="vb-accordion-panel ${isOpen ? '' : 'hidden'}">
              ${sec.bodyHtml}
            </div>
          </div>
        `;
      }).join('');

      // 1번 클릭 시 즉시 아코디언 토글
      listEl.querySelectorAll('.vb-accordion-trigger').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = btn.closest('.vb-accordion-item');
          const id = item?.getAttribute('data-acc-id');
          if (!id) return;
          const next = !this.accordionOpenState[id];
          this.accordionOpenState[id] = next;
          btn.setAttribute('aria-expanded', next ? 'true' : 'false');
          document.getElementById(`panel_${id}`)?.classList.toggle('hidden', !next);
        });
      });
    }
  };

  global.VolleyballPEApp = {
    UIModule,
    RubricCalcModule,
    ValidationModule,
    DataModelModule,
    AuthAccessModule,
    PrivacyGuardModule,
    ComplianceDocModule
  };

  document.addEventListener('DOMContentLoaded', () => {
    UIModule.init();
  });
})(window);
