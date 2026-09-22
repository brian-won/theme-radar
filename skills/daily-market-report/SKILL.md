---
name: daily-market-report
description: 한국 주식 일일 시황/테마 리포트를 만들어 Notion에 기록하고 "테마 레이더" 대시보드를 갱신할 때 반드시 사용합니다. 사용자가 "오늘/특정 날짜로 스크리닝 돌려서 리포트 만들어줘", "일일 리포트", "테마 순위 갱신", "대시보드 업데이트"라고 말하면 이 스킬을 먼저 활성화하세요.
---

# daily-market-report

한국 주식 일일 시황·주도 테마 리포트를 생성해 Notion에 기록하고, "테마 레이더" 대시보드(Artifact)까지 최신화하는 전체 절차입니다.

## 언제 사용하는가
- 사용자가 특정 날짜(보통 "오늘")로 시황/종목 스크리닝을 다시 돌려달라고 할 때
- 그 결과로 일일 리포트를 만들어 Notion에 올려달라고 할 때
- 테마 통계 대시보드를 최신 데이터로 갱신해달라고 할 때

## 사전 준비 (최초 1회, 세션마다 재확인)
아래 환경변수가 없으면 사용자에게 `!` 명령으로 직접 설정해달라고 요청할 것 — 절대 비밀번호/키를 채팅에 대신 입력하지 말 것(AGENTS.md 4장).
- `KRX_ID`, `KRX_PW` — data.krx.co.kr 무료 회원 (pykrx 인증용)
- `KIS_APP_KEY`, `KIS_APP_SECRET` — 한국투자증권 모의투자 Open API 키 (당일 조회 시 KRX+넥스트레이드 애프터마켓 통합 보정용, `scripts/kis_client.py`가 사용)

## 절차

### 1. 스크리닝 실행
```bash
python scripts/market_screen.py [YYYYMMDD]   # 생략 시 최근 영업일
```
- pykrx로 시가총액 300억+, ETF/ETN/스팩/우선주 제외 후 (거래대금, 등락률) 캐스케이드 임계값(500억/3% → 500억/2% → 300억/2%, 20종목 초과 시 완화 중단)으로 스크리닝.
- 조회일이 당일이면 KIS API로 KRX+NXT 통합(애프터마켓 포함) 수치로 자동 보정됨 — `docs/product-spec.md`의 배경 설명 참고.
- 결과 JSON에 `index`(코스피/코스닥 등락률·거래대금·이평선), `applied_screen_tier`, `stocks`(테마/재료는 비어있음) 포함.

### 2. 테마/재료 리서치
- 스크리닝된 종목마다 WebSearch로 당일 상승 이유를 조사하고 테마명을 부여. **테마명은 인포스탁(infostock.co.kr) 표기를 우선** — 국내 증권 뉴스가 "인포스탁 기준 OO 테마" 식으로 그대로 인용하는 경우가 많으니 검색 결과에서 활용. 마땅한 표기가 없으면 합리적으로 제안(사용자가 나중에 직접 교정 가능).
- 재료는 한 줄 요약, `reference/테마일지_9월.xlsx`의 "재료" 컬럼 문체를 참고.
- 종목 수가 많으면(10개 이상) WebSearch 결과로 컨텍스트가 오염되니 **fork 서브에이전트에 위임**하고 결과만 받을 것 — 3~5단계까지 fork에 함께 맡기는 게 효율적.

### 3. 테마 그룹핑/순위화
- 테마별로 묶어 평균 등락률, 합계 거래대금(억원, 정수) 계산.
- **합계 거래대금 기준 내림차순 순위** — 1~3등은 개별 순위(`rank: 1~3`)로 표시(`reference/테마일지_9월.xlsx`의 `일별주도섹터`/`260105(월)` 시트와 동일 규칙). **통계(발생빈도 등)는 1~3등만 집계 대상**이라 이 셋의 경계는 엄격히 지킬 것.
- **4등 이하도 하나로 뭉뚱그리지 말고 반드시 테마별로 세분화**해서 `rank: 4`의 여러 그룹으로 나눠 담을 것(거래대금 낮은 종목이라도 어떤 테마였는지 대시보드 리포트에서 확인 가능해야 함 — 2026-09-18 사용자 요청 이후 표준 규칙). `sumValue` 내림차순 정렬. (예: `daily_detail_with_reasons.json`의 "2026-09-17" 키 참고 — 항공우주/게임/광통신/바이오 등으로 세분화된 사례)

