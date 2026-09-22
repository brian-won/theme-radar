# -*- coding: utf-8 -*-
"""
관심종목 탭용 '최근 5거래일 등락률·거래대금'과 코스피/코스닥 구분을 조회해 data/recent_prices.json에 저장한다.

- 시세: 한국투자증권(KIS) 기간별 시세 API를 KRX+넥스트레이드(NXT) 통합(UN) 기준으로 조회 — 전 종목·전 일자 한 기준으로 통일
- 티커/시장 구분: pykrx (종목명 → 티커, KOSPI/KOSDAQ)
- 대상 종목: data/daily_detail_with_reasons.json에 한 번이라도 등장한 모든 종목(종목명 기준)
- 대상 일자: data/daily_reports.json의 최근 5개 거래일

사용법: python scripts/fetch_recent_prices.py
        (환경변수 KRX_ID/KRX_PW, KIS_APP_KEY/KIS_APP_SECRET 필요. 모의투자 API 제한(초당 2건)으로 종목당 약 1초 소요)
출력:   data/recent_prices.json
"""
import re
import sys
import json
import contextlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from kis_client import KisClient  # noqa: E402

ROOT = Path(__file__).parent.parent
N_DAYS = 5


def norm(name: str) -> str:
    return re.sub(r"[\s&().]", "", name)


def main():
    sys.stderr.reconfigure(encoding="utf-8")
    reports = json.loads((ROOT / "data" / "daily_reports.json").read_text(encoding="utf-8"))
    detail = json.loads((ROOT / "data" / "daily_detail_with_reasons.json").read_text(encoding="utf-8"))
    dates = sorted(r["date"] for r in reports)[-N_DAYS:]
    names = sorted({s["name"] for day in detail.values() for g in day["groups"] for s in g["stocks"]})
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
        ticker = name_to_ticker.get(norm(name))
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

    out = {"dates": dates, "source": "KIS(KRX+NXT 통합)", "prices": prices}
    (ROOT / "data" / "recent_prices.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장 완료: 종목 {len(prices)}개 / 일자 {dates}", file=sys.stderr)
    if unresolved:
        print(f"티커 미매칭 {len(unresolved)}개: {unresolved}", file=sys.stderr)
    if failed:
        print(f"KIS 조회 실패 {len(failed)}개: {failed}", file=sys.stderr)


if __name__ == "__main__":
    main()
