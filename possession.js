/**
 * 볼 점유율 분석원 실시간 측정 엔진 (possession.js)
 * 요구사항:
 * 1. 두 팀 이름 표시 및 자유 편집 가능
 * 2. 한 팀의 버튼을 꾹 누르면 그 팀만의 시간이 초 단위/밀리초로 쭉 올라감
 * 3. 손을 떼거나 마우스를 떼면 시간이 정지됨
 * 4. 다른 팀 버튼을 꾹 누르면 해당 팀의 시간만 올라감
 * 5. 상단 안내 문구: "공을 소유한 팀을 꾹 누르세요!", 누를 때 상태 메시지 실시간 전환
 * 6. 하단 실시간 볼 점유율(%) 자동 계산 및 두 팀 듀얼 비교 프로그레스 바 표시
 */

(function () {
  'use strict';

  // 로컬 스토리지 키
  const STORAGE_KEY = 'futsal_possession_data';
  const MATCH_STORAGE_KEY = 'futsal_shared_match_state';

  // 초고속 실시간 브로드캐스트 채널 버스 (0ms 딜레이 동기화)
  const SyncBus = {
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('futsal_sync_bus') : null,
    post(type, data = {}) {
      if (this.channel) {
        try {
          this.channel.postMessage({ type, data, timestamp: Date.now() });
        } catch (e) {
          console.error(e);
        }
      }
    },
    listen(handler) {
      if (this.channel) {
        this.channel.onmessage = (event) => {
          if (event && event.data) handler(event.data);
        };
      }
    }
  };

  // 상태 관리 객체
  const PossessionState = {
    team1Name: "1팀 (블루)",
    team2Name: "2팀 (오렌지)",
    team1Ms: 0, // 1팀 점유 시간 (밀리초)
    team2Ms: 0, // 2팀 점유 시간 (밀리초)
    activeTeam: null, // 현재 누르고 있는 팀 ('1' | '2' | null)
    lastTimestamp: null,
    animationFrameId: null,
    lastSavedAt: 0, // 100ms 고주기 실시간 스트리밍 저장용
    matchTimerSeconds: 900,
    isMatchEnded: false
  };

  // DOM 요소 캐시
  const DOM = {
    guideHeadline: document.getElementById('guideHeadline'),
    guideSub: document.getElementById('guideSub'),
    liveIndicatorPill: document.getElementById('liveIndicatorPill'),

    team1TouchCard: document.getElementById('team1TouchCard'),
    team2TouchCard: document.getElementById('team2TouchCard'),
    team1TouchBtn: document.getElementById('team1TouchBtn'),
    team2TouchBtn: document.getElementById('team2TouchBtn'),

    team1NameInput: document.getElementById('team1NameInput'),
    team2NameInput: document.getElementById('team2NameInput'),
    team1StateBadge: document.getElementById('team1StateBadge'),
    team2StateBadge: document.getElementById('team2StateBadge'),

    team1TimeDisplay: document.getElementById('team1TimeDisplay'),
    team2TimeDisplay: document.getElementById('team2TimeDisplay'),
    team1PctBadge: document.getElementById('team1PctBadge'),
    team2PctBadge: document.getElementById('team2PctBadge'),

    compTeam1Name: document.getElementById('compTeam1Name'),
    compTeam2Name: document.getElementById('compTeam2Name'),
    compTeam1Pct: document.getElementById('compTeam1Pct'),
    compTeam2Pct: document.getElementById('compTeam2Pct'),
    ratioBarTeam1: document.getElementById('ratioBarTeam1'),
    ratioBarTeam2: document.getElementById('ratioBarTeam2'),
    totalPossessionTime: document.getElementById('totalPossessionTime'),

    resetBtn: document.getElementById('resetPossessionBtn'),
    exportBtn: document.getElementById('exportPossessionBtn')
  };

  // =========================================================================
  // 시간 포맷 헬퍼 (MM:SS.s)
  // =========================================================================
  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const tenth = Math.floor((ms % 1000) / 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenth}`;
  }

  // =========================================================================
  // 실시간 루프 (requestAnimationFrame 기반 정밀 타이밍 + 고속 실시간 브로드캐스트)
  // =========================================================================
  function updateLoop(now) {
    if (PossessionState.activeTeam && PossessionState.lastTimestamp) {
      const delta = now - PossessionState.lastTimestamp;
      if (PossessionState.activeTeam === '1') {
        PossessionState.team1Ms += delta;
      } else if (PossessionState.activeTeam === '2') {
        PossessionState.team2Ms += delta;
      }
      PossessionState.lastTimestamp = now;
      renderDisplays();

      // ★ 누르고 있는 동안에도 매 100ms마다 실시간 저장 및 3개 앱 전파 (바로바로 연동)
      if (now - PossessionState.lastSavedAt >= 100) {
        PossessionState.lastSavedAt = now;
        saveToStorage();
        SyncBus.post('POSSESSION_UPDATE', {
          team1Ms: PossessionState.team1Ms,
          team2Ms: PossessionState.team2Ms,
          activeTeam: PossessionState.activeTeam
        });
      }

      PossessionState.animationFrameId = requestAnimationFrame(updateLoop);
    }
  }

  // =========================================================================
  // 꾹 누르기 시작 (Pointer Down)
  // =========================================================================
  function startPressing(team) {
    if (PossessionState.activeTeam) {
      stopPressing();
    }

    PossessionState.activeTeam = team;
    PossessionState.lastTimestamp = performance.now();
    PossessionState.lastSavedAt = performance.now();

    const activeTeamName = team === '1' ? PossessionState.team1Name : PossessionState.team2Name;

    // 가이드 배너 업데이트
    DOM.guideHeadline.textContent = `⚽ [${activeTeamName}] 볼 소유 중! 계속 누르고 계세요!`;
    DOM.guideHeadline.style.color = team === '1' ? 'var(--tesla-blue)' : 'var(--tesla-carbon-dark)';
    DOM.guideSub.textContent = `손을 떼면 시간이 즉시 정지되고, 상대 팀 볼 소유 시 상대 팀 버튼을 꾹 누르세요.`;
    DOM.liveIndicatorPill.textContent = `● 측정 중 (${team}팀)`;
    DOM.liveIndicatorPill.classList.add('active');

    // 카드 스타일 전환
    if (team === '1') {
      DOM.team1TouchCard.classList.add('pressing');
      DOM.team1StateBadge.textContent = '점유 시간 기록 중';
      DOM.team2TouchCard.classList.remove('pressing');
      DOM.team2StateBadge.textContent = '대기 중';
    } else {
      DOM.team2TouchCard.classList.add('pressing');
      DOM.team2StateBadge.textContent = '점유 시간 기록 중';
      DOM.team1TouchCard.classList.remove('pressing');
      DOM.team1StateBadge.textContent = '대기 중';
    }

    saveToStorage();
    SyncBus.post('POSSESSION_UPDATE', {
      team1Ms: PossessionState.team1Ms,
      team2Ms: PossessionState.team2Ms,
      activeTeam: PossessionState.activeTeam
    });

    cancelAnimationFrame(PossessionState.animationFrameId);
    PossessionState.animationFrameId = requestAnimationFrame(updateLoop);
  }

  // =========================================================================
  // 손 떼기 (Pointer Up / Leave / Cancel)
  // =========================================================================
  function stopPressing() {
    if (!PossessionState.activeTeam) return;

    PossessionState.activeTeam = null;
    PossessionState.lastTimestamp = null;
    cancelAnimationFrame(PossessionState.animationFrameId);

    // UI 대기 상태 복구
    DOM.guideHeadline.textContent = '공을 소유한 팀 버튼을 꾹 누르고 계세요!';
    DOM.guideHeadline.style.color = 'var(--tesla-carbon-dark)';
    DOM.guideSub.textContent = '버튼을 꾹 누르면 해당 팀의 점유 시간이 올라가고, 손을 떼면 시간이 멈춥니다.';
    DOM.liveIndicatorPill.textContent = '대기 중 (정지)';
    DOM.liveIndicatorPill.classList.remove('active');

    DOM.team1TouchCard.classList.remove('pressing');
    DOM.team2TouchCard.classList.remove('pressing');
    DOM.team1StateBadge.textContent = '대기 중';
    DOM.team2StateBadge.textContent = '대기 중';

    renderDisplays();
    saveToStorage();
    SyncBus.post('POSSESSION_UPDATE', {
      team1Ms: PossessionState.team1Ms,
      team2Ms: PossessionState.team2Ms,
      activeTeam: null
    });
  }

  // =========================================================================
  // 화면 렌더링 (시간 및 실시간 1분 주기 점유율 계산)
  // =========================================================================
  function renderDisplays() {
    // 1. 시간 표시
    DOM.team1TimeDisplay.textContent = formatTime(PossessionState.team1Ms);
    DOM.team2TimeDisplay.textContent = formatTime(PossessionState.team2Ms);

    const totalMs = PossessionState.team1Ms + PossessionState.team2Ms;
    DOM.totalPossessionTime.textContent = formatTime(totalMs);

    // 2. 점유율(%) 계산
    let pct1 = 50.0;
    let pct2 = 50.0;

    if (totalMs > 0) {
      pct1 = Math.round((PossessionState.team1Ms / totalMs) * 1000) / 10;
      pct2 = Math.round((100 - pct1) * 10) / 10;
    }

    const pct1Str = pct1.toFixed(1) + '%';
    const pct2Str = pct2.toFixed(1) + '%';

    DOM.team1PctBadge.textContent = pct1Str;
    DOM.team2PctBadge.textContent = pct2Str;

    DOM.compTeam1Pct.textContent = pct1.toFixed(0) + '%';
    DOM.compTeam2Pct.textContent = pct2.toFixed(0) + '%';

    DOM.ratioBarTeam1.style.width = pct1 + '%';
    DOM.ratioBarTeam2.style.width = pct2 + '%';
  }

  // =========================================================================
  // 로컬 스토리지 동기화 및 1분 주기 점유율 통계 저장
  // =========================================================================
  function saveToStorage() {
    try {
      const totalMs = PossessionState.team1Ms + PossessionState.team2Ms;
      const pct1 = totalMs > 0 ? Math.round((PossessionState.team1Ms / totalMs) * 100) : 50;
      const pct2 = 100 - pct1;

      // 15분 경기 기준 1분(60초) 단위 버킷 인덱스
      const elapsedSec = Math.max(0, 900 - (PossessionState.matchTimerSeconds || 900));
      const current1MinBucket = Math.min(15, Math.floor(elapsedSec / 60) + 1);

      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        team1Name: PossessionState.team1Name,
        team2Name: PossessionState.team2Name,
        team1Ms: PossessionState.team1Ms,
        team2Ms: PossessionState.team2Ms,
        pct1: pct1,
        pct2: pct2,
        current1MinBucket: current1MinBucket,
        updatedAt: new Date().toISOString()
      }));
    } catch (e) {
      console.error(e);
    }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.team1Name) PossessionState.team1Name = parsed.team1Name;
        if (parsed.team2Name) PossessionState.team2Name = parsed.team2Name;
        if (typeof parsed.team1Ms === 'number') PossessionState.team1Ms = parsed.team1Ms;
        if (typeof parsed.team2Ms === 'number') PossessionState.team2Ms = parsed.team2Ms;
      }

      // 운영판 경기 데이터 실시간 반영
      const matchRaw = localStorage.getItem(MATCH_STORAGE_KEY);
      if (matchRaw) {
        const match = JSON.parse(matchRaw);
        if (match.team1Name) PossessionState.team1Name = match.team1Name;
        if (match.team2Name) PossessionState.team2Name = match.team2Name;
        if (match.timer) PossessionState.matchTimerSeconds = match.timer.remainingSeconds;
        PossessionState.isMatchEnded = !!match.isMatchEnded;
      }
    } catch (e) {
      console.error(e);
    }
  }

  // =========================================================================
  // 이벤트 바인딩
  // =========================================================================
  function initEvents() {
    // Pointer Events: 마우스 누르기 + 모바일 화면 터치 누르기 동시 지원
    // 1팀 버튼 꾹 누르기
    DOM.team1TouchBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startPressing('1');
    });

    // 2팀 버튼 꾹 누르기
    DOM.team2TouchBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startPressing('2');
    });

    // 화면 어디서든 손이나 마우스를 떼면 즉시 시간 정지
    window.addEventListener('pointerup', () => stopPressing());
    window.addEventListener('pointercancel', () => stopPressing());
    window.addEventListener('blur', () => stopPressing());

    // 터치 우클릭/메뉴 팝업 방지
    DOM.team1TouchBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    DOM.team2TouchBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    // 팀 이름 편집 연동
    DOM.team1NameInput.addEventListener('input', (e) => {
      const val = e.target.value.trim() || '1팀';
      PossessionState.team1Name = val;
      DOM.compTeam1Name.textContent = val;
      saveToStorage();
    });

    DOM.team2NameInput.addEventListener('input', (e) => {
      const val = e.target.value.trim() || '2팀';
      PossessionState.team2Name = val;
      DOM.compTeam2Name.textContent = val;
      saveToStorage();
    });

    // 리셋 버튼
    DOM.resetBtn.addEventListener('click', () => {
      if (confirm('볼 점유율 측정 시간을 0으로 초기화하시겠습니까?')) {
        stopPressing();
        PossessionState.team1Ms = 0;
        PossessionState.team2Ms = 0;
        renderDisplays();
        saveToStorage();
        SyncBus.post('POSSESSION_UPDATE', { team1Ms: 0, team2Ms: 0, reset: true });
      }
    });

    // 데이터 복사 버튼
    DOM.exportBtn.addEventListener('click', () => {
      const totalMs = PossessionState.team1Ms + PossessionState.team2Ms;
      let pct1 = 50, pct2 = 50;
      if (totalMs > 0) {
        pct1 = ((PossessionState.team1Ms / totalMs) * 100).toFixed(1);
        pct2 = (100 - pct1).toFixed(1);
      }
      const summaryText = `[학교폭력예방 풋살대회 볼 점유율 분석 결과]\n` +
        `- ${PossessionState.team1Name}: ${formatTime(PossessionState.team1Ms)} (${pct1}%)\n` +
        `- ${PossessionState.team2Name}: ${formatTime(PossessionState.team2Ms)} (${pct2}%)\n` +
        `- 총 인플레이 시간: ${formatTime(totalMs)}`;

      navigator.clipboard.writeText(summaryText)
        .then(() => alert('점유율 통계가 클립보드에 복사되었습니다!\n\n' + summaryText))
        .catch(() => alert(summaryText));
    });
  }

  // =========================================================================
  // 초기화 및 실시간 브로드캐스트 동기화
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    loadFromStorage();

    DOM.team1NameInput.value = PossessionState.team1Name;
    DOM.team2NameInput.value = PossessionState.team2Name;
    DOM.compTeam1Name.textContent = PossessionState.team1Name;
    DOM.compTeam2Name.textContent = PossessionState.team2Name;

    initEvents();
    renderDisplays();

    // 1. 브로드캐스트 버스로 운영판 경기 데이터 즉각 수신 (0ms 지연)
    SyncBus.listen((msg) => {
      if (msg.type === 'MATCH_UPDATE' && msg.data) {
        if (msg.data.team1Name && msg.data.team1Name !== PossessionState.team1Name) {
          PossessionState.team1Name = msg.data.team1Name;
          DOM.team1NameInput.value = msg.data.team1Name;
          DOM.compTeam1Name.textContent = msg.data.team1Name;
        }
        if (msg.data.team2Name && msg.data.team2Name !== PossessionState.team2Name) {
          PossessionState.team2Name = msg.data.team2Name;
          DOM.team2NameInput.value = msg.data.team2Name;
          DOM.compTeam2Name.textContent = msg.data.team2Name;
        }
        if (msg.data.timer) {
          PossessionState.matchTimerSeconds = msg.data.timer.remainingSeconds;
        }
        if (typeof msg.data.isMatchEnded === 'boolean') {
          PossessionState.isMatchEnded = msg.data.isMatchEnded;
        }
        saveToStorage();
      }
    });

    // 2. 다른 창 스토리지 이벤트 동기화
    window.addEventListener('storage', (e) => {
      if (e.key === MATCH_STORAGE_KEY) {
        loadFromStorage();
        DOM.team1NameInput.value = PossessionState.team1Name;
        DOM.team2NameInput.value = PossessionState.team2Name;
        DOM.compTeam1Name.textContent = PossessionState.team1Name;
        DOM.compTeam2Name.textContent = PossessionState.team2Name;
      }
    });

    // 3. 고속 인터벌 (200ms) 폴링
    setInterval(() => {
      if (!PossessionState.activeTeam) {
        const matchRaw = localStorage.getItem(MATCH_STORAGE_KEY);
        if (matchRaw) {
          try {
            const m = JSON.parse(matchRaw);
            if (m.team1Name && m.team1Name !== PossessionState.team1Name) {
              PossessionState.team1Name = m.team1Name;
              DOM.team1NameInput.value = m.team1Name;
              DOM.compTeam1Name.textContent = m.team1Name;
            }
            if (m.team2Name && m.team2Name !== PossessionState.team2Name) {
              PossessionState.team2Name = m.team2Name;
              DOM.team2NameInput.value = m.team2Name;
              DOM.compTeam2Name.textContent = m.team2Name;
            }
          } catch(e){}
        }
      }
    }, 200);
  });
})();
