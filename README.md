# 풋살 대회 대진표·일정 자동 생성 및 경기 결과 확정 시스템

> **한 줄 요약**: 구글폼 신청(이름/학번/팀명/성별) 응답이 쌓인 구글시트에서 **12개 팀(남 8팀 + 여 4팀)**을 불러와 검증하고, **교사 시드 추첨**으로 12팀 토너먼트 대진표와 일정을 자동 생성하며, 학생은 **‘🏁 경기 종료 확정’** 버튼을 눌러 **승패 · 점수 · 다음 라운드 진출자**를 5초 이내에 확인하는 웹 애플리케이션입니다.

---

## 1. 범위 및 대상 설정 (심의 대응 체크리스트)
- [x] **사용 목적**: 교사용 대회 운영 + 학생용 결과 확인
- [x] **사용 장면**: 학생은 수업/동아리 시간에 학생용 링크에서 결과만 확인
- [x] **교사만 운영**: 시드 추첨/대진 생성/진행 상태 관리는 교사 화면에서만 수행
- [ ] **가정/과제용 여부**: **(선생님 확인 필요 - 기본값 미설정)**

---

## 2. 기술 방향 및 관리형 데이터베이스 제안

### A. 프론트엔드 (가장 단순하고 즉시 실행 가능한 구성)
- **HTML5 + Vanilla CSS + ES6 JavaScript (무빌드 표준 웹)**:
  - 복잡한 외부 라이브러리 설치 없이 학교 PC, 태블릿, 스마트폰 브라우저에서 즉시 실행됩니다.
  - 동일 기기/브라우저 간에는 `LocalStorage`와 `BroadcastChannel`을 통해 **0ms 지연 실시간 상태 공유**가 즉시 동작합니다.

### B. 여러 기기 간 실시간 공유를 위한 관리형 서비스 제안: **Supabase (권장)**
학생과 교사가 서로 다른 스마트폰/태블릿에서 동일한 대진표와 경기 확정 상태를 실시간으로 보려면 서버와 데이터베이스가 필요합니다. 처음 만드는 선생님도 무료로 쉽게 다룰 수 있는 **Supabase(PostgreSQL 기반 관리형 서비스)**를 추천합니다.
- **선정 이유**:
  1. 무료 시작 가능(Free Tier) 및 별도 백엔드 서버 코딩 없이 URL과 공개키만으로 연동 가능
  2. 데이터베이스 수준에서 권한을 강제하는 **행 단위 보안(Row Level Security, RLS)** 및 실시간 구독(Realtime) 기본 제공
- **권한 강제(RLS) 및 테이블 보안 규칙 예시**:
  ```sql
  -- 1) 모든 사용자(학생/교사)는 팀명만 포함된 대진표(matches, teams) 조회 가능
  CREATE POLICY "Anyone can view tournament matches"
  ON matches FOR SELECT USING (true);

  -- 2) 시드 추첨 및 대진표 생성(INSERT/DELETE)은 교사 역할(role = 'teacher')만 허용
  CREATE POLICY "Only teachers can generate brackets"
  ON matches FOR INSERT
  WITH CHECK ((auth.jwt() ->> 'role') = 'teacher');

  -- 3) 이미 '확정'된 경기는 중복 수정(UPDATE) 불가하도록 서버에서 강제 차단
  CREATE POLICY "Confirm only unconfirmed matches"
  ON matches FOR UPDATE
  USING (status <> '확정');
  ```
