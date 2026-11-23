# -*- coding: utf-8 -*-
"""
관심종목 탭용 '최근 5거래일 등락률·거래대금'과 코스피/코스닥 구분을 조회해 data/recent_prices.json에 저장한다.

- 시세: 한국투자증권(KIS) 기간별 시세 API를 KRX+넥스트레이드(NXT) 통합(UN) 기준으로 조회 — 전 종목·전 일자 한 기준으로 통일
- 티커/시장 구분: pykrx (종목명 → 티커, KOSPI/KOSDAQ)
- 대상 종목: data/daily_detail_with_reasons.json에 한 번이라도 등장한 모든 종목(종목명 기준)
           + 관심종목(해외) 탭의 국내 연관 종목(매핑표 한국 종목 + 화면에서 추가해 Supabase에 동기화된 종목)
- 대상 일자: data/daily_reports.json의 최근 5개 거래일

사용법: python scripts/fetch_recent_prices.py           # 전체 종목(약 5분) — 사용자가 요청할 때만
        python scripts/fetch_recent_prices.py --today   # 최근 리포트 날짜의 큰 틀 1~4위 그룹에 든 그날 종목만(수십 초) — 일일 스크리닝 때 실행
          · --today는 기존 data/recent_prices.json에 합친다: 대상 종목의 일자별 값만 추가·갱신하고, 다른 종목과 공통 'dates'는 그대로 둔다
            (관심종목 탭은 카드마다 그 카드 종목들이 가진 최근 5일로 열 제목을 잡으므로, 갱신 안 된 카드는 예전 날짜로 계속 보인다)
          · 큰 틀 순위 = theme_taxonomy.json mapping으로 묶은 큰 틀별 거래대금 합계(종목 중복 제외) 내림차순 — 대시보드 buildFrameDetail과 같은 기준
        (환경변수 KRX_ID/KRX_PW, KIS_APP_KEY/KIS_APP_SECRET 필요. 모의투자 API 제한(초당 2건)으로 종목당 약 1초 소요)
출력:   data/recent_prices.json
"""
import re
import sys
import json
import contextlib
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from kis_client import KisClient  # noqa: E402
from build_dashboard import US_KR_MAPPING, parse_us_kr_mapping  # noqa: E402

ROOT = Path(__file__).parent.parent
N_DAYS = 5
TODAY_TOP = 4  # --today: 큰 틀 1~4위(2026-11-23 사용자 지시)
# 매핑표·화면 표기 → pykrx 종목명 (영문 공식명 등 표기가 다른 종목만)
NAME_ALIAS = {"네이버": "NAVER", "LS일렉트릭": "LS ELECTRIC", "포스코홀딩스": "POSCO홀딩스",
              "LIG D&A": "LIG디펜스앤에어로스페이스", "엔씨소프트": "NC"}


def norm(name: str) -> str:
    return re.sub(r"[\s&().]", "", name)


def us_tab_added_names() -> set:
    """관심종목(해외) 탭에서 직접 추가한 국내 종목(Supabase watch_state.usAdded). 연결 실패 시 빈 집합."""
    try:
        cfg = json.loads((ROOT / "data" / "supabase_config.json").read_text(encoding="utf-8"))
        req = urllib.request.Request(
            cfg["url"] + "/rest/v1/watch_state?id=eq.default&select=data",
            headers={"apikey": cfg["anonKey"], "Authorization": "Bearer " + cfg["anonKey"]},
        )
        rows = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
        added = (rows[0].get("data") or {}).get("usAdded") or {} if rows else {}
        return {n for names in added.values() for n in names}
    except Exception as e:
        print(f"Supabase 조회 실패(화면에서 추가한 종목은 제외): {e}", file=sys.stderr)
        return set()


