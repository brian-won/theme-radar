# -*- coding: utf-8 -*-
"""scripts/tech_check.py — 종목 분석 › 기술적 분석 지표 계산 테스트 (python -m unittest discover -s tests/py)."""
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import tech_check as t  # noqa: E402


def make_ohlcv(closes, start="2025-01-01", vols=None, spread=0.01):
    """종가 목록으로 가짜 일봉을 만든다(주말 없이 하루씩). 고가·저가는 종가 ±spread."""
    d0, out = date.fromisoformat(start), {}
    for i, c in enumerate(closes):
        d = (d0 + timedelta(days=i)).isoformat()
        out[d] = {"o": c, "h": c * (1 + spread), "l": c * (1 - spread), "c": c, "v": (vols[i] if vols else 1000), "val": 1.0}
    return out


class TestBasics(unittest.TestCase):
    def test_sma(self):
        self.assertEqual(t.sma([1, 2, 3, 4], 2), 3.5)
        self.assertIsNone(t.sma([1, 2], 3))

    def test_ema_first_value_is_seed(self):
        e = t.ema_series([10, 10, 10], 5)
        self.assertEqual(e, [10, 10, 10])

    def test_pct(self):
        self.assertEqual(t.pct(110, 100), 10.0)
        self.assertIsNone(t.pct(1, 0))


class TestRSI(unittest.TestCase):
    # StockCharts 교과서 예제(와일더 RSI 14) — 교과서는 단계마다 반올림해 0.1 안팎 차이가 난다
    CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
              46.28, 46.00, 46.03, 46.41, 46.22, 45.64]
    EXPECTED = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97]

    def test_textbook_example(self):
        for n, want in zip(range(15, 21), self.EXPECTED):
            self.assertAlmostEqual(t.rsi(self.CLOSES[:n]), want, delta=0.2, msg=f"{n}번째 종가까지")

    def test_extremes(self):
        self.assertEqual(t.rsi(list(range(1, 30))), 100.0)   # 계속 오르면 100
        self.assertEqual(t.rsi(list(range(30, 1, -1))), 0.0)  # 계속 내리면 0

    def test_too_short(self):
        self.assertIsNone(t.rsi([1] * 14))