- **비밀키 관리**:
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TEACHER_TOKEN_HASH` 등 모든 비밀키는 코드에 직접 쓰지 않고 `.env` 파일(예시: [.env.example](file:///c:/Users/user/Desktop/footsal/.env.example)) 또는 배포 환경변수에 두며, [.gitignore](file:///c:/Users/user/Desktop/footsal/.gitignore)에 `.env`를 포함해 공개 저장소 노출을 차단했습니다.

---

## 3. 프로젝트 파일 구조

```text
c:/Users/user/Desktop/footsal/
├── index.html                 # 대회 운영 포털 (교사용 / 학생용 / 전광판 진입 링크 분리)
├── portal.html                # 교사용·학생용 역할별 독립 접속 안내 포털
├── match.html                 # 메인 웹앱 (교사 대진 생성 콘솔 + 학생 대진표/경기 종료 확정 화면)
├── tournament.js              # 핵심 7대 분리 모듈 (시트 연동, 12팀 대진 생성, 경기 확정 전이, 권한, 개인정보보호)
├── app.js                     # 실시간 스코어보드·타이머 및 경기 종료 확정 연동 로직
├── scoreboard.html            # 대회장 대형 스크린용 학생 중계 전광판 (승패·점수·다음 라운드 진출자 표시)
├── scoreboard.js              # 전광판 실시간 렌더링 엔진
├── possession.html            # (보조) 볼 점유율 측정 앱
├── style.css                  # 스타일시트 (대진표 4단 그리드, 결과 확정 모달, 반응형 레이아웃)
├── PRIVACY_POLICY.md          # 개인정보보호위원회 작성지침 준수 개인정보 처리방침 초안
├── TERMS_OF_SERVICE.md        # 디지털콘텐츠 표준약관 취지 준수 이용약관 초안
├── TEST_CHECKLIST_RESULT.md   # 필수 4대 테스트 기준 검증 결과 보고서
├── .env.example               # 비밀키/환경변수 분리 설정 예시
└── .gitignore                 # .env 등 민감 파일 커밋 방지 설정
```

---

## 4. 핵심 7대 분리 모듈 명세 (`tournament.js`)

각 모듈은 서로 독립적으로 수정·유지보수할 수 있도록 입력·출력·예외 처리가 분리되어 있습니다.

| 모듈명 | 역할 및 주요 기능 | 입력 데이터 | 출력 데이터 | 예외 처리 및 수정 시 주의사항 |
| :--- | :--- | :--- | :--- | :--- |
| **1) `TeacherUIModule`**<br>(교사 화면 UI) | 팀 수 검증(남8+여4), 시드 추첨, 대진 생성, 진행 상태 대시보드, 학생용 링크 복사 | 구글시트 팀 목록, 교사 버튼 클릭 | 검증 결과 표, 대진표 미리보기, 진행 상태 대시보드 | 화면에는 **팀명**만 노출하며, 남/여 팀 수 불일치 시 구체적 부족·초과 수를 안내 |
| **2) `StudentUIModule`**<br>(학생 화면 UI) | 대진표/일정 표시, 현재 진행 경기 강조, ‘경기 종료 확정’ 클릭 시 승패·점수·진출자 모달 표시 | 현재 토너먼트 상태, 경기 종료 확정 액션 | 승패·점수·다음 라운드 진출자 표시(5초 이내) | 학생용 링크(`?role=student`)에서는 교사 전용 패널이 렌더링되지 않도록 차단 |
| **3) `SheetSyncModule`**<br>(구글시트 연동) | 구글폼 응답 시트(CSV/URL) 읽기, 중복 팀명 정리, 남 8팀·여 4팀 검증 | 구글시트 URL 또는 CSV 텍스트, 컬럼명 매핑 | 검증된 12팀 목록(`teamId`, `teamName`, `gender`) | 선생님이 실제 폼에 설정한 컬럼명(`이름`, `학번`, `팀명`, `성별`)을 화면에서 즉시 매핑 가능 |
| **4) `BracketGeneratorModule`**<br>(12팀 대진 생성) | 시드 추첨(`seedValue`), 12팀 토너먼트(1R 4경기 + 부전승 4팀 8강 자동 배치 → 8강 → 4강 → 결승) 생성 | 남 8팀 + 여 4팀 배열, 시드 난수 | 11개 경기(`M1~M11`) 및 라운드 연결(`nextMatchId`, `nextSlot`) | 부전승 4개 팀(시드 1~4위)이 2라운드(8강 `M5~M8` A슬롯)에 누락 없이 즉시 표시되도록 보장 |
| **5) `MatchTransitionModule`**<br>(경기 확정/상태 전이) | ‘경기 종료 확정’ 시 승패·점수·진출자 계산, 다음 라운드 슬롯 자동 채움, 다음 경기 `진행` 전환 | `matchId`, `scoreA`, `scoreB`, 동점 시 승자 ID | 확정된 경기 상태, 진출자 요약, 다음 진행 경기 ID | 이미 `확정`된 경기의 **중복 확정 요청을 엄격히 차단**하고 동점 시 승부차기 승자 선택 안내 |
| **6) `RoleAuthModule`**<br>(권한/역할 제어) | 교사(`teacher`)와 학생(`student`) 권한 분리 및 감사 로그 기록 | 요청 주체 역할(`role`), 서명 토큰 | 허용 여부 또는 `PERMISSION_DENIED` 예외 | 단순 화면 숨김에 그치지 않고 함수 호출 시점에 `assertTeacherPermission()`으로 교사 권한 강제 검증 |
| **7) `PrivacyGuardModule`**<br>(개인정보보호 규칙) | 시트의 이름/학번 즉시 폐기, 화면 팀명만 노출, 로그 내 학번 패턴 자동 마스킹 | 원본 시트 행(`이름`, `학번`, `팀명`, `성별`) | 개인정보가 제거된 안전한 팀 객체(`teamName`, `gender`) | 로그나 에러 메시지에도 5자리 학번·이름이 남지 않도록 `maskLogMessage()` 항상 경유 |

---

## 5. 데이터 모델 및 생명주기(수집·보관·접근·파기)

| 모델명 | 주요 필드 (예시 필드명) | 수집 목적 및 보관 범위 | 접근 권한 및 파기/내보내기 기준 |
| :--- | :--- | :--- | :--- |
| **`Team`** | `teamId`, `teamName`, `gender` (`남`/`여`), `seedNumber`, `hasBye` | 12팀(남8+여4) 대진표 편성 (개인 이름·학번은 저장하지 않음) | • 조회: 교사/학생 전체(팀명만)<br>• 생성/삭제: 교사만 가능 |
| **`Tournament`** | `tournamentId`, `createdAt`, `status` (`대기`/`진행`/`종료`), `currentMatchId` | 현재 대회 진행 상태 및 활성 경기 추적 | • 교사 화면에서 JSON 백업 내보내기 및 대회 종료 후 영구 파기 가능 |
| **`Match`** | `matchId`, `tournamentId`, `roundNumber`, `matchNumber`, `teamAId`, `teamBId`, `status` (`대기`/`진행`/`확정`), `scoreA`, `scoreB`, `winnerTeamId`, `nextMatchId`, `nextSlot` (`A`/`B`) | 라운드별 경기 일정, 확정 점수, 승패 및 다음 라운드 자동 진출 연결 | • 확정 전 경기만 결과 확정 가능(중복 확정 차단)<br>• 확정 즉시 다음 라운드 슬롯에 `winnerTeamId` 자동 반영 |
| **`Seed`** | `tournamentId`, `seedValue` | 시드 추첨 결과의 공정성 검증 및 재현/감사용 난수 키 | • 교사 및 학생 화면 상단에 시드 감사값 표시 |

---

## 6. 실행 방법 및 역할별 접속 주소

### 로컬 웹 서버로 실행
```bash
npx -y serve .
# 또는
python -m http.server 8080
```
- **운영 포털 메인**: `http://localhost:8080/index.html`
- **교사용 대회 운영 화면**: `http://localhost:8080/match.html?role=teacher`
- **학생용 결과 확인 & 경기 종료 확정 화면**: `http://localhost:8080/match.html?role=student`
- **학생 대형 전광판**: `http://localhost:8080/scoreboard.html`

---

## 7. 선생님 확인 필요 항목 (최종 운영 전 기입 안내)
아래 3개 항목은 임의의 기본값을 두지 않고 화면 및 정책 문서([PRIVACY_POLICY.md](file:///c:/Users/user/Desktop/footsal/PRIVACY_POLICY.md), [TERMS_OF_SERVICE.md](file:///c:/Users/user/Desktop/footsal/TERMS_OF_SERVICE.md))에 **`(선생님 확인 필요)`**로 표시해 두었습니다.
1. **가정/과제용 여부**: 수업/동아리 시간 외에 가정·과제용으로도 접속하는지 여부
2. **개인정보(대회 운영 데이터) 보유 기간**: 대회 종료 후 며칠/몇 개월 보관 후 파기할지 여부
3. **개인정보 보호책임자 및 담당부서**: 학교명, 담당 부서명(예: 체육교육부), 담당 교사 성명 및 연락처
