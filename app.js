/**
 * 학교폭력예방 풋살대회 경기 기록 운영 시스템 (app.js)
 * 신규 요구사항 구현:
 * 1. 파울 5개 누적 시 자동으로 퇴장(레드카드 1개) 및 '출전 불가' 자동 전환
 * 2. 수동 퇴장/출전 불가 제어 버튼 지원
 * 3. 학번(studentNumber) 필드 지원 (전광판 득점자 표시용)
 * 4. 팀별 슈팅 수(shots) 카운터 제어
 * 5. 경기 종료(endMatch) 플래그 지원 -> 전광판 결과 화면 트리거
 * 6. LocalStorage를 통한 학생 전광판(scoreboard.html) 실시간 동기화
 */

(function () {
  'use strict';

  // 초기 5 vs 5 라인업 (학번 및 퇴장/출전불가 상태 포함)
  const INITIAL_PLAYERS = [
    { id: "p1", name: "김민준", studentNum: "10101", number: 1, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p2", name: "이서준", studentNum: "10102", number: 7, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p3", name: "박도윤", studentNum: "10103", number: 9, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p4", name: "정예준", studentNum: "10104", number: 10, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p5", name: "최시우", studentNum: "10105", number: 11, team: "1", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    
    { id: "p6", name: "강하준", studentNum: "10201", number: 1, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p7", name: "조은우", studentNum: "10202", number: 7, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p8", name: "윤지호", studentNum: "10203", number: 8, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p9", name: "장유준", studentNum: "10204", number: 10, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false },
    { id: "p10", name: "임선우", studentNum: "10205", number: 18, team: "2", goals: 0, assists: 0, fouls: 0, redCards: 0, isBanned: false }
  ];

  const STORAGE_KEY = 'futsal_shared_match_state';

  // 전역 상태
  const State = {
    sessionId: 'match_' + Date.now(),
    team1Name: "1팀 (블루)",
    team2Name: "2팀 (오렌지)",
    team1Shots: 0,
    team2Shots: 0,
    isMatchEnded: false,
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
        // 플레이어 필드 호환성 보정
        this.players.forEach(p => {
          if (p.team === 'A') p.team = '1';
          if (p.team === 'B') p.team = '2';
          if (typeof p.redCards !== 'number') p.redCards = 0;
          if (typeof p.isBanned !== 'boolean') p.isBanned = false;
          if (!p.studentNum) p.studentNum = '101' + String(p.number).padStart(2, '0');
        });
        if (typeof this.team1Shots !== 'number') this.team1Shots = 0;
        if (typeof this.team2Shots !== 'number') this.team2Shots = 0;
        if (typeof this.isMatchEnded !== 'boolean') this.isMatchEnded = false;
      }
    }
  };

  // 스토리지 저장 & 실시간 동기화
  function saveState() {
    try {
      const data = {
        sessionId: State.sessionId,
        team1Name: State.team1Name,
        team2Name: State.team2Name,
        team1Shots: State.team1Shots,
        team2Shots: State.team2Shots,
        isMatchEnded: State.isMatchEnded,
        timer: State.timer,
        players: State.players,
        updatedAt: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      // 과거 세션 호환
      localStorage.setItem('futsal_session_' + State.sessionId, JSON.stringify(data));
      localStorage.setItem('futsal_current_session_id', State.sessionId);
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
        if (confirm("새로운 경기를 시작하시겠습니까?\n모든 기록과 상태가 초기화됩니다.")) {
          localStorage.removeItem(STORAGE_KEY);
          location.reload();
        }
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
      alert("15분 정규 경기 시간이 종료되었습니다!");
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
  // 경기 기록 운영원 매니저
  // =========================================================================
  const OperatorManager = {
    init() {
      this.bindInputs();
      this.bindEndMatch();
      this.bindShots();
      this.render();
    },

    bindInputs() {
      // 1팀 / 2팀 이름 실시간 편집
      document.getElementById('team1NameInput').addEventListener('input', (e) => {
        State.team1Name = e.target.value.trim() || '1팀';
        document.getElementById('team1TitleDisplay').textContent = State.team1Name;
        saveState();
      });

      document.getElementById('team2NameInput').addEventListener('input', (e) => {
        State.team2Name = e.target.value.trim() || '2팀';
        document.getElementById('team2TitleDisplay').textContent = State.team2Name;
        saveState();
      });

      // 선수 추가 모달
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

      // 스탯 조작 이벤트 위임
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
          // ★ 파울 5개 누적 시 자동으로 퇴장(레드카드 1개) 및 출전 불가 자동 전환
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

    bindEndMatch() {
      const endBtn = document.getElementById('endMatchBtn');
      const badge = document.getElementById('gameStatusBadge');

      endBtn.addEventListener('click', () => {
        if (!State.isMatchEnded) {
          if (confirm("경기를 정식 종료하시겠습니까?\n학생 전광판 화면에 최종 결과(스코어, 점유율, 슈팅, 득점자)가 즉시 띄워집니다.")) {
            State.isMatchEnded = true;
            TimerModule.pause();
            saveState();
            this.render();
            alert("경기가 종료되었습니다. 학생 전광판에서 최종 결과를 확인하실 수 있습니다.");
          }
        } else {
          if (confirm("경기 종료 상태를 해제하고 다시 경기 진행 모드로 전환하시겠습니까?")) {
            State.isMatchEnded = false;
            saveState();
            this.render();
          }
        }
      });
    },

    addNewPlayer() {
      const name = document.getElementById('newPlayerName').value.trim();
      const studentNum = document.getElementById('newPlayerStudentNum').value.trim() || '10100';
      const num = parseInt(document.getElementById('newPlayerNumber').value, 10);
      const team = document.getElementById('newPlayerTeamSelect').value;

      if (!name || isNaN(num)) {
        alert("선수 이름과 등번호를 올바르게 입력해 주세요.");
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
        ? `<span class="player-status-tag status-suspended">출전불가 (퇴장)</span>`
        : `<span class="player-status-tag status-active">출전 가능</span>`;

      return `
        <div class="player-card ${isBanned ? 'banned-card' : ''}" style="${isBanned ? 'background:#fff5f5; border-color:#fca5a5;' : ''}">
          <div class="player-identity">
            <span class="player-num">#${p.number}</span>
            <div>
              <div class="player-name-text">${p.name} <small style="font-size:11px; color:#8e8e8e;">(${p.studentNum})</small></div>
              <div style="margin-top:2px;">${statusBadge}</div>
            </div>
          </div>

          <div class="player-actions-row">
            <!-- 득점 -->
            <div class="stat-unit" title="득점">
              <span class="stat-label-icon">⚽ 득점</span>
              <span class="stat-num-val">${p.goals}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="goals" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="goals" data-delta="1">+</button>
              </div>
            </div>

            <!-- 도움 -->
            <div class="stat-unit" title="도움">
              <span class="stat-label-icon">👟 도움</span>
              <span class="stat-num-val">${p.assists}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="assists" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="assists" data-delta="1">+</button>
              </div>
            </div>

            <!-- 파울 (5개 시 자동 퇴장) -->
            <div class="stat-unit" title="파울 (5개 시 자동 퇴장)" style="${p.fouls >= 5 ? 'border-color:#f59e0b;' : ''}">
              <span class="stat-label-icon" style="color:#d97706;">🟨 파울</span>
              <span class="stat-num-val">${p.fouls}/5</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="fouls" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="fouls" data-delta="1">+</button>
              </div>
            </div>

            <!-- 퇴장 -->
            <div class="stat-unit" title="퇴장 (레드카드)">
              <span class="stat-label-icon" style="color:#dc2626;">🟥 퇴장</span>
              <span class="stat-num-val" style="color:#dc2626;">${p.redCards}</span>
              <div class="stat-btns-pair">
                <button class="btn-ctrl" data-pid="${p.id}" data-act="redCards" data-delta="-1">-</button>
                <button class="btn-ctrl plus" data-pid="${p.id}" data-act="redCards" data-delta="1">+</button>
              </div>
            </div>

            <!-- 출전 불가 토글 -->
            <button class="btn-outline-sm" data-pid="${p.id}" data-act="toggleBan" style="font-size:11px; padding:3px 6px; ${p.isBanned ? 'background:#fee2e2; color:#b91c1c;' : ''}">
              ${p.isBanned ? '출전금지 해제' : '출전불가 설정'}
            </button>
          </div>
        </div>
      `;
    },

    render() {
      // 1. 헤더 및 경기 상태 동기화
      const badge = document.getElementById('gameStatusBadge');
      const endBtn = document.getElementById('endMatchBtn');
      if (State.isMatchEnded) {
        badge.textContent = "🏁 경기 종료됨";
        badge.classList.add('ended');
        endBtn.textContent = "재경기 / 진행 모드로 복귀";
      } else {
        badge.textContent = "⚽ 경기 진행 중";
        badge.classList.remove('ended');
        endBtn.textContent = "🏁 경기 종료 확정";
      }

      // 2. 팀 정보
      document.getElementById('team1NameInput').value = State.team1Name;
      document.getElementById('team2NameInput').value = State.team2Name;
      document.getElementById('team1TitleDisplay').textContent = State.team1Name;
      document.getElementById('team2TitleDisplay').textContent = State.team2Name;

      // 3. 점수, 파울, 퇴장 합산
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

      // 4. 선수 명단 렌더링
      const team1Players = State.players.filter(p => p.team === '1');
      const team2Players = State.players.filter(p => p.team === '2');

      document.getElementById('team1CountBadge').textContent = `${team1Players.length}명`;
      document.getElementById('team2CountBadge').textContent = `${team2Players.length}명`;

      document.getElementById('team1PlayersList').innerHTML = team1Players.map(p => this.createPlayerRowHtml(p)).join('');
      document.getElementById('team2PlayersList').innerHTML = team2Players.map(p => this.createPlayerRowHtml(p)).join('');
    }
  };

  // 초기 로드
  document.addEventListener('DOMContentLoaded', () => {
    const existing = loadState();
    State.initSession(existing);

    TimerModule.init();
    OperatorManager.init();

    // 타 창(전광판, 분석원)에서의 변경 실시간 리스너
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        const updated = loadState();
        if (updated) {
          State.initSession(updated);
          OperatorManager.render();
          TimerModule.render();
        }
      }
    });
  });
})();
