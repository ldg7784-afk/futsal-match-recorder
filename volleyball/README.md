# 🏐 고등학교 체육 배구 수행평가 시스템 (`volleyball/`)

배구 고등학교 체육 수행평가에서 **교사가 루브릭 기준으로 점수/등급을 입력·검증**하면, **학생은 총점(큰 숫자)과 항목별 세부(1클릭 아코디언 접기/펼치기)**만 빠르게 확인하는 독립 웹 애플리케이션입니다.

---

## 1. 파일 구조
- `index.html` : 교사용 루브릭 점수 입력 화면, 학생용 총점(큰 숫자)·아코디언 세부 화면, 심의 체크리스트 및 정책 모달, 공통 푸터
- `style.css` : 교사용 2단 레이아웃, 학생용 대형 점수 카드, 아코디언 애니메이션 및 반응형 스타일
- `app.js` : 7대 필수 모듈(`UIModule`, `RubricCalcModule`, `ValidationModule`, `DataModelModule`, `AuthAccessModule`, `PrivacyGuardModule`, `ComplianceDocModule`) 구현
- `PRIVACY_POLICY.md` : 개인정보보호위원회 작성지침 기준 개인정보 처리방침 초안
- `TERMS_OF_SERVICE.md` : 디지털콘텐츠 중개 표준약관 취지 반영 서비스 이용약관 초안
- `TEST_CHECKLIST_RESULT.md` : 5대 계산 정확성 테스트 및 기능 검증 결과서
- `.env.example` / `.gitignore` : 환경 변수 분리 템플릿 및 보안 제외 설정
- `vercel.json` : 독립 Vercel 프로젝트 배포 설정

---

## 2. 실행 방법
1. 별도 빌드 과정이나 무거운 외부 라이브러리 없이 브라우저에서 `volleyball/index.html`을 열거나 정적 서버(`npx serve volleyball`)로 즉시 실행할 수 있습니다.
2. Vercel에 독립 웹앱으로 배포할 때는 Root Directory를 `volleyball`로 지정하거나 `volleyball` 폴더에서 `vercel --prod`를 실행하면 독립 도메인으로 배포됩니다.

---

## 3. 관리형 서버·데이터베이스 추천 (Supabase)
- 여러 학생이 각자 스마트폰/태블릿으로 접속해 본인 점수를 열람해야 하는 환경에서는 무료 시작이 가능한 **Supabase (PostgreSQL + Auth + Row Level Security)**를 권장합니다.
- **선정 이유**:
  1. 별도의 백엔드 서버 코드를 직접 짜지 않아도 테이블 생성만으로 클라우드 저장이 가능합니다.
  2. **Row Level Security(RLS)** 정책을 통해 데이터베이스 수준에서 "교사 역할(`role = 'teacher'`)만 INSERT/UPDATE 가능, 학생은 본인 `student_number` 행만 SELECT 가능"하도록 서버 권한 강제가 쉽습니다.
  3. 환경 변수(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)만 `.env`에 설정하면 됩니다.
- 교사 1인이 교실 전자칠판/태블릿으로 운영하는 경우에는 기본 내장된 브라우저 영속 저장소(`LocalStorage`) + **JSON 백업 내보내기**만으로 다음 수업까지 안전하게 데이터가 보존됩니다.
