# -*- coding: utf-8 -*-
"""
'테마 레이더' 대시보드를 클로드/코덱스/안티그래비티 등 어떤 도구로도 열고 갱신할 수 있는
순수 정적 HTML 파일(dashboard/index.html)로 빌드한다. Claude Artifact 전용 API(window.claude)에
의존하지 않고, 데이터를 파일에 직접 埋め込む(embed)한다 — 더블클릭으로 브라우저에서 바로 열림.

사용법:
  python scripts/build_dashboard.py

입력 (이 파일들을 갱신한 뒤 실행):
  data/daily_reports.json          # 일별 리포트 요약 (코스피/코스닥, top1~3, Notion URL 등) 배열
  data/daily_detail_with_reasons.json  # 날짜별 테마 그룹 + 종목별 등락률/거래대금/재료 상세
  data/recent_prices.json          # (선택) 관심종목 탭의 최근 5일 시세 — scripts/fetch_recent_prices.py로 생성
  data/supabase_config.json        # 관심종목 수정 동기화용 Supabase 프로젝트 URL + anon key (공개해도 되는 값)
  data/site_password.json          # 대시보드 접근 비밀번호의 SHA-256 해시(평문 아님) — scripts/set_dashboard_password.py로 설정

출력:
  dashboard/index.html  # 완전한 standalone 웹페이지 (데이터 내장, 서버/네트워크 불필요, 로컬 미리보기용)
  docs/index.html       # 위와 동일 — GitHub Pages가 이 폴더를 서빙(웹/폰 공유 URL)

새 날짜를 추가하려면: data/daily_reports.json에 항목 추가 + data/daily_detail_with_reasons.json에
날짜 키 추가 후 이 스크립트를 다시 실행하면 된다. daily-market-report 스킬의 6단계 참고.
"""
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
TEMPLATE = ROOT / "dashboard" / "template.html"
OUTPUT = ROOT / "dashboard" / "index.html"
PAGES_OUTPUT = ROOT / "docs" / "index.html"


def main():
    daily_reports = json.loads((ROOT / "data" / "daily_reports.json").read_text(encoding="utf-8"))
    daily_detail = json.loads((ROOT / "data" / "daily_detail_with_reasons.json").read_text(encoding="utf-8"))
    # 날짜순 정렬 후 dict 유지
    daily_detail = {k: daily_detail[k] for k in sorted(daily_detail.keys())}

    prices_path = ROOT / "data" / "recent_prices.json"
    recent_prices = json.loads(prices_path.read_text(encoding="utf-8")) if prices_path.exists() else {"dates": [], "prices": {}}

    supabase_path = ROOT / "data" / "supabase_config.json"
    if not supabase_path.exists():
        raise RuntimeError("data/supabase_config.json이 없습니다 — Supabase 프로젝트 URL/anon key를 먼저 저장하세요")
    supabase_config = json.loads(supabase_path.read_text(encoding="utf-8"))

    pw_path = ROOT / "data" / "site_password.json"
    if not pw_path.exists():
        raise RuntimeError("data/site_password.json이 없습니다 — python scripts/set_dashboard_password.py 를 먼저 실행하세요")
    site_password = json.loads(pw_path.read_text(encoding="utf-8"))

    snapshot_js = (
        "{\n"
        "    generatedAt: " + json.dumps(max(d["date"] for d in daily_reports)) + ",\n"
        "    dailyReports: " + json.dumps(daily_reports, ensure_ascii=False, indent=2) + ",\n"
        "    dailyDetail: " + json.dumps(daily_detail, ensure_ascii=False, indent=2) + ",\n"
        "    recentPrices: " + json.dumps(recent_prices, ensure_ascii=False) + "\n"
        "  }"
    )

    template = TEMPLATE.read_text(encoding="utf-8")
    for marker in ("/*__SNAPSHOT__*/", "/*__SUPABASE_CONFIG__*/", "/*__SITE_PASSWORD__*/"):
        if marker not in template:
            raise RuntimeError(f"dashboard/template.html에 {marker} 플레이스홀더가 없습니다")
    output = (
        template
        .replace("/*__SNAPSHOT__*/", snapshot_js)
        .replace("/*__SUPABASE_CONFIG__*/", json.dumps(supabase_config, ensure_ascii=False))
        .replace("/*__SITE_PASSWORD__*/", json.dumps(site_password, ensure_ascii=False))
    )

    OUTPUT.write_text(output, encoding="utf-8")
    PAGES_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    PAGES_OUTPUT.write_text(output, encoding="utf-8")
    total_stocks = sum(len(g["stocks"]) for day in daily_detail.values() for g in day["groups"])
    print(f"빌드 완료: {OUTPUT}")
    print(f"           {PAGES_OUTPUT} (GitHub Pages용, 동일 내용)")
    print(f"  거래일 {len(daily_reports)}개, 누적 종목 {total_stocks}개, 테마 로그 {len(daily_detail)}일치")


if __name__ == "__main__":
    main()
