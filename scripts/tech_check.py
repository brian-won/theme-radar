# -*- coding: utf-8 -*-
"""
종목 분석 › 기술적 분석 — 2026-11-24 사용자 지시.
그날 종목 분석 대상(scripts/thesis_targets.py가 뽑은 최대 9종목)만 기술적 지표를 계산해 data/tech_checks.json에 합친다.
숫자는 모두 이 스크립트가 계산한다(LLM 판단 없음). 요약 태그도 아래 규칙으로만 만든다.

시세: KIS 기간별 시세(KRX+NXT 통합, 수정주가) 약 1년치 일봉 — 종목당 3~4회 조회(100일씩)
수급: KIS 종목별 투자자 매매동향(최근 약 30거래일, KRX 정규장) — 외국인·기관 순매수 거래대금(원 단위 백만원 → 억원)

지표: 이동평균 5·20·60·120일(값·위치·이격도)과 배열(정배열/역배열/혼조), RSI(14, 와일더), MACD(12,26,9),
      볼린저밴드(20, 2σ) %B, 거래량 배수(그날 ÷ 직전 20일 평균), 52주(250거래일) 고가·저가 대비, 20일 지지(최저가)·저항(최고가),
      5·20일 수익률, 외국인·기관 5·20일 누적 순매수(억원)

사용법:
  python scripts/tech_check.py              # thesis_targets.json의 가장 최근 날짜 대상
  python scripts/tech_check.py 2026-11-23   # 그 날짜 대상(그날까지의 데이터로 계산)
출력: data/tech_checks.json {"history": {날짜: {종목: {...}}}, "series": {종목: 최근 120거래일 종가·이평선(가장 최근 계산분)}}
(환경변수 KIS_APP_KEY, KIS_APP_SECRET 필요)
"""
import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from kis_client import KisClient  # noqa: E402

ROOT = Path(__file__).parent.parent
TARGETS = ROOT / "data" / "thesis_targets.json"
OUT = ROOT / "data" / "tech_checks.json"
NEED_DAYS = 260      # 120일선 + 52주 고저를 보려면 250거래일 이상
SERIES_DAYS = 120    # 화면 차트용


def fetch_ohlcv(kis: KisClient, ticker: str, end: str) -> dict:
    """end(YYYY-MM-DD)까지 최근 NEED_DAYS 거래일 이상을 100일씩 거꾸로 모은다."""
    rows, cur = {}, date.fromisoformat(end)
    for _ in range(5):
        start = cur - timedelta(days=150)
        got = kis.inquire_daily_ohlcv_integrated(ticker, start.strftime("%Y%m%d"), cur.strftime("%Y%m%d"))
        if not got:
            break
        rows.update(got)
        if len(rows) >= NEED_DAYS:
            break
        cur = date.fromisoformat(min(got)) - timedelta(days=1)
    return rows


def sma(vals, n):
    return sum(vals[-n:]) / n if len(vals) >= n else None


def ema_series(vals, n):
    k, out = 2 / (n + 1), []
    for i, v in enumerate(vals):
        out.append(v if i == 0 else v * k + out[-1] * (1 - k))
    return out


def rsi(vals, n=14):
    if len(vals) <= n:
        return None
    gains = [max(vals[i] - vals[i - 1], 0) for i in range(1, len(vals))]
    losses = [max(vals[i - 1] - vals[i], 0) for i in range(1, len(vals))]
    ag, al = sum(gains[:n]) / n, sum(losses[:n]) / n
    for g, l in zip(gains[n:], losses[n:]):
        ag, al = (ag * (n - 1) + g) / n, (al * (n - 1) + l) / n
    return 100.0 if al == 0 else round(100 - 100 / (1 + ag / al), 1)


def pct(a, b):
    return round((a - b) / b * 100, 2) if b else None