### 4. Notion "일일 시황 리포트"에 기록
DB: `https://app.notion.com/p/1f9031db2a534d0fa751b6a2c94a58e6` (data source `collection://b7067d25-d02a-4c71-a861-3f78d883049b`)
- 속성: `Name`("YYYY-MM-DD 일일 시황 리포트"), `날짜`, `코스피/코스닥 등락률·거래대금(조)`, `코스피/코스닥 이평선`("5일선 위·20일선 아래·60일선 아래" 형식), `1위~3위 테마`, `스크리닝 종목수`
- 본문: 맨 위에 "거래대금은 KRX+NXT 애프터마켓 통합 기준" 안내 한 줄 → 시황 요약 → 순위별 테마 섹션(종목명/등락률/거래대금/재료 표 + 테마 소계) → 4등 묶음 → 하단에 테마명 잠정 부여 종목 명시

### 5. Notion "테마별 종목 로그"에 종목 추가
DB: `https://app.notion.com/p/e5f8b1008d914dd6b231b05c92a88773` (data source `collection://a1efde8d-c136-4ba9-8267-9f8064a78a1d`)
- 스크리닝된 전체 종목(4등 포함)을 종목명/날짜/테마/등락률/거래대금(억) 행으로 추가. `notion-create-pages`는 100개씩 배치, `allow_async: true` 권장.
- **테마가 기존 SELECT 옵션에 없으면 먼저 `notion-update-data-source`로 `ALTER COLUMN "테마" SET SELECT(...)`에 기존 옵션 전체 + 신규 옵션을 추가**해야 한다 — 새 옵션명으로 바로 페이지를 만들면 `validation_error`로 실패함. 개념이 겹치는 테마명(예: "보안(정보)" vs 기존 "보안")은 새로 만들지 말고 기존 옵션에 매핑할 것.
- 한글을 유니코드 이스케이프(`\uXXXX`)로 수기 입력하면 오타가 잦다(이번 세션에서 에이피알→에이피어사, 에코프로비엠→에코프로비엔, 테크윙→테크윈, 티엠씨→티엔씨 등 4건 발생). **생성 직후 `notion-fetch`로 종목명을 재확인하고 틀렸으면 `notion-update-page`로 즉시 수정할 것.**

### 6. "테마 레이더" 대시보드 갱신
두 가지 버전이 공존한다. 데이터 원본은 동일(`data/daily_reports.json` + `data/daily_detail_with_reasons.json`)하므로, 새 날짜 추가 시 두 버전 다 갱신할 것.

**6-A. 표준(공통) 버전 — `dashboard/index.html` (Claude/코덱스/안티그래비티 등 어떤 도구로도 사용 가능)**
- `data/daily_reports.json`에 그날 리포트 요약(코스피/코스닥 등락률·거래대금·이평선, 종목수, top1~3, Notion 페이지 URL) 항목 추가.
- `data/daily_detail_with_reasons.json`에 그날 전체 상세(순위별 테마 그룹 + 종목별 종목명/등락률/거래대금/재료 `reason`)를 날짜 키로 추가.
  - ⚠️ **발생빈도 = 테마에 속한 종목 수가 아니라, 그 테마가 어떤 날의 1~3위로 뽑힌 횟수다.** 4등 그룹은 통계에서 제외되지만, `daily_detail`에는 4등 종목도 전부 기록한다(상세표 표시용).
