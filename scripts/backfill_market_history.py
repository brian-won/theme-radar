# -*- coding: utf-8 -*-
"""
시황 탭 과거 지수 데이터(스크리닝·테마 없이 지수만) 채우기.

data/daily_reports.json은 스크리닝(테마/종목)까지 한 날짜만 담는다. 시황 탭은 지수 정보만 있으면
그릴 수 있으므로, 스크리닝을 하지 않은 과거 거래일의 지수 값은 이 스크립트로 data/market_history.json에 따로 둔다.
대시보드 시황 탭은 daily_reports + market_history를 합쳐서 보여 주고(같은 날짜는 daily_reports 우선),
리포트·통계 탭에는 영향이 없다.

계산 방식은 scripts/market_screen.py의 index_snapshot과 같다(KRX 정규장 지수 기준):
  등락률 = 전일 종가 대비(소수 둘째 자리), 거래대금 = 지수 거래대금(조, 소수 둘째 자리),
  이평선 = 당일 포함 최근 w거래일 종가 평균, dev = (종가-이평)/이평*100(소수 둘째 자리), pos = 종가>=이평이면 '위'

사용법:
  python scripts/backfill_market_history.py 20260102 20260903   # 기간 지정(기존 파일에 합침, 같은 날짜는 덮어씀)
  python scripts/backfill_market_history.py --check 20260904 20261109   # 저장하지 않고 daily_reports.json 값과 비교만
  python scripts/backfill_market_history.py --fill-reports 20260701 20261111   # daily_reports.json에 빠진 이평선(120일선 등)만 채움
필요 환경변수: KRX_ID, KRX_PW (pykrx KRX 로그인)
"""
import sys
import json
import contextlib
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUT = ROOT / "data" / "market_history.json"
MA_WINDOWS = (5, 20, 60, 120)
INDEX_TICKERS = {"kospi": "1001", "kosdaq": "2001"}


def build_rows(start: str, end: str) -> dict:
    lookback = (datetime.strptime(start, "%Y%m%d") - timedelta(days=200)).strftime("%Y%m%d")
    rows = {}
    with contextlib.redirect_stdout(sys.stderr):  # pykrx 로그인 메시지가 stdout에 섞이지 않게
        from pykrx import stock
        for key, ticker in INDEX_TICKERS.items():
            df = stock.get_index_ohlcv_by_date(lookback, end, ticker)
            closes = [float(x) for x in df["종가"]]
            values = [float(x) for x in df["거래대금"]]
            dates = [d.strftime("%Y-%m-%d") for d in df.index]
            for i, d in enumerate(dates):
                if d < f"{start[:4]}-{start[4:6]}-{start[6:]}" or i == 0:
                    continue
                close, prev = closes[i], closes[i - 1]
                mad = []
                for w in MA_WINDOWS:
                    if i + 1 >= w:
                        ma = sum(closes[i + 1 - w:i + 1]) / w
                        mad.append({"w": w, "pos": "위" if close >= ma else "아래", "dev": round((close - ma) / ma * 100, 2)})
                r = rows.setdefault(d, {"date": d})
                r[key + "Change"] = round((close - prev) / prev * 100, 2)
                r[key + "Value"] = round(values[i] / 1e12, 2)
                r[key + "MaD"] = mad
    return {d: r for d, r in rows.items() if "kospiChange" in r and "kosdaqChange" in r}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    check = bool(args) and args[0] == "--check"
    fill = bool(args) and args[0] == "--fill-reports"
    if check or fill:
        args = args[1:]
    if len(args) != 2:
        print(__doc__)
        sys.exit(1)
    start, end = args
    rows = build_rows(start, end)

    if fill:
        # daily_reports.json의 kospiMaD/kosdaqMaD에 없는 이평선(예: 120일선, 2026-11-11 추가)만 계산값으로 채운다. 기존 값은 그대로 둔다.
        rp = ROOT / "data" / "daily_reports.json"
        raw = rp.read_text(encoding="utf-8")
        reports = json.loads(raw)
        added = 0
        for o in reports:
            r = rows.get(o["date"])
            if not r:
                continue
            for k in ("kospiMaD", "kosdaqMaD"):
                have = {e["w"] for e in o.get(k) or []}
                for e in r[k]:
                    if e["w"] not in have:
                        o.setdefault(k, []).append(e)
                        added += 1
                o[k].sort(key=lambda e: e["w"])
        rp.write_text(json.dumps(reports, ensure_ascii=False, indent=2) + ("\n" if raw.endswith("\n") else ""), encoding="utf-8", newline="\n")
        print(f"daily_reports 이평선 채움: {added}개")
        return

    if check:
        reports = {r["date"]: r for r in json.loads((ROOT / "data" / "daily_reports.json").read_text(encoding="utf-8"))}
        diffs = 0
        for d, r in sorted(rows.items()):
            if d not in reports:
                continue
            o = reports[d]
            for k in ("kospiChange", "kospiValue", "kosdaqChange", "kosdaqValue"):
                if abs((o.get(k) or 0) - r[k]) > 0.011:
                    diffs += 1
                    print(f"{d} {k}: 리포트 {o.get(k)} / 계산 {r[k]}")
            for k in ("kospiMaD", "kosdaqMaD"):
                a = {e["w"]: e for e in o.get(k) or []}
                for e in r[k]:
                    b = a.get(e["w"])
                    if not b or b["pos"] != e["pos"] or abs(b["dev"] - e["dev"]) > 0.011:
                        diffs += 1
                        print(f"{d} {k} {e['w']}일: 리포트 {b} / 계산 {e}")
        print(f"비교 {len([d for d in rows if d in reports])}일, 차이 {diffs}건")
        return

    store = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"days": []}
    merged = {r["date"]: r for r in store["days"]}
    merged.update(rows)
    out = {
        "_note": "시황 탭 과거 지수(스크리닝 없음). KRX 정규장 지수 기준. scripts/backfill_market_history.py로 생성",
        "days": [merged[d] for d in sorted(merged)],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")).replace('},{"date"', '},\n{"date"') + "\n", encoding="utf-8", newline="\n")
    ds = sorted(rows)
    print(f"저장: {OUT} — 이번 {len(rows)}일({ds[0] if ds else '-'} ~ {ds[-1] if ds else '-'}), 전체 {len(merged)}일")


if __name__ == "__main__":
    main()
