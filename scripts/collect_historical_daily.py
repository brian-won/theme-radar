# -*- coding: utf-8 -*-
"""KRX와 NXT의 과거 일별 종목 데이터를 같은 날짜·종목코드 기준으로 합산한다.

이 스크립트는 테마를 추정하지 않는다. 테마는 가격만으로 확정할 수 없으므로, 이후
뉴스 근거를 붙인 별도 리서치 단계에서 작성한다. 여기서는 재현 가능한 원천 수치만
``data/backtest/historical_daily_krx_nxt.json``에 저장한다.

사용법:
    python scripts/collect_historical_daily.py 20251101 20260831

출력에는 시가총액 300억원 이상 보통주만 보존한다. 이는 기존 일일 스크리닝의
최소 유니버스와 같으며, 백테스트의 실제 매매 조건(1,000억원 이상)은 이후 적용한다.
"""
from __future__ import annotations

import contextlib
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).parent.parent
OUTPUT = ROOT / "data" / "backtest" / "historical_daily_krx_nxt.json"
NXT_URL = "https://www.nextrade.co.kr/brdinfoTime/brdinfoTimeList.do"
MIN_MARKET_CAP_EOK = 300
REQUEST_PAUSE_SECONDS = 0.15


def as_number(value: object) -> int:
    """NXT 응답의 숫자 문자열·숫자를 정수로 통일한다."""
    if value in (None, ""):
        return 0
    return int(str(value).replace(",", ""))


def trading_dates(start: str, end: str) -> list[str]:
    """코스닥 지수의 실제 거래일만 사용한다."""
    from pykrx import stock

    frame = stock.get_index_ohlcv_by_date(start, end, "1001")
    return [index.strftime("%Y%m%d") for index in frame.index]


def fetch_nxt(date: str) -> dict[str, dict]:
    """NXT 정규시장 종목별 일별 거래대금·종가를 종목코드별로 반환한다."""
    response = requests.post(
        NXT_URL,
        data={
            "pageIndex": "1",
            "pageUnit": "2000",
            "scSecuGroup": "STOCK",
            "scAggDd": date,
            "scMktId": "",
            "searchKeyword": "",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("brdinfoTimeList") or []
    result: dict[str, dict] = {}
    for row in rows:
        # NXT는 A005930 형태로 반환한다. KRX·KIS의 6자리 코드와 맞춘다.
        code = str(row.get("isuSrdCd", "")).removeprefix("A")
        if len(code) != 6:
            continue
        result[code] = {
            "close": as_number(row.get("curPrc")),
            "trading_value": as_number(row.get("accTrval")),
            "trading_volume": as_number(row.get("accTdQty")),
        }
    return result


def fetch_krx(date: str, ticker_names: dict[str, str]) -> list[dict]:
    """KRX 일별 원천과 시가총액을 가져오고, 기존 제외 규칙을 적용한다."""
    from pykrx import stock
    from market_screen import is_excluded_by_name

    frame = stock.get_market_ohlcv_by_ticker(date, market="ALL")
    etf = set(stock.get_etf_ticker_list(date))
    etn = set(stock.get_etn_ticker_list(date))
    records: list[dict] = []
    for ticker, row in frame.iterrows():
        ticker = str(ticker)
        if ticker in etf or ticker in etn:
            continue
        name = ticker_names.get(ticker)
        if not name:
            name = stock.get_market_ticker_name(ticker)
            ticker_names[ticker] = name
        if is_excluded_by_name(name):
            continue
        market_cap_eok = round(float(row["시가총액"]) / 1e8)
        if market_cap_eok < MIN_MARKET_CAP_EOK:
            continue
        records.append({
            "ticker": ticker,
            "name": name,
            "market_cap_eok": market_cap_eok,
            "close": int(row["종가"]),
            "change_rate_pct": round(float(row["등락률"]), 2),
            "trading_value": int(row["거래대금"]),
            "trading_volume": int(row["거래량"]),
        })
    return records


def load_existing() -> dict:
    if not OUTPUT.exists():
        return {"source": "KRX + NXT", "ticker_names": {}, "days": {}}
    return json.loads(OUTPUT.read_text(encoding="utf-8"))


def collect_day(date: str, ticker_names: dict[str, str]) -> dict:
    nxt = fetch_nxt(date)
    krx_rows = fetch_krx(date, ticker_names)
    stocks = []
    for row in krx_rows:
        nxt_row = nxt.get(row["ticker"], {})
        stocks.append({
            "ticker": row["ticker"],
            "name": row["name"],
            "market_cap_eok": row["market_cap_eok"],
            "krx": {
                "close": row["close"],
                "change_rate_pct": row["change_rate_pct"],
                "trading_value": row["trading_value"],
                "trading_volume": row["trading_volume"],
            },
            "nxt": nxt_row,
            "combined": {
                "trading_value": row["trading_value"] + nxt_row.get("trading_value", 0),
                "trading_volume": row["trading_volume"] + nxt_row.get("trading_volume", 0),
            },
        })
    return {"nxt_stock_count": len(nxt), "stocks": stocks}


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("사용법: python scripts/collect_historical_daily.py YYYYMMDD YYYYMMDD")
    start, end = sys.argv[1:]
    datetime.strptime(start, "%Y%m%d")
    datetime.strptime(end, "%Y%m%d")
    if start > end:
        raise SystemExit("시작일은 종료일보다 빠르거나 같아야 합니다.")

    sys.stderr.reconfigure(encoding="utf-8")
    with contextlib.redirect_stdout(sys.stderr):
        dates = trading_dates(start, end)
        output = load_existing()
        days = output.setdefault("days", {})
        ticker_names = output.setdefault("ticker_names", {})
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        for index, date in enumerate(dates, 1):
            if date in days:
                print(f"[{index}/{len(dates)}] {date} 이미 수집됨", file=sys.stderr)
                continue
            days[date] = collect_day(date, ticker_names)
            OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding="utf-8")
            print(
                f"[{index}/{len(dates)}] {date} 저장: "
                f"NXT {days[date]['nxt_stock_count']}종목 / 대상 {len(days[date]['stocks'])}종목",
                file=sys.stderr,
            )
            time.sleep(REQUEST_PAUSE_SECONDS)


if __name__ == "__main__":
    main()
