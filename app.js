/**
 * 학교폭력예방 풋살대회 경기 기록 및 토너먼트 연동 시스템 (app.js)
 * - 12팀 토너먼트 대진표(tournament.js)와 실시간 양방향 연동
 * - '🏁 경기 종료 확정' 클릭 시 승패·점수·다음 라운드 진출자 즉시 표시 및 다음 경기 자동 이동
 * - 개인정보 최소 수집 원칙: 기본 선수 표시는 실명/학번 대신 번호/가명 사용
 * - LocalStorage & BroadcastChannel을 통한 학생 전광판(scoreboard.html) 실시간 동기화
 */

(function () {
  'use strict';

  // 개인정보 보호 기본값: 이름/학번 대신 번호/가명 사용 (테스트용 가명 데이터)
  const INITIAL_PLAYERS = [
    { id: "p1", name: "A팀 #1 (GK)", studentNum: "A-01", number: 1, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p2", name: "A팀 #7", studentNum: "A-07", number: 7, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p3", name: "A팀 #9", studentNum: "A-09", number: 9, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p4", name: "A팀 #10", studentNum: "A-10", number: 10, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p5", name: "A팀 #11", studentNum: "A-11", number: 11, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },

    { id: "p6", name: "B팀 #1 (GK)", studentNum: "B-01", number: 1, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p7", name: "B팀 #7", studentNum: "B-07", number: 7, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p8", name: "B팀 #8", studentNum: "B-08", number: 8, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p9", name: "B팀 #10", studentNum: "B-10", number: 10, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p10", name: "B팀 #18", studentNum: "B-18", number: 18, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false }
  ];

  const STORAGE_KEY = 'futsal_shared_match_state';
  const POSSESSION_STORAGE_KEY = 'futsal_possession_data';

  // 초고속 실시간 브로드캐스트 채널 버스 (0ms 딜레이 동기화)
  const SyncBus = {
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('futsal_sync_bus') : null,
    post(type, data = {}) {
      if (this.channel) {
        try {
          this.channel.postMessage({ type, data, timestamp: Date.now() });
        } catch (e) {
          console.warn('[SyncBus] 전송 오류');
        }
      }
    },
    listen(handler) {
      if (this.channel) {
        this.channel.addEventListener('message', (event) => {
          if (event && event.data) handler(event.data);
        });
      }
    }
  };

  // 전역 상태
  const State = {
    sessionId: 'match_' + Date.now(),
    team1Name: "청룡 FC",
    team2Name: "백호 유나이티드",
    team1Shots: 0,
    team2Shots: 0,
    isMatchEnded: false,
    lastTournamentResult: null,
    timer: {
      durationSeconds: 15 * 60,
      remainingSeconds: 15 * 60,
      isRunning: false,
      startedAt: null
    },
    players: JSON.parse(JSON.stringify(INITIAL_PLAYERS)),

    initSession(existing = null) {
      if (existing) {
        Object.assign(this, existing);
        this.players.forEach(p => {
          if (p.team === 'A') p.team = '1';
          if (p.team === 'B') p.team = '2';
          if (typeof p.redCards !== 'number') p.redCards = 0;
          if (typeof p.isBanned !== 'boolean') p.isBanned = false;
          if (!p.studentNum) p.studentNum = 'P-' + String(p.number).padStart(2, '0');
        });
        if (typeof this.team1Shots !== 'number') this.team1Shots = 0;
        if (typeof this.team2Shots !== 'number') this.team2Shots = 0;
        if (typeof this.isMatchEnded !== 'boolean') this.isMatchEnded = false;
      }

      // 토너먼트 현재 진행 경기 팀명과 동기화
      if (window.FutsalTournament && window.FutsalTournament.TournamentStore) {
        const activeMatch = window.FutsalTournament.TournamentStore.getActiveMatch();
        if (activeMatch) {
          this.team1Name = window.FutsalTournament.TournamentStore.getTeamName(activeMatch.teamAId);
          this.team2Name = window.FutsalTournament.TournamentStore.getTeamName(activeMatch.teamBId);
        }
      }
    }
  };

  function getTeamScores() {
    let score1 = 0, score2 = 0;
    State.players.forEach(p => {
      if (p.team === '1') score1 += (p.goals || 0);
      else score2 += (p.goals || 0);
    });
    return { score1, score2 };
  }

  // 스토리지 저장 & 실시간 동기화 브로드캐스트
  function saveState() {
    try {
      const { score1, score2 } = getTeamScores();

      // 토너먼트 현재 경기 카드의 점수 입력창과도 실시간 연동
      if (window.FutsalTournament && window.FutsalTournament.TournamentStore) {
        const activeMatch = window.FutsalTournament.TournamentStore.getActiveMatch();
        if (activeMatch && activeMatch.status !== '확정') {
          activeMatch.scoreA = score1;
          activeMatch.scoreB = score2;
          const spA = document.getElementById('spotlightScoreA');
          const spB = document.getElementById('spotlightScoreB');
          const cardA = document.getElementById(`scoreA_input_${activeMatch.matchId}`);
          const cardB = document.getElementById(`scoreB_input_${activeMatch.matchId}`);
          if (spA) spA.value = score1;
          if (spB) spB.value = score2;
          if (cardA) cardA.value = score1;
          if (cardB) cardB.value = score2;
        }
      }

      const data = {
        sessionId: State.sessionId,
        team1Name: State.team1Name,
        team2Name: State.team2Name,
        team1Shots: State.team1Shots,
        team2Shots: State.team2Shots,
        isMatchEnded: State.isMatchEnded,
        lastTournamentResult: State.lastTournamentResult,
        timer: State.timer,
        players: State.players,
        updatedAt: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem('futsal_session_' + State.sessionId, JSON.stringify(data));
      localStorage.setItem('futsal_current_session_id', State.sessionId);

      SyncBus.post('MATCH_UPDATE', data);
    } catch (e) {
      console.error(e);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  // =========================================================================
  // 15분 타이머 모듈
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
      this.sync();
    },

    bindEvents() {
      this.startBtn.addEventListener('click', () => this.start());
      this.pauseBtn.addEventListener('click', () => this.pause());
      this.resetBtn.addEventListener('click', () => this.reset(15 * 60));

      document.getElementById('add1MinBtn').addEventListener('click', () => this.addTime(60));
      document.getElementById('add5MinBtn').addEventListener('click', () => this.addTime(300));
      document.getElementById('newMatchSessionBtn').addEventListener('click', () => {
        State.players.forEach(p => {
          p.goals = 0;
          p.assists = 0;
          p.fouls = 0;
          p.redCards = 0;
          p.isBanned = false;
        });
        State.team1Shots = 0;
        State.team2Shots = 0;
        State.isMatchEnded = false;
        this.reset(15 * 60);
        OperatorManager.render();
      });
    },

    sync() {
      const timer = State.timer;
      if (timer.isRunning && timer.startedAt) {
        const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
        timer.remainingSeconds = Math.max(0, timer.durationSeconds - elapsed);
        if (timer.remainingSeconds > 0) this.start(true);
        else this.onEnd();
      }
      this.render();
    },

    start(resume = false) {
      const timer = State.timer;
      if (timer.remainingSeconds <= 0) {
        timer.remainingSeconds = 15 * 60;
        timer.durationSeconds = 15 * 60;
      }
      timer.isRunning = true;
      if (!resume) {
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
        saveState();

        if (timer.remainingSeconds <= 0) {
          this.onEnd();
        }
      }, 500);

      saveState();
    },

    pause() {
      const timer = State.timer;
      timer.isRunning = false;
      clearInterval(this.intervalId);
      this.startBtn.disabled = false;
      this.pauseBtn.disabled = true;
      if (this.colonElem) this.colonElem.classList.add('paused');
      saveState();
    },

    reset(sec = 15 * 60) {
      this.pause();
      State.timer.durationSeconds = sec;
      State.timer.remainingSeconds = sec;
      State.timer.startedAt = null;
      this.render();
      saveState();
    },

    addTime(extra) {
      State.timer.durationSeconds += extra;
      State.timer.remainingSeconds += extra;
      if (State.timer.isRunning) {
        State.timer.startedAt += extra * 1000;
      }
      this.render();
      saveState();
    },

    onEnd() {
      this.pause();
      State.timer.remainingSeconds = 0;
      this.render();
      saveState();
    },

    render() {
      const sec = Math.max(0, State.timer.remainingSeconds);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      this.minutesElem.textContent = String(m).padStart(2, '0');
      this.secondsElem.textContent = String(s).padStart(2, '0');

      const pct = State.timer.durationSeconds > 0 ? (sec / State.timer.durationSeconds) * 100 : 0;
      this.progressBar.style.width = `${pct}%`;
    }
  };

  // =========================================================================
  // 경기 기록 및 종료 확정 매니저
  // =========================================================================
  const OperatorManager = {
    init() {
      this.bindInputs();
      this.bindQuickGoals();
      this.bindEndMatch();
      this.bindShots();
      this.bindTournamentSyncEvent();
      this.render();
    },

    bindTournamentSyncEvent() {
      // 토너먼트에서 다음 경기로 자동 이동할 때 스코어보드 팀명 및 점수 자동 전환
      window.addEventListener('futsal:loadTournamentMatch', (e) => {
        const detail = e.detail || {};
        if (detail.team1Name) State.team1Name = detail.team1Name;
        if (detail.team2Name) State.team2Name = detail.team2Name;
        if (detail.lastConfirmedSummary) {
          State.lastTournamentResult = detail.lastConfirmedSummary;
        }
        // 다음 경기를 위해 득점/슈팅 초기화
        State.players.forEach(p => {
          p.goals = 0;
          p.assists = 0;
          p.fouls = 0;
          p.redCards = 0;
          p.isBanned = false;
        });
        State.team1Shots = 0;
        State.team2Shots = 0;
        State.isMatchEnded = false;
        TimerModule.reset(15 * 60);
        this.render();
      });
    },

    bindQuickGoals() {
      const adjustTeamGoal = (teamStr, delta) => {
        const teamPlayers = State.players.filter(p => p.team === teamStr);
        if (teamPlayers.length === 0) return;
        if (delta > 0) {
          // 대표 득점 슬롯(첫 번째 필드 플레이어)에 득점 가산
          const target = teamPlayers[1] || teamPlayers[0];
          target.goals = (target.goals || 0) + 1;
        } else {
          const scorer = teamPlayers.find(p => (p.goals || 0) > 0);
          if (scorer) scorer.goals = Math.max(0, scorer.goals - 1);
        }
        saveState();
        this.render();
      };

      document.getElementById('team1GoalPlusBtn')?.addEventListener('click', () => adjustTeamGoal('1', 1));
      document.getElementById('team1GoalMinusBtn')?.addEventListener('click', () => adjustTeamGoal('1', -1));
      document.getElementById('team2GoalPlusBtn')?.addEventListener('click', () => adjustTeamGoal('2', 1));
      document.getElementById('team2GoalMinusBtn')?.addEventListener('click', () => adjustTeamGoal('2', -1));
    },

    bindInputs() {
      document.getElementById('team1NameInput').addEventListener('input', (e) => {
        State.team1Name = e.target.value.trim() || 'A팀';
        document.getElementById('team1TitleDisplay').textContent = State.team1Name;
        saveState();
      });

      document.getElementById('team2NameInput').addEventListener('input', (e) => {
        State.team2Name = e.target.value.trim() || 'B팀';
        document.getElementById('team2TitleDisplay').textContent = State.team2Name;
        saveState();
      });

      document.getElementById('addPlayer1Btn').addEventListener('click', () => {
        document.getElementById('newPlayerTeamSelect').value = "1";
        document.getElementById('addPlayerModalTitle').textContent = `${State.team1Name} 선수 추가`;
        document.getElementById('addPlayerModal').classList.remove('hidden');
      });

      document.getElementById('addPlayer2Btn').addEventListener('click', () => {
        document.getElementById('newPlayerTeamSelect').value = "2";
        document.getElementById('addPlayerModalTitle').textContent = `${State.team2Name} 선수 추가`;
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

      const handleAction = (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        const pid = btn.getAttribute('data-pid');
        if (!pid) return;

        const player = State.players.find(p => p.id === pid);
        if (!player) return;

        const action = btn.getAttribute('data-act');
        const delta = parseInt(btn.getAttribute('data-delta') || 0, 10);

        if (action === 'goals') {
          player.goals = Math.max(0, (player.goals || 0) + delta);
        } else if (action === 'assists') {
          player.assists = Math.max(0, (player.assists || 0) + delta);
        } else if (action === 'fouls') {
          player.fouls = Math.max(0, (player.fouls || 0) + delta);
          if (player.fouls >= 5) {
            player.redCards = 1;
            player.isBanned = true;
          }
        } else if (action === 'redCards') {
          player.redCards = Math.max(0, (player.redCards || 0) + delta);
          if (player.redCards > 0) player.isBanned = true;
        } else if (action === 'toggleBan') {
          player.isBanned = !player.isBanned;
        }

        saveState();
        this.render();
      };

      document.getElementById('team1PlayersList').addEventListener('click', handleAction);
      document.getElementById('team2PlayersList').addEventListener('click', handleAction);
    },

    bindShots() {
      document.getElementById('team1ShotPlus').addEventListener('click', () => {
        State.team1Shots = (State.team1Shots || 0) + 1;
        saveState();
        this.render();
      });
      document.getElementById('team1ShotMinus').addEventListener('click', () => {
        State.team1Shots = Math.max(0, (State.team1Shots || 0) - 1);
        saveState();
        this.render();
      });

      document.getElementById('team2ShotPlus').addEventListener('click', () => {
        State.team2Shots = (State.team2Shots || 0) + 1;
        saveState();
        this.render();
      });
      document.getElementById('team2ShotMinus').addEventListener('click', () => {
        State.team2Shots = Math.max(0, (State.team2Shots || 0) - 1);
        saveState();
        this.render();
      });
    },

    /**
     * 상단 '🏁 경기 종료 확정' 버튼(#endMatchBtn) 클릭 시
     * 현재 진행 중인 토너먼트 경기의 승패·점수·다음 라운드 진출자를 즉시 확정하고 표시합니다.
     */
    bindEndMatch() {
      const endBtn = document.getElementById('endMatchBtn');

      endBtn.addEventListener('click', () => {
        const { score1, score2 } = getTeamScores();

        if (window.FutsalTournament && window.FutsalTournament.TournamentStore) {
          const activeMatch = window.FutsalTournament.TournamentStore.getActiveMatch();
          if (activeMatch) {
            // 스포트라이트 점수 입력창에 직접 입력한 값이 있고 스코어보드가 0:0인 경우 스포트라이트 점수 우선 사용
            const spA = parseInt(document.getElementById('spotlightScoreA')?.value || '0', 10);
            const spB = parseInt(document.getElementById('spotlightScoreB')?.value || '0', 10);
            const finalA = (score1 === 0 && score2 === 0 && (spA > 0 || spB > 0)) ? spA : score1;
            const finalB = (score1 === 0 && score2 === 0 && (spA > 0 || spB > 0)) ? spB : score2;

            TimerModule.pause();
            const summary = window.FutsalTournament.TournamentAppController.executeMatchConfirm(
              activeMatch.matchId,
              finalA,
              finalB
            );
            if (summary) {
              State.lastTournamentResult = summary;
              State.isMatchEnded = true;
              saveState();
              // 전광판(scoreboard.html)에도 종료 모달이 표시되도록 상태 전달 후 다음 경기 준비
              setTimeout(() => {
                State.isMatchEnded = false;
                saveState();
                this.render();
              }, 300);
            }
            return;
          }
        }

        // 토너먼트 모든 경기가 이미 끝난 상태이거나 단독 경기일 때의 결과 표시
        State.isMatchEnded = !State.isMatchEnded;
        TimerModule.pause();
        saveState();
        this.render();
      });
    },

    addNewPlayer() {
      const name = document.getElementById('newPlayerName').value.trim();
      const studentNum = document.getElementById('newPlayerStudentNum').value.trim() || 'P-00';
      const num = parseInt(document.getElementById('newPlayerNumber').value, 10);
      const team = document.getElementById('newPlayerTeamSelect').value;

      if (!name || isNaN(num)) {
        alert("선수 표시명(또는 번호)과 등번호를 입력해 주세요.");
        return;
      }

      State.players.push({
        id: 'p_' + Date.now(),
        name,
        studentNum,
        number: num,
        team,
        goals: 0,
        assists: 0,
        fouls: 0,
        redCards: 0,
        isBanned: false
      });

      document.getElementById('addPlayerModal').classList.add('hidden');
      document.getElementById('newPlayerName').value = '';
      document.getElementById('newPlayerStudentNum').value = '';
      document.getElementById('newPlayerNumber').value = '';

      saveState();
      this.render();
    },

    createPlayerRowHtml(p) {
      const isBanned = p.isBanned || p.fouls >= 5 || p.redCards > 0;
      const statusBadge = isBanned
        ? `<span class="player-status-tag status-suspended">출전 불가</span>`
        : `<span class="player-status-tag status-active">출전 가능</span>`;

      return `
        <div class="player-card ${isBanned ? 'banned-card' : ''}">
          <div class="player-card-top-row">
            <div class="player-identity">
              <span class="player-num">#${p.number}</span>
              <div class="player-name-wrap">
                <span class="player-name-text">${p.name}</span>
                ${statusBadge}
              </div>
            </div>
            <button class="btn-toggle-ban ${p.isBanned ? 'banned-active' : ''}" data-pid="${p.id}" data-act="toggleBan">
              ${p.isBanned ? '출전금지 해제' : '출전불가 설정'}
            </button>
          </div>

          <div class="player-actions-row">
            <div class="stat-unit">
              <span class="stat-label-icon">⚽ 득점</span>
              <span class="stat-num-val pop">${p.goals}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="goals" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="goals" data-delta="1">+</button>
              </div>
            </div>

            <div class="stat-unit">
              <span class="stat-label-icon">👟 도움</span>
              <span class="stat-num-val">${p.assists}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="assists" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="assists" data-delta="1">+</button>
              </div>
            </div>

            <div class="stat-unit ${p.fouls >= 5 ? 'foul-warning' : ''}">
              <span class="stat-label-icon foul-label">🟨 파울</span>
              <span class="stat-num-val ${p.fouls >= 5 ? 'red-text' : ''}">${p.fouls}/5</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="fouls" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="fouls" data-delta="1">+</button>
              </div>
            </div>

            <div class="stat-unit ${p.redCards > 0 ? 'red-warning' : ''}">
              <span class="stat-label-icon red-label">🟥 퇴장</span>
              <span class="stat-num-val red-text">${p.redCards}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="redCards" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="redCards" data-delta="1">+</button>
              </div>
            </div>
          </div>
        </div>
      `;
    },

    render() {
      const badge = document.getElementById('gameStatusBadge');
      const endBtn = document.getElementById('endMatchBtn');

      let activeLabel = '⚽ 경기 진행 중';
      if (window.FutsalTournament && window.FutsalTournament.TournamentStore) {
        const activeMatch = window.FutsalTournament.TournamentStore.getActiveMatch();
        if (activeMatch) {
          activeLabel = `🔥 ${activeMatch.matchLabel} 진행 중`;
        } else if (window.FutsalTournament.TournamentStore.state.tournament?.status === '종료') {
          activeLabel = '🏆 대회 전체 종료';
        }
      }
      if (badge) badge.textContent = activeLabel;
      if (endBtn) endBtn.textContent = '🏁 경기 종료 확정';

      document.getElementById('team1NameInput').value = State.team1Name;
      document.getElementById('team2NameInput').value = State.team2Name;
      document.getElementById('team1TitleDisplay').textContent = State.team1Name;
      document.getElementById('team2TitleDisplay').textContent = State.team2Name;

      let score1 = 0, fouls1 = 0, red1 = 0;
      let score2 = 0, fouls2 = 0, red2 = 0;

      State.players.forEach(p => {
        if (p.team === '1') {
          score1 += (p.goals || 0);
          fouls1 += (p.fouls || 0);
          red1 += (p.redCards || 0);
        } else {
          score2 += (p.goals || 0);
          fouls2 += (p.fouls || 0);
          red2 += (p.redCards || 0);
        }
      });

      document.getElementById('team1Score').textContent = score1;
      document.getElementById('team2Score').textContent = score2;
      document.getElementById('team1TotalFouls').textContent = fouls1;
      document.getElementById('team2TotalFouls').textContent = fouls2;
      document.getElementById('team1TotalRed').textContent = red1;
      document.getElementById('team2TotalRed').textContent = red2;

      document.getElementById('team1ShotsDisplay').textContent = State.team1Shots || 0;
      document.getElementById('team2ShotsDisplay').textContent = State.team2Shots || 0;

      const team1Players = State.players.filter(p => p.team === '1');
      const team2Players = State.players.filter(p => p.team === '2');

      document.getElementById('team1CountBadge').textContent = `${team1Players.length}명`;
      document.getElementById('team2CountBadge').textContent = `${team2Players.length}명`;

      document.getElementById('team1PlayersList').innerHTML = team1Players.map(p => this.createPlayerRowHtml(p)).join('');
      document.getElementById('team2PlayersList').innerHTML = team2Players.map(p => this.createPlayerRowHtml(p)).join('');

      renderPossessionBar();
    }
  };

  function renderPossessionBar() {
    const raw = localStorage.getItem(POSSESSION_STORAGE_KEY);
    const t1Elem = document.getElementById('matchPossTeam1Val');
    const t2Elem = document.getElementById('matchPossTeam2Val');
    const b1Elem = document.getElementById('matchPossTeam1Bar');
    const b2Elem = document.getElementById('matchPossTeam2Bar');
    if (!t1Elem || !t2Elem || !b1Elem || !b2Elem) return;

    let pct1 = 50, pct2 = 50;
    if (raw) {
      try {
        const poss = JSON.parse(raw);
        const sum = (poss.team1Ms || 0) + (poss.team2Ms || 0);
        if (sum > 0) {
          pct1 = Math.round(((poss.team1Ms || 0) / sum) * 100);
          pct2 = 100 - pct1;
        }
      } catch (e) {}
    }
    t1Elem.textContent = `${State.team1Name} ${pct1}%`;
    t2Elem.textContent = `${pct2}% ${State.team2Name}`;
    b1Elem.style.width = `${pct1}%`;
    b2Elem.style.width = `${pct2}%`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const existing = loadState();
    State.initSession(existing);

    TimerModule.init();
    OperatorManager.init();
    renderPossessionBar();

    SyncBus.listen((msg) => {
      if (msg.type === 'POSSESSION_UPDATE') {
        renderPossessionBar();
      }
    });

    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        const updated = loadState();
        if (updated) {
          State.initSession(updated);
          OperatorManager.render();
          TimerModule.render();
        }
      } else if (e.key === POSSESSION_STORAGE_KEY) {
        renderPossessionBar();
      }
    });

    setInterval(renderPossessionBar, 300);
  });
})();
