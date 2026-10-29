# -*- coding: utf-8 -*-
"""
관심종목(해외) 탭용 미국 종목 '최근 5거래일 등락률·거래대금'을 조회해 data/us_recent_prices.json에 저장한다.

- 시세: 한국투자증권(KIS) 해외주식 기간별시세 API(HHDFS76240000, 모의투자 지원)
- 대상 종목: skills/us-kr-sector-mapping/references/us_kr_sector_mapping.md 매핑표의 미국 티커 전체
- 거래소 코드(NAS/NYS/AMS)는 매핑표에 없으므로 직전 결과 → 나스닥 → 뉴욕 → 아멕스 순으로 시도해 찾는다
- 아직 끝나지 않은 미국 정규장(미국 동부시간 16시 전 당일분)은 제외한다

사용법: python scripts/fetch_us_prices.py
        (환경변수 KIS_APP_KEY/KIS_APP_SECRET 필요. 종목당 약 1초)
출력:   data/us_recent_prices.json  — {dates, source, prices: {티커: {exchange, days: {날짜: {change, value(달러), close}}}}}
"""
import sys
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from kis_client import KisClient  # noqa: E402
from build_dashboard import US_KR_MAPPING, parse_us_kr_mapping  # noqa: E402

ROOT = Path(__file__).parent.parent
OUT = ROOT / "data" / "us_recent_prices.json"
N_DAYS = 5
EXCHANGES = ("NAS", "NYS", "AMS")


def fetch_daily(client: KisClient, excd: str, ticker: str) -> list:
    data = client._get(
        "/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000",
        {"AUTH": "", "EXCD": excd, "SYMB": ticker, "GUBN": "0", "BYMD": "", "MODP": "1"}, ticker,
    )
    return data.get("output2") or []


def main():
    sys.stderr.reconfigure(encoding="utf-8")
    rows = parse_us_kr_mapping(US_KR_MAPPING)["rows"]
    tickers = sorted({u["ticker"] for r in rows for u in r["us"] if u["ticker"]})
    prev = json.loads(OUT.read_text(encoding="utf-8")).get("prices", {}) if OUT.exists() else {}

    now_et = datetime.now(ZoneInfo("America/New_York"))
    open_session = now_et.strftime("%Y%m%d") if now_et.hour < 16 or (now_et.hour == 16 and now_et.minute < 15) else None

    client = KisClient()
    prices, failed = {}, []
    for i, ticker in enumerate(tickers, 1):
        known = prev.get(ticker, {}).get("exchange")
        found = None
        for excd in ([known] if known else []) + [e for e in EXCHANGES if e != known]:
            try:
                daily = fetch_daily(client, excd, ticker)
            except Exception as e:
                failed.append(f"{ticker}({e})")
                break
            if daily:
                found = excd
                break
        if not found:
            if not any(f.startswith(ticker + "(") for f in failed):
                failed.append(f"{ticker}(거래소 미발견)")
            continue
        days = {}
        for row in daily:
            d = row.get("xymd")
            if not d or d == open_session or not row.get("clos"):
                continue
            days[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = {
                "change": float(row["rate"]),
                "value": round(float(row["tamt"])),
                "close": float(row["clos"]),
            }
        prices[ticker] = {"exchange": found, "days": days}
        if i % 20 == 0:
            print(f"  진행 {i}/{len(tickers)}", file=sys.stderr)

    all_dates = sorted({d for p in prices.values() for d in p["days"]})
    dates = all_dates[-N_DAYS:]
    for p in prices.values():
        p["days"] = {d: v for d, v in p["days"].items() if d in dates}

    out = {"dates": dates, "source": "KIS 해외주식 기간별시세", "prices": prices}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장 완료: 종목 {len(prices)}/{len(tickers)}개 / 일자 {dates}", file=sys.stderr)
    if failed:
        print(f"조회 실패 {len(failed)}개: {failed}", file=sys.stderr)


if __name__ == "__main__":
    main()
