"""
일일 시황/종목 스크리닝 데이터 수집 스크립트.

pykrx(KRX 정규장 기준)로 1차 후보군을 넓게 추린 뒤, 당일(가장 최근 영업일)인 경우
한국투자증권(KIS) API로 KRX+넥스트레이드(NXT) 통합·애프터마켓 포함 등락률/거래대금을
재조회해서 정확한 수치로 교체한 다음 최종 임계값을 적용한다.
  * KRX 정규장 데이터만 쓰면 애프터마켓/NXT 거래분이 누락되어 실제보다 거래대금이
    과소 집계되고(예: 영풍 9/14 KRX 303억 vs 통합 673억), 그 경계에 걸친 종목이
    스크리닝에서 통째로 빠지는 문제가 있었다(사용자 실측 대비 확인됨).

수집 데이터:
  1. 코스피/코스닥 지수: 종가, 등락률, 거래대금(조), 5/20/60일 이동평균 대비 위치
  2. 종목 스크리닝: ETF/ETN/스팩/우선주 제외, 시가총액 300억 이상만 대상으로
     (거래대금, 등락률) 임계값을 단계적으로 완화하며 20종목 초과할 때까지 선별
       1단계: 500억 이상 & 등락률 3% 이상
       2단계(1단계 결과 20종목 이하): 500억 이상 & 등락률 2% 이상
       3단계(2단계 결과 20종목 이하): 300억 이상 & 등락률 2% 이상 (더 이상 확대하지 않음)
     (KIS 재조회는 당일 데이터에만 적용됨 - inquire-price가 실시간 현재가라 과거 날짜엔 못 씀)

사용법:
  python scripts/market_screen.py [YYYYMMDD]   # 생략 시 가장 최근 영업일. 당일일 때만 KIS 보정 적용
"""
import re
import sys
import json
import contextlib
from datetime import datetime, timedelta

MIN_MARKET_CAP = 30_000_000_000  # 300억원
SCREEN_TIERS = [
    {"min_trading_value_eok": 500, "min_change_rate": 3.0},
    {"min_trading_value_eok": 500, "min_change_rate": 2.0},
    {"min_trading_value_eok": 300, "min_change_rate": 2.0},
]
# KRX 정규장 기준 1차 후보군(느슨한 하한) - NXT/애프터마켓 합산 시 거래대금이
# 크게 늘어나는 종목을 놓치지 않기 위해 최종 임계값(500억/3%)보다 낮게 잡는다.
PRELIM_MIN_TRADING_VALUE_EOK = 150
PRELIM_MIN_CHANGE_RATE = 1.5
MIN_ROWS_BEFORE_RELAX = 20
MA_WINDOWS = (5, 20, 60)
INDEX_TICKERS = {"KOSPI": "1001", "KOSDAQ": "2001"}
PREFERRED_STOCK_RE = re.compile(r"\d*우(B)?$")


def resolve_target_date(arg: str | None) -> str:
    from pykrx import stock
    if arg:
        return arg
    today = datetime.now()
    for i in range(10):
        d = (today - timedelta(days=i)).strftime("%Y%m%d")
        if stock.get_nearest_business_day_in_a_week(d) == d:
            return d
    raise RuntimeError("최근 영업일을 찾지 못했습니다")


def index_snapshot(target_date: str) -> dict:
    from pykrx import stock
    result = {}
    lookback_start = (datetime.strptime(target_date, "%Y%m%d") - timedelta(days=120)).strftime("%Y%m%d")
    for name, ticker in INDEX_TICKERS.items():
        df = stock.get_index_ohlcv_by_date(lookback_start, target_date, ticker)
        if df.empty:
            result[name] = None
            continue
        closes = df["종가"]
        last_close = float(closes.iloc[-1])
        prev_close = float(closes.iloc[-2]) if len(closes) > 1 else last_close
        change_rate = round((last_close - prev_close) / prev_close * 100, 2)
        trading_value_eok = float(df["거래대금"].iloc[-1]) / 1e8
        ma_status = {}
        for w in MA_WINDOWS:
            if len(closes) >= w:
                ma = float(closes.tail(w).mean())
                ma_status[f"MA{w}"] = {
                    "value": round(ma, 2),
                    "position": "위" if last_close >= ma else "아래",
                }
            else:
                ma_status[f"MA{w}"] = None
        result[name] = {
            "date": target_date,
            "close": last_close,
            "change_rate_pct": change_rate,
            "trading_value_trillion": round(trading_value_eok / 10000, 2),
            "ma": ma_status,
        }
    return result


def is_excluded_by_name(name: str) -> bool:
    if "스팩" in name or "SPAC" in name.upper():
        return True
    if PREFERRED_STOCK_RE.search(name):
        return True
    return False


