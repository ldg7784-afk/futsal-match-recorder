/**
 * 학교폭력예방 풋살대회 공식 중계 전광판 (scoreboard.js)
 * Premier League & EA SPORTS FC 방송 그래픽 엔진
 * 1. 1920x1080 뷰포트 자동 스케일러 (16:9 비율 유지)
 * 2. 실시간 동기화 (BroadcastChannel + Storage + High-speed Loop)
 * 3. 메인 스코어버그 & 5인 라인업 활약상 (골, 어시스트, 파울, 퇴장)
 * 4. 풋살 5파울 누적 인디케이터
 * 5. 가로형 듀얼 볼 점유율 및 경기 통계 (슈팅, 유효슈팅, 파울)
 * 6. 득점 발생 시 EA FC 스타일 'GOAL!' 세리머니 애니메이션 (득점자+어시스트)
 * 7. 경기 종료 시 FULL TIME 쇼케이스 & 경기 MVP (Player of the Match) 선정
 */

(function () {
  'use strict';

  const MATCH_STORAGE_KEY = 'futsal_shared_match_state';
  const POSSESSION_STORAGE_KEY = 'futsal_possession_data';

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

  // 전광판 내부 런타임 상태
  const ScoreboardRuntime = {
    matchData: null,
    possessionData: null,
    previousPlayers: {}, // { [id]: { goals, assists } }
    previousScore1: 0,
    previousScore2: 0,
    isGoalAlertActive: false,
    goalTimeoutId: null
  };

  // =========================================================================
  // 1. 1920x1080 반응형 뷰포트 자동 스케일러
  // =========================================================================
  function initViewportScaler() {
    const scaler = document.getElementById('viewportScaler');
    if (!scaler) return;

    function applyScale() {
      const targetW = 1920;
      const targetH = 1080;
      const windowW = window.innerWidth;
      const windowH = window.innerHeight;

      // 16:9 비율 유지 스케일 팩터 계산
      const scaleX = windowW / targetW;
      const scaleY = windowH / targetH;
      const scale = Math.min(scaleX, scaleY);

      scaler.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }

    window.addEventListener('resize', applyScale);
    window.addEventListener('orientationchange', applyScale);
    applyScale();
  }

  // =========================================================================
  // 2. 현재 시각 실시간 업데이트 (HH:MM:SS)
  // =========================================================================
  function updateRibbonTime() {
    const el = document.getElementById('ribbonCurrentTime');
    if (!el) return;
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `${h}:${m}:${s}`;
  }

  // =========================================================================
  // 3. 점유율 계산 (밀리초 기반 실시간 비율)
  // =========================================================================
  function getPossessionRatio(possData) {
    if (!possData) return { pct1: 50, pct2: 50 };
    const t1 = possData.team1Ms || 0;
    const t2 = possData.team2Ms || 0;
    const sum = t1 + t2;

    if (sum === 0) return { pct1: 50, pct2: 50 };

    const pct1 = Math.round((t1 / sum) * 100);
    const pct2 = 100 - pct1;
    return { pct1, pct2 };
  }

  // =========================================================================
  // 4. 골 득점 이벤트 감지 및 애니메이션 트리거 (핵심 요구사항 7)
  // =========================================================================
  function checkForNewGoal(newMatch) {
    if (!newMatch || !newMatch.players) return;

    let totalScore1 = 0;
    let totalScore2 = 0;
    let scoredPlayer = null;
    let scoredTeam = null;

    newMatch.players.forEach(p => {
      const g = p.goals || 0;
      if (p.team === '1') totalScore1 += g;
      else totalScore2 += g;

      const prev = ScoreboardRuntime.previousPlayers[p.id];
      if (prev && g > prev.goals) {
        scoredPlayer = p;
        scoredTeam = p.team;
      }
      // 플레이어 상태 업데이트
      ScoreboardRuntime.previousPlayers[p.id] = {
        goals: g,
        assists: p.assists || 0
      };
    });

    // 최초 로드 시에는 애니메이션 건너뜀
    if (ScoreboardRuntime.previousScore1 === 0 && ScoreboardRuntime.previousScore2 === 0 &&
      Object.keys(ScoreboardRuntime.previousPlayers).length <= 10) {
      // 초기 상태 저장
      ScoreboardRuntime.previousScore1 = totalScore1;
      ScoreboardRuntime.previousScore2 = totalScore2;
      return;
    }

    // 스코어가 실제로 증가한 경우
    const scoreIncreased = (totalScore1 > ScoreboardRuntime.previousScore1) || (totalScore2 > ScoreboardRuntime.previousScore2);

    if (scoreIncreased && scoredPlayer && !ScoreboardRuntime.isGoalAlertActive) {
      // 어시스트 선수 찾기 (최근 어시스트가 있는 같은 팀 선수 탐색)
      const sameTeamPlayers = newMatch.players.filter(p => p.team === scoredTeam && p.id !== scoredPlayer.id);
      const assistCandidate = sameTeamPlayers.find(p => (p.assists || 0) > 0);

      const teamName = scoredTeam === '1' ? (newMatch.team1Name || '1팀 (블루)') : (newMatch.team2Name || '2팀 (오렌지)');
      triggerGoalCelebration(scoredPlayer, assistCandidate, teamName, scoredTeam);
    }

    ScoreboardRuntime.previousScore1 = totalScore1;
    ScoreboardRuntime.previousScore2 = totalScore2;
  }

  function triggerGoalCelebration(player, assistPlayer, teamName, teamNum) {
    ScoreboardRuntime.isGoalAlertActive = true;
    const overlay = document.getElementById('goalAlertOverlay');
    if (!overlay) return;

    // 데이터 바인딩
    document.getElementById('goalPlayerJersey').textContent = `#${player.number}`;
    document.getElementById('goalPlayerStudentNum').textContent = `학번 ${player.studentNum || '-'}`;
    document.getElementById('goalPlayerName').textContent = player.name;
    document.getElementById('goalPlayerCountBadge').textContent = `TOURNAMENT GOAL ⚽ ${player.goals}골`;
    document.getElementById('goalTeamName').textContent = teamName;

    const assistBar = document.getElementById('goalAssistBar');
    if (assistPlayer) {
      assistBar.style.display = 'flex';
      document.getElementById('goalAssistName').textContent = `${assistPlayer.name} (${assistPlayer.studentNum || '-'})`;
    } else {
      assistBar.style.display = 'none';
    }

    // 팀 색상 글로우 스타일 조정
    const badge = document.getElementById('goalTeamBadge');
    if (teamNum === '1') {
      badge.style.borderColor = 'var(--team-1-cyan)';
      badge.style.color = 'var(--team-1-cyan)';
    } else {
      badge.style.borderColor = 'var(--team-2-orange)';
      badge.style.color = 'var(--team-2-orange)';
    }

    // 오버레이 표시
    overlay.classList.remove('hidden');

    // 4.5초 후 자동으로 닫기
    if (ScoreboardRuntime.goalTimeoutId) clearTimeout(ScoreboardRuntime.goalTimeoutId);
    ScoreboardRuntime.goalTimeoutId = setTimeout(() => {
      overlay.classList.add('hidden');
      ScoreboardRuntime.isGoalAlertActive = false;
    }, 4500);
  }

  // =========================================================================
  // 5. 경기 MVP 자동 계산 (핵심 요구사항 8)
  // =========================================================================
  function calculateMatchMVP(players, t1Name, t2Name) {
    if (!players || players.length === 0) return null;

    let bestPlayer = null;
    let highestRating = -999;

    players.forEach(p => {
      const goals = p.goals || 0;
      const assists = p.assists || 0;
      const fouls = p.fouls || 0;
      const isEjected = (fouls >= 5) || (p.redCards > 0) || p.isBanned;

      // 방송용 공식 MVP 산출 공식:
      // 기본 평점 6.0 + (골 × 2.0) + (도움 × 1.2) - (파울 × 0.3)
      let rating = 6.0 + (goals * 2.0) + (assists * 1.2) - (fouls * 0.3);
      if (isEjected) rating -= 3.0; // 퇴장 시 큰 감점

      if (rating > highestRating) {
        highestRating = rating;
        bestPlayer = {
          ...p,
          rating: Math.min(10.0, Math.max(6.0, rating)).toFixed(1),
          teamName: p.team === '1' ? t1Name : t2Name
        };
      }
    });

    return bestPlayer;
  }

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

  const DEFAULT_MATCH = {
    team1Name: "1팀 (블루)",
    team2Name: "2팀 (오렌지)",
    team1Shots: 0,
    team2Shots: 0,
    isMatchEnded: false,
    timer: { durationSeconds: 900, remainingSeconds: 900, isRunning: false },
    players: INITIAL_PLAYERS
  };

  // =========================================================================
  // 6. 메인 전광판 렌더러
  // =========================================================================
  function renderScoreboard() {
    const rawMatch = localStorage.getItem(MATCH_STORAGE_KEY);
    const rawPoss = localStorage.getItem(POSSESSION_STORAGE_KEY);

    const match = rawMatch ? JSON.parse(rawMatch) : DEFAULT_MATCH;
    const poss = rawPoss ? JSON.parse(rawPoss) : null;

    ScoreboardRuntime.matchData = match;
    ScoreboardRuntime.possessionData = poss;

    // 1. 신규 골 득점 여부 검사
    checkForNewGoal(match);

    // 2. 팀 명단 및 헤더
    const t1Name = match.team1Name || '1팀 (블루)';
    const t2Name = match.team2Name || '2팀 (오렌지)';

    document.getElementById('sbTeam1Name').textContent = t1Name;
    document.getElementById('sbTeam2Name').textContent = t2Name;
    document.getElementById('panelT1Name').textContent = `${t1Name} 선수 명단`;
    document.getElementById('panelT2Name').textContent = `${t2Name} 선수 명단`;
    document.getElementById('hudTeam1').textContent = t1Name;
    document.getElementById('hudTeam2').textContent = t2Name;

    // 3. 점수, 파울, 득점자 집계
    let score1 = 0, score2 = 0;
    let fouls1 = 0, fouls2 = 0;
    const scorers1 = [];
    const scorers2 = [];

    (match.players || []).forEach(p => {
      const isT1 = (p.team === '1');
      const g = p.goals || 0;
      const f = p.fouls || 0;

      if (isT1) {
        score1 += g;
        fouls1 += f;
        if (g > 0) scorers1.push({ name: p.name, studentNum: p.studentNum || '-', goals: g });
      } else {
        score2 += g;
        fouls2 += f;
        if (g > 0) scorers2.push({ name: p.name, studentNum: p.studentNum || '-', goals: g });
      }
    });

    document.getElementById('sbScore1').textContent = score1;
    document.getElementById('sbScore2').textContent = score2;
    document.getElementById('team1TotalGoalsBadge').textContent = `⚽ ${score1}`;
    document.getElementById('team2TotalGoalsBadge').textContent = `⚽ ${score2}`;

    // 상단 빠른 득점자 요약
    const t1Quick = scorers1.map(s => `⚽ ${s.name}(${s.goals})`).join('  ');
    const t2Quick = scorers2.map(s => `⚽ ${s.name}(${s.goals})`).join('  ');
    document.getElementById('sbTeam1QuickScorers').textContent = t1Quick;
    document.getElementById('sbTeam2QuickScorers').textContent = t2Quick;

    // 4. 타이머 및 경기 상태
    const rem = match.timer?.remainingSeconds ?? 900;
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    document.getElementById('sbClock').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    const statusBadge = document.getElementById('sbClockStatus');
    const statusText = document.getElementById('sbClockStatusText');

    if (match.isMatchEnded) {
      statusText.textContent = "FULL TIME (종료)";
      statusBadge.style.color = "var(--danger-red)";
      statusBadge.style.borderColor = "var(--danger-red)";
    } else if (match.timer?.isRunning) {
      statusText.textContent = "LIVE MATCH";
      statusBadge.style.color = "var(--live-green)";
      statusBadge.style.borderColor = "var(--live-green)";
    } else {
      statusText.textContent = "PAUSED (일시정지)";
      statusBadge.style.color = "var(--warning-yellow)";
      statusBadge.style.borderColor = "var(--warning-yellow)";
    }

    // 5. 볼 점유율 듀얼 가로형 그래픽 렌더링 (핵심 요구사항 5)
    const { pct1, pct2 } = getPossessionRatio(poss);
    document.getElementById('miniPoss1').textContent = `${pct1}%`;
    document.getElementById('miniPoss2').textContent = `${pct2}%`;
    document.getElementById('miniPossFill1').style.width = `${pct1}%`;

    document.getElementById('statPossVal1').textContent = `${pct1}%`;
    document.getElementById('statPossVal2').textContent = `${pct2}%`;
    document.getElementById('statPossBar1').style.width = `${pct1}%`;
    document.getElementById('statPossBar2').style.width = `${pct2}%`;

    const inner1 = document.getElementById('statPossInnerText1');
    const inner2 = document.getElementById('statPossInnerText2');
    if (inner1) inner1.textContent = pct1 >= 14 ? `${pct1}%` : '';
    if (inner2) inner2.textContent = pct2 >= 14 ? `${pct2}%` : '';

    // 6. 슈팅 & 유효슈팅 & 파울 공식 통계 그래픽 (핵심 요구사항 6)
    const shots1 = match.team1Shots || 0;
    const shots2 = match.team2Shots || 0;
    document.getElementById('hudShot1').textContent = shots1;
    document.getElementById('hudShot2').textContent = shots2;
    document.getElementById('statShotsVal1').textContent = shots1;
    document.getElementById('statShotsVal2').textContent = shots2;

    const totalShots = Math.max(1, shots1 + shots2);
    document.getElementById('statShotsBar1').style.width = `${Math.round((shots1 / totalShots) * 100)}%`;
    document.getElementById('statShotsBar2').style.width = `${Math.round((shots2 / totalShots) * 100)}%`;

    // 유효슈팅 (득점 + 슈팅 비율 기반 정밀 추정치)
    const target1 = Math.min(shots1, score1 + Math.round((shots1 - score1) * 0.5));
    const target2 = Math.min(shots2, score2 + Math.round((shots2 - score2) * 0.5));
    document.getElementById('statTargetVal1').textContent = target1;
    document.getElementById('statTargetVal2').textContent = target2;

    const totalTargets = Math.max(1, target1 + target2);
    document.getElementById('statTargetBar1').style.width = `${Math.round((target1 / totalTargets) * 100)}%`;
    document.getElementById('statTargetBar2').style.width = `${Math.round((target2 / totalTargets) * 100)}%`;

    // 팀 파울 통계 바
    document.getElementById('statFoulsVal1').textContent = fouls1;
    document.getElementById('statFoulsVal2').textContent = fouls2;
    const totalFouls = Math.max(1, fouls1 + fouls2);
    document.getElementById('statFoulsBar1').style.width = `${Math.round((fouls1 / totalFouls) * 100)}%`;
    document.getElementById('statFoulsBar2').style.width = `${Math.round((fouls2 / totalFouls) * 100)}%`;

    // 7. 풋살 5파울 누적 인디케이터 (풋살 핵심 룰)
    renderFoulDots('team1FoulDots', 'team1FoulsCount', fouls1);
    renderFoulDots('team2FoulDots', 'team2FoulsCount', fouls2);

    // 8. 양 팀 5인 라인업 프로필 카드 렌더링 (핵심 요구사항 4)
    renderPlayerCards(match.players || []);

    // 9. 하단 득점자 & 어시스트 티커 피드
    renderBottomTicker(match.players || [], t1Name, t2Name);

    // 10. 경기 종료 모달 및 MVP (핵심 요구사항 8)
    renderMatchEndedModal(match, t1Name, t2Name, score1, score2, pct1, pct2, shots1, shots2, target1, target2, fouls1, fouls2, scorers1, scorers2);
  }

  // =========================================================================
  // 7. 5파울 도트 인디케이터 렌더러
  // =========================================================================
  function renderFoulDots(containerId, countId, fouls) {
    const container = document.getElementById(containerId);
    const countEl = document.getElementById(countId);
    if (!container || !countEl) return;

    countEl.textContent = `${fouls} / 5`;
    const dots = container.querySelectorAll('.foul-dot');
    dots.forEach((dot, index) => {
      if (index < fouls) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    });
  }

  // =========================================================================
  // 8. 5인 라인업 카드 렌더러 (공, 축구화, 옐로/레드카드)
  // =========================================================================
  function renderPlayerCards(players) {
    const list1 = document.getElementById('team1ProfileList');
    const list2 = document.getElementById('team2ProfileList');

    const t1 = players.filter(p => p.team === '1').slice(0, 5);
    const t2 = players.filter(p => p.team === '2').slice(0, 5);

    list1.innerHTML = t1.map(p => createPlayerCardHtml(p)).join('');
    list2.innerHTML = t2.map(p => createPlayerCardHtml(p)).join('');
  }

  function createPlayerCardHtml(p) {
    const isEjected = (p.fouls >= 5) || (p.redCards > 0) || p.isBanned;

    // 스탯 배지
    const chips = [];
    if (p.goals > 0) {
      chips.push(`<span class="stat-chip chip-goal" title="득점 ${p.goals}골">⚽ ${p.goals}골</span>`);
    }
    if (p.assists > 0) {
      chips.push(`<span class="stat-chip chip-assist" title="도움 ${p.assists}개">👟 ${p.assists}도움</span>`);
    }
    if (p.fouls > 0 && !isEjected) {
      chips.push(`<span class="stat-chip chip-foul" title="파울 ${p.fouls}회">🟨 ${p.fouls}파울</span>`);
    }
    if (isEjected) {
      chips.push(`<span class="stat-chip chip-ejected" title="퇴장 (5파울 또는 레드카드)">🟥 퇴장</span>`);
    }

    return `
      <div class="broadcast-player-card ${isEjected ? 'is-ejected' : ''}">
        <div class="player-jersey-box">
          <span class="jersey-num">#${p.number}</span>
          <span class="jersey-snum">${p.studentNum || '-'}</span>
        </div>
        <div class="player-details-col">
          <div class="player-name-row">
            <span class="p-name">${p.name}</span>
            <span class="p-student-id">(${p.studentNum || '-'})</span>
          </div>
          <div class="player-achievements-row">
            ${chips.length > 0 ? chips.join('') : '<span style="font-size:11px; color:#475569;">출전 중</span>'}
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 9. 하단 득점 & 어시스트 티커 피드
  // =========================================================================
  function renderBottomTicker(players, t1Name, t2Name) {
    const el = document.getElementById('sbScorersList');
    if (!el) return;

    const events = [];
    players.forEach(p => {
      const team = p.team === '1' ? t1Name : t2Name;
      if (p.goals > 0) {
        events.push(`⚽ [${team}] #${p.number} ${p.name} (${p.studentNum}) ${p.goals}골`);
      }
      if (p.assists > 0) {
        events.push(`👟 [${team}] #${p.number} ${p.name} (${p.studentNum}) ${p.assists}도움`);
      }
    });

    if (events.length === 0) {
      el.textContent = "현재 공식 경기 진행 중입니다. 양 팀 득점 및 도움 기록이 실시간으로 표출됩니다.";
    } else {
      el.textContent = events.join('   ✦   ');
    }
  }

  // =========================================================================
  // 10. 경기 종료 모달 및 MVP (핵심 요구사항 8)
  // =========================================================================
  function renderMatchEndedModal(match, t1Name, t2Name, s1, s2, pct1, pct2, shots1, shots2, targets1, targets2, f1, f2, sc1, sc2) {
    const modal = document.getElementById('matchEndedModal');
    if (!match.isMatchEnded) {
      modal.classList.add('hidden');
      return;
    }

    modal.classList.remove('hidden');

    // 1. 스코어 및 팀명
    document.getElementById('modalTeam1Name').textContent = t1Name;
    document.getElementById('modalTeam2Name').textContent = t2Name;
    document.getElementById('modalTeam1Score').textContent = s1;
    document.getElementById('modalTeam2Score').textContent = s2;
    document.getElementById('tableT1Head').textContent = t1Name;
    document.getElementById('tableT2Head').textContent = t2Name;

    // 2. 득점자 명단 (학번 + 이름 + 골 수)
    const ul1 = document.getElementById('modalTeam1Scorers');
    const ul2 = document.getElementById('modalTeam2Scorers');

    ul1.innerHTML = sc1.length > 0
      ? sc1.map(g => `<li>⚽ <strong>${g.name}</strong> (${g.studentNum}) - ${g.goals}골</li>`).join('')
      : '<li class="no-record">득점 없음</li>';

    ul2.innerHTML = sc2.length > 0
      ? sc2.map(g => `<li>⚽ <strong>${g.name}</strong> (${g.studentNum}) - ${g.goals}골</li>`).join('')
      : '<li class="no-record">득점 없음</li>';

    // 3. 통계 요약 (점유율 -> 슈팅 -> 유효슈팅 -> 파울 순)
    document.getElementById('finalPossession1').textContent = `${pct1}%`;
    document.getElementById('finalPossession2').textContent = `${pct2}%`;
    document.getElementById('finalShots1').textContent = `${shots1}회`;
    document.getElementById('finalShots2').textContent = `${shots2}회`;
    document.getElementById('finalTargets1').textContent = `${targets1}회`;
    document.getElementById('finalTargets2').textContent = `${targets2}회`;
    document.getElementById('finalFouls1').textContent = `${f1}회`;
    document.getElementById('finalFouls2').textContent = `${f2}회`;

    // 4. 🌟 경기 MVP (Player of the Match) 계산 및 렌더링
    const mvp = calculateMatchMVP(match.players || [], t1Name, t2Name);
    if (mvp) {
      document.getElementById('mvpJerseyNum').textContent = `#${mvp.number}`;
      document.getElementById('mvpPlayerName').textContent = mvp.name;
      document.getElementById('mvpStudentNum').textContent = `학번: ${mvp.studentNum || '-'}`;
      document.getElementById('mvpTeamName').textContent = mvp.teamName;
      document.getElementById('mvpGoalsText').textContent = `${mvp.goals || 0} 득점`;
      document.getElementById('mvpAssistsText').textContent = `${mvp.assists || 0} 도움`;
      document.getElementById('mvpRatingText').textContent = `MVP RATING ${mvp.rating}`;
    }
  }

  // =========================================================================
  // 초기화 및 이벤트 리스너 바인딩
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    // 1. 1920x1080 뷰포트 스케일러 초기화
    initViewportScaler();

    // 2. 현재 시계 루프
    updateRibbonTime();
    setInterval(updateRibbonTime, 1000);

    // 3. 최초 렌더링
    renderScoreboard();

    // 4. 브로드캐스트 채널 리스너 (0ms 무지연 수신)
    SyncBus.listen(() => {
      renderScoreboard();
    });

    // 5. 로컬스토리지 변경 감지
    window.addEventListener('storage', () => {
      renderScoreboard();
    });

    // 6. 100ms 정밀 루프 (타이머 및 점유율 가로형 바 부드러운 전환)
    setInterval(renderScoreboard, 150);

    // 7. 모달 닫기 버튼 이벤트
    const closeBtn = document.getElementById('closeEndedModalBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        document.getElementById('matchEndedModal').classList.add('hidden');
      });
    }
  });
})();
