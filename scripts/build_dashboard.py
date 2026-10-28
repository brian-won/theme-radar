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
  skills/us-kr-sector-mapping/references/us_kr_sector_mapping.md  # (선택) 관심종목(해외) 탭 — 미국 섹터 종목 ↔ 한국 연관 종목 매핑표(파일을 고치고 다시 빌드하면 반영)

출력:
  dashboard/index.html  # 완전한 standalone 웹페이지 (데이터 내장, 서버/네트워크 불필요, 로컬 미리보기용)
  docs/index.html       # 위와 동일 — GitHub Pages가 이 폴더를 서빙(웹/폰 공유 URL)

새 날짜를 추가하려면: data/daily_reports.json에 항목 추가 + data/daily_detail_with_reasons.json에
날짜 키 추가 후 이 스크립트를 다시 실행하면 된다. daily-market-report 스킬의 6단계 참고.
"""
import re
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
TEMPLATE = ROOT / "dashboard" / "template.html"
OUTPUT = ROOT / "dashboard" / "index.html"
PAGES_OUTPUT = ROOT / "docs" / "index.html"
US_KR_MAPPING = ROOT / "skills" / "us-kr-sector-mapping" / "references" / "us_kr_sector_mapping.md"


def parse_us_kr_mapping(path: Path) -> dict:
    """관심종목(해외) 탭용: skills/us-kr-sector-mapping/references/us_kr_sector_mapping.md의 매핑표·이벤트 트리거·미확인 항목을 읽는다."""
    if not path.exists():
        return {"asOf": None, "rows": [], "triggers": [], "cautions": []}
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^as_of:\s*(\S+)", text, re.M)
    as_of = m.group(1) if m else None

    def section(title):
        m = re.search(r"^## " + re.escape(title) + r"\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
        return m.group(1) if m else ""

    def split_list(cell):
        cell = cell.strip()
        if not cell or (cell.startswith("(") and cell.endswith(")") and ", " not in cell):
            return [], cell.strip("()")  # 예: "(마땅한 대응주 없음)" → 종목 없음 + 안내 문구
        return [x.strip() for x in cell.split(", ") if x.strip()], None

    def ids_of(line):
        return re.findall(r"(?<![\d-])(\d-\d+)(?![\d-])", line)  # "(6-1)", "7-3에서" 등 섹터 id

    rows = []
    for line in section("매핑표").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 7 or not re.fullmatch(r"\d+-\d+", cells[0]):
            continue
        us_items, us_empty = split_list(cells[3])
        us = []
        for item in us_items:
            mm = re.fullmatch(r"(.+?)\(([^)]*)\)", item)
            name, ticker = (mm.group(1).strip(), mm.group(2).strip()) if mm else (item, "")
            us.append({"name": name, "ticker": ticker if re.fullmatch(r"[A-Z.]+", ticker) else "", "tickerNote": "" if re.fullmatch(r"[A-Z.]+", ticker) else ticker})
        kr, kr_empty = split_list(cells[4])
        rows.append({
            "id": cells[0], "sector": cells[1], "sub": cells[2], "us": us, "usEmpty": us_empty,
            "kr": kr, "krEmpty": kr_empty, "strength": cells[5], "note": cells[6],
        })
    bullets = lambda s: [ln.strip()[2:].strip() for ln in s.splitlines() if ln.strip().startswith("- ")]
    triggers = [{"text": b, "ids": ids_of(b)} for b in bullets(section("이벤트 트리거 (시차 매매 참고)"))]
    cautions = [{"text": b, "ids": ids_of(b)} for b in bullets(section("미확인·주의 항목"))]
    return {"asOf": as_of, "rows": rows, "triggers": triggers, "cautions": cautions}


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

    taxonomy = json.loads((ROOT / "data" / "theme_taxonomy.json").read_text(encoding="utf-8"))
    unmapped = sorted({g["theme"] for day in daily_detail.values() for g in day["groups"]} - set(taxonomy["mapping"]))
    if unmapped:
        print(f"경고: data/theme_taxonomy.json에 큰 틀 매핑이 없는 세부 테마 {len(unmapped)}개(그대로 큰 틀로 표시됨): {unmapped}")

    us_kr = parse_us_kr_mapping(US_KR_MAPPING)

    snapshot_js = (
        "{\n"
        "    generatedAt: " + json.dumps(max(d["date"] for d in daily_reports)) + ",\n"
        "    dailyReports: " + json.dumps(daily_reports, ensure_ascii=False, indent=2) + ",\n"
        "    dailyDetail: " + json.dumps(daily_detail, ensure_ascii=False, indent=2) + ",\n"
        "    themeParent: " + json.dumps(taxonomy["mapping"], ensure_ascii=False) + ",\n"
        "    recentPrices: " + json.dumps(recent_prices, ensure_ascii=False) + ",\n"
        "    usKrMap: " + json.dumps(us_kr, ensure_ascii=False) + "\n"
        "  }"
    )

    # D3(차트)는 CDN이 아니라 파일에 내장 — 인터넷 없이 더블클릭으로 열어도 차트가 그려지도록
    d3_js = (ROOT / "dashboard" / "vendor" / "d3.v7.9.0.min.js").read_text(encoding="utf-8")

    template = TEMPLATE.read_text(encoding="utf-8")
    for marker in ("/*__SNAPSHOT__*/", "/*__SUPABASE_CONFIG__*/", "/*__SITE_PASSWORD__*/", "<!--__D3__-->"):
        if marker not in template:
            raise RuntimeError(f"dashboard/template.html에 {marker} 플레이스홀더가 없습니다")
    output = (
        template
        .replace("<!--__D3__-->", "<script>" + d3_js.replace("</script", "<\\/script") + "</script>")
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
    print(f"  관심종목(해외) 매핑 {len(us_kr['rows'])}행 (기준일 {us_kr['asOf']})")


if __name__ == "__main__":
    main()
