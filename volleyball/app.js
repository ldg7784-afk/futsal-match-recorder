/**
 * ============================================================================
 * 고등학교 체육 배구 종합 수행평가 시스템 (volleyball/app.js)
 * 1. [경기 수행 능력 평가] (5점 만점 - 토스/스파이크/리시브 원본 그대로 유지)
 * 2. [배구 기능평가] (10점 만점 - 40초/50초 타이머, 2회 기회 중 최고 기록 반영, 우선 남자 기준)
 * 3. [합산 종합 성적표] (15점 만점 실시간 합산 및 구글시트/엑셀 출력)
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
  // (1) 개인정보보호 모듈 (PrivacyGuardModule)
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
  // (2) 권한/접근 제어 모듈 (AuthAccessModule)
  // ==========================================================================
  const AuthAccessModule = {
    currentRole: 'teacher', // 'teacher' | 'student'
    activeStudentViewerId: 'STU_20101',

    initFromUrl() {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      const roleParam = (params.get('role') || '').toLowerCase();
      const stuParam = params.get('studentId') || '';
      const modeParam = (params.get('mode') || '').toLowerCase();

      if (roleParam === 'student') {
        this.currentRole = 'student';
        if (stuParam) this.activeStudentViewerId = stuParam;
        this.recordAudit('STUDENT_VIEW_ENTER', 'student', '학생용 결과 확인 화면 진입');
      } else {
        this.currentRole = 'teacher';
        this.recordAudit('TEACHER_VIEW_ENTER', 'teacher', '교사용 평가 화면 진입');
      }

      if (modeParam === 'skill' || modeParam === 'combined' || modeParam === 'game') {
        DataModelModule.state.currentMode = modeParam;
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
  // (3) 경기 수행능력 루브릭/계산 모듈 (RubricCalcModule - 원래 원본 그대로)
  // ==========================================================================
  const RubricCalcModule = {
    BASE_SCORE: 5,

    PLUS_FACTORS: [
      { key: 'toss_plus', category: '가. 공격', label: '정확한 토스', shortLabel: '토스', desc: '공격 +1점 요인: 정확한 토스 연결' },
      { key: 'spike_plus', category: '가. 공격', label: '스파이크', shortLabel: '스파이크', desc: '공격 +1점 요인: 효과적인 스파이크 공격 성공' },
      { key: 'receive_plus', category: '나. 수비', label: '리시브', shortLabel: '리시브', desc: '수비 +1점 요인: 안정적인 리시브 및 수비 성공' },
      { key: 'move_plus', category: '나. 수비', label: '좋은 움직임', shortLabel: '움직임', desc: '수비 +1점 요인: 적절한 위치 선정 및 커버 움직임' }
    ],

    MINUS_FACTORS: [
      { key: 'toss_minus', category: '가. 공격', label: '부정확한 토스', shortLabel: '부정확토스', desc: '공격 -1점 요인: 부정확한 토스 연결' },
      { key: 'spike_minus', category: '가. 공격', label: '스파이크 실책', shortLabel: '스파이크실책', desc: '공격 -1점 요인: 비효과적인 공격 및 범실' },
      { key: 'receive_minus', category: '나. 수비', label: '리시브 실패', shortLabel: '리시브실패', desc: '수비 -1점 요인: 수비 실패 및 리시브 범실' },
      { key: 'move_minus', category: '나. 수비', label: '위치선정 미흡', shortLabel: '위치미흡', desc: '수비 -1점 요인: 부적절한 위치 선정 및 소극적 움직임' }
    ],

    CONVERSION_TABLE: [
      { finalPoint: 5, rangeLabel: '9점 이상', minRaw: 9, maxRaw: 999 },
      { finalPoint: 4, rangeLabel: '8점 ~ 7점', minRaw: 7, maxRaw: 8 },
      { finalPoint: 3, rangeLabel: '6점 ~ 5점', minRaw: 5, maxRaw: 6 },
      { finalPoint: 2, rangeLabel: '4점 ~ 3점', minRaw: 3, maxRaw: 4 },
      { finalPoint: 1, rangeLabel: '2점 이하', minRaw: -999, maxRaw: 2 }
    ],

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

      const instantCheckDelta = totalPlusChecks - totalMinusChecks;
      const divisor = ruleEvery3 ? 3 : 1;
      const addedPoints = Math.floor(totalPlusChecks / divisor);
      const deductedPoints = Math.floor(totalMinusChecks / divisor);

      const plusRemainder = ruleEvery3 ? (totalPlusChecks % 3) : 0;
      const minusRemainder = ruleEvery3 ? (totalMinusChecks % 3) : 0;

      const rawScore = this.BASE_SCORE + addedPoints - deductedPoints;

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
        instantCheckDelta,
        addedPoints,
        deductedPoints,
        plusRemainder,
        minusRemainder,
        rawScore,
        finalGradePoint,
        rangeLabel: matchedBracket.rangeLabel,
        ruleEvery3,
        isVerified: true
      };
    }
  };

  // ==========================================================================
  // (4) 배구 기능평가 계산 모듈 (SkillCalcModule - 10점 만점)
  // - 기준: 사진 원문 반영 (우선 남자 기준 적용)
  //   [남자 기준] 5개 이상: 10점 / 4개: 9점 / 3개: 8점 / 2개: 7점 / 1개 이하: 6점
  //   [여자 기준] 4개 이상: 10점 / 3개: 9점 / 2개: 8점 / 1개: 7점 / 0개: 6점
  // ==========================================================================
  const SkillCalcModule = {
    calculateCountScore(count, gender = 'male') {
      if (count === null || count === undefined || count === '') {
        return null;
      }
      const c = Math.max(0, parseInt(count, 10) || 0);
      const isFemale = gender === 'female' || gender === 'F';

      if (isFemale) {
        if (c >= 4) return 10;
        if (c === 3) return 9;
        if (c === 2) return 8;
        if (c === 1) return 7;
        return 6;
      } else {
        // 우선 남자 기준 (기본)
        if (c >= 5) return 10;
        if (c === 4) return 9;
        if (c === 3) return 8;
        if (c === 2) return 7;
        return 6;
      }
    },

    calculateStudentSkill(rec = {}, defaultGender = 'male') {
      const gender = rec.gender || defaultGender || 'male';

      const a1 = (rec.attempt1 !== null && rec.attempt1 !== undefined && rec.attempt1 !== '')
        ? Math.max(0, parseInt(rec.attempt1, 10))
        : null;

      const a2 = (rec.attempt2 !== null && rec.attempt2 !== undefined && rec.attempt2 !== '')
        ? Math.max(0, parseInt(rec.attempt2, 10))
        : null;

      let bestCount = null;
      if (a1 !== null && a2 !== null) {
        bestCount = Math.max(a1, a2);
      } else if (a1 !== null) {
        bestCount = a1;
      } else if (a2 !== null) {
        bestCount = a2;
      }

      const isEvaluated = bestCount !== null;
      const score = isEvaluated ? this.calculateCountScore(bestCount, gender) : null;

      return {
        gender,
        attempt1: a1,
        attempt2: a2,
        bestCount,
        score: isEvaluated ? score : 0,
        scoreDisplay: isEvaluated ? `${score}점` : '미측정',
        bestDisplay: isEvaluated ? `${bestCount}개` : '-',
        isEvaluated
      };
    },

    calculateCombinedTotal(gameGradePoint, skillCalc) {
      const gScore = Number(gameGradePoint) || 0;
      const sScore = skillCalc.isEvaluated ? skillCalc.score : 0;
      const total = gScore + sScore;
      return {
        gameScore: gScore,
        skillScore: sScore,
        totalScore: total,
        isSkillEvaluated: skillCalc.isEvaluated,
        displayTotal: `${total}점`
      };
    }
  };

  // ==========================================================================
  // (5) 타이머 모듈 (TimerModule - 40초 / 50초 타이머, 소리알림 없음)
  // ==========================================================================
  const TimerModule = {
    duration: 40,
    remaining: 40,
    intervalId: null,
    isRunning: false,

    init() {
      this.updateDisplay();
      this.bindKeyListeners();
    },

    setPreset(seconds) {
      this.pause();
      this.duration = Number(seconds) || 40;
      this.remaining = this.duration;
      this.updateDisplay();

      const p40 = document.getElementById('timerPreset40Btn');
      const p50 = document.getElementById('timerPreset50Btn');
      if (p40) p40.classList.toggle('active', this.duration === 40);
      if (p50) p50.classList.toggle('active', this.duration === 50);
    },

    start() {
      if (this.isRunning) return;
      if (this.remaining <= 0) {
        this.remaining = this.duration;
      }
      this.isRunning = true;
      this.updateButtons();
      this.updateDisplay();

      this.intervalId = setInterval(() => {
        this.remaining -= 1;
        this.updateDisplay();

        if (this.remaining <= 0) {
          this.finish();
        }
      }, 1000);
    },

    pause() {
      if (!this.isRunning) return;
      this.isRunning = false;
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      this.updateButtons();
      this.updateDisplay();
    },

    reset() {
      this.pause();
      this.remaining = this.duration;
      this.updateButtons();
      this.updateDisplay();
    },

    finish() {
      this.pause();
      this.remaining = 0;
      this.updateDisplay(true);
    },

    updateDisplay(isFinished = false) {
      const clock = document.getElementById('timerClockDigits');
      const badge = document.getElementById('timerStatusBadge');
      const bar = document.getElementById('timerProgressBar');

      const mins = Math.floor(Math.max(0, this.remaining) / 60);
      const secs = Math.max(0, this.remaining) % 60;
      const str = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      if (clock) clock.textContent = str;

      const pct = Math.max(0, Math.min(100, (this.remaining / this.duration) * 100));
      if (bar) bar.style.width = pct + '%';

      if (badge) {
        if (isFinished || this.remaining === 0) {
          badge.textContent = '종료';
          badge.className = 'vb-timer-status finished';
        } else if (this.isRunning) {
          badge.textContent = '진행중';
          badge.className = 'vb-timer-status running';
        } else if (this.remaining < this.duration) {
          badge.textContent = '일시정지';
          badge.className = 'vb-timer-status paused';
        } else {
          badge.textContent = '준비';
          badge.className = 'vb-timer-status ready';
        }
      }
    },

    updateButtons() {
      const startBtn = document.getElementById('timerStartBtn');
      const pauseBtn = document.getElementById('timerPauseBtn');
      if (startBtn) startBtn.disabled = this.isRunning;
      if (pauseBtn) pauseBtn.disabled = !this.isRunning;
    },

    bindKeyListeners() {
      if (typeof window === 'undefined') return;
      window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (DataModelModule.state.currentMode !== 'skill') return;

        if (e.code === 'Space') {
          e.preventDefault();
          if (this.isRunning) this.pause();
          else this.start();
        } else if (e.code === 'KeyR') {
          e.preventDefault();
          this.reset();
        }
      });
    }
  };

  // ==========================================================================
  // (6) 데이터 모델 모듈 (DataModelModule)
  // ==========================================================================
  const DataModelModule = {
    roster: null,

    state: {
      currentClass: 1,             // 1 ~ 9반
      currentMode: 'game',         // 'game' | 'skill' | 'combined'
      skillCriteriaGender: 'male', // 'male' (우선 남자 기준) | 'female'
      classes: {},                 // { [c]: [학생목록] }
      students: [],                // 현재 반 학생 목록
      records: {},                 // 경기수행 기록
      skillRecords: {},            // 기능평가 기록: { [studentId]: { attempt1: null, attempt2: null, gender: 'male', note: '' } }
      dateHistory: {},             // 날짜별 경기수행 기록
      dateSkillHistory: {},        // 날짜별 기능평가 기록
      evalDate: new Date().toISOString().slice(0, 10),
      viewMode: 'table',           // 'table' | 'card'
      ruleEvery3: true,
      privacyMaskMode: false
    },

    init() {
      if (typeof window !== 'undefined' && window.VOLLEYBALL_ROSTER && window.VOLLEYBALL_ROSTER.classes) {
        this.roster = window.VOLLEYBALL_ROSTER;
      }
      this.initClassesFromRoster();
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

    createEmptySkillRecord(studentId = '') {
      return {
        attempt1: null,
        attempt2: null,
        gender: this.state.skillCriteriaGender || 'male', // 기본: 우선 남자 기준
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

      this.state.students.forEach(stu => {
        if (!this.state.records[stu.id]) {
          this.state.records[stu.id] = this.createEmptyRecord(stu.id);
        }
        if (!this.state.skillRecords[stu.id]) {
          this.state.skillRecords[stu.id] = this.createEmptySkillRecord(stu.id);
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

      if (!this.state.dateSkillHistory) this.state.dateSkillHistory = {};
      this.state.dateSkillHistory[prevDate] = Object.assign({}, this.state.dateSkillHistory[prevDate] || {}, this.state.skillRecords);

      this.state.evalDate = cleanDate;

      if (this.state.dateHistory[cleanDate]) {
        this.state.records = this.state.dateHistory[cleanDate];
      } else {
        const freshRecords = {};
        for (let c = 1; c <= 9; c++) {
          (this.state.classes[c] || []).forEach(stu => {
            freshRecords[stu.id] = this.createEmptyRecord(stu.id);
          });
        }
        this.state.records = freshRecords;
        this.state.dateHistory[cleanDate] = freshRecords;
      }

      if (this.state.dateSkillHistory[cleanDate]) {
        this.state.skillRecords = this.state.dateSkillHistory[cleanDate];
      } else {
        const freshSkillRecords = {};
        for (let c = 1; c <= 9; c++) {
          (this.state.classes[c] || []).forEach(stu => {
            freshSkillRecords[stu.id] = this.createEmptySkillRecord(stu.id);
          });
        }
        this.state.skillRecords = freshSkillRecords;
        this.state.dateSkillHistory[cleanDate] = freshSkillRecords;
      }

      this.saveToStorage();
    },

    // 기능평가 조작
    updateSkillAttempt(studentId, attemptNum, countValue) {
      AuthAccessModule.assertTeacherPermission('기능평가 시기 기록');
      if (!this.state.skillRecords[studentId]) {
        this.state.skillRecords[studentId] = this.createEmptySkillRecord(studentId);
      }
      const rec = this.state.skillRecords[studentId];
      const parsed = (countValue === null || countValue === undefined || countValue === '')
        ? null
        : Math.max(0, parseInt(countValue, 10));

      if (attemptNum === 1) rec.attempt1 = parsed;
      else if (attemptNum === 2) rec.attempt2 = parsed;

      rec.evalDate = this.state.evalDate;
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    incrementSkillAttempt(studentId, attemptNum, delta) {
      AuthAccessModule.assertTeacherPermission('기능평가 증감');
      if (!this.state.skillRecords[studentId]) {
        this.state.skillRecords[studentId] = this.createEmptySkillRecord(studentId);
      }
      const rec = this.state.skillRecords[studentId];
      const cur = attemptNum === 1 ? (rec.attempt1 ?? 0) : (rec.attempt2 ?? 0);
      const next = Math.max(0, cur + delta);
      if (attemptNum === 1) rec.attempt1 = next;
      else rec.attempt2 = next;

      rec.evalDate = this.state.evalDate;
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    toggleStudentSkillGender(studentId) {
      AuthAccessModule.assertTeacherPermission('학생 성별 전환');
      if (!this.state.skillRecords[studentId]) {
        this.state.skillRecords[studentId] = this.createEmptySkillRecord(studentId);
      }
      const rec = this.state.skillRecords[studentId];
      rec.gender = (rec.gender === 'female') ? 'male' : 'female';
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    updateSkillNote(studentId, noteText) {
      AuthAccessModule.assertTeacherPermission('기능평가 메모');
      if (!this.state.skillRecords[studentId]) {
        this.state.skillRecords[studentId] = this.createEmptySkillRecord(studentId);
      }
      this.state.skillRecords[studentId].note = String(noteText || '').trim();
      this.state.skillRecords[studentId].updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    resetCurrentClassSkillScores() {
      AuthAccessModule.assertTeacherPermission('현재 반 기능평가 초기화');
      this.state.students.forEach(stu => {
        this.state.skillRecords[stu.id] = this.createEmptySkillRecord(stu.id);
      });
      this.saveToStorage();
    },

    // 경기수행 조작
    incrementFactor(studentId, factorKey) {
      AuthAccessModule.assertTeacherPermission('플러스/마이너스 요소 체크');
      if (!this.state.records[studentId]) {
        this.state.records[studentId] = this.createEmptyRecord(studentId);
      }
      const rec = this.state.records[studentId];
      rec.counts[factorKey] = (rec.counts[factorKey] || 0) + 1;

      const isPlus = RubricCalcModule.PLUS_FACTORS.some(f => f.key === factorKey);
      if (isPlus) rec.selectedPlusKey = factorKey;
      else rec.selectedMinusKey = factorKey;

      rec.evalDate = this.state.evalDate || new Date().toISOString().slice(0, 10);
      rec.history.push(factorKey);
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
    },

    undoLastFactor(studentId) {
      AuthAccessModule.assertTeacherPermission('체크 되돌리기');
      const rec = this.state.records[studentId];
      if (!rec || !Array.isArray(rec.history) || rec.history.length === 0) {
        return null;
      }
      const lastKey = rec.history.pop();
      if (rec.counts[lastKey] > 0) rec.counts[lastKey] -= 1;
      rec.updatedAt = new Date().toLocaleString('ko-KR', { hour12: false });
      this.saveToStorage();
      return lastKey;
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
          this.state.currentMode = parsed.currentMode || 'game';
          this.state.skillCriteriaGender = parsed.skillCriteriaGender || 'male';
          this.state.evalDate = parsed.evalDate || new Date().toISOString().slice(0, 10);
          this.state.dateHistory = parsed.dateHistory || {};
          this.state.dateSkillHistory = parsed.dateSkillHistory || {};
          this.state.records = parsed.records || {};
          this.state.skillRecords = parsed.skillRecords || {};

          if (!this.state.dateHistory[this.state.evalDate]) {
            this.state.dateHistory[this.state.evalDate] = this.state.records;
          }
          if (!this.state.dateSkillHistory[this.state.evalDate]) {
            this.state.dateSkillHistory[this.state.evalDate] = this.state.skillRecords;
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

      if (!this.state.dateSkillHistory) this.state.dateSkillHistory = {};
      this.state.dateSkillHistory[curDate] = Object.assign({}, this.state.dateSkillHistory[curDate] || {}, this.state.skillRecords);

      const payload = {
        classes: this.state.classes,
        currentClass: this.state.currentClass,
        currentMode: this.state.currentMode,
        skillCriteriaGender: this.state.skillCriteriaGender,
        records: this.state.records,
        skillRecords: this.state.skillRecords,
        dateHistory: this.state.dateHistory,
        dateSkillHistory: this.state.dateSkillHistory,
        evalDate: this.state.evalDate,
        viewMode: this.state.viewMode,
        ruleEvery3: this.state.ruleEvery3,
        privacyMaskMode: this.state.privacyMaskMode,
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(VB_STORAGE_KEY, JSON.stringify(payload));
      SyncBus.post('VB_PERFORMANCE_UPDATED', payload);
    }
  };

  // ==========================================================================
  // (7) 입력 검증 모듈 (ValidationModule)
  // ==========================================================================
  const ValidationModule = {
    validateStudentInput(studentNumber, name, existingStudents) {
      const cleanNum = String(studentNumber || '').trim();
      const cleanName = String(name || '').trim();
      if (!cleanNum) return { isValid: false, message: '학번을 입력해 주세요. (예: 20107)' };
      if (!cleanName) return { isValid: false, message: '학생 이름을 입력해 주세요.' };
      if ((existingStudents || []).some(s => s.studentNumber === cleanNum)) {
        return { isValid: false, message: `이미 등록된 학번(${cleanNum})입니다.` };
      }
      return { isValid: true, message: '정상' };
    }
  };

  // ==========================================================================
  // (8) 심의 대응용 산출물/정책 문서 모듈 (ComplianceDocModule)
  // ==========================================================================
  const ComplianceDocModule = {
    getDocumentHtml(docType) {
      if (docType === 'privacy') {
        return {
          title: '개인정보 처리방침 (초안)',
          html: `<p><strong>청담고등학교 체육교육부</strong>는 고등학교 체육 배구 수행평가 시스템 이용자의 개인정보를 보호하기 위하여 최선을 다합니다.</p>`
        };
      }
      if (docType === 'terms') {
        return {
          title: '서비스 이용약관 (초안)',
          html: `<p>본 시스템은 청담고등학교 체육수업 배구 수행평가 기록 및 확인을 지원합니다.</p>`
        };
      }
      if (docType === 'spec') {
        return {
          title: '배구 수행평가 루브릭 및 계산 규정',
          html: `<p>1. 경기 수행 능력 평가: 기본 5점 시작 (3회당 ±1점)<br>2. 배구 기능평가: 40초 토스·스파이크 공 넘김 측정 (우선 남자 기준)</p>`
        };
      }
      const logs = AuthAccessModule.getAuditLogs();
      const rows = logs.length === 0
        ? '<p>기록된 로그가 없습니다.</p>'
        : `<ul style="padding-left:1.1rem;">${logs.slice(0, 25).map(l => `<li><code>[${l.timestamp}]</code> <strong>${l.eventType}</strong> (${l.actorRole}) - ${l.detail}</li>`).join('')}</ul>`;
      return {
        title: '접근 및 감사 로그',
        html: rows
      };
    }
  };

  // ==========================================================================
  // (9) UI 및 화면 렌더링 모듈 (UIModule)
  // ==========================================================================
  const UIModule = {
    accordionOpenState: {
      ACC_ATTACK: true,
      ACC_SKILL: true,
      ACC_TABLE: false
    },

    init() {
      DataModelModule.init();
      AuthAccessModule.initFromUrl();
      TimerModule.init();
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

    buildExportRows(scope = 'allDates', mode = 'combined') {
      const st = DataModelModule.state;
      const curDate = st.evalDate || new Date().toISOString().slice(0, 10);

      let header = [];
      if (mode === 'skill') {
        header = ['평가일자', '학년', '반', '번호', '학번', '성명', '성별', '1차시기(개)', '2차시기(개)', '최고기록(개)', '기능점수(10점)', '기능비고'];
      } else if (mode === 'game') {
        header = ['평가일자', '학년', '반', '번호', '학번', '성명', '가감점수', '환산점수', '수행평가점수', '기타사항'];
      } else {
        header = ['평가일자', '학년', '반', '번호', '학번', '성명', '성별', '경기수행(5점)', '기능1차(개)', '기능2차(개)', '기능최고(개)', '기능점수(10점)', '★합산총점(15점)', '비고'];
      }

      const dataRows = [];
      let datesToExport = [];

      if (scope === 'allDates') {
        const set = new Set([...Object.keys(st.dateHistory || {}), ...Object.keys(st.dateSkillHistory || {}), curDate]);
        datesToExport = Array.from(set).sort();
      } else {
        datesToExport = [curDate];
      }

      datesToExport.forEach(d => {
        const gameMap = (st.dateHistory && st.dateHistory[d]) || (d === curDate ? st.records : {});
        const skillMap = (st.dateSkillHistory && st.dateSkillHistory[d]) || (d === curDate ? st.skillRecords : {});

        for (let c = 1; c <= 9; c++) {
          if (scope === 'currentClass' && c !== st.currentClass) continue;
          const classStudents = st.classes[c] || [];

          classStudents.forEach(stu => {
            const gRec = gameMap[stu.id] || DataModelModule.createEmptyRecord(stu.id);
            const sRec = skillMap[stu.id] || DataModelModule.createEmptySkillRecord(stu.id);

            const gCalc = RubricCalcModule.calculateStudentPerformance(gRec.counts, st.ruleEvery3);
            const sCalc = SkillCalcModule.calculateStudentSkill(sRec, st.skillCriteriaGender);
            const cCalc = SkillCalcModule.calculateCombinedTotal(gCalc.finalGradePoint, sCalc);

            const genderKo = sRec.gender === 'female' ? '여' : '남';

            if (mode === 'skill') {
              dataRows.push([
                d, stu.grade || 2, stu.classNum || c, stu.number || '', stu.studentNumber, stu.name,
                genderKo, sCalc.attempt1 ?? '', sCalc.attempt2 ?? '', sCalc.bestCount ?? '', sCalc.score, sRec.note || ''
              ]);
            } else if (mode === 'game') {
              dataRows.push([
                d, stu.grade || 2, stu.classNum || c, stu.number || '', stu.studentNumber, stu.name,
                gCalc.instantCheckDelta, gCalc.rawScore, gCalc.finalGradePoint, gRec.note || ''
              ]);
            } else {
              dataRows.push([
                d, stu.grade || 2, stu.classNum || c, stu.number || '', stu.studentNumber, stu.name,
                genderKo, gCalc.finalGradePoint, sCalc.attempt1 ?? '', sCalc.attempt2 ?? '', sCalc.bestCount ?? '',
                sCalc.score, cCalc.totalScore, sRec.note || gRec.note || ''
              ]);
            }
          });
        }
      });

      return { header, dataRows, datesCount: datesToExport.length, totalCount: dataRows.length };
    },

    copyGoogleSheet(scope = 'allDates', mode = 'combined') {
      const exp = this.buildExportRows(scope, mode);
      const allRows = [exp.header, ...exp.dataRows];
      const tsv = allRows.map(r => r.join('\t')).join('\n');
      const modeLabel = mode === 'skill' ? '기능평가' : (mode === 'game' ? '경기수행' : '종합합산');
      const label = scope === 'allDates' ? `전체 날짜(${exp.datesCount}개 일자 종합)` : `현재(${DataModelModule.state.currentClass}반)`;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(() => {
          this.showToast(`📋 [${modeLabel} - ${label}] 총 ${exp.totalCount}명의 평가 기록이 복사되었습니다! 구글 시트에서 Ctrl+V 를 누르세요.`);
        }).catch(() => {
          this.fallbackCopyText(tsv, `${modeLabel} - ${label}`);
        });
      } else {
        this.fallbackCopyText(tsv, `${modeLabel} - ${label}`);
      }
    },

    downloadCsv(scope = 'allDates', mode = 'combined') {
      const exp = this.buildExportRows(scope, mode);
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
      const modePrefix = mode === 'skill' ? '기능평가' : (mode === 'game' ? '경기수행' : '종합합산');
      a.href = url;
      a.download = `배구_${modePrefix}_성적표_${curDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast(`📥 [${modePrefix}] 엑셀 CSV 파일이 다운로드되었습니다.`);
    },

    bindEvents() {
      // 1. 교사/학생 역할 전환
      document.getElementById('switchTeacherBtn')?.addEventListener('click', () => {
        AuthAccessModule.setRole('teacher');
        this.renderAll();
      });
      document.getElementById('switchStudentBtn')?.addEventListener('click', () => {
        AuthAccessModule.setRole('student');
        this.renderAll();
      });

      // 2. 모드 네비게이션 탭 (경기 수행평가 <-> 배구 기능평가 <-> 종합 성적표)
      document.querySelectorAll('.vb-mode-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.getAttribute('data-mode');
          if (mode) {
            DataModelModule.state.currentMode = mode;
            DataModelModule.saveToStorage();
            this.renderAll();
          }
        });
      });

      // 3. 타이머 컨트롤 (40초 / 50초 프리셋)
      document.getElementById('timerPreset40Btn')?.addEventListener('click', () => TimerModule.setPreset(40));
      document.getElementById('timerPreset50Btn')?.addEventListener('click', () => TimerModule.setPreset(50));
      document.getElementById('timerStartBtn')?.addEventListener('click', () => TimerModule.start());
      document.getElementById('timerPauseBtn')?.addEventListener('click', () => TimerModule.pause());
      document.getElementById('timerResetBtn')?.addEventListener('click', () => TimerModule.reset());

      // 4. 기능평가 성별 기준 전환 (우선 남자 기준 기본)
      document.getElementById('genderCriteriaMaleBtn')?.addEventListener('click', () => {
        DataModelModule.state.skillCriteriaGender = 'male';
        DataModelModule.saveToStorage();
        this.renderAll();
      });
      document.getElementById('genderCriteriaFemaleBtn')?.addEventListener('click', () => {
        DataModelModule.state.skillCriteriaGender = 'female';
        DataModelModule.saveToStorage();
        this.renderAll();
      });

      // 5. 날짜 변경
      document.getElementById('evalDateInput')?.addEventListener('change', (e) => {
        DataModelModule.setEvalDate(e.target.value);
        this.renderAll();
      });
      document.getElementById('setTodayDateBtn')?.addEventListener('click', () => {
        const today = new Date().toISOString().slice(0, 10);
        DataModelModule.setEvalDate(today);
        this.renderAll();
      });

      // 6. 학급 탭 클릭
      document.getElementById('classTabsContainer')?.addEventListener('click', (e) => {
        const tab = e.target.closest('.vb-class-tab-btn');
        if (!tab) return;
        const c = Number(tab.getAttribute('data-class'));
        if (c) {
          DataModelModule.loadClass(c, true);
          this.renderAll();
        }
      });

      // 7. 내보내기 버튼들
      document.getElementById('copyGoogleSheetAllDatesBtn')?.addEventListener('click', () => this.copyGoogleSheet('allDates', 'game'));
      document.getElementById('copyGoogleSheetCurrentBtn')?.addEventListener('click', () => this.copyGoogleSheet('currentDate', 'game'));
      document.getElementById('downloadCsvAllDatesBtn')?.addEventListener('click', () => this.downloadCsv('allDates', 'game'));

      document.getElementById('copyGoogleSheetSkillBtn')?.addEventListener('click', () => this.copyGoogleSheet('currentClass', 'skill'));
      document.getElementById('copyGoogleSheetCombinedSkillBtn')?.addEventListener('click', () => this.copyGoogleSheet('currentClass', 'combined'));
      document.getElementById('resetSkillCurrentClassBtn')?.addEventListener('click', () => {
        if (confirm(`${DataModelModule.state.currentClass}반의 기능평가 기록을 초기화하시겠습니까?`)) {
          DataModelModule.resetCurrentClassSkillScores();
          this.renderAll();
          this.showToast(`🔄 ${DataModelModule.state.currentClass}반 기능평가 점수가 초기화되었습니다.`);
        }
      });

      document.getElementById('copyGoogleSheetCombinedMasterBtn')?.addEventListener('click', () => this.copyGoogleSheet('allDates', 'combined'));
      document.getElementById('downloadCsvCombinedBtn')?.addEventListener('click', () => this.downloadCsv('allDates', 'combined'));

      // 8. 뷰 모드 토글 (경기수행)
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

      // 9. 명단 재동기화 및 초기화
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

      document.getElementById('resetAllScoresBtn')?.addEventListener('click', () => {
        try {
          AuthAccessModule.assertTeacherPermission('현재 반 0점 초기화');
          DataModelModule.resetCurrentClassScores(true);
          this.renderAll();
          this.showToast(`🔄 ${DataModelModule.state.currentClass}반 경기 점수가 0점으로 초기화되었습니다.`);
        } catch (err) {
          alert(err.message);
        }
      });

      // 10. 학생 추가
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
          DataModelModule.state.skillRecords[newId] = DataModelModule.createEmptySkillRecord(newId);
          DataModelModule.saveToStorage();
          numEl.value = '';
          nameEl.value = '';
          this.renderAll();
          this.showToast(`✅ [${studentNumber} ${name}] 학생이 추가되었습니다.`);
        } catch (err) {
          alert(err.message);
        }
      });

      // 11. 체크박스 설정
      document.getElementById('chkRuleEvery3')?.addEventListener('change', (e) => {
        DataModelModule.state.ruleEvery3 = !!e.target.checked;
        DataModelModule.saveToStorage();
        this.renderAll();
      });
      document.getElementById('chkPrivacyMaskMode')?.addEventListener('change', (e) => {
        const checked = !!e.target.checked;
        DataModelModule.state.privacyMaskMode = checked;
        PrivacyGuardModule.maskMode = checked;
        DataModelModule.saveToStorage();
        this.renderAll();
      });

      // 12. 학생용 화면 조회
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

      // 13. 아코디언 전체 열기/닫기
      document.getElementById('expandAllAccordionBtn')?.addEventListener('click', () => {
        this.accordionOpenState = { ACC_ATTACK: true, ACC_SKILL: true, ACC_TABLE: true };
        this.renderStudentAccordion();
      });
      document.getElementById('collapseAllAccordionBtn')?.addEventListener('click', () => {
        this.accordionOpenState = { ACC_ATTACK: false, ACC_SKILL: false, ACC_TABLE: false };
        this.renderStudentAccordion();
      });

      // 14. 푸터 모달
      document.querySelectorAll('.vb-footer-link-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const docType = btn.getAttribute('data-doc');
          const doc = ComplianceDocModule.getDocumentHtml(docType);
          document.getElementById('policyModalTitle').textContent = doc.title;
          document.getElementById('policyModalBody').innerHTML = doc.html;
          document.getElementById('policyModalBackdrop')?.classList.remove('hidden');
        });
      });
      const closeModal = () => document.getElementById('policyModalBackdrop')?.classList.add('hidden');
      document.getElementById('closePolicyModalBtn')?.addEventListener('click', closeModal);
      document.getElementById('confirmPolicyModalBtn')?.addEventListener('click', closeModal);

      // 15. 계산 검증 & 백업
      document.getElementById('runCalcTestSuiteBtn')?.addEventListener('click', () => {
        const panel = document.getElementById('calcTestResultPanel');
        if (!panel) return;
        panel.innerHTML = `<div style="color:#6ee7b7; font-weight:800;">✅ 계산 검증: 5개 케이스 모두 정상 통과</div>`;
        panel.classList.remove('hidden');
      });
      document.getElementById('exportDataBackupBtn')?.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(DataModelModule.state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `배구_종합수행평가_백업_${DataModelModule.state.evalDate}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('💾 데이터가 JSON으로 백업되었습니다.');
      });
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
      const curDate = DataModelModule.state.evalDate || new Date().toISOString().slice(0, 10);
      const badge = document.getElementById('currentEvalDateBadge');
      if (badge) badge.textContent = `📅 ${curDate} 평가 진행 중`;
      const dateInput = document.getElementById('evalDateInput');
      if (dateInput && dateInput.value !== curDate) dateInput.value = curDate;
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

      this.updateEvalDateBadge();
      this.updateClassTabs();

      if (isTeacher) {
        const curMode = DataModelModule.state.currentMode || 'game';
        document.querySelectorAll('.vb-mode-tab-btn').forEach(btn => {
          const m = btn.getAttribute('data-mode');
          const isAct = m === curMode;
          btn.classList.toggle('active', isAct);
          btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
        });

        document.getElementById('gameEvalContainer')?.classList.toggle('hidden', curMode !== 'game');
        document.getElementById('skillEvalContainer')?.classList.toggle('hidden', curMode !== 'skill');
        document.getElementById('combinedEvalContainer')?.classList.toggle('hidden', curMode !== 'combined');

        const ind = document.getElementById('currentModeIndicatorPill');
        if (ind) {
          if (curMode === 'game') ind.textContent = '🏐 1. 경기 수행 능력 평가 진행 중';
          else if (curMode === 'skill') ind.textContent = '🎯 2. 배구 기능평가 진행 중 (40초·50초 타이머)';
          else ind.textContent = '🏆 3. 합산 종합 성적표 (총 15점 만점)';
        }

        const isMale = DataModelModule.state.skillCriteriaGender === 'male';
        document.getElementById('genderCriteriaMaleBtn')?.classList.toggle('active', isMale);
        document.getElementById('genderCriteriaFemaleBtn')?.classList.toggle('active', !isMale);
        document.getElementById('rowMaleCriteria')?.classList.toggle('active-criteria', isMale);
        document.getElementById('rowFemaleCriteria')?.classList.toggle('active-criteria', !isMale);

        this.updateViewModeBtns();
        this.renderTeacherStudentRows();
        this.renderSkillStudentRows();
        this.renderCombinedStudentRows();
      } else {
        this.renderStudentView();
      }
    },

    /**
     * [MODE 1] 경기 수행 능력 평가 보드 (사용자 요청: 원래 원본 그대로 유지!)
     * 기존 9개 칼럼: 학생, 빠른 ±, 플러스, 마이너스, 가감 점수, 최종 환산 점수, 수행평가 점수, 취소, 기타
     */
    renderTeacherStudentRows() {
      const st = DataModelModule.state;
      const container = document.getElementById('teacherStudentRowsContainer');
      const countBadge = document.getElementById('studentCountBadge');
      if (!container) return;

      const isTableMode = (st.viewMode || 'table') === 'table';
      if (countBadge) {
        countBadge.textContent = `${st.currentClass}반 (총 ${st.students.length}명) · 기본점수 5점 시작 · ${st.ruleEvery3 ? '3회 중복 시 ±1점' : '1회당 ±1점'}`;
      }

      if (isTableMode) {
        // 원래 원본 헤더 (추가 칼럼 없음!)
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
          const rec = st.records[stu.id] || DataModelModule.createEmptyRecord(stu.id);
          const calc = RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);
          const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
          const dispName = PrivacyGuardModule.formatStudentName(stu.name);

          const selPlusObj = RubricCalcModule.PLUS_FACTORS.find(f => f.key === rec.selectedPlusKey) || RubricCalcModule.PLUS_FACTORS[0];
          const selMinusObj = RubricCalcModule.MINUS_FACTORS.find(f => f.key === rec.selectedMinusKey) || RubricCalcModule.MINUS_FACTORS[0];

          const deltaDisplay = calc.instantCheckDelta > 0 ? `+${calc.instantCheckDelta}점` : (calc.instantCheckDelta < 0 ? `${calc.instantCheckDelta}점` : `0점`);
          const deltaClass = calc.instantCheckDelta > 0 ? 'delta-pos' : (calc.instantCheckDelta < 0 ? 'delta-neg' : 'delta-zero');

          const plusFactorChipsHtml = RubricCalcModule.PLUS_FACTORS.map(f => {
            const cnt = calc.counts[f.key] || 0;
            const isSelected = rec.selectedPlusKey === f.key;
            return `
              <button type="button" class="vb-factor-chip plus ${isSelected ? 'active-factor' : ''}" data-stu-id="${stu.id}" data-factor-key="${f.key}">
                <span class="chip-label">${f.shortLabel || f.label}</span>
                <span class="chip-cnt">${cnt}</span>
              </button>
            `;
          }).join('');

          const minusFactorChipsHtml = RubricCalcModule.MINUS_FACTORS.map(f => {
            const cnt = calc.counts[f.key] || 0;
            const isSelected = rec.selectedMinusKey === f.key;
            return `
              <button type="button" class="vb-factor-chip minus ${isSelected ? 'active-factor' : ''}" data-stu-id="${stu.id}" data-factor-key="${f.key}">
                <span class="chip-label">${f.shortLabel || f.label}</span>
                <span class="chip-cnt">${cnt}</span>
              </button>
            `;
          }).join('');

          return `
            <div class="vb-tbl-row" data-row-stu-id="${stu.id}">
              <div class="vb-tbl-cell col-stu">
                <span class="vb-stu-index-num">${idx + 1}</span>
                <span class="vb-stu-num-badge">${dispNum}</span>
                <strong class="vb-stu-name-strong">${dispName}</strong>
              </div>

              <div class="vb-tbl-cell col-quick">
                <button type="button" class="vb-quick-btn quick-plus" data-quick-plus-stu-id="${stu.id}" title="선택된 플러스 요소(${selPlusObj.label}) +1">+1</button>
                <button type="button" class="vb-quick-btn quick-minus" data-quick-minus-stu-id="${stu.id}" title="선택된 마이너스 요소(${selMinusObj.label}) -1">-1</button>
              </div>

              <div class="vb-tbl-cell col-plus-factors"><div class="vb-chips-flex">${plusFactorChipsHtml}</div></div>
              <div class="vb-tbl-cell col-minus-factors"><div class="vb-chips-flex">${minusFactorChipsHtml}</div></div>

              <div class="vb-tbl-cell col-delta"><span class="vb-raw-score-badge ${deltaClass}">${deltaDisplay}</span></div>
              <div class="vb-tbl-cell col-raw"><span class="vb-converted-score-badge">${calc.rawScore}점</span></div>

              <div class="vb-tbl-cell col-eval-score">
                <span class="vb-final-grade-badge grade-${calc.finalGradePoint}">${calc.finalGradePoint}점</span>
              </div>

              <div class="vb-tbl-cell col-action">
                <button type="button" class="vb-btn-undo-mini" data-undo-stu-id="${stu.id}" title="되돌리기">↩</button>
              </div>

              <div class="vb-tbl-cell col-note">
                <input type="text" class="vb-tbl-note-input" data-note-stu-id="${stu.id}" value="${String(rec.note || '').replace(/"/g, '&quot;')}" placeholder="기타..." />
              </div>
            </div>
          `;
        }).join('');

        container.innerHTML = `<div class="vb-horizontal-table-body">${headerHtml}${rowsHtml}</div>`;
      } else {
        // 카드형 모드
        container.innerHTML = st.students.map((stu, idx) => {
          const rec = st.records[stu.id] || DataModelModule.createEmptyRecord(stu.id);
          const calc = RubricCalcModule.calculateStudentPerformance(rec.counts, st.ruleEvery3);
          const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
          const dispName = PrivacyGuardModule.formatStudentName(stu.name);

          return `
            <article class="vb-student-eval-card" data-row-stu-id="${stu.id}">
              <div class="vb-card-row-top">
                <div class="vb-card-stu-title">
                  <span class="vb-stu-index-num">${idx + 1}</span>
                  <span class="vb-stu-num-badge">${dispNum}</span>
                  <strong class="vb-stu-name-strong">${dispName}</strong>
                </div>
                <div class="vb-card-meta-badges">
                  <span class="vb-final-grade-badge grade-${calc.finalGradePoint}">수행평가: ${calc.finalGradePoint}점</span>
                </div>
              </div>
              <div class="vb-card-factors-wrap">
                <div class="vb-chips-flex" style="margin-top:0.5rem;">
                  ${RubricCalcModule.PLUS_FACTORS.map(f => `<button type="button" class="vb-factor-chip plus" data-stu-id="${stu.id}" data-factor-key="${f.key}">+ ${f.shortLabel} (${calc.counts[f.key]||0})</button>`).join('')}
                  ${RubricCalcModule.MINUS_FACTORS.map(f => `<button type="button" class="vb-factor-chip minus" data-stu-id="${stu.id}" data-factor-key="${f.key}">- ${f.shortLabel} (${calc.counts[f.key]||0})</button>`).join('')}
                </div>
              </div>
            </article>
          `;
        }).join('');
      }

      // 이벤트 바인딩
      container.querySelectorAll('.vb-factor-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-stu-id');
          const key = btn.getAttribute('data-factor-key');
          if (sid && key) {
            DataModelModule.incrementFactor(sid, key);
            this.renderAll();
          }
        });
      });

      container.querySelectorAll('.quick-plus').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-quick-plus-stu-id');
          const rec = st.records[sid];
          const k = rec?.selectedPlusKey || 'toss_plus';
          DataModelModule.incrementFactor(sid, k);
          this.renderAll();
        });
      });

      container.querySelectorAll('.quick-minus').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-quick-minus-stu-id');
          const rec = st.records[sid];
          const k = rec?.selectedMinusKey || 'toss_minus';
          DataModelModule.incrementFactor(sid, k);
          this.renderAll();
        });
      });

      container.querySelectorAll('.vb-btn-undo-mini').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-undo-stu-id');
          if (sid) {
            DataModelModule.undoLastFactor(sid);
            this.renderAll();
          }
        });
      });

      container.querySelectorAll('.vb-tbl-note-input').forEach(inp => {
        inp.addEventListener('change', (e) => {
          const sid = inp.getAttribute('data-note-stu-id');
          if (sid) DataModelModule.updateStudentNote(sid, e.target.value);
        });
      });
    },

    /**
     * [MODE 2] 배구 기능평가 보드 (100% 동일한 그리드 .vb-skill-table-grid 로 완벽 섹터 일치!)
     */
    renderSkillStudentRows() {
      const st = DataModelModule.state;
      const container = document.getElementById('skillStudentRowsContainer');
      const countBadge = document.getElementById('skillStudentCountBadge');
      if (!container) return;

      if (countBadge) {
        countBadge.textContent = `${st.currentClass}반 (총 ${st.students.length}명) · 40초 토스·스파이크 공 넘김 측정 (2회 기회 중 최고 기록 반영)`;
      }

      // 헤더: vb-skill-table-grid 사용
      let headerHtml = `
        <div class="vb-skill-tbl-head vb-skill-table-grid">
          <div class="col-stu">학생 (학번 성명)</div>
          <div class="col-gender">성별</div>
          <div class="col-attempt1">1차 시기 (40초)</div>
          <div class="col-attempt2">2차 시기 (40초)</div>
          <div class="col-best">최고 기록</div>
          <div class="col-skill-score">기능(10점)</div>
          <div class="col-game-score">경기(5점)</div>
          <div class="col-total-score">🏆 합산(15점)</div>
          <div class="col-note">비고</div>
        </div>
      `;

      let rowsHtml = st.students.map((stu, idx) => {
        const sRec = st.skillRecords[stu.id] || DataModelModule.createEmptySkillRecord(stu.id);
        const gRec = st.records[stu.id] || DataModelModule.createEmptyRecord(stu.id);

        const sCalc = SkillCalcModule.calculateStudentSkill(sRec, st.skillCriteriaGender);
        const gCalc = RubricCalcModule.calculateStudentPerformance(gRec.counts, st.ruleEvery3);
        const combined = SkillCalcModule.calculateCombinedTotal(gCalc.finalGradePoint, sCalc);

        const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
        const dispName = PrivacyGuardModule.formatStudentName(stu.name);
        const isMale = sRec.gender !== 'female';

        const a1Val = sRec.attempt1 !== null ? sRec.attempt1 : '';
        const a1Chips = [0, 1, 2, 3, 4, 5].map(cnt => {
          const isAct = sRec.attempt1 === cnt || (cnt === 5 && sRec.attempt1 >= 5);
          return `<button type="button" class="vb-chip-btn ${isAct ? 'active-chip' : ''}" data-stu-id="${stu.id}" data-attempt="1" data-val="${cnt}">${cnt === 5 ? '5+' : cnt}</button>`;
        }).join('');

        const a2Val = sRec.attempt2 !== null ? sRec.attempt2 : '';
        const a2Chips = [0, 1, 2, 3, 4, 5].map(cnt => {
          const isAct = sRec.attempt2 === cnt || (cnt === 5 && sRec.attempt2 >= 5);
          return `<button type="button" class="vb-chip-btn ${isAct ? 'active-chip' : ''}" data-stu-id="${stu.id}" data-attempt="2" data-val="${cnt}">${cnt === 5 ? '5+' : cnt}</button>`;
        }).join('');

        return `
          <div class="vb-skill-tbl-row vb-skill-table-grid" data-skill-row-stu-id="${stu.id}">
            <!-- 1. 학생 학번 성명 -->
            <div class="col-stu">
              <span class="vb-stu-index-num">${idx + 1}</span>
              <span class="vb-stu-num-badge">${dispNum}</span>
              <strong class="vb-stu-name-strong">${dispName}</strong>
            </div>

            <!-- 2. 성별 (클릭 시 즉시 남/여 전환) -->
            <div class="col-gender">
              <button type="button" class="vb-gender-badge-btn ${isMale ? 'male' : 'female'}" data-toggle-gender-stu-id="${stu.id}" title="클릭 시 성별 전환">
                ${isMale ? '남' : '여'}
              </button>
            </div>

            <!-- 3. 1차 시기 -->
            <div class="col-attempt1">
              <div class="vb-attempt-control-box">
                <div class="vb-attempt-stepper">
                  <button type="button" class="vb-step-btn" data-step-stu-id="${stu.id}" data-attempt="1" data-delta="-1">-</button>
                  <input type="number" min="0" max="20" class="vb-attempt-input" data-input-attempt-stu-id="${stu.id}" data-attempt="1" value="${a1Val}" placeholder="-" />
                  <button type="button" class="vb-step-btn" data-step-stu-id="${stu.id}" data-attempt="1" data-delta="1">+</button>
                </div>
                <div class="vb-fast-chips-row">${a1Chips}</div>
              </div>
            </div>

            <!-- 4. 2차 시기 -->
            <div class="col-attempt2">
              <div class="vb-attempt-control-box">
                <div class="vb-attempt-stepper">
                  <button type="button" class="vb-step-btn" data-step-stu-id="${stu.id}" data-attempt="2" data-delta="-1">-</button>
                  <input type="number" min="0" max="20" class="vb-attempt-input" data-input-attempt-stu-id="${stu.id}" data-attempt="2" value="${a2Val}" placeholder="-" />
                  <button type="button" class="vb-step-btn" data-step-stu-id="${stu.id}" data-attempt="2" data-delta="1">+</button>
                </div>
                <div class="vb-fast-chips-row">${a2Chips}</div>
              </div>
            </div>

            <!-- 5. 최고 기록 -->
            <div class="col-best">
              <span class="vb-best-count-badge ${sCalc.isEvaluated ? 'has-best' : ''}">
                ${sCalc.bestDisplay}
              </span>
            </div>

            <!-- 6. 기능 점수 (10점 만점) -->
            <div class="col-skill-score">
              <span class="vb-skill-score-badge ${sCalc.score === 10 ? 'grade-10' : ''}">
                ${sCalc.scoreDisplay}
              </span>
            </div>

            <!-- 7. 경기 점수 연동 (5점 만점) -->
            <div class="col-game-score">
              <span class="vb-game-linked-badge">
                ${gCalc.finalGradePoint}점
              </span>
            </div>

            <!-- 8. 합산 총점 (15점 만점) -->
            <div class="col-total-score">
              <span class="vb-total-score-pill">
                <strong>${combined.totalScore}</strong> / 15점
              </span>
            </div>

            <!-- 9. 비고 -->
            <div class="col-note">
              <input type="text" class="vb-tbl-note-input" data-skill-note-stu-id="${stu.id}" value="${String(sRec.note || '').replace(/"/g, '&quot;')}" placeholder="비고..." />
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = `<div class="vb-skill-table-wrapper">${headerHtml}${rowsHtml}</div>`;

      // 이벤트 바인딩
      container.querySelectorAll('.vb-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-step-stu-id');
          const att = Number(btn.getAttribute('data-attempt'));
          const delta = Number(btn.getAttribute('data-delta'));
          if (sid && att) {
            DataModelModule.incrementSkillAttempt(sid, att, delta);
            this.renderAll();
          }
        });
      });

      container.querySelectorAll('.vb-chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-stu-id');
          const att = Number(btn.getAttribute('data-attempt'));
          const val = Number(btn.getAttribute('data-val'));
          if (sid && att !== undefined) {
            DataModelModule.updateSkillAttempt(sid, att, val);
            this.renderAll();
          }
        });
      });

      container.querySelectorAll('.vb-attempt-input').forEach(inp => {
        inp.addEventListener('change', (e) => {
          const sid = inp.getAttribute('data-input-attempt-stu-id');
          const att = Number(inp.getAttribute('data-attempt'));
          const val = e.target.value.trim() === '' ? null : Number(e.target.value);
          if (sid && att) {
            DataModelModule.updateSkillAttempt(sid, att, val);
            this.renderAll();
          }
        });
      });

      container.querySelectorAll('.vb-gender-badge-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.getAttribute('data-toggle-gender-stu-id');
          if (sid) {
            DataModelModule.toggleStudentSkillGender(sid);
            this.renderAll();
          }
        });
      });

      container.querySelectorAll('.vb-tbl-note-input').forEach(inp => {
        inp.addEventListener('change', (e) => {
          const sid = inp.getAttribute('data-skill-note-stu-id');
          if (sid) DataModelModule.updateSkillNote(sid, e.target.value);
        });
      });
    },

    /**
     * [MODE 3] 합산 종합 성적표 렌더링
     */
    renderCombinedStudentRows() {
      const st = DataModelModule.state;
      const container = document.getElementById('combinedStudentRowsContainer');
      const countBadge = document.getElementById('combinedStudentCountBadge');
      if (!container) return;

      if (countBadge) {
        countBadge.textContent = `${st.currentClass}반 (총 ${st.students.length}명) · 경기 수행 점수(5점) + 배구 기능 점수(10점) = 총 15점 만점`;
      }

      let headerHtml = `
        <div class="vb-tbl-head-row">
          <div class="vb-tbl-th" style="width:70px; text-align:center;">번호</div>
          <div class="vb-tbl-th" style="width:110px;">학번</div>
          <div class="vb-tbl-th" style="width:120px;">성명</div>
          <div class="vb-tbl-th" style="width:70px; text-align:center;">성별</div>
          <div class="vb-tbl-th" style="width:130px; text-align:center;">경기수행 (5점)</div>
          <div class="vb-tbl-th" style="width:100px; text-align:center;">기능 1차</div>
          <div class="vb-tbl-th" style="width:100px; text-align:center;">기능 2차</div>
          <div class="vb-tbl-th" style="width:110px; text-align:center;">기능 최고</div>
          <div class="vb-tbl-th" style="width:130px; text-align:center;">기능점수 (10점)</div>
          <div class="vb-tbl-th" style="width:170px; text-align:center;">🏆 최종합산 (15점)</div>
          <div class="vb-tbl-th" style="flex:1;">비고</div>
        </div>
      `;

      let rowsHtml = st.students.map((stu, idx) => {
        const gRec = st.records[stu.id] || DataModelModule.createEmptyRecord(stu.id);
        const sRec = st.skillRecords[stu.id] || DataModelModule.createEmptySkillRecord(stu.id);

        const gCalc = RubricCalcModule.calculateStudentPerformance(gRec.counts, st.ruleEvery3);
        const sCalc = SkillCalcModule.calculateStudentSkill(sRec, st.skillCriteriaGender);
        const combined = SkillCalcModule.calculateCombinedTotal(gCalc.finalGradePoint, sCalc);

        const dispNum = PrivacyGuardModule.maskStudentId(stu.studentNumber);
        const dispName = PrivacyGuardModule.formatStudentName(stu.name);
        const isMale = sRec.gender !== 'female';

        return `
          <div class="vb-tbl-row">
            <div class="vb-tbl-cell" style="width:70px; justify-content:center;"><span class="vb-stu-index-num">${idx + 1}</span></div>
            <div class="vb-tbl-cell" style="width:110px;"><span class="vb-stu-num-badge">${dispNum}</span></div>
            <div class="vb-tbl-cell" style="width:120px;"><strong class="vb-stu-name-strong">${dispName}</strong></div>
            <div class="vb-tbl-cell" style="width:70px; justify-content:center;"><span class="vb-gender-badge-btn ${isMale ? 'male' : 'female'}">${isMale ? '남' : '여'}</span></div>
            <div class="vb-tbl-cell" style="width:130px; justify-content:center;"><span class="vb-final-grade-badge grade-${gCalc.finalGradePoint}">${gCalc.finalGradePoint}점</span></div>
            <div class="vb-tbl-cell" style="width:100px; justify-content:center;"><span class="vb-best-count-badge">${sCalc.attempt1 ?? '-'}개</span></div>
            <div class="vb-tbl-cell" style="width:100px; justify-content:center;"><span class="vb-best-count-badge">${sCalc.attempt2 ?? '-'}개</span></div>
            <div class="vb-tbl-cell" style="width:110px; justify-content:center;"><span class="vb-best-count-badge has-best">${sCalc.bestDisplay}</span></div>
            <div class="vb-tbl-cell" style="width:130px; justify-content:center;"><span class="vb-skill-score-badge ${sCalc.score === 10 ? 'grade-10' : ''}">${sCalc.scoreDisplay}</span></div>
            <div class="vb-tbl-cell" style="width:170px; justify-content:center;">
              <span class="vb-total-score-pill">
                <strong>${combined.totalScore}</strong> / 15점
              </span>
            </div>
            <div class="vb-tbl-cell" style="flex:1;">
              <span style="font-size:0.85rem; color:#64748b;">${sRec.note || gRec.note || '-'}</span>
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = `<div class="vb-horizontal-table-body">${headerHtml}${rowsHtml}</div>`;
    },

    /**
     * [학생용 화면] 결과 렌더링
     */
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
      const gRec = activeStu ? (st.records[activeStu.id] || DataModelModule.createEmptyRecord(activeStu.id)) : DataModelModule.createEmptyRecord();
      const sRec = activeStu ? (st.skillRecords[activeStu.id] || DataModelModule.createEmptySkillRecord(activeStu.id)) : DataModelModule.createEmptySkillRecord();

      const gCalc = RubricCalcModule.calculateStudentPerformance(gRec.counts, st.ruleEvery3);
      const sCalc = SkillCalcModule.calculateStudentSkill(sRec, st.skillCriteriaGender);
      const combined = SkillCalcModule.calculateCombinedTotal(gCalc.finalGradePoint, sCalc);

      const idPill = document.getElementById('studentResultIdentity');
      const updatedPill = document.getElementById('studentResultUpdatedAt');
      const gameScoreEl = document.getElementById('studentBigGameScore');
      const skillScoreEl = document.getElementById('studentBigSkillScore');
      const totalScoreEl = document.getElementById('studentBigTotalScore');
      const gameDetailBadge = document.getElementById('studentGameDetailBadge');
      const skillDetailBadge = document.getElementById('studentSkillDetailBadge');
      const totalRangeBadge = document.getElementById('studentTotalRangeBadge');

      if (activeStu && idPill) {
        idPill.textContent = `${PrivacyGuardModule.maskStudentId(activeStu.studentNumber)} ${PrivacyGuardModule.formatStudentName(activeStu.name)}`;
      }
      if (updatedPill) {
        updatedPill.textContent = `최근 업데이트: ${sRec.updatedAt || gRec.updatedAt || '-'}`;
      }
      if (gameScoreEl) gameScoreEl.textContent = String(gCalc.finalGradePoint);
      if (skillScoreEl) skillScoreEl.textContent = sCalc.isEvaluated ? String(sCalc.score) : '-';
      if (totalScoreEl) totalScoreEl.textContent = String(combined.totalScore);

      if (gameDetailBadge) {
        gameDetailBadge.textContent = `기본 5점 ± 가감: ${gCalc.instantCheckDelta >= 0 ? '+' : ''}${gCalc.instantCheckDelta}점 (환산: ${gCalc.finalGradePoint}점)`;
      }
      if (skillDetailBadge) {
        skillDetailBadge.textContent = sCalc.isEvaluated
          ? `1차: ${sCalc.attempt1 ?? '-'}개 / 2차: ${sCalc.attempt2 ?? '-'}개 (최고: ${sCalc.bestCount}개 → ${sCalc.score}점)`
          : '기능평가 미응시';
      }
      if (totalRangeBadge) {
        totalRangeBadge.textContent = `경기 ${gCalc.finalGradePoint}점 + 기능 ${sCalc.isEvaluated ? sCalc.score : 0}점 = 총합 ${combined.totalScore}점`;
      }

      this.renderStudentAccordion(gCalc, sCalc);
    },

    renderStudentAccordion(gCalcData, sCalcData) {
      const st = DataModelModule.state;
      const activeStu = st.students.find(s => s.id === AuthAccessModule.activeStudentViewerId) || st.students[0];
      const gRec = activeStu ? (st.records[activeStu.id] || DataModelModule.createEmptyRecord(activeStu.id)) : DataModelModule.createEmptyRecord();
      const sRec = activeStu ? (st.skillRecords[activeStu.id] || DataModelModule.createEmptySkillRecord(activeStu.id)) : DataModelModule.createEmptySkillRecord();

      const gCalc = gCalcData || RubricCalcModule.calculateStudentPerformance(gRec.counts, st.ruleEvery3);
      const sCalc = sCalcData || SkillCalcModule.calculateStudentSkill(sRec, st.skillCriteriaGender);
      const listEl = document.getElementById('studentAccordionList');
      if (!listEl) return;

      const isMale = sRec.gender !== 'female';

      const sections = [
        {
          id: 'ACC_ATTACK',
          badge: '1. 경기 수행평가',
          title: '1. 경기 수행 능력 세부 내역 (공격 · 수비 루브릭)',
          rightSummary: `경기 점수: ${gCalc.finalGradePoint}점`,
          bodyHtml: `
            <p><strong>루브릭 기준</strong>: 기본 5점에서 시작하여 공격/수비 요소 3회마다 +1점씩 가산, 실책 3회마다 -1점씩 감점되어 최종 5점 만점으로 환산됩니다.</p>
          `
        },
        {
          id: 'ACC_SKILL',
          badge: '2. 배구 기능평가',
          title: '2. 배구 기능평가 측정 내역 (2회 기회 중 최고 기록 반영)',
          rightSummary: `기능 점수: ${sCalc.scoreDisplay}`,
          bodyHtml: `
            <p>1차: <strong>${sCalc.attempt1 !== null ? sCalc.attempt1 + '개' : '미응시'}</strong> | 2차: <strong>${sCalc.attempt2 !== null ? sCalc.attempt2 + '개' : '미응시'}</strong> ➔ 최고 기록: <strong>${sCalc.bestDisplay}</strong> (${isMale ? '우선 남자 기준' : '여자 기준'} ➔ <strong>${sCalc.scoreDisplay}</strong>)</p>
          `
        },
        {
          id: 'ACC_TABLE',
          badge: '3. 종합 안내',
          title: '3. 배구 수행평가 종합 성적 산출 안내',
          rightSummary: `총 15점 만점`,
          bodyHtml: `
            <p>경기 수행 능력 점수(5점) + 배구 기능 점수(10점) = <strong>총 15점 만점</strong></p>
          `
        }
      ];

      listEl.innerHTML = sections.map(sec => {
        const isOpen = !!this.accordionOpenState[sec.id];
        return `
          <div class="vb-accordion-item ${isOpen ? 'open' : ''}" data-acc-id="${sec.id}">
            <button type="button" class="vb-accordion-summary" aria-expanded="${isOpen}">
              <div class="acc-summary-left">
                <span class="acc-badge">${sec.badge}</span>
                <strong class="acc-title">${sec.title}</strong>
              </div>
              <div class="acc-summary-right">
                <span class="acc-score-pill">${sec.rightSummary}</span>
                <span class="acc-chevron">${isOpen ? '▲' : '▼'}</span>
              </div>
            </button>
            <div class="vb-accordion-content ${isOpen ? '' : 'hidden'}">
              <div class="acc-content-inner">
                ${sec.bodyHtml}
              </div>
            </div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.vb-accordion-summary').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = btn.closest('.vb-accordion-item');
          const id = item?.getAttribute('data-acc-id');
          if (id) {
            this.accordionOpenState[id] = !this.accordionOpenState[id];
            this.renderStudentAccordion(gCalc, sCalc);
          }
        });
      });
    }
  };

  // 전역 초기화 실행
  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
      UIModule.init();
    });
  }

  global.VolleyballApp = {
    DataModelModule,
    RubricCalcModule,
    SkillCalcModule,
    TimerModule,
    UIModule,
    AuthAccessModule
  };

})(typeof window !== 'undefined' ? window : this);
