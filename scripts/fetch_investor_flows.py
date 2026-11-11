# -*- coding: utf-8 -*-
"""
시황 탭 '거래주체별 순매수' 블록용 데이터 수집.

KRX 투자자별 거래실적(pykrx get_market_trading_value_by_date, detail=True, 순매수)을
코스피·코스닥 각각 받아 data/investor_flows.json에 날짜별로 합친다(기존 날짜는 새 값으로 덮어씀).
2026-11-11 추가: 코스피200 선물·콜옵션·풋옵션 투자자별 순매수는 KIS 시장별 투자자매매동향(일별, FHPTJ04040000,
시장 K2I / 업종 F001·OC01·OP01)으로 받는다. 한 번 호출에 최근 300거래일이 와서, 실행할 때마다 KRX 날짜 전체에 덮어쓴다.
  fut  = 선물 순매수 계약 수(정수), call/put = 옵션 순매수 금액(억원, 소수 첫째 자리)
  KIS 키(KIS_APP_KEY/KIS_APP_SECRET)가 없거나 실패하면 경고만 하고 코스피·코스닥만 저장한다.

저장 값(단위 억원, 반올림 정수) — 순서는 파일의 "order"와 같다:
  개인, 외국인, 기관, 금융투자, 투신, 연기금
  * 기관 = 금융투자 + 보험 + 투신 + 사모 + 은행 + 기타금융 + 연기금 (KRX '기관합계'와 같음)
  * 기타법인·기타외국인은 저장하지 않는다.

사용법:
  python scripts/fetch_investor_flows.py              # data/daily_reports.json 날짜 중 빠진 날 + 가장 최근 리포트 날짜를 받음
  python scripts/fetch_investor_flows.py 20261109     # 위와 같되 끝 날짜를 지정(그 날짜는 항상 다시 받음)
  python scripts/fetch_investor_flows.py 20260901 20261109   # 기간 전체를 다시 받음
필요 환경변수: KRX_ID, KRX_PW (pykrx KRX 로그인)
"""
import sys
import json
import contextlib
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUT = ROOT / "data" / "investor_flows.json"
ORDER = ["개인", "외국인", "기관", "금융투자", "투신", "연기금"]
INSTITUTION = ["금융투자", "보험", "투신", "사모", "은행", "기타금융", "연기금"]
MARKETS = {"kospi": "KOSPI", "kosdaq": "KOSDAQ"}
DERIVATIVES = {"fut": ("F001", "qty"), "call": ("OC01", "amt"), "put": ("OP01", "amt")}
# KIS 필드 접두어: 개인 prsn, 외국인 frgn, 기관계 orgn, 증권(=금융투자) scrt, 투자신탁 ivtr, 기금(=연기금) fund
KIS_PREFIX = ["prsn", "frgn", "orgn", "scrt", "ivtr", "fund"]


def ymd(d: str) -> str:
    return d.replace("-", "")


def dash(d: str) -> str:
    d = ymd(d)
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def fetch_derivatives(end: str) -> dict:
    """KIS로 선물·콜·풋 투자자별 순매수(end 포함 최근 300거래일)를 받아 {날짜: {fut:[..], call:[..], put:[..]}}로 돌려준다."""
    sys.path.insert(0, str(Path(__file__).parent))
    from kis_client import KisClient
    client = KisClient()
    out = {}
    for key, (code, unit) in DERIVATIVES.items():
        params = {"FID_COND_MRKT_DIV_CODE": "U", "FID_INPUT_ISCD": "0001", "FID_INPUT_DATE_1": ymd(end),
                  "FID_INPUT_ISCD_1": "K2I", "FID_INPUT_DATE_2": ymd(end), "FID_INPUT_ISCD_2": code}
        data = client._get("/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market", "FHPTJ04040000", params, f"파생 투자자({key})")
        for row in data.get("output") or []:
            if unit == "qty":
                vals = [int(row[p + "_ntby_qty"]) for p in KIS_PREFIX]
            else:  # 백만원 -> 억원
                vals = [round(int(row[p + "_ntby_tr_pbmn"]) / 100, 1) for p in KIS_PREFIX]
            out.setdefault(dash(row["stck_bsop_date"]), {})[key] = vals
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    store = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    days = store.get("days", {})

    args = sys.argv[1:]
    if len(args) >= 2:
        start, end = dash(args[0]), dash(args[1])
    else:
        report_dates = sorted(r["date"] for r in json.loads((ROOT / "data" / "daily_reports.json").read_text(encoding="utf-8")))
        end = dash(args[0]) if args else report_dates[-1]
        missing = [d for d in report_dates if d <= end and d not in days]
        start = min(missing + [end])

    print(f"거래주체별 순매수 조회: {start} ~ {end}")
    fetched = {}
    # pykrx는 로그인 메시지를 stdout에 바로 찍으므로 stderr로 돌린다
    with contextlib.redirect_stdout(sys.stderr):
        from pykrx import stock
        for key, market in MARKETS.items():
            df = stock.get_market_trading_value_by_date(ymd(start), ymd(end), market, detail=True)
            for idx, row in df.iterrows():
                v = {k: float(x) / 1e8 for k, x in row.items()}
                if not any(v.values()):
                    continue  # 집계 전(장중 등) 빈 값
                vals = [v["개인"], v["외국인"], sum(v[k] for k in INSTITUTION), v["금융투자"], v["투신"], v["연기금"]]
                fetched.setdefault(idx.strftime("%Y-%m-%d"), {})[key] = [round(x) for x in vals]

    added = 0
    for d, m in fetched.items():
        if set(m) == set(MARKETS):
            added += d not in days
            days[d] = m
    deriv_n = 0
    try:
        with contextlib.redirect_stdout(sys.stderr):
            deriv = fetch_derivatives(max(days) if days else end)
        for d, m in deriv.items():
            if d in days and set(m) == set(DERIVATIVES):
                days[d].update(m)
                deriv_n += 1
    except Exception as e:  # KIS 키 없음·장애 시 현물만 저장
        print(f"주의: 선물·옵션(KIS) 조회 실패 — 코스피·코스닥만 저장합니다: {e}")
    store = {
        "_note": "kospi/kosdaq = KRX 투자자별 순매수(억원), 기관 = 금융투자·보험·투신·사모·은행·기타금융·연기금 합계. "
                 "fut = 코스피200 선물 순매수(계약), call/put = 코스피200 콜·풋옵션 순매수(억원) — KIS 시장별 투자자매매동향. scripts/fetch_investor_flows.py로 갱신",
        "order": ORDER,
        "days": {k: days[k] for k in sorted(days)},
    }
    OUT.write_text(json.dumps(store, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"저장: {OUT} — 이번 조회 {len(fetched)}일(신규 {added}일), 전체 {len(days)}일, 최근 {max(days) if days else '-'} · 선물·옵션 {deriv_n}일")
    if end not in fetched:
        print(f"주의: {end} 값이 아직 없습니다(장 마감 전이거나 휴장일).")


if __name__ == "__main__":
    main()
