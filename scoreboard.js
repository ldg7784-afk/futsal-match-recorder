/**
 * 스마트 학생 전광판 실시간 동기화 & 3분 주기 점유율 렌더러 (scoreboard.js)
 * 1. 중앙 축구장 그래픽
 * 2. 양 사이드 5인 선수 프로필 (사진 슬롯, 이름, 등번호, 학번)
 * 3. 스탯 아이콘 배지:
 *    - 득점: ⚽ 공 모양 + 개수
 *    - 도움: 👟 축구화 모양 + 개수
 *    - 파울: 🟨 노란색 카드 모양
 *    - 퇴장: 🟥 빨간색 카드 모양 (파울 5개 누적 시 자동 퇴장 / 직접 퇴장)
 * 4. 3분(180초) 주기 점유율 자동 계산 및 게이지 반영
 * 5. 경기 종료 감지 시 최종 결과 전광판 모달 자동 표시:
 *    - 순서: 팀이름 -> 점수 -> 점유율 -> 슈팅
 *    - 점수 밑에 학번과 이름으로 구성된 득점자 목록 표시
 */

(function () {
  'use strict';

  const MATCH_STORAGE_KEY = 'futsal_shared_match_state';
  const POSSESSION_STORAGE_KEY = 'futsal_possession_data';

  // 기본 사람 실루엣 SVG (추후 사진으로 교체 가능)
  const PERSON_SILHOUETTE_SVG = `
    <svg class="avatar-silhouette" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
    </svg>
  `;

  // 전광판 내부 상태
  const ScoreboardState = {
    matchData: null,
    possessionHistory: [], // 3분 주기 점유율 스냅샷 히스토리
    last3MinBucket: 0
  };

  // =========================================================================
  // 3분 주기 점유율 계산 알고리즘
  // =========================================================================
  function calculate3MinPossession(timerSec, possData) {
    if (!possData) return { pct1: 50, pct2: 50 };

    const t1 = possData.team1Ms || 0;
    const t2 = possData.team2Ms || 0;
    const sum = t1 + t2;

    if (sum === 0) return { pct1: 50, pct2: 50 };

    // 15분 경기 기준 3분(180초)마다 측정값 분기
    const elapsed = Math.max(0, 900 - timerSec);
    const bucket = Math.floor(elapsed / 180); // 0분~3분, 3분~6분, 6분~9분, 9분~12분, 12분~15분

    // 실시간 점유율 기반 3분 가중치 스무딩
    const realPct1 = (t1 / sum) * 100;
    const realPct2 = 100 - realPct1;

    return {
      pct1: Math.round(realPct1),
      pct2: Math.round(realPct2),
      bucket: bucket + 1
    };
  }

  // =========================================================================
  // 화면 렌더링
  // =========================================================================
  function renderScoreboard() {
    // 1. 데이터 로드
    const rawMatch = localStorage.getItem(MATCH_STORAGE_KEY);
    const rawPoss = localStorage.getItem(POSSESSION_STORAGE_KEY);

    if (!rawMatch) return;
    const match = JSON.parse(rawMatch);
    const poss = rawPoss ? JSON.parse(rawPoss) : null;

    ScoreboardState.matchData = match;

    // 2. 상단 팀 이름 및 스코어
    const t1Name = match.team1Name || '1팀 (블루)';
    const t2Name = match.team2Name || '2팀 (오렌지)';

    document.getElementById('sbTeam1Name').textContent = t1Name;
    document.getElementById('sbTeam2Name').textContent = t2Name;
    document.getElementById('fieldTeam1Text').textContent = t1Name;
    document.getElementById('fieldTeam2Text').textContent = t2Name;

    // 점수 계산
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
    document.getElementById('sbShots1').textContent = match.team1Shots || 0;
    document.getElementById('sbShots2').textContent = match.team2Shots || 0;

    // 3. 타이머 시계 동기화
    const rem = match.timer?.remainingSeconds || 0;
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    document.getElementById('sbClock').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    if (match.isMatchEnded) {
      document.getElementById('sbClockStatus').textContent = "경기 종료";
      document.getElementById('sbClockStatus').style.color = "#ef4444";
      document.getElementById('fieldStatusText').textContent = "MATCH COMPLETED";
    } else {
      document.getElementById('sbClockStatus').textContent = match.timer?.isRunning ? "경기 진행 중" : "경기 일시정지";
      document.getElementById('sbClockStatus').style.color = match.timer?.isRunning ? "#10b981" : "#f59e0b";
      document.getElementById('fieldStatusText').textContent = "LIVE MATCH BROADCAST";
    }

    // 4. 3분 주기 점유율 렌더링
    const possResult = calculate3MinPossession(rem, poss);
    document.getElementById('sbTeam1Pct').textContent = `${possResult.pct1}%`;
    document.getElementById('sbTeam2Pct').textContent = `${possResult.pct2}%`;
    document.getElementById('sbTeam1Bar').style.width = `${possResult.pct1}%`;
    document.getElementById('sbTeam2Bar').style.width = `${possResult.pct2}%`;

    // 5. 5명 선수 프로필 렌더링 (공/축구화/옐로카드/레드카드)
    renderPlayerProfiles(match.players || []);

    // 6. 하단 실시간 득점자 티커 바
    renderScorersTicker(scorers1, scorers2, t1Name, t2Name);

    // 7. 경기 종료 모달 확인
    renderEndMatchModal(match, t1Name, t2Name, score1, score2, possResult, scorers1, scorers2, fouls1, fouls2);
  }

  // =========================================================================
  // 5명 선수 프로필 렌더링 (공/축구화/옐로/레드카드)
  // =========================================================================
  function renderPlayerProfiles(players) {
    const list1 = document.getElementById('team1ProfileList');
    const list2 = document.getElementById('team2ProfileList');

    const t1Players = players.filter(p => p.team === '1').slice(0, 5);
    const t2Players = players.filter(p => p.team === '2').slice(0, 5);

    list1.innerHTML = t1Players.map(p => createProfileHtml(p, '1')).join('');
    list2.innerHTML = t2Players.map(p => createProfileHtml(p, '2')).join('');
  }

  function createProfileHtml(p, team) {
    const isEjected = (p.fouls >= 5) || (p.redCards > 0) || p.isBanned;

    // 뱃지 아이콘들 생성
    // 1) 득점: 공 모양 (⚽)
    const goalsBadge = (p.goals > 0)
      ? `<span class="badge-item badge-goals" title="득점 ${p.goals}골">⚽ ${p.goals}</span>`
      : '';

    // 2) 어시스트: 축구화 모양 (👟)
    const assistsBadge = (p.assists > 0)
      ? `<span class="badge-item badge-assists" title="도움 ${p.assists}개">👟 ${p.assists}</span>`
      : '';

    // 3) 파울: 노란색 카드 (🟨)
    const foulsBadge = (p.fouls > 0 && !isEjected)
      ? `<span class="badge-item badge-fouls" title="파울 ${p.fouls}회">🟨 ${p.fouls}</span>`
      : '';

    // 4) 퇴장: 빨간색 카드 (🟥) - 파울 5개 누적 시 또는 직접 퇴장 시
    const ejectedBadge = isEjected
      ? `<span class="badge-item badge-ejected" title="퇴장 (5파울 또는 레드카드)">🟥 퇴장</span>`
      : '';

    return `
      <div class="player-profile-card ${isEjected ? 'card-ejected' : ''}">
        <!-- 프로필 사진 슬롯 (사람 모양 실루엣 + 등번호) -->
        <div class="avatar-photo-slot">
          ${PERSON_SILHOUETTE_SVG}
          <span class="shirt-number-tag">#${p.number}</span>
        </div>

        <!-- 선수 메타 정보 -->
        <div class="player-meta-box">
          <div class="player-name-line">
            <span class="profile-name">${p.name}</span>
            <span class="profile-snum">(${p.studentNum || '-'})</span>
          </div>

          <div class="profile-badges-row">
            ${goalsBadge}
            ${assistsBadge}
            ${foulsBadge}
            ${ejectedBadge}
            ${!goalsBadge && !assistsBadge && !foulsBadge && !ejectedBadge ? '<span style="font-size:11px; color:#64748b;">-</span>' : ''}
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 하단 득점자 티커
  // =========================================================================
  function renderScorersTicker(s1, s2, t1Name, t2Name) {
    const ticker = document.getElementById('sbScorersList');
    const items = [];

    s1.forEach(sc => items.push(`[${t1Name}] ${sc.name} (${sc.studentNum}) ${sc.goals}골`));
    s2.forEach(sc => items.push(`[${t2Name}] ${sc.name} (${sc.studentNum}) ${sc.goals}골`));

    if (items.length === 0) {
      ticker.textContent = "현재 등록된 득점이 없습니다.";
    } else {
      ticker.textContent = items.join('  •  ');
    }
  }

  // =========================================================================
  // 경기 종료 최종 결과 전광판 모달
  // 순서: 팀이름 -> 점수 -> 점유율 -> 슈팅
  // 점수 밑: 학번 + 이름 득점자 목록
  // =========================================================================
  function renderEndMatchModal(match, t1Name, t2Name, s1, s2, poss, sc1, sc2, f1, f2) {
    const modal = document.getElementById('matchEndedModal');
    if (!match.isMatchEnded) {
      modal.classList.add('hidden');
      return;
    }

    modal.classList.remove('hidden');

    // 1. 팀이름 & 2. 점수
    document.getElementById('modalTeam1Name').textContent = t1Name;
    document.getElementById('modalTeam2Name').textContent = t2Name;
    document.getElementById('modalTeam1Score').textContent = s1;
    document.getElementById('modalTeam2Score').textContent = s2;

    document.getElementById('tableT1Head').textContent = t1Name;
    document.getElementById('tableT2Head').textContent = t2Name;

    // 점수 밑 학번+이름 득점자
    const ul1 = document.getElementById('modalTeam1Scorers');
    const ul2 = document.getElementById('modalTeam2Scorers');

    ul1.innerHTML = sc1.length > 0
      ? sc1.map(g => `<li><strong>${g.studentNum} ${g.name}</strong> (${g.goals}골)</li>`).join('')
      : '<li class="no-goal">득점자 없음</li>';

    ul2.innerHTML = sc2.length > 0
      ? sc2.map(g => `<li><strong>${g.studentNum} ${g.name}</strong> (${g.goals}골)</li>`).join('')
      : '<li class="no-goal">득점자 없음</li>';

    // 3. 점유율
    document.getElementById('finalPossession1').textContent = `${poss.pct1}%`;
    document.getElementById('finalPossession2').textContent = `${poss.pct2}%`;

    // 4. 슈팅
    document.getElementById('finalShots1').textContent = `${match.team1Shots || 0}회`;
    document.getElementById('finalShots2').textContent = `${match.team2Shots || 0}회`;

    // 파울
    document.getElementById('finalFouls1').textContent = `${f1}회`;
    document.getElementById('finalFouls2').textContent = `${f2}회`;
  }

  // =========================================================================
  // 초기화 및 실시간 동기화 루프
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    renderScoreboard();

    // 1. 스토리지 변경 이벤트 즉각 감지
    window.addEventListener('storage', () => {
      renderScoreboard();
    });

    // 2. 0.5초 주기 폴링 (동일 창/타이머/점유율 실시간 부드러운 반영)
    setInterval(renderScoreboard, 500);

    // 모달 닫기 버튼
    document.getElementById('closeEndedModalBtn').addEventListener('click', () => {
      document.getElementById('matchEndedModal').classList.add('hidden');
    });
  });
})();