def today_top_names(detail: dict, date: str, top: int) -> list:
    """그날 큰 틀(인포스탁 테마) 거래대금 1~top위에 든 종목명. 큰 틀 합계는 종목 중복을 빼고 계산."""
    mapping = json.loads((ROOT / "data" / "theme_taxonomy.json").read_text(encoding="utf-8"))["mapping"]
    frames = {}
    for g in detail[date]["groups"]:
        f = frames.setdefault(mapping.get(g["theme"], g["theme"]), {})
        for s in g["stocks"]:
            f[s["name"]] = s["value"]
    ranked = sorted(frames, key=lambda k: -sum(frames[k].values()))[:top]
    print(f"{date} 큰 틀 1~{top}위: {ranked}", file=sys.stderr)
    return sorted({n for k in ranked for n in frames[k]})


def main():
    sys.stderr.reconfigure(encoding="utf-8")
    today_only = "--today" in sys.argv[1:]
    reports = json.loads((ROOT / "data" / "daily_reports.json").read_text(encoding="utf-8"))
    detail = json.loads((ROOT / "data" / "daily_detail_with_reasons.json").read_text(encoding="utf-8"))
    dates = sorted(r["date"] for r in reports)[-N_DAYS:]
    if today_only:
        names = today_top_names(detail, dates[-1], TODAY_TOP)
    else:
        names = {s["name"] for day in detail.values() for g in day["groups"] for s in g["stocks"]}
        names |= {k for r in parse_us_kr_mapping(US_KR_MAPPING)["rows"] for k in r["kr"]}
        names = sorted(names | us_tab_added_names())
    latest = dates[-1].replace("-", "")

    # pykrx는 import/로그인 시점부터 stdout에 print를 하므로 stderr로 돌린다
    with contextlib.redirect_stdout(sys.stderr):
        from pykrx import stock
        name_df = stock.get_market_price_change_by_ticker(latest, latest, market="ALL")
        # pykrx 종목명은 공백·&·괄호가 빠진 표기(예: LSELECTRIC, 삼성EA)라 정규화해서 비교한다
        name_to_ticker = {norm(row["종목명"]): ticker for ticker, row in name_df.iterrows()}
        market_of = {}
        for mkt in ("KOSPI", "KOSDAQ"):
            for t in stock.get_market_ticker_list(latest, market=mkt):
                market_of[t] = mkt

    client = KisClient()
    start, end = dates[0].replace("-", ""), latest
    prices, unresolved, failed = {}, [], []
    for i, name in enumerate(names, 1):
        ticker = name_to_ticker.get(norm(NAME_ALIAS.get(name, name)))
        if not ticker:
            unresolved.append(name)
            continue
        try:
            daily = client.inquire_daily_prices_integrated(ticker, start, end)
        except Exception as e:
            failed.append(f"{name}({e})")
            continue
        prices[name] = {
            "ticker": ticker,
            "market": market_of.get(ticker, ""),
            "days": {d: {"change": v["change_rate_pct"], "value": v["trading_value_eok"]}
                     for d, v in daily.items() if d in dates},
        }
        if i % 20 == 0:
            print(f"  진행 {i}/{len(names)}", file=sys.stderr)

    out_path = ROOT / "data" / "recent_prices.json"
    if today_only and out_path.exists():
        # 기존 파일에 합친다: 대상 종목은 예전 일자 값을 남긴 채 새 일자 값을 덮어쓰고, 공통 dates·다른 종목은 그대로
        out = json.loads(out_path.read_text(encoding="utf-8"))
        for name, p in prices.items():
            old = out["prices"].get(name)
            if old:
                old["days"].update(p["days"])
                old["ticker"], old["market"] = p["ticker"], p["market"] or old.get("market", "")
            else:
                out["prices"][name] = p
    else:
        out = {"dates": dates, "source": "KIS(KRX+NXT 통합)", "prices": prices}
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장 완료: 종목 {len(prices)}개 / 일자 {dates}", file=sys.stderr)
    if unresolved:
        print(f"티커 미매칭 {len(unresolved)}개: {unresolved}", file=sys.stderr)
    if failed:
        print(f"KIS 조회 실패 {len(failed)}개: {failed}", file=sys.stderr)


if __name__ == "__main__":
    main()
