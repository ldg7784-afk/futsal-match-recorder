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
        } catch (_) { }
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
      } catch (_) { }
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
  // - 점수 체계:
  //   1) 실시간 가감 점수: 누를 때마다 바로 +1점/-1점 실시간 상승 (instantCheckDelta)
  //   2) 최종 환산 점수: 기본 5점에서 3회 누적 가감된 점수 (rawScore: 5점 시작)
  //   3) 수행평가 점수: 사진 기준 5점 만점 환산 (9점이상=5, 8~7=4, 6~5=3, 4~3=2, 2이하=1)
  // ==========================================================================
  const RubricCalcModule = {
    BASE_SCORE: 5,

    // 플러스(+) 체크 요소 정의 (가. 공격 / 나. 수비)
    PLUS_FACTORS: [
      { key: 'toss_plus', category: '가. 공격', label: '정확한 토스', shortLabel: '토스', desc: '공격 +1점 요인: 정확한 토스 연결' },
      { key: 'spike_plus', category: '가. 공격', label: '스파이크', shortLabel: '스파이크', desc: '공격 +1점 요인: 효과적인 스파이크 공격 성공' },
      { key: 'receive_plus', category: '나. 수비', label: '리시브', shortLabel: '리시브', desc: '수비 +1점 요인: 안정적인 리시브 및 수비 성공' },
      { key: 'move_plus', category: '나. 수비', label: '좋은 움직임', shortLabel: '움직임', desc: '수비 +1점 요인: 적절한 위치 선정 및 커버 움직임' }
    ],

    // 마이너스(-) 체크 요소 정의 (가. 공격 / 나. 수비)
    MINUS_FACTORS: [
      { key: 'toss_minus', category: '가. 공격', label: '부정확한 토스', shortLabel: '부정확토스', desc: '공격 -1점 요인: 부정확한 토스 연결' },
      { key: 'spike_minus', category: '가. 공격', label: '스파이크 실책', shortLabel: '스파이크실책', desc: '공격 -1점 요인: 비효과적인 공격 및 범실' },
      { key: 'receive_minus', category: '나. 수비', label: '리시브 실패', shortLabel: '리시브실패', desc: '수비 -1점 요인: 수비 실패 및 리시브 범실' },
      { key: 'move_minus', category: '나. 수비', label: '위치선정 미흡', shortLabel: '위치미흡', desc: '수비 -1점 요인: 부적절한 위치 선정 및 소극적 움직임' }
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

      // [1] 실시간 가감 점수: 누를 때마다 바로 실시간으로 +1점, -1점 즉시 상승
      const instantCheckDelta = totalPlusChecks - totalMinusChecks;

      // [2] 최종 환산 점수: 기본 5점에서 3회 누적 가감된 점수 (기본 5점 시작)
      const divisor = ruleEvery3 ? 3 : 1;
      const addedPoints = Math.floor(totalPlusChecks / divisor);
      const deductedPoints = Math.floor(totalMinusChecks / divisor);

      const plusRemainder = ruleEvery3 ? (totalPlusChecks % 3) : 0;
      const minusRemainder = ruleEvery3 ? (totalMinusChecks % 3) : 0;

      // 기본점수 5점에서 3회 가감 계산 (5점 시작: 5, 6, 7, 8, 9... 또는 감점 시 4, 3, 2, 1)
      const rawScore = this.BASE_SCORE + addedPoints - deductedPoints;

      // [3] 사진 기준 최종 수행평가 점수 매핑 (5점 ~ 1점)
      let finalGradePoint = 1;
      let matchedBracket = this.CONVERSION_TABLE[this.CONVERSION_TABLE.length - 1];
      for (const row of this.CONVERSION_TABLE) {
        if (rawScore >= row.minRaw && rawScore <= row.maxRaw) {
          finalGradePoint = row.finalPoint;
          matchedBracket = row;
          break;
        }
      }

      return {
        baseScore: this.BASE_SCORE,
        counts: safeCounts,
        attackPlusCount,
        defensePlusCount,
        attackMinusCount,
        defenseMinusCount,
        totalPlusChecks,
        totalMinusChecks,
        instantCheckDelta,  // 누를 때마다 바로 오르내리는 실시간 가감 점수 (+1, +2, -1...)
        addedPoints,
        deductedPoints,
        plusRemainder,
        minusRemainder,
        rawScore,           // 기본 5점 시작 최종 환산 점수 (5점, 6점, 7점...)
        finalGradePoint,    // 사진 기준 수행평가 점수 (5점, 4점, 3점, 2점, 1점)
        rangeLabel: matchedBracket.rangeLabel,
        ruleEvery3,
        isVerified: true
      };
    },

    /**
     * 필수 5대 계산 정확성 테스트 케이스 자동 실행
     */
    runMandatoryFiveTestCases() {
      const results = [];

      // 케이스 1: 초기 기본 상태 (플러스 0회, 마이너스 0회 -> 가감 0점, 환산 5점, 수행평가 3점(6~5점 구간))
      const c1 = this.calculateStudentPerformance({}, true);
      results.push({
        name: '케이스 1: 초기 기본점수 확인 (플러스 0회·마이너스 0회)',
        expected: '가감 0점 / 환산 5점 / 수행평가 3점(6~5점 구간)',
        actual: `가감 ${c1.instantCheckDelta}점 / 환산 ${c1.rawScore}점 / 수행평가 ${c1.finalGradePoint}점(${c1.rangeLabel})`,
        passed: c1.instantCheckDelta === 0 && c1.rawScore === 5 && c1.finalGradePoint === 3
      });

      // 케이스 2: 최고 등급(수행평가 5점 만점) 달성 (플러스가 12회 누적 -> 가감 +12점 -> 환산 5+4=9점 -> 9점 이상 = 수행평가 5점)
      const c2 = this.calculateStudentPerformance({
        toss_plus: 4,
        spike_plus: 3,
        receive_plus: 3,
        move_plus: 2
      }, true);
      results.push({
        name: '케이스 2: 최고 점수 달성 (플러스 12회 = 환산 9점 → 수행평가 5점 만점)',
        expected: '가감 +12점 / 환산 9점 / 수행평가 5점(9점 이상)',
        actual: `가감 +${c2.instantCheckDelta}점 / 환산 ${c2.rawScore}점 / 수행평가 ${c2.finalGradePoint}점(${c2.rangeLabel})`,
        passed: c2.instantCheckDelta === 12 && c2.rawScore === 9 && c2.finalGradePoint === 5
      });

      // 케이스 3: 최저 점수(수행평가 1점) 달성 (마이너스 9회 누적 -> 환산 5-3=2점 -> 2점 이하 = 1점)
      const c3 = this.calculateStudentPerformance({
        toss_minus: 3,
        spike_minus: 3,
        receive_minus: 3
      }, true);
      results.push({
        name: '케이스 3: 최저 점수 구간 (마이너스 9회 = 환산 2점 → 수행평가 1점)',
        expected: '가감 -9점 / 환산 2점 / 수행평가 1점(2점 이하)',
        actual: `가감 ${c3.instantCheckDelta}점 / 환산 ${c3.rawScore}점 / 수행평가 ${c3.finalGradePoint}점(${c3.rangeLabel})`,
        passed: c3.instantCheckDelta === -9 && c3.rawScore === 2 && c3.finalGradePoint === 1
      });

      // 케이스 4: 실시간 가감 즉시 상승 검증 (플러스 1회=가감+1점 / 플러스 2회=가감+2점)
      const c4_1 = this.calculateStudentPerformance({ toss_plus: 1 }, true);
      const c4_2 = this.calculateStudentPerformance({ toss_plus: 2 }, true);
      results.push({
        name: '케이스 4: 누를 때마다 실시간 가감 즉시 상승 (1회→+1점, 2회→+2점)',
        expected: '1회→가감 +1점, 2회→가감 +2점 (환산 5점 유지)',
        actual: `1회→+${c4_1.instantCheckDelta}점, 2회→+${c4_2.instantCheckDelta}점`,
        passed: c4_1.instantCheckDelta === 1 && c4_2.instantCheckDelta === 2 && c4_1.rawScore === 5
      });

      // 케이스 5: 공격·수비 플러스 9회(+3점), 마이너스 3회(-1점) -> 환산 5+3-1=7점 -> 수행평가 4점(8~7점)
      const c5 = this.calculateStudentPerformance({
        toss_plus: 3,
        spike_plus: 3,
        receive_plus: 3,
        toss_minus: 3
      }, true);
      results.push({
        name: '케이스 5: 플러스 9회·마이너스 3회 (환산 7점 → 수행평가 4점)',
        expected: '환산 7점 / 수행평가 4점(8~7점)',
        actual: `환산 ${c5.rawScore}점 / 수행평가 ${c5.finalGradePoint}점`,
        passed: c5.rawScore === 7 && c5.finalGradePoint === 4
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
  // - 엑셀 학생명렬표(1반~9반, 20101 이동규 형식) 완벽 연동
  // - 기타 사항(note) 및 구글 시트 내보내기 지원
  // ==========================================================================
  const DataModelModule = {
    roster: null,

    state: {
      currentClass: 1, // 현재 선택된 반 (1 ~ 9)
      classes: {},     // { [classNum]: [ 학생 목록 ] }
      students: [],    // 현재 반의 학생 목록
      records: {},     // { [studentId]: { counts: {}, selectedPlusKey, selectedMinusKey, history: [], evalDate, updatedAt, note: '' } }
      evalDate: new Date().toISOString().slice(0, 10),
      viewMode: 'table', // 'table' (가로형 빠른 체크보드) | 'card' (상세 카드)
      ruleEvery3: true,
      privacyMaskMode: false
    },

    init() {
      // 1. roster_data.js 에서 1반부터 9반 명단 불러오기
      if (typeof window !== 'undefined' && window.VOLLEYBALL_ROSTER && window.VOLLEYBALL_ROSTER.classes) {
        this.roster = window.VOLLEYBALL_ROSTER;
      }
      this.initClassesFromRoster();

      // 2. 로컬스토리지에서 기존 평가 기록 복원
      this.loadFromStorage();

      if (!this.state.evalDate) {
        this.state.evalDate = new Date().toISOString().slice(0, 10);
      }
      this.loadClass(this.state.currentClass || 1, false);
    },

    initClassesFromRoster() {
      const rosterClasses = this.roster ? this.roster.classes : {};
      const nextClasses = {};
      for (let c = 1; c <= 9; c++) {
        const list = rosterClasses[String(c)] || rosterClasses[c] || [];
        if (list.length > 0) {
          nextClasses[c] = JSON.parse(JSON.stringify(list));
        } else {
          // 기본 샘플 15명 생성 (20000대 번호)
          nextClasses[c] = Array.from({ length: 15 }, (_, i) => {
            const num = i + 1;
            const stuNum = `20${c}${num < 10 ? '0' + num : num}`;
            return {
              id: `STU_${stuNum}`,
              studentNumber: stuNum,
              name: `학생${stuNum}`,
              classNum: c,
              grade: 2,
              number: num,
              note: ''
            };
          });
        }
      }
      this.state.classes = nextClasses;
    },

    createEmptyRecord(studentId = '') {
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
        selectedPlusKey: 'toss_plus',
        selectedMinusKey: 'toss_minus',
        history: [],
        note: '',
        evalDate: this.state.evalDate || new Date().toISOString().slice(0, 10),
        updatedAt: new Date().toLocaleString('ko-KR', { hour12: false })
      };
    },

    loadClass(classNum, broadcast = true) {
      const c = Number(classNum) || 1;
      this.state.currentClass = c;
      const classStudents = this.state.classes[c] || [];
      this.state.students = classStudents;

      // 해당 반 학생들의 레코드 확인/생성
      this.state.students.forEach(stu => {
        if (!this.state.records[stu.id]) {
          this.state.records[stu.id] = this.createEmptyRecord(stu.id);
        }
      });

      if (broadcast) this.saveToStorage();
    },

    setEvalDate(newDate) {
      if (!newDate) return;
      const cleanDate = String(newDate).trim();
      const prevDate = this.state.evalDate || cleanDate;

      if (!this.state.dateHistory) this.state.dateHistory = {};
      this.state.dateHistory[prevDate] = Object.assign({}, this.state.dateHistory[prevDate] || {}, this.state.records);

      this.state.evalDate = cleanDate;

      if (this.state.dateHistory[cleanDate] && Object.keys(this.state.dateHistory[cleanDate]).length > 0) {
        this.state.records = this.state.dateHistory[cleanDate];
      } else {
        const freshRecords = {};
        for (let c = 1; c <= 9; c++) {
          const list = this.state.classes[c] || [];
          list.forEach(stu => {
            freshRecords[stu.id] = this.createEmptyRecord(stu.id);
          });
        }
        this.state.records = freshRecords;
        this.state.dateHistory[cleanDate] = freshRecords;
      }

      this.saveToStorage();
    },

    loadFromStorage() {
      try {
        const raw = localStorage.getItem(VB_STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (parsed) {
          if (parsed.classes && Object.keys(parsed.classes).length > 0) {
            this.state.classes = parsed.classes;
          }
          this.state.currentClass = Number(parsed.currentClass) || 1;
          this.state.evalDate = parsed.evalDate || new Date().toISOString().slice(0, 10);
          this.state.dateHistory = parsed.dateHistory || {};
          this.state.records = parsed.records || {};

          // 날짜별 이력과 현재 레코드 동기화
          if (!this.state.dateHistory[this.state.evalDate]) {
            this.state.dateHistory[this.state.evalDate] = this.state.records;
          } else if (Object.keys(this.state.records).length > 0) {
            this.state.dateHistory[this.state.evalDate] = Object.assign({}, this.state.dateHistory[this.state.evalDate], this.state.records);
          } else {
            this.state.records = this.state.dateHistory[this.state.evalDate];
          }

          this.state.viewMode = parsed.viewMode || 'table';
          this.state.ruleEvery3 = parsed.ruleEvery3 !== undefined ? !!parsed.ruleEvery3 : true;
          this.state.privacyMaskMode = !!parsed.privacyMaskMode;
          PrivacyGuardModule.maskMode = this.state.privacyMaskMode;
          return true;
        }
      } catch (_) { }
      return false;
    },

    saveToStorage() {
      const curDate = this.state.evalDate || new Date().toISOString().slice(0, 10);
      if (!this.state.dateHistory) this.state.dateHistory = {};
      this.state.dateHistory[curDate] = Object.assign({}, this.state.dateHistory[curDate] || {}, this.state.records);

      const payload = {
        classes: this.state.classes,
        currentClass: this.state.currentClass,
        records: this.state.records,
        dateHistory: this.state.dateHistory,
        evalDate: this.state.evalDate,
        viewMode: this.state.viewMode,
        ruleEvery3: this.state.ruleEvery3,
        privacyMaskMode: this.state.privacyMaskMode,
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(VB_STORAGE_KEY, JSON.stringify(payload));
      SyncBus.post('VB_PERFORMANCE_UPDATED', payload);
    },

    updateStudentNote(studentId, noteText) {
      AuthAccessModule.assertTeacherPermission('기타 사항 수정');
      if (!this.state.records[studentId]) {
        this.state.records[studentId] = this.createEmptyRecord(studentId);
      }
      this.state.records[studentId].note = String(noteText || '').trim();
      this.state.records[studentId].evalDate = this.state.evalDate;
      this.state.records[studentId].updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    resetCurrentClassScores(broadcast = true) {
      this.state.students.forEach(stu => {
        this.state.records[stu.id] = this.createEmptyRecord(stu.id);
      });
      if (broadcast) this.saveToStorage();
    },

    reSyncCurrentClassFromRoster(broadcast = true) {
      this.initClassesFromRoster();
      this.loadClass(this.state.currentClass, broadcast);
    },

    incrementFactor(studentId, factorKey) {
      AuthAccessModule.assertTeacherPermission('플러스/마이너스 요소 체크');
      if (!this.state.records[studentId]) {
        this.state.records[studentId] = this.createEmptyRecord(studentId);
      }
      const rec = this.state.records[studentId];
      rec.counts[factorKey] = (rec.counts[factorKey] || 0) + 1;

      const isPlus = RubricCalcModule.PLUS_FACTORS.some(f => f.key === factorKey);
      if (isPlus) {
        rec.selectedPlusKey = factorKey;
      } else {
        rec.selectedMinusKey = factorKey;
      }

      rec.evalDate = this.state.evalDate || new Date().toISOString().slice(0, 10);
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
      }, 3000);
    },

    fallbackCopyText(text, label) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        this.showToast(`📋 [${label}] 기록 복사 완료! 구글 시트에서 Ctrl+V 를 누르세요.`);
      } catch (e) {
        alert('클립보드 복사 권한이 없어 수동 복사가 필요합니다.');
      }
      document.body.removeChild(ta);
    },

    /**
     * 전체 날짜별 / 현재 날짜별 평가 데이터 세트 생성
     * @param {'allDates'|'currentDate'} scope
     */
    buildExportRows(scope = 'allDates') {
      const st = DataModelModule.state;
      const curDate = st.evalDate || new Date().toISOString().slice(0, 10);

      if (!st.dateHistory) st.dateHistory = {};
      st.dateHistory[curDate] = Object.assign({}, st.dateHistory[curDate] || {}, st.records);

      const header = [
        '평가일자',
        '학년',
        '반',
        '번호',
        '학번',
        '성명',
        '가감점수(실시간)',
        '최종환산점수(기본5점시작)',
        '수행평가점수(사진기준)',
        '기타사항',
        '플러스누적',
        '마이너스누적'
      ];

      const dataRows = [];
      let datesToExport = [];

      if (scope === 'allDates') {
        datesToExport = Object.keys(st.dateHistory).sort();
        if (datesToExport.length === 0) datesToExport = [curDate];
      } else {
        datesToExport = [curDate];
      }

      datesToExport.forEach(d => {
        const recordsMap = st.dateHistory[d] || {};
        for (let c = 1; c <= 9; c++) {
          const classStudents = st.classes[c] || [];
          classStudents.forEach(stu => {
            const rec = recordsMap[stu.id] || DataModelModule.createEmptyRecord(stu.id);
            const calc = RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);
            const dStr = calc.instantCheckDelta > 0 ? `+${calc.instantCheckDelta}` : String(calc.instantCheckDelta);
            dataRows.push([
              d,
              stu.grade || 2,
              stu.classNum || c,
              stu.number || '',
              stu.studentNumber,
              stu.name,
              dStr,
              calc.rawScore,
              calc.finalGradePoint,
              rec.note || '',
              `${calc.totalPlusChecks}회`,
              `${calc.totalMinusChecks}회`
            ]);
          });
        }
      });

      return { header, dataRows, datesCount: datesToExport.length, totalCount: dataRows.length };
    },

    /**
     * 구글 스프레드시트용 TSV 클립보드 복사
     * @param {'allDates'|'currentDate'} scope
     */
    copyGoogleSheet(scope = 'allDates') {
      const exp = this.buildExportRows(scope);
      const allRows = [exp.header, ...exp.dataRows];
      const tsv = allRows.map(r => r.join('\t')).join('\n');
      const label = scope === 'allDates' ? `전체 날짜(${exp.datesCount}개 일자 종합)` : `현재 날짜(${DataModelModule.state.evalDate})`;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(() => {
          this.showToast(`📋 [${label}] 총 ${exp.totalCount}명의 평가 기록이 복사되었습니다! 구글 시트에서 Ctrl+V 를 누르세요.`);
        }).catch(() => {
          this.fallbackCopyText(tsv, label);
        });
      } else {
        this.fallbackCopyText(tsv, label);
      }
    },

    /**
     * 엑셀 호환 CSV 파일 다운로드 (UTF-8 BOM 탑재)
     * @param {'allDates'|'currentDate'} scope
     */
    downloadCsv(scope = 'allDates') {
      const exp = this.buildExportRows(scope);
      const allRows = [exp.header, ...exp.dataRows];

      const csvLines = allRows.map(r => {
        return r.map(cell => {
          const str = String(cell !== undefined && cell !== null ? cell : '');
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        }).join(',');
      });

      const csvContent = '\uFEFF' + csvLines.join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const curDate = DataModelModule.state.evalDate;
      a.href = url;
      a.download = scope === 'allDates'
        ? `배구_수행평가_전체날짜별종합_${curDate}.csv`
        : `배구_수행평가_${curDate}_기록.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast(`📥 [${scope === 'allDates' ? '전체 날짜별 종합' : '현재 날짜'}] 엑셀 CSV 파일이 다운로드되었습니다.`);
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
        const firstId = DataModelModule.state.students[0]?.id || 'STU_20101';
        const url = `${window.location.origin}${window.location.pathname}?role=student&studentId=${encodeURIComponent(firstId)}`;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).catch(() => { });
        }
        this.showToast(`🔗 학생용 결과 확인 링크가 복사되었습니다: ${url}`);
      });

      // 구글 시트 복사 버튼 이벤트 (전체 날짜별 정리 / 현재 날짜)
      document.getElementById('copyGoogleSheetAllDatesBtn')?.addEventListener('click', () => {
        this.copyGoogleSheet('allDates');
      });

      document.getElementById('copyGoogleSheetCurrentBtn')?.addEventListener('click', () => {
        this.copyGoogleSheet('currentDate');
      });

      // 엑셀 CSV 다운로드 버튼 이벤트 (전체 날짜별 / 현재 날짜)
      document.getElementById('downloadCsvAllDatesBtn')?.addEventListener('click', () => {
        this.downloadCsv('allDates');
      });

      document.getElementById('downloadCsvCurrentBtn')?.addEventListener('click', () => {
        this.downloadCsv('currentDate');
      });

      // 1반부터 9반 탭 클릭 이벤트
      document.querySelectorAll('.vb-class-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const cls = Number(btn.getAttribute('data-class'));
          if (cls >= 1 && cls <= 9) {
            DataModelModule.loadClass(cls, true);
            this.renderAll();
            this.showToast(`🏫 ${cls}반 학생 명단이 로드되었습니다.`);
          }
        });
      });

      // 평가 일자 피커 이벤트 (날짜 변경 시 해당 날짜 기록으로 안전하게 전환)
      const dateInput = document.getElementById('evalDateInput');
      if (dateInput) {
        dateInput.value = DataModelModule.state.evalDate;
        dateInput.addEventListener('change', (e) => {
          const val = e.target.value || new Date().toISOString().slice(0, 10);
          DataModelModule.setEvalDate(val);
          this.renderAll();
          this.showToast(`📅 평가 일자가 [${val}] 로 설정되었으며 해당 일자 기록이 로드되었습니다.`);
        });
      }

      // 오늘 날짜로 즉시 설정
      document.getElementById('setTodayDateBtn')?.addEventListener('click', () => {
        const today = new Date().toISOString().slice(0, 10);
        DataModelModule.setEvalDate(today);
        if (dateInput) dateInput.value = today;
        this.renderAll();
        this.showToast(`📅 평가 일자를 오늘(${today})로 설정했습니다.`);
      });

      // 가로형 테이블 vs 카드 뷰 전환 토글
      document.getElementById('viewModeTableBtn')?.addEventListener('click', () => {
        DataModelModule.state.viewMode = 'table';
        DataModelModule.saveToStorage();
        this.updateViewModeBtns();
        this.renderTeacherStudentRows();
      });

      document.getElementById('viewModeCardBtn')?.addEventListener('click', () => {
        DataModelModule.state.viewMode = 'card';
        DataModelModule.saveToStorage();
        this.updateViewModeBtns();
        this.renderTeacherStudentRows();
      });

      // 현재 반 명단 재동기화 (불러오기)
      document.getElementById('loadSample15Btn')?.addEventListener('click', () => {
        try {
          AuthAccessModule.assertTeacherPermission('명단 재동기화');
          DataModelModule.reSyncCurrentClassFromRoster(true);
          this.renderAll();
          this.showToast(`🔄 ${DataModelModule.state.currentClass}반 학생 명렬표가 재동기화되었습니다.`);
        } catch (err) {
          alert(err.message);
        }
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
          a.download = `volleyball_performance_backup_${DataModelModule.state.evalDate || new Date().toISOString().slice(0, 10)}.json`;
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
          const studentNumber = String(numEl.value).trim();
          const name = String(nameEl.value).trim();
          const newId = 'STU_' + studentNumber;
          const newStu = {
            id: newId,
            studentNumber,
            name,
            classNum: DataModelModule.state.currentClass,
            grade: 2,
            number: studentNumber.slice(-2),
            note: ''
          };
          DataModelModule.state.students.push(newStu);
          if (!DataModelModule.state.classes[DataModelModule.state.currentClass]) {
            DataModelModule.state.classes[DataModelModule.state.currentClass] = [];
          }
          DataModelModule.state.classes[DataModelModule.state.currentClass].push(newStu);
          DataModelModule.state.records[newId] = DataModelModule.createEmptyRecord(newId);
          DataModelModule.saveToStorage();
          numEl.value = '';
          nameEl.value = '';
          this.renderAll();
          this.showToast(`✅ [${studentNumber} ${name}] 학생이 ${DataModelModule.state.currentClass}반에 등록되었습니다.`);
        } catch (err) {
          alert(err.message);
        }
      });

      // 현재 반 0점 초기화
      document.getElementById('resetAllScoresBtn')?.addEventListener('click', () => {
        try {
          AuthAccessModule.assertTeacherPermission('현재 반 초기화');
          DataModelModule.resetCurrentClassScores(true);
          this.renderAll();
          this.showToast(`🔄 ${DataModelModule.state.currentClass}반 학생 전원의 점수가 0점(체크 내역 없음)으로 초기화되었습니다.`);
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

    updateClassTabs() {
      const curCls = DataModelModule.state.currentClass || 1;
      document.querySelectorAll('.vb-class-tab-btn').forEach(btn => {
        const c = Number(btn.getAttribute('data-class'));
        const isActive = c === curCls;
        btn.classList.toggle('active', isActive);
        const count = (DataModelModule.state.classes[c] || []).length;
        btn.textContent = `${c}반 (${count}명)`;
      });
    },

    updateEvalDateBadge() {
      const badge = document.getElementById('currentEvalDateBadge');
      const curDate = DataModelModule.state.evalDate || new Date().toISOString().slice(0, 10);
      if (badge) {
        badge.textContent = `📅 ${curDate} 평가 진행 중`;
      }
      const dateInput = document.getElementById('evalDateInput');
      if (dateInput && dateInput.value !== curDate) {
        dateInput.value = curDate;
      }
    },

    updateViewModeBtns() {
      const isTable = (DataModelModule.state.viewMode || 'table') === 'table';
      const tblBtn = document.getElementById('viewModeTableBtn');
      const crdBtn = document.getElementById('viewModeCardBtn');
      const container = document.getElementById('teacherStudentRowsContainer');

      if (tblBtn) {
        tblBtn.classList.toggle('vb-btn-primary', isTable);
        tblBtn.classList.toggle('vb-btn-outline', !isTable);
        tblBtn.classList.toggle('active', isTable);
      }
      if (crdBtn) {
        crdBtn.classList.toggle('vb-btn-primary', !isTable);
        crdBtn.classList.toggle('vb-btn-outline', isTable);
        crdBtn.classList.toggle('active', !isTable);
      }
      if (container) {
        container.className = isTable
          ? 'vb-student-board-view mode-horizontal-table'
          : 'vb-student-board-view mode-card-stack';
      }
    },

    renderAll() {
      const isTeacher = AuthAccessModule.currentRole === 'teacher';
      document.getElementById('teacherViewSection')?.classList.toggle('hidden', !isTeacher);
      document.getElementById('studentViewSection')?.classList.toggle('hidden', isTeacher);

      document.getElementById('switchTeacherBtn')?.classList.toggle('active', isTeacher);
      document.getElementById('switchStudentBtn')?.classList.toggle('active', !isTeacher);

      const roleBadge = document.getElementById('currentRoleBadge');
      if (roleBadge) {
        roleBadge.textContent = isTeacher ? '교사용' : '학생용';
        roleBadge.classList.toggle('student-mode', !isTeacher);
      }

      const ruleChk = document.getElementById('chkRuleEvery3');
      if (ruleChk) ruleChk.checked = DataModelModule.state.ruleEvery3;

      const maskChk = document.getElementById('chkPrivacyMaskMode');
      if (maskChk) maskChk.checked = DataModelModule.state.privacyMaskMode;

      this.updateEvalDateBadge();
      this.updateClassTabs();
      this.updateViewModeBtns();

      if (isTeacher) {
        this.renderTeacherStudentRows();
      } else {
        this.renderStudentView();
      }
    },

    /**
     * 교사용 핵심 화면:
     * 가로형 테이블 모드 (15명 동시 빠른 체크) / 카드형 모드
     * 절대 겹치지 않는 구조 설계
     */
    renderTeacherStudentRows() {
      const st = DataModelModule.state;
      const container = document.getElementById('teacherStudentRowsContainer');
      const countBadge = document.getElementById('studentCountBadge');
      if (!container) return;

      const isTableMode = (st.viewMode || 'table') === 'table';

      if (countBadge) {
        countBadge.textContent = `총 ${st.students.length}명 동시 평가 (기본점수 5점 시작 · ${st.ruleEvery3 ? '3회 중복 시 ±1점' : '1회당 ±1점'})`;
      }

      if (isTableMode) {
        // [1] 가로형 빠른 체크보드 모드: 학생(학번 성명), 가감 점수, 최종 환산 점수, 수행평가 점수, 취소, 기타 사항
        let headerHtml = `
          <div class="vb-tbl-head-row">
            <div class="vb-tbl-th col-stu">학생 (학번 성명)</div>
            <div class="vb-tbl-th col-quick">빠른 ±</div>
            <div class="vb-tbl-th col-plus-factors">플러스 (+)</div>
            <div class="vb-tbl-th col-minus-factors">마이너스 (-)</div>
            <div class="vb-tbl-th col-delta">가감 점수</div>
            <div class="vb-tbl-th col-raw">최종 환산 점수</div>
            <div class="vb-tbl-th col-eval-score">수행평가 점수</div>
            <div class="vb-tbl-th col-action">취소</div>
            <div class="vb-tbl-th col-note">기타</div>
          </div>
        `;

        let rowsHtml = st.students.map((stu, idx) => {
          const rec = st.records[stu.id] || DataModelModule.createEmptyRecord();
          const calc = RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);
          const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
          const dispName = PrivacyGuardModule.formatStudentName(stu.name);

          const selPlusObj = RubricCalcModule.PLUS_FACTORS.find(f => f.key === rec.selectedPlusKey) || RubricCalcModule.PLUS_FACTORS[0];
          const selMinusObj = RubricCalcModule.MINUS_FACTORS.find(f => f.key === rec.selectedMinusKey) || RubricCalcModule.MINUS_FACTORS[0];

          // 누를 때마다 바로 1점씩 오르내리는 가감 점수 텍스트
          const deltaDisplay = calc.instantCheckDelta > 0 ? `+${calc.instantCheckDelta}점` : (calc.instantCheckDelta < 0 ? `${calc.instantCheckDelta}점` : `0점`);
          const deltaClass = calc.instantCheckDelta > 0 ? 'delta-pos' : (calc.instantCheckDelta < 0 ? 'delta-neg' : 'delta-zero');

          const plusFactorChipsHtml = RubricCalcModule.PLUS_FACTORS.map(f => {
            const cnt = calc.counts[f.key] || 0;
            const isSelected = rec.selectedPlusKey === f.key;
            const displayLabel = f.shortLabel || f.label;
            return `
              <button
                type="button"
                class="vb-factor-chip plus ${isSelected ? 'active-factor' : ''}"
                data-stu-id="${stu.id}"
                data-factor-key="${f.key}"
                title="${f.desc} (클릭 시 +1회 체크)"
              >
                <span class="chip-label">${displayLabel}</span>
                <span class="chip-cnt">${cnt}</span>
              </button>
            `;
          }).join('');

          const minusFactorChipsHtml = RubricCalcModule.MINUS_FACTORS.map(f => {
            const cnt = calc.counts[f.key] || 0;
            const isSelected = rec.selectedMinusKey === f.key;
            const displayLabel = f.shortLabel || f.label;
            return `
              <button
                type="button"
                class="vb-factor-chip minus ${isSelected ? 'active-factor' : ''}"
                data-stu-id="${stu.id}"
                data-factor-key="${f.key}"
                title="${f.desc} (클릭 시 -1회 체크)"
              >
                <span class="chip-label">${displayLabel}</span>
                <span class="chip-cnt">${cnt}</span>
              </button>
            `;
          }).join('');

          return `
            <div class="vb-tbl-row" data-row-stu-id="${stu.id}">
              <!-- 1. 학생 (학번 성명) -->
              <div class="vb-tbl-cell col-stu">
                <span class="vb-stu-index-num">${idx + 1}</span>
                <span class="vb-stu-num-badge">${dispNum}</span>
                <strong class="vb-stu-name-strong">${dispName}</strong>
              </div>

              <!-- 2. 빠른 +/- 원터치 버튼 -->
              <div class="vb-tbl-cell col-quick">
                <button
                  type="button"
                  class="vb-quick-btn quick-plus"
                  data-quick-plus-stu-id="${stu.id}"
                  title="선택된 플러스 요소(${selPlusObj.label}) +1회 체크"
                >
                  +1
                </button>
                <button
                  type="button"
                  class="vb-quick-btn quick-minus"
                  data-quick-minus-stu-id="${stu.id}"
                  title="선택된 마이너스 요소(${selMinusObj.label}) -1회 체크"
                >
                  -1
                </button>
              </div>

              <!-- 3. 플러스 요소 4종 -->
              <div class="vb-tbl-cell col-plus-factors">
                <div class="vb-chips-flex">
                  ${plusFactorChipsHtml}
                </div>
              </div>

              <!-- 4. 마이너스 요소 4종 -->
              <div class="vb-tbl-cell col-minus-factors">
                <div class="vb-chips-flex">
                  ${minusFactorChipsHtml}
                </div>
              </div>

              <!-- 5. 가감 점수 (누를 때마다 즉시 오르내림) -->
              <div class="vb-tbl-cell col-delta">
                <span class="vb-raw-score-badge ${deltaClass}">${deltaDisplay}</span>
              </div>

              <!-- 6. 최종 환산 점수 (기본 5점에서 3회 가감 계산) -->
              <div class="vb-tbl-cell col-raw">
                <span class="vb-converted-score-badge">${calc.rawScore}점</span>
              </div>

              <!-- 7. 수행평가 점수 (사진 기준 환산 1~5점) -->
              <div class="vb-tbl-cell col-eval-score">
                <span class="vb-final-grade-badge grade-${calc.finalGradePoint}">
                  ${calc.finalGradePoint}점
                </span>
              </div>

              <!-- 8. 취소(되돌리기) -->
              <div class="vb-tbl-cell col-action">
                <button
                  type="button"
                  class="vb-btn-undo-mini"
                  data-undo-stu-id="${stu.id}"
                  title="방금 체크한 항목 1단계 되돌리기"
                >
                  ↩
                </button>
              </div>

              <!-- 9. 기타 사항 (취소 옆) -->
              <div class="vb-tbl-cell col-note">
                <input
                  type="text"
                  class="vb-tbl-note-input"
                  data-note-stu-id="${stu.id}"
                  value="${String(rec.note || '').replace(/"/g, '&quot;')}"
                  placeholder="기타..."
                />
              </div>
            </div>
          `;
        }).join('');

        container.innerHTML = `<div class="vb-horizontal-table-body">${headerHtml}${rowsHtml}</div>`;
      } else {
        // [2] 카드형 모드 (상세 뷰)
        container.innerHTML = st.students.map((stu, idx) => {
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
            <article class="vb-student-eval-card" data-row-stu-id="${stu.id}">
              <div class="vb-card-row-top">
                <div class="vb-card-stu-title">
                  <span class="vb-stu-index-num">#${idx + 1}</span>
                  <span class="vb-stu-num-badge">${dispNum}</span>
                  <strong class="vb-stu-name-strong">${dispName}</strong>
                </div>
                <div class="vb-card-top-right">
                  <button
                    type="button"
                    class="vb-btn-undo-mini"
                    data-undo-stu-id="${stu.id}"
                    title="방금 체크한 항목 되돌리기(취소)"
                  >
                    ↩ 직전 체크 취소
                  </button>
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
              </div>

              <div class="vb-card-factors-wrap">
                <div class="vb-factor-section-block">
                  <div class="vb-factor-section-head plus">
                    <span>🟦 플러스(+) 공격·수비 체크 (3회 시 +1점)</span>
                  </div>
                  <div class="vb-factor-btn-grid">
                    ${plusFactorBtnsHtml}
                  </div>
                </div>

                <div class="vb-factor-section-block">
                  <div class="vb-factor-section-head minus">
                    <span>🟥 마이너스(-) 실책·범실 체크 (3회 시 -1점)</span>
                  </div>
                  <div class="vb-factor-btn-grid">
                    ${minusFactorBtnsHtml}
                  </div>
                </div>
              </div>

              <div class="vb-card-bottom-summary">
                <div class="vb-bottom-stat-pills">
                  <span class="vb-triple-stat-chip plus">
                    플러스 누적: ${calc.totalPlusChecks}회 (<strong>+${calc.addedPoints}점</strong>)
                    ${st.ruleEvery3 ? `➔ 남은횟수 ${calc.plusRemainder}/3` : ''}
                  </span>
                  <span class="vb-triple-stat-chip minus">
                    마이너스 누적: ${calc.totalMinusChecks}회 (<strong>-${calc.deductedPoints}점</strong>)
                    ${st.ruleEvery3 ? `➔ 남은횟수 ${calc.minusRemainder}/3` : ''}
                  </span>
                </div>
                <div class="vb-card-note-row">
                  <span class="vb-card-note-lbl">📝 기타 사항:</span>
                  <input
                    type="text"
                    class="vb-tbl-note-input"
                    data-note-stu-id="${stu.id}"
                    value="${String(rec.note || '').replace(/"/g, '&quot;')}"
                    placeholder="기타..."
                  />
                </div>
                <div class="vb-bottom-score-group">
                  <div class="vb-score-box">
                    <span class="lbl">가감 점수(실시간)</span>
                    <strong class="val">${calc.instantCheckDelta > 0 ? `+${calc.instantCheckDelta}점` : (calc.instantCheckDelta < 0 ? `${calc.instantCheckDelta}점` : `0점`)}</strong>
                  </div>
                  <span class="arrow">➔</span>
                  <div class="vb-score-box">
                    <span class="lbl">최종 환산 점수</span>
                    <strong class="val">${calc.rawScore}점</strong>
                  </div>
                  <span class="arrow">➔</span>
                  <div class="vb-score-box highlight">
                    <span class="lbl">수행평가 점수 (사진 기준)</span>
                    <strong class="val final">${calc.finalGradePoint}점</strong>
                    <span class="range">(${calc.rangeLabel})</span>
                  </div>
                </div>
              </div>
            </article>
          `;
        }).join('');
      }

      // 1. 세부 요소 칩/버튼 클릭
      container.querySelectorAll('.vb-factor-chip, .vb-factor-check-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-stu-id');
          const factorKey = btn.getAttribute('data-factor-key');
          if (!stuId || !factorKey) return;
          DataModelModule.incrementFactor(stuId, factorKey);
          this.renderTeacherStudentRows();
        });
      });

      // 2. 빠른 + 버튼
      container.querySelectorAll('[data-quick-plus-stu-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-quick-plus-stu-id');
          const rec = st.records[stuId] || DataModelModule.createEmptyRecord();
          DataModelModule.incrementFactor(stuId, rec.selectedPlusKey || 'toss_plus');
          this.renderTeacherStudentRows();
        });
      });

      // 3. 빠른 - 버튼
      container.querySelectorAll('[data-quick-minus-stu-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const stuId = btn.getAttribute('data-quick-minus-stu-id');
          const rec = st.records[stuId] || DataModelModule.createEmptyRecord();
          DataModelModule.incrementFactor(stuId, rec.selectedMinusKey || 'toss_minus');
          this.renderTeacherStudentRows();
        });
      });

      // 4. 취소(되돌리기) 버튼
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

      // 5. 기타 사항 입력 필드 실시간 저장 (블러 시 렌더하지 않고 조용히 저장)
      container.querySelectorAll('.vb-tbl-note-input').forEach(input => {
        input.addEventListener('input', (e) => {
          const stuId = input.getAttribute('data-note-stu-id');
          if (!stuId) return;
          DataModelModule.updateStudentNote(stuId, e.target.value);
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
        rawScoreEl.textContent = calc.instantCheckDelta > 0 ? `+${calc.instantCheckDelta}점` : (calc.instantCheckDelta < 0 ? `${calc.instantCheckDelta}점` : `0점`);
      }
      if (finalScoreEl) {
        finalScoreEl.textContent = String(calc.finalGradePoint);
      }
      if (deltaBadge) {
        deltaBadge.textContent = `실시간 가감: ${calc.instantCheckDelta >= 0 ? '+' : ''}${calc.instantCheckDelta}점 (플러스 ${calc.totalPlusChecks}회 · 마이너스 ${calc.totalMinusChecks}회)`;
      }
      if (bracketBadge) {
        bracketBadge.textContent = `기본 5점 시작 ➔ 3회 누적 가감 반영 최종: ${calc.finalGradePoint}점`;
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