def apply_tiers(rows: list[dict]) -> dict:
    """등락률/거래대금이 채워진 rows에 캐스케이드 임계값을 적용해 최종 선별한다."""
    applied_tier = None
    selected = rows
    for tier in SCREEN_TIERS:
        candidate = [
            r for r in rows
            if r["change_rate_pct"] >= tier["min_change_rate"]
            and r["trading_value_eok"] >= tier["min_trading_value_eok"]
        ]
        selected = candidate
        applied_tier = tier
        if len(candidate) > MIN_ROWS_BEFORE_RELAX:
            break
    selected.sort(key=lambda r: r["trading_value_eok"], reverse=True)
    return {"applied_tier": applied_tier, "stocks": selected}


def refine_with_kis(rows: list[dict]) -> list[dict]:
    """KIS API로 KRX+NXT 통합(애프터마켓 포함) 등락률/거래대금을 재조회해 덮어쓴다."""
    from kis_client import KisClient
    client = KisClient()
    for r in rows:
        try:
            q = client.inquire_price_integrated(r["ticker"])
        except Exception as e:
            print(f"KIS 재조회 실패({r['ticker']} {r['name']}): {e}", file=sys.stderr)
            continue
        r["change_rate_pct"] = round(q["change_rate_pct"], 2)
        r["trading_value_eok"] = q["trading_value_eok"]
        r["close"] = q["close"]
        r["source"] = "KIS(KRX+NXT 통합)"
    return rows


def stock_screen(target_date: str, use_kis: bool) -> dict:
    from pykrx import stock

    df = stock.get_market_ohlcv_by_ticker(target_date, market="ALL")  # 시가총액 컬럼 포함

    excluded_tickers = set(stock.get_etf_ticker_list(target_date)) | set(stock.get_etn_ticker_list(target_date))
    df = df[~df.index.isin(excluded_tickers)]
    df = df[df["시가총액"] >= MIN_MARKET_CAP]

    names = {ticker: stock.get_market_ticker_name(ticker) for ticker in df.index}
    df = df[[not is_excluded_by_name(names[t]) for t in df.index]]

    prelim_rate = PRELIM_MIN_CHANGE_RATE if use_kis else SCREEN_TIERS[-1]["min_change_rate"]
    prelim_value = PRELIM_MIN_TRADING_VALUE_EOK if use_kis else SCREEN_TIERS[-1]["min_trading_value_eok"]
    prelim = df[(df["등락률"] >= prelim_rate) & (df["거래대금"] / 1e8 >= prelim_value)]

    rows = []
    for ticker, row in prelim.iterrows():
        rows.append({
            "ticker": ticker,
            "name": names[ticker],
            "change_rate_pct": round(float(row["등락률"]), 2),
            "trading_value_eok": round(float(row["거래대금"]) / 1e8),  # 억원 단위 정수
            "market_cap_eok": round(float(row["시가총액"]) / 1e8),
            "close": float(row["종가"]),
            "source": "pykrx(KRX 정규장)",
            "theme": None,       # 후속 단계(인포스탁테마 우선 + 뉴스)에서 채움
            "reason": None,      # 후속 단계에서 채움
        })

    if use_kis and rows:
        print(f"KIS API로 {len(rows)}개 후보 종목 통합 시세 재조회 중...", file=sys.stderr)
        rows = refine_with_kis(rows)

    return apply_tiers(rows)


def main():
    # Windows에서 stdout이 파일/파이프로 리다이렉트되면 콘솔이 아니므로 로케일 기본
    # 인코딩(cp949)을 쓰는데, 이러면 ensure_ascii=False로 쓰는 한글이 깨진다 → UTF-8 강제.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    # pykrx는 최초 import/로그인 시점부터 stdout에 직접 print를 하므로,
    # JSON 결과와 섞이지 않도록 pykrx 관련 호출 전체(및 최초 import)를 stderr로 돌린다.
    with contextlib.redirect_stdout(sys.stderr):
        arg = sys.argv[1] if len(sys.argv) > 1 else None
        target_date = resolve_target_date(arg)
        # KIS inquire-price는 실시간 현재가라 과거 날짜엔 쓸 수 없음 - 최근 영업일(=오늘) 조회일 때만 사용
        use_kis = arg is None or target_date == datetime.now().strftime("%Y%m%d")
        screen_result = stock_screen(target_date, use_kis)
        payload = {
            "target_date": target_date,
            "index": index_snapshot(target_date),
            "applied_screen_tier": screen_result["applied_tier"],
            "stocks": screen_result["stocks"],
        }
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