def compute(ohlcv: dict, flows: list, asof: str) -> dict | None:
    days = sorted(d for d in ohlcv if d <= asof)
    if len(days) < 30 or days[-1] != asof:
        return None
    c = [ohlcv[d]["c"] for d in days]
    h = [ohlcv[d]["h"] for d in days]
    l = [ohlcv[d]["l"] for d in days]
    v = [ohlcv[d]["v"] for d in days]
    close = c[-1]
    ma = {}
    for w in (5, 20, 60, 120):
        m = sma(c, w)
        ma[str(w)] = None if m is None else {"value": round(m, 1), "pos": "위" if close >= m else "아래", "dev": pct(close, m)}
    vals = [ma[k]["value"] for k in ("5", "20", "60", "120") if ma[k]]
    align = "정배열" if len(vals) == 4 and vals == sorted(vals, reverse=True) else "역배열" if len(vals) == 4 and vals == sorted(vals) else "혼조"
    e12, e26 = ema_series(c, 12), ema_series(c, 26)
    macd = [a - b for a, b in zip(e12, e26)]
    sig = ema_series(macd, 9)
    hist, hist_prev = macd[-1] - sig[-1], macd[-2] - sig[-2]
    cross = "골든크로스" if hist_prev <= 0 < hist else "데드크로스" if hist_prev >= 0 > hist else None
    m20 = sma(c, 20)
    sd = (sum((x - m20) ** 2 for x in c[-20:]) / 20) ** 0.5
    pctb = round((close - (m20 - 2 * sd)) / (4 * sd) * 100, 1) if sd else None
    vol_ratio = round(v[-1] / (sum(v[-21:-1]) / 20), 2) if len(v) > 21 and sum(v[-21:-1]) else None
    n52 = min(250, len(days))
    hi52, lo52 = max(h[-n52:]), min(l[-n52:])
    flow = {}
    rows = sorted((r for r in flows if r.get("stck_bsop_date") and f"{r['stck_bsop_date'][:4]}-{r['stck_bsop_date'][4:6]}-{r['stck_bsop_date'][6:]}" <= asof),
                  key=lambda r: r["stck_bsop_date"], reverse=True)
    for who, key in (("foreign", "frgn_ntby_tr_pbmn"), ("inst", "orgn_ntby_tr_pbmn")):
        nums = [float(r.get(key) or 0) / 100 for r in rows]  # 백만원 → 억원
        flow[who] = {"d1": round(nums[0]) if nums else None, "d5": round(sum(nums[:5])) if len(nums) >= 5 else None,
                     "d20": round(sum(nums[:20])) if len(nums) >= 20 else None}
    r14 = rsi(c)
    res = {
        "asof": asof, "close": close,  # 그날 등락률은 리포트 값(전일 KRX 종가 기준)을 쓰고 여기서는 계산하지 않는다
        "ma": ma, "align": align, "rsi": r14,
        "macd": {"macd": round(macd[-1], 1), "signal": round(sig[-1], 1), "hist": round(hist, 1), "cross": cross},
        "bbPctB": pctb, "volRatio": vol_ratio,
        "hi52": hi52, "lo52": lo52, "fromHi52": pct(close, hi52), "fromLo52": pct(close, lo52), "days52": n52,
        "support20": min(l[-20:]), "resist20": max(h[-20:]),
        "ret5": pct(close, c[-6]) if len(c) > 5 else None, "ret20": pct(close, c[-21]) if len(c) > 20 else None,
        "flow": flow,
    }
    res["tags"] = tags(res)
    return res