- `python scripts/fetch_recent_prices.py` 실행 → 관심종목 탭의 최근 5거래일 시세와 코스피/코스닥 구분을 `data/recent_prices.json`에 갱신(새 날짜를 추가한 뒤 빌드 전에 항상 먼저 실행. KRX_ID/KRX_PW·KIS_APP_KEY/KIS_APP_SECRET 필요. 시세는 KIS 기간별 시세 API를 KRX+NXT 통합(UN) 기준으로 조회하며 172종목 기준 약 3분 소요, 모의투자 초당 2건 제한. 종목명은 공백·&·괄호를 뺀 표기로 pykrx와 매칭하며 미매칭·조회 실패 종목은 로그로 출력됨).
- `python scripts/build_dashboard.py` 실행 → `dashboard/index.html`(로컬 미리보기)과 `docs/index.html`(GitHub Pages 배포본, 내용 동일)을 재생성. 이 파일은 데이터가 내장된 완전한 정적 HTML이라 서버/네트워크/Claude API 없이 더블클릭만으로 어떤 브라우저·어떤 AI 도구에서도 열람/수정 가능하다.
- **실제 서비스(웹/폰)에 반영하려면 빌드만으로 끝나지 않고 `git add -A && git commit && git push`까지 해야 한다** — `https://brian-won.github.io/theme-radar/`는 GitHub Pages가 `main` 브랜치 `docs/` 폴더를 서빙하는 것이라, 푸시 전까지는 로컬 파일만 갱신된 상태다.
- HTML 골격/스타일/JS 로직을 바꿀 때는 `dashboard/template.html`(`/*__SNAPSHOT__*/` 플레이스홀더 포함)을 고치고 다시 빌드할 것 — `dashboard/index.html`을 직접 수정하면 다음 빌드 때 덮어써진다.
- 발행 전 `node --check`로 인라인 `<script>` 문법을 검증하고, DOM을 최소 스텁으로 채운 Node에서 `computeThemeStats`/`groupDetailTable` 같은 핵심 함수를 직접 호출해 종목 수 합계 등을 검산할 것.
- **화면 구조(2026-09-18 개편)**: 헤더에 종목명·테마·재료 통합 검색창(결과 클릭 시 리포트 탭의 해당 날짜로 이동) + 탭 6개(시황/리포트/테마/관심종목/통계/분석). 시황·리포트 탭은 "월 선택(년/월 칩) → 그 달 일자 표 → 행 클릭 시 하단에 상세 카드" 구조가 공통. 리포트 탭 상세 카드는 4등 이하도 테마별로 세분화해서 보여준다(3단계 규칙 참고). 테마 탭은 전체 날짜의 테마를 누적해서 나열하고 상위 4개를 1~4순위로 하이라이트(순위 = 1~3위에 든 날의 평균 거래대금 순위 + 평균 등락률 순위를 합산, 낮을수록 상위·동점이면 평균 거래대금 우선, 1~3위 이력 없는 테마는 순위 없이 하단 표시). 관심종목 탭은 리포트에 등장한 종목을 테마별로 자동 누적(한 종목이 여러 테마에 속할 수 있음)하며, 테마는 가로 탭으로 나열(순서: 최근 등장일↓·그날 순위↑·합계 거래대금↓)하고 선택한 테마 아래에 종목을 4개까지 보여준 뒤 "더보기"로 나머지를 펼친다. 테마 안 종목 순서는 최근 등장일↓·거래대금↓·등락률↓이고 맨 위 종목이 대장주(왕관)이다. 종목 옆에 코스피/코스닥 배지와 최근 5거래일 등락률/거래대금을 표시하며, **시세는 전부 KIS KRX+NXT 통합 기준 하나로 통일**(리포트 값과 섞지 않음 — 2026-09-18 사용자 지시; 9/18 리포트 45종목과 100% 일치 확인). 종목 우측 ⋮ 메뉴로 테마 삭제(그 테마에서 그 종목 제외)·테마 추가(기존/새 테마)·대장주 On/Off(다른 종목을 ON 하면 왕관+맨 위로 이동, OFF면 대장주 없음, 자동 선정 종목을 다시 ON 하면 자동으로 복귀)를 할 수 있다. 이 수정은 브라우저 localStorage(`themeRadar.watchEdits`)에 즉시 저장되고 동시에 Supabase(`watch_state` 테이블, `data/supabase_config.json`의 anon key 사용)로도 동기화되어 **웹과 폰 앱이 같은 관심종목 수정 내용을 공유**한다(2026-09-22 개편). 분석 탭은 아직 설계 전(준비중 안내만 표시) — 다음에 내용을 정의할 것. 통계 탭은 기존 년/월/주차 필터 + 테마 집계 차트를 그대로 유지.

