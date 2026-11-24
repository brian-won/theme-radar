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
  data/us_recent_prices.json       # (선택) 관심종목(해외) 탭의 미국 종목 최근 5일 시세 — scripts/fetch_us_prices.py로 생성
  data/investor_flows.json         # (선택) 시황 탭 '거래주체별 순매수' — scripts/fetch_investor_flows.py로 생성
  data/market_history.json         # (선택) 시황 탭 과거 지수(스크리닝 없는 날) — scripts/backfill_market_history.py로 생성
  data/supabase_config.json        # 관심종목 수정 동기화용 Supabase 프로젝트 URL + anon key (공개해도 되는 값)
  skills/us-kr-sector-mapping/references/us_kr_sector_mapping.md  # (선택) 관심종목(해외) 탭 — 미국 섹터 종목 ↔ 한국 연관 종목 매핑표(파일을 고치고 다시 빌드하면 반영)
  dashboard/bt/engine.js, strategies.js  # 분석 탭 백테스트 엔진 — 파일 내용을 그대로 내장(브라우저 전역 BT)
  docs/bt/meta.js                  # (선택) 분석 탭 시세 조각 목록 — scripts/build_bt_data.py로 생성. 기준일·종목 수·달 목록만 SNAPSHOT.btMeta로 내장
  data/bt_defaults.json            # (선택) 분석 탭 비교표의 기법별 기본값 결과 — node scripts/bt_run.js --defaults 로 생성 → SNAPSHOT.btDefaults
  data/theses/*.md, data/thesis_targets.json  # (선택) 분석 › 종목 분석 — theme-thesis 스킬 문서(마크다운 → HTML)와 날짜별 대상 → SNAPSHOT.theses / thesisTargets
  data/catalysts.json              # (선택) 캘린더 탭 이벤트(테마 일정·매크로·실적) — skills/catalyst-calendar/SKILL.md 규칙으로 직접 갱신 → SNAPSHOT.catalysts(해외 일정은 한국 시간 kst를 계산해 붙임)

출력:
  dashboard/index.html  # 완전한 standalone 웹페이지 (데이터 내장, 서버/네트워크 불필요, 로컬 미리보기용)
  docs/index.html       # 위와 동일 — GitHub Pages가 이 폴더를 서빙(웹/폰 공유 URL)
  (분석 탭 시세 조각 docs/bt/*.js 는 이 스크립트가 만들거나 복사하지 않는다. 화면이 실행 때 'bt/' → 없으면 '../docs/bt/' 순서로 읽으므로
   dashboard/index.html 로컬 미리보기도 docs/bt 를 그대로 쓴다. dashboard/bt 의 조각 복사본은 .gitignore 대상)

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
BT_ENGINE = ROOT / "dashboard" / "bt" / "engine.js"
BT_STRATEGIES = ROOT / "dashboard" / "bt" / "strategies.js"
BT_META = ROOT / "docs" / "bt" / "meta.js"
BT_DEFAULTS = ROOT / "data" / "bt_defaults.json"
CATALYSTS = ROOT / "data" / "catalysts.json"
THESES_DIR = ROOT / "data" / "theses"
THESIS_TARGETS = ROOT / "data" / "thesis_targets.json"


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


def load_bt_meta(path: Path):
    """분석 탭용: 시세 조각 목록(docs/bt/meta.js, `window.__btChunk({...});` 한 줄)에서 화면 머리말에 쓸 요약만 뽑는다. 없으면 None."""
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    meta = json.loads(text[text.index("(") + 1:text.rindex(")")])
    tickers = meta.get("tickers") or {}
    infos = tickers.values() if isinstance(tickers, dict) else []
    return {
        "asOf": meta.get("asOf"),
        "tickers": len(tickers),
        "delisted": sum(1 for v in infos if isinstance(v, dict) and v.get("delisted")),
        "months": meta.get("months") or [],
        "flowMonths": meta.get("flowMonths") or [],
    }


CATALYST_TZ = {"ET": "America/New_York", "PT": "America/Los_Angeles", "CT": "America/Chicago", "MT": "America/Denver",
               "CET": "Europe/Berlin", "JST": "Asia/Tokyo", "KST": "Asia/Seoul", "CST": "Asia/Shanghai"}
CATALYST_KINDS = {"macro", "earnings", "theme", "market"}


def load_catalysts(path: Path, frames: list, today: str):
    """캘린더 탭용: data/catalysts.json을 읽어 형식을 검사하고, 현지 시각이 있는 해외 일정에 한국 시간(kst)을 붙인다.
    서머타임은 zoneinfo가 날짜별로 반영한다. 형식이 틀린 이벤트는 경고를 내고 뺀다(빌드는 계속)."""
    if not path.exists():
        return {"updatedAt": None, "macroMonths": [], "events": []}, []
    from datetime import datetime, date
    from zoneinfo import ZoneInfo
    raw = json.loads(path.read_text(encoding="utf-8"))
    seoul = ZoneInfo("Asia/Seoul")
    star_rules = raw.get("starRules", {})  # 사용자가 바꾼 별점: {series: {"stars": 1~3, "setOn": "YYYY-MM-DD"}} — 같은 series의 모든 이벤트에 우선 적용
    events, warnings, seen = [], [], set()
    for ev in raw.get("events", []):
        eid = ev.get("id") or "(id 없음)"
        problems = []
        if eid in seen:
            problems.append("id 중복")
        seen.add(eid)
        try:
            d0 = date.fromisoformat(ev.get("date", ""))
            if ev.get("endDate") and date.fromisoformat(ev["endDate"]) < d0:
                problems.append("endDate가 date보다 앞섬")
        except ValueError:
            problems.append("date/endDate 형식 오류(YYYY-MM-DD)")
        if ev.get("kind") not in CATALYST_KINDS:
            problems.append(f"kind는 {sorted(CATALYST_KINDS)} 중 하나")
        if ev.get("tz") not in CATALYST_TZ:
            problems.append(f"tz는 {sorted(CATALYST_TZ)} 중 하나")
        if not ev.get("title"):
            problems.append("title 없음")
        if ev.get("time") and not re.fullmatch(r"\d\d:\d\d", ev["time"]):
            problems.append("time 형식 오류(HH:MM)")
        if problems:
            warnings.append(f"{eid}: " + ", ".join(problems) + " — 캘린더에서 뺌")
            continue
        out = dict(ev)
        rule = star_rules.get(ev.get("series") or "")
        if rule and rule.get("stars") in (1, 2, 3):
            out["stars"], out["starsByUser"] = rule["stars"], True
        elif ev.get("stars") not in (1, 2, 3):
            warnings.append(f"{eid}: stars는 1~3 정수여야 함 — 1로 표시")
            out["stars"] = 1
        if ev.get("time") and ev["tz"] != "KST":
            local = datetime.fromisoformat(f"{ev['date']}T{ev['time']}").replace(tzinfo=ZoneInfo(CATALYST_TZ[ev["tz"]]))
            out["kst"] = local.astimezone(seoul).strftime("%Y-%m-%d %H:%M")
        unknown = [f for f in ev.get("frames", []) if f not in frames]
        if unknown:
            warnings.append(f"{eid}: theme_taxonomy.json 큰 틀에 없는 이름 {unknown}")
        if (ev.get("endDate") or ev["date"]) < today and ev.get("metrics") and any(m.get("actual") in (None, "") for m in ev["metrics"]) and not ev.get("result"):
            warnings.append(f"{eid}: 지난 이벤트인데 결과값이 비어 있음 — 다음 스크리닝 때 채울 것")
        events.append(out)
    events.sort(key=lambda e: (e["date"], e.get("kst") or e.get("time") or ""))
    unused = sorted(set(star_rules) - {e.get("series") for e in events})
    if unused:
        warnings.append(f"starRules에 있지만 해당 series 이벤트가 아직 없음(규칙은 유지): {unused}")
    return {"updatedAt": raw.get("updatedAt"), "macroMonths": raw.get("macroMonths", []), "events": events}, warnings


def _md_inline(text: str) -> str:
    """종목 분석 문서용 아주 작은 마크다운 변환: HTML 이스케이프 → **굵게**, [글](주소), `코드`."""
    import html
    s = html.escape(text, quote=True)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    return s


def _table_rows(lines: list) -> list:
    rows = []
    for ln in lines:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue  # 구분선
        rows.append(cells)
    return rows


def _md_block(text: str) -> str:
    """문단·목록(- )·표(|)만 다룬다. 우리 문서 형식(skills/theme-thesis/SKILL.md) 밖의 문법은 그대로 문단으로 둔다."""
    out, i, lines = [], 0, [ln for ln in text.strip().splitlines()]
    while i < len(lines):
        ln = lines[i].strip()
        if not ln:
            i += 1
            continue
        if ln.startswith("|"):
            block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i]); i += 1
            rows = _table_rows(block)
            head, body = rows[0], rows[1:]
            out.append('<div class="table-scroll"><table class="ts-t"><thead><tr>' + "".join(f"<th>{_md_inline(c)}</th>" for c in head) +
                       "</tr></thead><tbody>" + "".join("<tr>" + "".join(f"<td>{_md_inline(c)}</td>" for c in r) + "</tr>" for r in body) + "</tbody></table></div>")
            continue
        if ln.startswith("- "):
            items = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(lines[i].strip()[2:]); i += 1
            out.append("<ul>" + "".join(f"<li>{_md_inline(x)}</li>" for x in items) + "</ul>")
            continue
        out.append(f"<p>{_md_inline(ln)}</p>")
        i += 1
    return "".join(out)


def load_theses(dir_path: Path) -> dict:
    """분석 › 종목 분석용: data/theses/<종목>.md 를 머리 정보 + 절(HTML) + 날짜별 기록 행으로 바꾼다."""
    out = {}
    if not dir_path.exists():
        return out
    for p in sorted(dir_path.glob("*.md")):
        text = p.read_text(encoding="utf-8")
        m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
        if not m:
            print(f"경고(종목 분석): {p.name} 머리 정보(---)가 없어 건너뜀")
            continue
        meta = {}
        for ln in m.group(1).splitlines():
            if ":" not in ln:
                continue
            k, v = ln.split(":", 1)
            v = v.split("  #")[0].strip().strip('"')
            meta[k.strip()] = [x.strip() for x in v.strip("[]").split(",") if x.strip()] if v.startswith("[") else v
        sections, records = {}, []
        for part in re.split(r"^## ", m.group(2), flags=re.M)[1:]:
            title, _, body = part.partition("\n")
            title = title.strip()
            if title.startswith("기록"):
                rows = _table_rows([ln for ln in body.splitlines() if ln.strip().startswith("|")])
                head = rows[0] if rows else []
                for r in rows[1:]:
                    if len(r) == len(head) == 7:
                        records.append(dict(zip(["date", "theme", "rankInTheme", "change", "material", "impact", "conviction"], r)))
                sections["기록"] = _md_block(body)
            else:
                sections[re.sub(r"\s*\(.*\)$", "", title)] = _md_block(body)
        name = meta.get("name") or p.stem
        out[name] = {"meta": meta, "sections": sections, "records": records}
    return out


def main():
    daily_reports = json.loads((ROOT / "data" / "daily_reports.json").read_text(encoding="utf-8"))
    daily_detail = json.loads((ROOT / "data" / "daily_detail_with_reasons.json").read_text(encoding="utf-8"))
    # 날짜순 정렬 후 dict 유지
    daily_detail = {k: daily_detail[k] for k in sorted(daily_detail.keys())}

    prices_path = ROOT / "data" / "recent_prices.json"
    recent_prices = json.loads(prices_path.read_text(encoding="utf-8")) if prices_path.exists() else {"dates": [], "prices": {}}
    us_prices_path = ROOT / "data" / "us_recent_prices.json"
    us_prices = json.loads(us_prices_path.read_text(encoding="utf-8")) if us_prices_path.exists() else {"dates": [], "prices": {}}

    supabase_path = ROOT / "data" / "supabase_config.json"
    if not supabase_path.exists():
        raise RuntimeError("data/supabase_config.json이 없습니다 — Supabase 프로젝트 URL/anon key를 먼저 저장하세요")
    supabase_config = json.loads(supabase_path.read_text(encoding="utf-8"))

    taxonomy = json.loads((ROOT / "data" / "theme_taxonomy.json").read_text(encoding="utf-8"))
    unmapped = sorted({g["theme"] for day in daily_detail.values() for g in day["groups"]} - set(taxonomy["mapping"]))
    if unmapped:
        print(f"경고: data/theme_taxonomy.json에 큰 틀 매핑이 없는 세부 테마 {len(unmapped)}개(그대로 큰 틀로 표시됨): {unmapped}")

    us_kr = parse_us_kr_mapping(US_KR_MAPPING)

    from datetime import datetime
    from zoneinfo import ZoneInfo
    catalysts, catalyst_warnings = load_catalysts(CATALYSTS, taxonomy["frames"], datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d"))
    for w in catalyst_warnings:
        print(f"경고(캘린더): {w}")

    # 분석 › 종목 분석: 문서 + 날짜별 대상(종목명·순위·등장 횟수·그날 등락만 남겨 크기를 줄임)
    theses = load_theses(THESES_DIR)
    targets_raw = json.loads(THESIS_TARGETS.read_text(encoding="utf-8")) if THESIS_TARGETS.exists() else {"history": {}}
    thesis_targets = {
        "window": targets_raw.get("window"),
        "tickers": targets_raw.get("tickers", {}),
        "history": {d: [{"rank": t["rank"], "theme": t["theme"], "n": t["stocksToday"], "tied": t["tiedOut"],
                         "top": [[r["name"], r["count"], r["todayChange"]] for r in t["top"]]} for t in day["themes"]]
                    for d, day in targets_raw.get("history", {}).items()},
    }
    latest_targets = max(thesis_targets["history"], default=None)
    if latest_targets:
        missing_docs = sorted({r[0] for t in thesis_targets["history"][latest_targets] for r in t["top"]} - set(theses))
        if missing_docs:
            print(f"경고(종목 분석): {latest_targets} 대상인데 문서가 없는 종목 {missing_docs} — theme-thesis 스킬로 작성 필요")

    flows_path = ROOT / "data" / "investor_flows.json"
    investor_flows = json.loads(flows_path.read_text(encoding="utf-8")) if flows_path.exists() else {"order": [], "days": {}}
    history_path = ROOT / "data" / "market_history.json"
    market_history = json.loads(history_path.read_text(encoding="utf-8"))["days"] if history_path.exists() else []
    missing_flows = [r["date"] for r in daily_reports if r["date"] not in investor_flows["days"]]
    if missing_flows:
        print(f"경고: 거래주체별 순매수가 없는 리포트 날짜 {len(missing_flows)}개 — python scripts/fetch_investor_flows.py 실행 필요: {missing_flows}")

    # 분석 탭(백테스트): 조각 목록 요약 + 기법별 기본값 결과. 둘 다 없어도 빌드는 되고 화면이 안내 문구를 보여 준다
    bt_meta = load_bt_meta(BT_META)
    bt_defaults = json.loads(BT_DEFAULTS.read_text(encoding="utf-8")) if BT_DEFAULTS.exists() else None
    if bt_meta is None:
        print("안내: docs/bt/meta.js 가 없어 분석 탭 시세 요약을 넣지 못했습니다 — python scripts/build_bt_data.py 실행 필요")
    if bt_defaults is None:
        print("안내: data/bt_defaults.json 이 없어 분석 탭 비교표가 비어 있습니다 — node scripts/bt_run.js --defaults 실행 필요")
    elif bt_meta and bt_defaults.get("asOf") != bt_meta["asOf"]:
        print(f"경고: 분석 탭 기본값 결과({bt_defaults.get('asOf')})와 시세 조각({bt_meta['asOf']})의 기준일이 다릅니다 — node scripts/bt_run.js --defaults 다시 실행 필요")

    snapshot_js = (
        "{\n"
        "    generatedAt: " + json.dumps(max(d["date"] for d in daily_reports)) + ",\n"
        "    dailyReports: " + json.dumps(daily_reports, ensure_ascii=False, indent=2) + ",\n"
        "    dailyDetail: " + json.dumps(daily_detail, ensure_ascii=False, indent=2) + ",\n"
        "    themeParent: " + json.dumps(taxonomy["mapping"], ensure_ascii=False) + ",\n"
        "    recentPrices: " + json.dumps(recent_prices, ensure_ascii=False) + ",\n"
        "    usPrices: " + json.dumps(us_prices, ensure_ascii=False) + ",\n"
        "    usKrMap: " + json.dumps(us_kr, ensure_ascii=False) + ",\n"
        "    investorFlows: " + json.dumps({"order": investor_flows["order"], "days": investor_flows["days"]}, ensure_ascii=False, separators=(",", ":")) + ",\n"
        "    marketHistory: " + json.dumps(market_history, ensure_ascii=False, separators=(",", ":")) + ",\n"
        "    btMeta: " + json.dumps(bt_meta, ensure_ascii=False, separators=(",", ":")) + ",\n"
        "    btDefaults: " + json.dumps(bt_defaults, ensure_ascii=False, separators=(",", ":")) + ",\n"
        "    catalysts: " + json.dumps(catalysts, ensure_ascii=False, separators=(",", ":")) + ",\n"
        "    theses: " + json.dumps(theses, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/") + ",\n"
        "    thesisTargets: " + json.dumps(thesis_targets, ensure_ascii=False, separators=(",", ":")) + "\n"
        "  }"
    )

    # D3(차트)는 CDN이 아니라 파일에 내장 — 인터넷 없이 더블클릭으로 열어도 차트가 그려지도록
    d3_js = (ROOT / "dashboard" / "vendor" / "d3.v7.9.0.min.js").read_text(encoding="utf-8")

    template = TEMPLATE.read_text(encoding="utf-8")
    for marker in ("/*__SNAPSHOT__*/", "/*__SUPABASE_CONFIG__*/", "<!--__D3__-->", "/*__BT_ENGINE__*/", "/*__BT_STRATEGIES__*/"):
        if marker not in template:
            raise RuntimeError(f"dashboard/template.html에 {marker} 플레이스홀더가 없습니다")
    # 백테스트 엔진 두 파일을 그대로 내장(엔진 → 기법 순서). Node 테스트(tests/bt)가 쓰는 파일과 같은 내용이라 결과가 어긋나지 않는다
    for path in (BT_ENGINE, BT_STRATEGIES):
        if not path.exists():
            raise RuntimeError(f"{path.relative_to(ROOT)} 가 없습니다 — 분석 탭 백테스트 엔진 파일이 필요합니다")
    bt_engine_js = BT_ENGINE.read_text(encoding="utf-8").replace("</script", "<\\/script")
    bt_strategies_js = BT_STRATEGIES.read_text(encoding="utf-8").replace("</script", "<\\/script")
    output = (
        template
        .replace("/*__BT_ENGINE__*/", bt_engine_js)
        .replace("/*__BT_STRATEGIES__*/", bt_strategies_js)
        .replace("<!--__D3__-->", "<script>" + d3_js.replace("</script", "<\\/script") + "</script>")
        .replace("/*__SNAPSHOT__*/", snapshot_js)
        .replace("/*__SUPABASE_CONFIG__*/", json.dumps(supabase_config, ensure_ascii=False))
    )

    OUTPUT.write_text(output, encoding="utf-8")
    PAGES_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    PAGES_OUTPUT.write_text(output, encoding="utf-8")
    total_stocks = sum(len(g["stocks"]) for day in daily_detail.values() for g in day["groups"])
    print(f"빌드 완료: {OUTPUT}")
    print(f"           {PAGES_OUTPUT} (GitHub Pages용, 동일 내용)")
    print(f"  거래일 {len(daily_reports)}개, 누적 종목 {total_stocks}개, 테마 로그 {len(daily_detail)}일치")
    print(f"  시황 과거 지수 {len(market_history)}일치 ({market_history[0]['date'] if market_history else None} ~ {market_history[-1]['date'] if market_history else None})")
    print(f"  거래주체별 순매수 {len(investor_flows['days'])}일치 (최근 {max(investor_flows['days']) if investor_flows['days'] else None})")
    print(f"  분석 탭: 시세 조각 {len(bt_meta['months']) if bt_meta else 0}개월(기준일 {bt_meta['asOf'] if bt_meta else None}, {bt_meta['tickers'] if bt_meta else 0}종목), "
          f"기본값 결과 {len(bt_defaults.get('strategies', {})) if bt_defaults else 0}개 기법")
    print(f"  종목 분석 문서 {len(theses)}개, 대상 이력 {len(thesis_targets['history'])}일 (최근 {latest_targets})")
    print(f"  캘린더 이벤트 {len(catalysts['events'])}개 (매크로 반영 달 {catalysts['macroMonths']}, 결과 입력 {sum(1 for e in catalysts['events'] if e.get('result') or any(m.get('actual') not in (None, '') for m in e.get('metrics', [])))}개)")
    print(f"  관심종목(해외) 매핑 {len(us_kr['rows'])}행 (기준일 {us_kr['asOf']}), 미국 시세 {len(us_prices['prices'])}종목(최근 {(us_prices['dates'] or [None])[-1]})")


if __name__ == "__main__":
    main()