def tags(r: dict) -> list:
    """규칙으로만 만든 요약 태그: [이름, 상태(good/bad/neutral)]."""
    out = []
    out.append(["정배열", "good"] if r["align"] == "정배열" else ["역배열", "bad"] if r["align"] == "역배열" else ["이평 혼조", "neutral"])
    m20 = r["ma"]["20"]
    if m20:
        out.append(["20일선 위", "good"] if m20["pos"] == "위" else ["20일선 아래", "bad"])
    if r["rsi"] is not None:
        out.append(["RSI 과열 " + str(r["rsi"]), "bad"] if r["rsi"] >= 70 else ["RSI 침체 " + str(r["rsi"]), "neutral"] if r["rsi"] <= 30 else ["RSI " + str(r["rsi"]), "neutral"])
    if r["macd"]["cross"]:
        out.append(["MACD " + r["macd"]["cross"], "good" if r["macd"]["cross"] == "골든크로스" else "bad"])
    elif r["macd"]["hist"] is not None:
        out.append(["MACD 상승 쪽", "good"] if r["macd"]["hist"] > 0 else ["MACD 하락 쪽", "bad"])
    if r["volRatio"] and r["volRatio"] >= 2:
        out.append([f"거래량 {r['volRatio']}배", "good"])
    if r["fromHi52"] is not None and r["fromHi52"] >= -3:
        out.append(["52주 고가 근처", "good"])
    elif r["fromHi52"] is not None and r["fromHi52"] <= -40:
        out.append([f"52주 고가 대비 {r['fromHi52']}%", "bad"])
    f, i = r["flow"].get("foreign", {}), r["flow"].get("inst", {})
    if f.get("d5") is not None and i.get("d5") is not None:
        both = f["d5"] + i["d5"]
        out.append(["외국인·기관 5일 순매수", "good"] if f["d5"] > 0 and i["d5"] > 0 else ["외국인·기관 5일 순매도", "bad"] if f["d5"] < 0 and i["d5"] < 0 else ["수급 엇갈림", "neutral"])
    return out


def series(ohlcv: dict, asof: str) -> dict:
    days = sorted(d for d in ohlcv if d <= asof)
    c = [ohlcv[d]["c"] for d in days]
    keep = days[-SERIES_DAYS:]
    off = len(days) - len(keep)

    def ma_at(i, w):
        return round(sum(c[i - w + 1:i + 1]) / w, 1) if i + 1 >= w else None
    return {
        "dates": keep, "close": c[off:],
        "ma20": [ma_at(off + j, 20) for j in range(len(keep))],
        "ma60": [ma_at(off + j, 60) for j in range(len(keep))],
        "ma120": [ma_at(off + j, 120) for j in range(len(keep))],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("date", nargs="?", help="기준일 YYYY-MM-DD (생략 시 thesis_targets.json의 가장 최근 날짜)")
    args = ap.parse_args()
    targets = json.loads(TARGETS.read_text(encoding="utf-8"))
    hist = targets["history"]
    d = args.date or max(hist)
    if d not in hist:
        raise SystemExit(f"{d}는 thesis_targets.json에 없는 날짜입니다 — python scripts/thesis_targets.py {d} 를 먼저 실행하세요")
    names = []
    for t in hist[d]["themes"]:
        for r in t["top"]:
            if r["name"] not in names:
                names.append(r["name"])
    data = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    history, ser = data.get("history", {}), data.get("series", {})
    kis = KisClient()
    day_out, fails = history.get(d, {}), []
    for n in names:
        tk = (targets.get("tickers", {}).get(n) or {}).get("ticker")
        if not tk:
            fails.append(f"{n}(종목코드 없음)")
            continue
        try:
            ohlcv = fetch_ohlcv(kis, tk, d)
            flows = kis.inquire_investor_daily(tk)
        except Exception as e:  # 한 종목 실패가 전체를 막지 않게
            fails.append(f"{n}({e})")
            continue
        res = compute(ohlcv, flows, d)
        if not res:
            fails.append(f"{n}({d} 일봉 없음 또는 30거래일 미만)")
            continue
        day_out[n] = res
        if d >= max([ser[n]["dates"][-1]] if n in ser else [""]):
            ser[n] = series(ohlcv, d)
        print(f"  {n:<10} 종가 {res['close']:>10,.0f} {res['align']} RSI {res['rsi']} "
              f"거래량 {res['volRatio']}배 52주고가 {res['fromHi52']:+.1f}% · " + ", ".join(t[0] for t in res["tags"]))
    history[d] = day_out
    out = {
        "_note": "종목 분석 › 기술적 분석. scripts/tech_check.py가 그날 대상 종목만 계산(KIS KRX+NXT 통합 수정주가 일봉, 수급은 KRX 투자자 매매동향). 규칙은 skills/theme-thesis/SKILL.md",
        "history": dict(sorted(history.items())),
        "series": dict(sorted(ser.items())),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"저장: {OUT} — {d} {len(day_out)}종목" + (f" / 실패 {fails}" if fails else ""))


if __name__ == "__main__":
    main()