**6-A-1. 웹/모바일 배포 (2026-09-22 추가)**
- **웹**: `https://brian-won.github.io/theme-radar/` (GitHub 저장소 `brian-won/theme-radar`, 공개). 접근에 비밀번호 게이트(클라이언트 측 SHA-256 비교, 완전한 보안은 아니고 우연한 접근 차단용)가 있음 — 비밀번호 변경은 `python scripts/set_dashboard_password.py`.
- **관심종목 동기화**: Supabase 프로젝트(무료 티어)의 `watch_state` 테이블 한 개(`id text pk, data jsonb, updated_at timestamptz`)에 `{removed, added, leader}` 전체를 통째로 저장. RLS로 anon 역할의 select/insert/update만 허용. anon key는 공개돼도 되는 값(publishable key)이라 `data/supabase_config.json`에 평문으로 둠 — KRX_ID/KIS 키와는 성격이 다르므로 혼동하지 말 것.
- **폰 앱**: `mobile-app/`에 Capacitor 프로젝트(안드로이드, 웹뷰가 위 GitHub Pages URL을 그대로 로드). 플레이스토어 미배포, APK를 직접 사이드로드. `mobile-app/`은 `.gitignore`로 빌드 산출물(gradle/node_modules)만 제외하고 관리.

**6-B. Claude Artifact 버전(선택, 레거시) — `https://claude.ai/artifact/NneM8HegJxE8z1AyTpiNrr`**
(페이지 발행/재발행은 `Artifact` 도구, DB 읽기·쓰기는 `ArtifactData` 도구 — 둘이 분리되어 있음).
- **`daily_reports` 컬렉션**에 `doc_id`=날짜("2026-09-16")로 그날 리포트 요약(코스피/코스닥 등락률·거래대금·이평선, 종목수, top1~3, Notion 페이지 URL) 저장.
- **`daily_detail_v2` 컬렉션**에 `doc_id`=날짜로 그날 전체 상세(순위별 테마 그룹 + 종목별 종목명/등락률/거래대금/재료 `reason`)를 저장 — Notion 리포트 본문 표를 그대로 옮긴 것. 테마 통계(발생빈도/평균등락률/평균거래대금)는 별도 컬렉션 없이 대시보드 JS가 이 `daily_detail`에서 **1~3위 그룹만** 걸러 그때그때 재계산한다(`computeThemeStats()`).
  - ⚠️ **발생빈도 = 테마에 속한 종목 수가 아니라, 그 테마가 어떤 날의 1~3위로 뽑힌 횟수다.** 4등 그룹은 통계에서 제외되지만, `daily_detail`에는 4등 종목도 전부 기록한다(상세표 표시용, 사용자가 재료까지 보고 싶어함 — 2026-09-16 요청 반영).
  - HTML의 `SNAPSHOT.dailyReports`/`SNAPSHOT.dailyDetail`에도 같은 내용을 정적 스냅샷으로 넣을 것(최초 로드 시 DB 연결 전에도 보이도록). 종목이 많으면 손으로 옮기지 말고 Python으로 JSON을 만들어 HTML 안의 해당 블록을 통째로 치환하는 식으로 하는 게 오타가 안 난다.
  - **기존 문서를 덮어쓸 땐 `ArtifactData`로 먼저 `action:"get"`해서 `version`을 확인하고, 그 값을 `if_version`으로 넘겨 `set`/`update`할 것** — 버전 없이 기존 문서를 쓰면 `version_mismatch`로 거부된다. (과거엔 이 옵션을 못 찾아 컬렉션명에 버전 접미사를 붙이는 우회를 썼다 — `daily_detail`→`daily_detail_v2`가 그 흔적. 지금은 `if_version`이 정석.)
- HTML을 고치는 경우, 발행 전 `dataviz`·`artifact-design`·`artifact-capabilities` 스킬을 먼저 로드할 것(색상/타이포/레이아웃/DB 사용법 규정). 발행 전에는 `node --check`로 인라인 `<script>` 문법을 검증하고, DOM을 최소 스텁으로 채운 Node에서 `computeThemeStats`/`groupDetailTable` 같은 핵심 함수를 직접 호출해 종목 수 합계 등을 검산할 것.

## 참고 파일
- `scripts/market_screen.py`, `scripts/kis_client.py` — 스크리닝/KIS 연동 코드
- `docs/product-spec.md` — 임계값·필터·KIS 통합 배경 설명
- `reference/테마일지_9월.xlsx` — 재료 문체·순위 규칙의 원본 예시
