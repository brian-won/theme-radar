# AGENTS.md — 최상위 런타임 지형도 (Layer 0)

> 이 파일은 모든 세션·모든 프롬프트에서 항상 로드됩니다. **60~80줄을 넘기지 마세요.** 세부 내용은 5장 "하위 문서 지형도"를 통해 필요할 때만 탐색하세요. 새 규칙을 추가하기 전에, 실제로 에이전트가 그 실수를 저질렀는지 먼저 확인하세요(추측성 규칙 선추가 금지).

## 1. 행동 규범 (모든 작업에 예외 없이 적용)
- 기억이나 추측으로 답하지 말 것. 코드/설정/최신 정보는 반드시 직접 탐색(파일 열람, grep, 웹 검색)해서 검증 후 답할 것.
- 기존 코드 구조·변수명·API 스키마를 임의로 추측해 작성하지 말 것. 항상 실제 코드를 확인 후 작성할 것.
- 모든 답변과 작업 보고는 한국어로, 간결하고 명확하게 작성할 것.
- 답변 마지막에 열람한 파일을 명시할 것. 예: `열람파일: docs/architecture.md 외 1개`
- 반복되는 전문 작업(포맷 변환, 특정 워크플로우 등)이 필요하면 `skills/` 폴더에 관련 스킬이 있는지 확인할 것(작성법은 `skills/skill-creator/SKILL.md` 참고). 단순 질문에는 생략 가능. **코덱스는 스킬 자동 탐색 기능이 없으므로 이 지시가 유일한 근거다 — 명시적으로 확인할 것.**

## 2. 프로젝트 개요
- **프로젝트명**: 주식 분석 에이전트 (1단계: 한국 주식 → 2단계: 미국 주식 확대, 사용자 선언 시 전환)
- **코어 스택**: Python(pykrx, Notion API) + Claude Code(뉴스 리서치·테마 분류·요약) + Notion(리포트 저장) → 이후 텔레그램/카카오톡 알림, 클라우드 스케줄러 추가 예정
- **아키텍처 원칙**: 결정적 데이터 수집(스크립트)과 LLM 판단(테마/재료 요약)을 분리. 알림은 최후 단계.

## 3. Commands
```bash
python scripts/market_screen.py [YYYYMMDD]   # 시황+종목 스크리닝 원본 JSON 출력 (테마/재료는 후속 LLM 단계에서 채움)
python scripts/fetch_recent_prices.py        # 관심종목 탭용 최근 5거래일 시세(KIS KRX+NXT 통합)·코스피/코스닥 구분 → data/recent_prices.json (리포트 갱신 후 빌드 전에 실행, 약 3분)
python scripts/build_dashboard.py            # data/*.json → dashboard/index.html + docs/index.html (GitHub Pages 배포용, 내용 동일)
git add -A && git commit -m "..." && git push    # docs/index.html 갱신을 실제 배포(https://brian-won.github.io/theme-radar/)에 반영하려면 푸시까지 해야 함
python scripts/set_dashboard_password.py "새 비밀번호"   # 대시보드 접근 비밀번호 변경(해시만 저장됨) — 변경 후 build_dashboard.py 재실행 필요
# 필요 환경변수: KRX_ID, KRX_PW (data.krx.co.kr 회원) / KIS_APP_KEY, KIS_APP_SECRET (KIS 모의투자, 애프터마켓+NXT 통합 보정·관심종목 5일 시세에 사용)
```
lint/typecheck/test/build 파이프라인은 아직 미구성 (스크립트 위주 프로젝트). 구성 시 이 섹션을 갱신할 것.

## 4. 핵심 절대 규칙 (Boundaries & Invariants)
어떠한 경우에도 무시·우회할 수 없는 규칙입니다.
- `KRX_ID`/`KRX_PW`, 증권사 API 키, Telegram/Kakao 토큰 등은 환경 변수로만 관리하고 절대 코드/문서에 하드코딩하지 않는다.
- `.env`, 시크릿·인증 토큰은 코드에 하드코딩하지 않는다.
- `rm -rf`, `DROP TABLE` 등 파괴적 명령어는 실행 전 사용자에게 반드시 고지한다.
- 작업 완료 선언 전 lint·typecheck·test가 모두 통과(Zero-Error)해야 한다.

## 5. 하위 문서 지형도 (필요할 때만 탐색)
```text
docs/architecture.md       # 레이어 경계, 의존성 방향, 모듈 크기 제약
docs/coding-convention.md  # 네이밍, 타입 안전성, 커밋/PR 규칙
docs/product-spec.md       # 기능 명세, 완료 정의(Definition of Done)
docs/security.md           # 인증/권한, 민감정보 처리, 데이터 보호
skills/                    # 재사용 가능한 작업 절차 (SKILL.md 표준)
  ├── skill-creator/         # 새 스킬 생성/수정 방법
  └── daily-market-report/   # 일일 시황 스크리닝→Notion 기록→대시보드 갱신 전체 절차
```

## 6. 에이전트 오답 노트 (실제로 발생한 실수만 기록)
- [x] [Error-001] 과거 날짜 리포트를 새로 만들 때, 세션 초반 엑셀 원본으로 벌크 임포트해둔 "테마별 종목 로그" 행을 안 지우고 그 위에 새로 추가해 중복 발생 → 새 날짜 작업 전 항상 해당 날짜 기존 행 존재 여부부터 확인할 것.
- [x] [Error-002] Notion `query_data_sources`(SQL 쿼리)는 워크스페이스 사용량 한도가 있어 세션 중 막힐 수 있음 → 막히면 `notion-fetch`/`notion-create-pages` 등 비-SQL 도구로 대체하고, 집계는 페이지 본문에서 직접 값을 읽어 계산할 것.

## 7. 자동검증 연동
- `scripts/verify-task.sh`는 git pre-commit hook과 연동 대상입니다(연동 방법은 스크립트 상단 주석 참고).
- 검증 실패 시 에러 로그를 먼저 읽고 원인을 분석한 뒤 스스로 교정할 것(Self-Correction Loop). 짐작으로 진단하지 말 것.
