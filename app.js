/**
 * 학교폭력예방 풋살대회 경기 기록 시스템
 * 핵심 기능 모듈:
 * - Module 1: 1팀(왼쪽) vs 2팀(오른쪽) 2단 레이아웃 & 상단 중앙 스코어보드
 * - Module 2: 15분 정밀 경기 타이머 (Date.now 보정)
 * - Module 3: 실시간 자동 저장 및 세션 관리 (영속화)
 * - Module 4: 교사 관리자 모드 (전체 세션 이력, 백업/삭제)
 * - Module 5: 정책 문서 모달
 */

(function () {
  'use strict';

  // 초기 풋살 5 vs 5 라인업
  const INITIAL_PLAYERS = [
    { id: "p1", name: "선수 1", number: 1, team: "1", goals: 0, assists: 0, fouls: 0 },
    { id: "p2", name: "선수 2", number: 7, team: "1", goals: 0, assists: 0, fouls: 0 },
    { id: "p3", name: "선수 3", number: 9, team: "1", goals: 0, assists: 0, fouls: 0 },
    { id: "p4", name: "선수 4", number: 10, team: "1", goals: 0, assists: 0, fouls: 0 },
    { id: "p5", name: "선수 5", number: 11, team: "1", goals: 0, assists: 0, fouls: 0 },
    { id: "p6", name: "선수 6", number: 1, team: "2", goals: 0, assists: 0, fouls: 0 },
    { id: "p7", name: "선수 7", number: 7, team: "2", goals: 0, assists: 0, fouls: 0 },
    { id: "p8", name: "선수 8", number: 8, team: "2", goals: 0, assists: 0, fouls: 0 },
    { id: "p9", name: "선수 9", number: 10, team: "2", goals: 0, assists: 0, fouls: 0 },
    { id: "p10", name: "선수 10", number: 18, team: "2", goals: 0, assists: 0, fouls: 0 }
  ];

  // =========================================================================
  // 스토리지 엔진
  // =========================================================================
  const StorageModule = {
    KEYS: {
      CURRENT_SESSION_ID: 'futsal_current_session_id',
      SESSIONS_INDEX: 'futsal_sessions_index',
      SESSION_PREFIX: 'futsal_session_'
    },

    saveSession(sessionData) {
      if (!sessionData || !sessionData.sessionId) return false;
      try {
        localStorage.setItem(this.KEYS.SESSION_PREFIX + sessionData.sessionId, JSON.stringify(sessionData));
        let index = this.getAllSessionIds();
        if (!index.includes(sessionData.sessionId)) {
          index.unshift(sessionData.sessionId);
          localStorage.setItem(this.KEYS.SESSIONS_INDEX, JSON.stringify(index));
        }
        localStorage.setItem(this.KEYS.CURRENT_SESSION_ID, sessionData.sessionId);
        return true;
      } catch (err) {
        console.error("저장 오류:", err);
        return false;
      }
    },

    loadSession(sessionId) {
      try {
        const raw = localStorage.getItem(this.KEYS.SESSION_PREFIX + sessionId);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    getAllSessionIds() {
      try {
        const raw = localStorage.getItem(this.KEYS.SESSIONS_INDEX);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    },

    getAllSessions() {
      const ids = this.getAllSessionIds();
      return ids.map(id => this.loadSession(id)).filter(Boolean);
    },

    getCurrentSessionId() {
      return localStorage.getItem(this.KEYS.CURRENT_SESSION_ID);
    },

    deleteSession(sessionId) {
      localStorage.removeItem(this.KEYS.SESSION_PREFIX + sessionId);
      let index = this.getAllSessionIds().filter(id => id !== sessionId);
      localStorage.setItem(this.KEYS.SESSIONS_INDEX, JSON.stringify(index));
    },

    clearAll() {
      const ids = this.getAllSessionIds();
      ids.forEach(id => localStorage.removeItem(this.KEYS.SESSION_PREFIX + id));
      localStorage.removeItem(this.KEYS.SESSIONS_INDEX);
      localStorage.removeItem(this.KEYS.CURRENT_SESSION_ID);
    }
  };

  // =========================================================================
  // 앱 전역 상태
  // =========================================================================
  const State = {
    currentSession: null,
    saveTimerId: null,

    initSession(existingSession = null) {
      if (existingSession) {
        if (!existingSession.team1Name) existingSession.team1Name = "1팀 (블루)";
        if (!existingSession.team2Name) existingSession.team2Name = "2팀 (오렌지)";
        if (existingSession.players) {
          existingSession.players.forEach(p => {
            if (p.team === 'A') p.team = '1';
            if (p.team === 'B') p.team = '2';
          });
        }
        this.currentSession = existingSession;
      } else {
        const newId = 'match_' + Date.now();
        this.currentSession = {
          sessionId: newId,
          createdAt: new Date().toISOString(),
          team1Name: "1팀 (블루)",
          team2Name: "2팀 (오렌지)",
          timer: {
            durationSeconds: 15 * 60,
            remainingSeconds: 15 * 60,
            isRunning: false,
            startedAt: null
          },
          players: JSON.parse(JSON.stringify(INITIAL_PLAYERS))
        };
      }
    }
  };

  // =========================================================================
  // 15분 정밀 타이머
  // =========================================================================
  const TimerModule = {
    intervalId: null,
    minutesElem: null,
    secondsElem: null,
    progressBar: null,
    startBtn: null,
    pauseBtn: null,
    resetBtn: null,
    colonElem: null,

    init() {
      this.minutesElem = document.getElementById('timerMinutes');
      this.secondsElem = document.getElementById('timerSeconds');
      this.progressBar = document.getElementById('timerProgressBar');
      this.startBtn = document.getElementById('startTimerBtn');
      this.pauseBtn = document.getElementById('pauseTimerBtn');
      this.resetBtn = document.getElementById('resetTimerBtn');
      this.colonElem = document.querySelector('.time-colon');

      this.bindEvents();
      this.syncTimerState();
    },

    bindEvents() {
      this.startBtn.addEventListener('click', () => this.start());
      this.pauseBtn.addEventListener('click', () => this.pause());
      this.resetBtn.addEventListener('click', () => this.reset(15 * 60));

      document.getElementById('add1MinBtn').addEventListener('click', () => this.addTime(60));
      document.getElementById('add5MinBtn').addEventListener('click', () => this.addTime(300));
      document.getElementById('newMatchSessionBtn').addEventListener('click', () => {
        if (confirm("새로운 경기 세션을 시작하시겠습니까?\n현재 기록은 보관되며 새 전광판이 시작됩니다.")) {
          App.createNewSession();
        }
      });
    },

    syncTimerState() {
      const timer = State.currentSession.timer;
      if (timer.isRunning && timer.startedAt) {
        const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
        timer.remainingSeconds = Math.max(0, timer.durationSeconds - elapsed);
        if (timer.remainingSeconds > 0) {
          this.start(true);
        } else {
          this.onTimerEnd();
        }
      }
      this.render();
    },

    start(isResume = false) {
      const timer = State.currentSession.timer;
      if (timer.remainingSeconds <= 0) {
        timer.remainingSeconds = 15 * 60;
        timer.durationSeconds = 15 * 60;
      }

      timer.isRunning = true;
      if (!isResume) {
        timer.startedAt = Date.now() - (timer.durationSeconds - timer.remainingSeconds) * 1000;
      }

      this.startBtn.disabled = true;
      this.pauseBtn.disabled = false;
      if (this.colonElem) this.colonElem.classList.remove('paused');

      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => {
        const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
        timer.remainingSeconds = Math.max(0, timer.durationSeconds - elapsed);
        this.render();

        if (timer.remainingSeconds <= 0) {
          this.onTimerEnd();
        }
      }, 500);

      App.scheduleAutoSave();
    },

    pause() {
      const timer = State.currentSession.timer;
      timer.isRunning = false;
      clearInterval(this.intervalId);

      this.startBtn.disabled = false;
      this.pauseBtn.disabled = true;
      if (this.colonElem) this.colonElem.classList.add('paused');

      App.scheduleAutoSave();
    },

    reset(seconds = 15 * 60) {
      const timer = State.currentSession.timer;
      this.pause();
      timer.durationSeconds = seconds;
      timer.remainingSeconds = seconds;
      timer.startedAt = null;
      this.render();
      App.scheduleAutoSave();
    },

    addTime(extraSec) {
      const timer = State.currentSession.timer;
      timer.durationSeconds += extraSec;
      timer.remainingSeconds += extraSec;
      if (timer.isRunning) {
        timer.startedAt += extraSec * 1000;
      }
      this.render();
      App.scheduleAutoSave();
    },

    onTimerEnd() {
      this.pause();
      const timer = State.currentSession.timer;
      timer.remainingSeconds = 0;
      this.render();
      alert("15분 경기 시간이 종료되었습니다!");
      App.scheduleAutoSave();
    },

    render() {
      const timer = State.currentSession.timer;
      const totalSec = Math.max(0, timer.remainingSeconds);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;

      this.minutesElem.textContent = String(m).padStart(2, '0');
      this.secondsElem.textContent = String(s).padStart(2, '0');

      const pct = timer.durationSeconds > 0 ? (totalSec / timer.durationSeconds) * 100 : 0;
      this.progressBar.style.width = `${pct}%`;
    }
  };

  // =========================================================================
  // 1팀(왼쪽)과 2팀(오른쪽) 2단 레이아웃 & 스코어보드 렌더러
  // =========================================================================
  const MatchRecordModule = {
    team1ListElem: null,
    team2ListElem: null,
    team1ScoreElem: null,
    team2ScoreElem: null,
    team1FoulsElem: null,
    team2FoulsElem: null,
    team1NameInput: null,
    team2NameInput: null,
    team1TitleDisplay: null,
    team2TitleDisplay: null,
    team1CountBadge: null,
    team2CountBadge: null,

    init() {
      this.team1ListElem = document.getElementById('team1PlayersList');
      this.team2ListElem = document.getElementById('team2PlayersList');
      this.team1ScoreElem = document.getElementById('team1Score');
      this.team2ScoreElem = document.getElementById('team2Score');
      this.team1FoulsElem = document.getElementById('team1TotalFouls');
      this.team2FoulsElem = document.getElementById('team2TotalFouls');

      this.team1NameInput = document.getElementById('team1NameInput');
      this.team2NameInput = document.getElementById('team2NameInput');
      this.team1TitleDisplay = document.getElementById('team1TitleDisplay');
      this.team2TitleDisplay = document.getElementById('team2TitleDisplay');
      this.team1CountBadge = document.getElementById('team1CountBadge');
      this.team2CountBadge = document.getElementById('team2CountBadge');

      this.bindEvents();
      this.render();
    },

    bindEvents() {
      this.team1NameInput.addEventListener('input', (e) => {
        const val = e.target.value.trim() || "1팀";
        State.currentSession.team1Name = val;
        this.team1TitleDisplay.textContent = val;
        App.scheduleAutoSave();
      });

      this.team2NameInput.addEventListener('input', (e) => {
        const val = e.target.value.trim() || "2팀";
        State.currentSession.team2Name = val;
        this.team2TitleDisplay.textContent = val;
        App.scheduleAutoSave();
      });

      document.getElementById('addPlayer1Btn').addEventListener('click', () => {
        document.getElementById('newPlayerTeamSelect').value = "1";
        document.getElementById('addPlayerModalTitle').textContent = `${State.currentSession.team1Name} 새 선수 등록`;
        document.getElementById('addPlayerModal').classList.remove('hidden');
      });

      document.getElementById('addPlayer2Btn').addEventListener('click', () => {
        document.getElementById('newPlayerTeamSelect').value = "2";
        document.getElementById('addPlayerModalTitle').textContent = `${State.currentSession.team2Name} 새 선수 등록`;
        document.getElementById('addPlayerModal').classList.remove('hidden');
      });

      document.getElementById('closeAddPlayerModalBtn').addEventListener('click', () => {
        document.getElementById('addPlayerModal').classList.add('hidden');
      });
      document.getElementById('cancelAddPlayerBtn').addEventListener('click', () => {
        document.getElementById('addPlayerModal').classList.add('hidden');
      });

      document.getElementById('saveNewPlayerBtn').addEventListener('click', () => {
        this.addNewPlayer();
      });

      const handleStatClick = (e) => {
        const btn = e.target.closest('.btn-ctrl');
        if (!btn) return;
        const playerId = btn.getAttribute('data-player-id');
        const statType = btn.getAttribute('data-stat');
        const change = parseInt(btn.getAttribute('data-change'), 10);
        this.updatePlayerStat(playerId, statType, change, btn);
      };

      this.team1ListElem.addEventListener('click', handleStatClick);
      this.team2ListElem.addEventListener('click', handleStatClick);
    },

    updatePlayerStat(playerId, statType, change, triggerBtn) {
      const player = State.currentSession.players.find(p => p.id === playerId);
      if (!player) return;

      const currentVal = player[statType] || 0;
      const newVal = Math.max(0, currentVal + change);
      if (newVal === currentVal) return;

      player[statType] = newVal;

      const statUnit = triggerBtn.closest('.stat-unit');
      if (statUnit) {
        const valElem = statUnit.querySelector('.stat-num-val');
        if (valElem) {
          valElem.textContent = newVal;
          valElem.classList.add('pop');
          setTimeout(() => valElem.classList.remove('pop'), 180);
        }
      }

      this.updateScoreboardTotals();
      App.scheduleAutoSave();
    },

    updateScoreboardTotals() {
      let score1 = 0, fouls1 = 0;
      let score2 = 0, fouls2 = 0;

      State.currentSession.players.forEach(p => {
        const isTeam1 = (p.team === '1' || p.team === 'A');
        if (isTeam1) {
          score1 += (p.goals || 0);
          fouls1 += (p.fouls || 0);
        } else {
          score2 += (p.goals || 0);
          fouls2 += (p.fouls || 0);
        }
      });

      this.team1ScoreElem.textContent = score1;
      this.team2ScoreElem.textContent = score2;
      this.team1FoulsElem.textContent = fouls1;
      this.team2FoulsElem.textContent = fouls2;
    },

    addNewPlayer() {
      const name = document.getElementById('newPlayerName').value.trim();
      const num = parseInt(document.getElementById('newPlayerNumber').value, 10);
      const team = document.getElementById('newPlayerTeamSelect').value;

      if (!name) {
        alert("선수 이름을 입력해 주세요.");
        return;
      }
      if (isNaN(num) || num < 1 || num > 99) {
        alert("등번호는 1~99 사이의 숫자로 입력해 주세요.");
        return;
      }

      const newPlayer = {
        id: 'p_' + Date.now(),
        name,
        number: num,
        team,
        goals: 0,
        assists: 0,
        fouls: 0
      };

      State.currentSession.players.push(newPlayer);
      document.getElementById('addPlayerModal').classList.add('hidden');
      document.getElementById('newPlayerName').value = '';
      document.getElementById('newPlayerNumber').value = '';

      this.render();
      App.scheduleAutoSave();
    },

    createPlayerCardHtml(player) {
      return `
        <div class="player-card">
          <div class="player-identity">
            <span class="player-num">#${player.number}</span>
            <span class="player-name-text" title="${player.name}">${player.name}</span>
          </div>

          <div class="player-actions-row">
            <!-- 득점 -->
            <div class="stat-unit" title="득점">
              <span class="stat-label-icon">득점</span>
              <span class="stat-num-val">${player.goals}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-player-id="${player.id}" data-stat="goals" data-change="-1" title="득점 -1">-</button>
                <button class="btn-ctrl plus" data-player-id="${player.id}" data-stat="goals" data-change="1" title="득점 +1">+</button>
              </div>
            </div>

            <!-- 도움 -->
            <div class="stat-unit" title="도움">
              <span class="stat-label-icon">도움</span>
              <span class="stat-num-val">${player.assists}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-player-id="${player.id}" data-stat="assists" data-change="-1" title="도움 -1">-</button>
                <button class="btn-ctrl plus" data-player-id="${player.id}" data-stat="assists" data-change="1" title="도움 +1">+</button>
              </div>
            </div>

            <!-- 파울 -->
            <div class="stat-unit" title="파울">
              <span class="stat-label-icon">파울</span>
              <span class="stat-num-val">${player.fouls}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-player-id="${player.id}" data-stat="fouls" data-change="-1" title="파울 -1">-</button>
                <button class="btn-ctrl plus" data-player-id="${player.id}" data-stat="fouls" data-change="1" title="파울 +1">+</button>
              </div>
            </div>
          </div>
        </div>
      `;
    },

    render() {
      const t1Name = State.currentSession.team1Name || "1팀 (블루)";
      const t2Name = State.currentSession.team2Name || "2팀 (오렌지)";

      this.team1NameInput.value = t1Name;
      this.team2NameInput.value = t2Name;
      this.team1TitleDisplay.textContent = t1Name;
      this.team2TitleDisplay.textContent = t2Name;

      const team1Players = State.currentSession.players.filter(p => p.team === '1' || p.team === 'A');
      const team2Players = State.currentSession.players.filter(p => p.team === '2' || p.team === 'B');

      this.team1CountBadge.textContent = `${team1Players.length}명`;
      this.team2CountBadge.textContent = `${team2Players.length}명`;

      this.team1ListElem.innerHTML = team1Players.map(p => this.createPlayerCardHtml(p)).join('');
      this.team2ListElem.innerHTML = team2Players.map(p => this.createPlayerCardHtml(p)).join('');

      this.updateScoreboardTotals();
    }
  };

  // =========================================================================
  // 교사 관리 모드 (조회, 백업, 영구 삭제)
  // =========================================================================
  const TeacherModule = {
    dashboardElem: null,
    tableBody: null,
    isTeacherMode: false,

    init() {
      this.dashboardElem = document.getElementById('teacherDashboard');
      this.tableBody = document.getElementById('sessionTableBody');

      document.getElementById('toggleTeacherModeBtn').addEventListener('click', () => {
        this.toggleMode();
      });

      document.getElementById('exportJsonBtn').addEventListener('click', () => {
        this.exportAllData();
      });

      document.getElementById('importJsonInput').addEventListener('change', (e) => {
        this.importData(e);
      });

      document.getElementById('clearAllDataBtn').addEventListener('click', () => {
        if (confirm("경고: 저장된 모든 경기 기록이 영구 파기됩니다.\n정말 초기화하시겠습니까?")) {
          StorageModule.clearAll();
          App.createNewSession();
          this.renderSessionsList();
          alert("전체 데이터가 영구 파기되었습니다.");
        }
      });
    },

    toggleMode() {
      this.isTeacherMode = !this.isTeacherMode;
      const textElem = document.getElementById('teacherBtnText');
      if (this.isTeacherMode) {
        this.dashboardElem.classList.remove('hidden');
        textElem.textContent = "경기 기록 화면으로 복귀";
        this.renderSessionsList();
      } else {
        this.dashboardElem.classList.add('hidden');
        textElem.textContent = "교사 관리 모드";
      }
    },

    renderSessionsList() {
      this.tableBody.innerHTML = '';
      const sessions = StorageModule.getAllSessions();

      if (sessions.length === 0) {
        this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#8e8e8e; padding: 2rem;">저장된 경기 기록이 없습니다.</td></tr>`;
        return;
      }

      sessions.forEach(s => {
        let score1 = 0, score2 = 0, totalFouls = 0;
        if (s.players) {
          s.players.forEach(p => {
            if (p.team === '1' || p.team === 'A') score1 += (p.goals || 0);
            else score2 += (p.goals || 0);
            totalFouls += (p.fouls || 0);
          });
        }

        const dateStr = s.createdAt ? new Date(s.createdAt).toLocaleString('ko-KR') : '-';
        const t1 = s.team1Name || '1팀';
        const t2 = s.team2Name || '2팀';

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><code>${s.sessionId}</code></td>
          <td>${dateStr}</td>
          <td><strong>${t1} ${score1} : ${score2} ${t2}</strong></td>
          <td>${totalFouls}회</td>
          <td>
            <button class="btn-primary btn-sm load-session-btn" data-id="${s.sessionId}">불러오기</button>
            <button class="btn-danger btn-sm del-session-btn" data-id="${s.sessionId}" style="padding:4px 8px; margin-left:4px;">삭제</button>
          </td>
        `;
        this.tableBody.appendChild(tr);
      });

      this.tableBody.querySelectorAll('.load-session-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.getAttribute('data-id');
          App.loadExistingSession(id);
        });
      });

      this.tableBody.querySelectorAll('.del-session-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.getAttribute('data-id');
          if (confirm("해당 경기 세션을 삭제하시겠습니까?")) {
            StorageModule.deleteSession(id);
            this.renderSessionsList();
          }
        });
      });
    },

    exportAllData() {
      const data = {
        exportedAt: new Date().toISOString(),
        appName: "학교폭력예방 풋살대회",
        sessions: StorageModule.getAllSessions()
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `futsal_tournament_records_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    importData(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (parsed && Array.isArray(parsed.sessions)) {
            parsed.sessions.forEach(s => StorageModule.saveSession(s));
            alert(`총 ${parsed.sessions.length}개의 경기 기록이 성공적으로 복원되었습니다.`);
            this.renderSessionsList();
          } else {
            alert("유효한 백업 JSON 파일이 아닙니다.");
          }
        } catch (err) {
          alert("파일 읽기 오류: " + err.message);
        }
      };
      reader.readAsText(file);
    }
  };

  // =========================================================================
  // 정책 모달 로더
  // =========================================================================
  const PolicyModalModule = {
    init() {
      this.bindModal('openPrivacyModalBtn', 'privacyModal', 'closePrivacyModalBtn', 'confirmPrivacyModalBtn', 'PRIVACY_POLICY.md', 'privacyModalContent');
      this.bindModal('openTermsModalBtn', 'termsModal', 'closeTermsModalBtn', 'confirmTermsModalBtn', 'TERMS_OF_SERVICE.md', 'termsModalContent');

      const secModal = document.getElementById('securityGuideModal');
      document.getElementById('openSecurityGuideModalBtn').addEventListener('click', () => secModal.classList.remove('hidden'));
      document.getElementById('closeSecurityGuideModalBtn').addEventListener('click', () => secModal.classList.add('hidden'));
      document.getElementById('confirmSecurityGuideBtn').addEventListener('click', () => secModal.classList.add('hidden'));
    },

    bindModal(openBtnId, modalId, closeBtnId, confirmBtnId, docPath, contentTargetId) {
      const openBtn = document.getElementById(openBtnId);
      const modal = document.getElementById(modalId);
      const closeBtn = document.getElementById(closeBtnId);
      const confirmBtn = document.getElementById(confirmBtnId);
      const contentElem = document.getElementById(contentTargetId);

      openBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        if (contentElem && !contentElem.dataset.loaded) {
          fetch(docPath)
            .then(res => res.text())
            .then(md => {
              contentElem.innerHTML = this.markdownToHtml(md);
              contentElem.dataset.loaded = "true";
            })
            .catch(() => {
              contentElem.innerHTML = "<p>문서를 불러오는 중 오류가 발생했습니다.</p>";
            });
        }
      });

      const closeModal = () => modal.classList.add('hidden');
      closeBtn.addEventListener('click', closeModal);
      confirmBtn.addEventListener('click', closeModal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    },

    markdownToHtml(md) {
      return md
        .replace(/^### (.*$)/gim, '<h4>$1</h4>')
        .replace(/^## (.*$)/gim, '<h3>$1</h3>')
        .replace(/^# (.*$)/gim, '<h2>$1</h2>')
        .replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>')
        .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
        .replace(/`([^`]+)`/gim, '<code>$1</code>')
        .replace(/\n\n/gim, '<br><br>');
    }
  };

  // =========================================================================
  // App 메인 컨트롤러
  // =========================================================================
  const App = {
    init() {
      const lastSessionId = StorageModule.getCurrentSessionId();
      let restoredSession = null;
      if (lastSessionId) {
        restoredSession = StorageModule.loadSession(lastSessionId);
      }

      State.initSession(restoredSession);

      TimerModule.init();
      MatchRecordModule.init();
      TeacherModule.init();
      PolicyModalModule.init();

      this.restoreUI();
      this.updateSaveStatusUI('자동 저장 준비 완료');
    },

    restoreUI() {
      document.getElementById('sessionBadge').textContent = `세션: ${State.currentSession.sessionId.slice(-8)}`;
      MatchRecordModule.render();
      TimerModule.render();
    },

    scheduleAutoSave() {
      const dot = document.getElementById('saveStatusDot');
      const text = document.getElementById('saveStatusText');
      dot.classList.add('saving');
      text.textContent = '자동 저장 중...';

      clearTimeout(State.saveTimerId);
      State.saveTimerId = setTimeout(() => {
        const ok = StorageModule.saveSession(State.currentSession);
        dot.classList.remove('saving');
        if (ok) {
          const nowStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          text.textContent = `기록 저장됨 (${nowStr})`;
        } else {
          text.textContent = '저장 실패';
        }
      }, 250);
    },

    updateSaveStatusUI(msg) {
      document.getElementById('saveStatusText').textContent = msg;
    },

    createNewSession() {
      State.initSession();
      TimerModule.reset(15 * 60);
      MatchRecordModule.render();
      document.getElementById('sessionBadge').textContent = `세션: ${State.currentSession.sessionId.slice(-8)}`;
      this.scheduleAutoSave();
    },

    loadExistingSession(sessionId) {
      const session = StorageModule.loadSession(sessionId);
      if (!session) return;
      State.initSession(session);
      this.restoreUI();
      TeacherModule.toggleMode();
      alert(`경기 세션(${sessionId})을 불러왔습니다.`);
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    App.init();
  });
})();