class TestCompute(unittest.TestCase):
    def test_uptrend(self):
        # 일정한 폭으로 오르면 MACD와 시그널이 같은 값으로 수렴해 히스토그램이 0이 된다 → 가속 상승(복리 1%)으로 시험
        closes = [round(100 * 1.01 ** i, 4) for i in range(260)]
        o = make_ohlcv(closes)
        asof = max(o)
        r = t.compute(o, [], asof)
        self.assertEqual(r["asof"], asof)
        self.assertEqual(r["close"], closes[-1])
        self.assertEqual(r["align"], "정배열")
        for w in ("5", "20", "60", "120"):
            self.assertEqual(r["ma"][w]["pos"], "위")
            self.assertGreater(r["ma"][w]["dev"], 0)
        self.assertEqual(r["rsi"], 100.0)
        self.assertGreater(r["macd"]["hist"], 0)
        self.assertAlmostEqual(r["fromHi52"], t.pct(closes[-1], closes[-1] * 1.01), places=2)  # 고가 = 종가 ×1.01
        names = [g[0] for g in r["tags"]]
        self.assertIn("정배열", names)
        self.assertIn("52주 고가 근처", names)
        self.assertEqual(r["ret5"], t.pct(closes[-1], closes[-6]))

    def test_downtrend(self):
        o = make_ohlcv([400 - i for i in range(260)])
        r = t.compute(o, [], max(o))
        self.assertEqual(r["align"], "역배열")
        self.assertEqual(r["ma"]["20"]["pos"], "아래")
        self.assertEqual(r["rsi"], 0.0)
        self.assertIn(["역배열", "bad"], r["tags"])

    def test_ma_values(self):
        closes = [float(i) for i in range(1, 201)]
        o = make_ohlcv(closes)
        r = t.compute(o, [], max(o))
        self.assertEqual(r["ma"]["5"]["value"], round(sum(closes[-5:]) / 5, 1))
        self.assertEqual(r["ma"]["120"]["value"], round(sum(closes[-120:]) / 120, 1))

    def test_asof_must_be_a_trading_day_and_enough_data(self):
        o = make_ohlcv([100 + i for i in range(60)])
        self.assertIsNone(t.compute(o, [], "1999-01-01"))
        self.assertIsNone(t.compute(make_ohlcv([100] * 10), [], "2025-01-10"))

    def test_asof_ignores_later_days(self):
        closes = [100 + i for i in range(100)]
        o = make_ohlcv(closes)
        asof = sorted(o)[79]
        r = t.compute(o, [], asof)
        self.assertEqual(r["close"], closes[79])

    def test_volume_ratio_and_support_resist(self):
        vols = [100] * 59 + [300]
        closes = [100.0] * 60
        o = make_ohlcv(closes, vols=vols)
        r = t.compute(o, [], max(o))
        self.assertEqual(r["volRatio"], 3.0)
        self.assertIn(["거래량 3.0배", "good"], r["tags"])
        self.assertEqual(r["support20"], 99.0)
        self.assertEqual(r["resist20"], 101.0)

    def test_macd_cross_matches_histogram_sign(self):
        closes = [200 - i for i in range(80)] + [120 + 3 * i for i in range(40)]
        o = make_ohlcv(closes)
        crosses = []
        for d in sorted(o)[40:]:
            r = t.compute(o, [], d)
            if r["macd"]["cross"] == "골든크로스":
                self.assertGreater(r["macd"]["hist"], 0)
                crosses.append(d)
            if r["macd"]["cross"] == "데드크로스":
                self.assertLess(r["macd"]["hist"], 0)
        self.assertEqual(len(crosses), 1, "하락 뒤 반등하는 동안 골든크로스는 한 번")

    def test_flow_units_and_windows(self):
        o = make_ohlcv([100 + i for i in range(60)])
        days = sorted(o)
        # KIS 투자자 API: 순매수 거래대금 단위는 백만원 → 억원으로 /100
        flows = [{"stck_bsop_date": d.replace("-", ""), "frgn_ntby_tr_pbmn": "450042", "orgn_ntby_tr_pbmn": "-10000"}
                 for d in days[-25:]]
        r = t.compute(o, flows, days[-1])
        self.assertEqual(r["flow"]["foreign"]["d1"], 4500)
        self.assertEqual(r["flow"]["foreign"]["d5"], round(4500.42 * 5))
        self.assertEqual(r["flow"]["foreign"]["d20"], round(4500.42 * 20))
        self.assertEqual(r["flow"]["inst"]["d5"], -500)
        self.assertIn(["수급 엇갈림", "neutral"], r["tags"])
        # 기준일 이후 수급은 쓰지 않는다
        r2 = t.compute(o, flows, days[-10])
        self.assertEqual(r2["flow"]["foreign"]["d20"], None)  # 기준일까지 16일뿐

    def test_series(self):
        closes = [float(i) for i in range(1, 201)]
        o = make_ohlcv(closes)
        s = t.series(o, max(o))
        self.assertEqual(len(s["dates"]), t.SERIES_DAYS)
        self.assertEqual(s["close"][-1], 200.0)
        self.assertEqual(s["ma20"][-1], round(sum(closes[-20:]) / 20, 1))
        short = t.series(make_ohlcv(closes[:50]), "2025-02-19")
        self.assertIsNone(short["ma60"][-1])

    def test_series_indicators_match_compute(self):
        closes = [100 + 10 * ((i * 7) % 13) / 13 + i * 0.3 for i in range(240)]  # 오르내리는 시세
        o = make_ohlcv(closes, vols=[1000 + (i % 5) * 100 for i in range(240)])
        asof = max(o)
        s, r = t.series(o, asof), t.compute(o, [], asof)
        n = t.SERIES_DAYS
        for k in ("val", "bbU", "bbL", "rsi", "macd", "signal", "hist"):
            self.assertEqual(len(s[k]), n, k)
        self.assertEqual(s["rsi"][-1], r["rsi"])                       # 차트 마지막 RSI = 지표 타일 RSI
        self.assertAlmostEqual(s["hist"][-1], r["macd"]["hist"], delta=0.06)
        self.assertLess(s["bbL"][-1], s["ma20"][-1])
        self.assertGreater(s["bbU"][-1], s["ma20"][-1])
        self.assertAlmostEqual((s["bbU"][-1] + s["bbL"][-1]) / 2, s["ma20"][-1], delta=0.1)  # 밴드 중심 = 20일선
        self.assertEqual(s["prevClose"], closes[-n - 1])

    def test_rsi_series_last_equals_rsi(self):
        c = TestRSI.CLOSES
        self.assertEqual(t.rsi_series(c)[-1], t.rsi(c))
        self.assertIsNone(t.rsi_series(c)[13])
        self.assertIsNotNone(t.rsi_series(c)[14])


if __name__ == "__main__":
    unittest.main()
