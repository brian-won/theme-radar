# -*- coding: utf-8 -*-
"""scripts/thesis_targets.py — 종목 분석 대상(그날 1~3위 테마별, 25거래일 등장 1~3위) 선정 테스트."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import thesis_targets as t  # noqa: E402


def st(name, value, change=1.0):
    return {"name": name, "value": value, "change": change, "reason": ""}


def day(*groups):
    """groups: (작은 틀, [종목...])"""
    return {"groups": [{"theme": th, "rank": 4, "stocks": stocks} for th, stocks in groups]}


MAPPING = {"로봇 부품": "로봇", "휴머노이드": "로봇", "기판": "반도체 기판", "장비": "반도체 장비", "화장품": "화장품", "게임": "게임"}


class TestTopFrames(unittest.TestCase):
    def test_groups_small_themes_into_frames_and_dedupes(self):
        d = day(("로봇 부품", [st("A", 100), st("B", 50)]),
                ("휴머노이드", [st("A", 100), st("C", 30)]),   # A 중복 → 큰 틀 합계에서 한 번만
                ("기판", [st("D", 150)]),
                ("장비", [st("E", 120)]),
                ("화장품", [st("F", 10)]))
        fr = t.top_frames(d, MAPPING)
        self.assertEqual([(r, f) for r, f, _ in fr], [(1, "로봇"), (2, "반도체 기판"), (3, "반도체 장비")])
        self.assertEqual(sorted(fr[0][2]), ["A", "B", "C"])  # 로봇 합계 180(중복 제외)

    def test_unmapped_small_theme_is_its_own_frame(self):
        fr = t.top_frames(day(("새 테마", [st("X", 999)])), MAPPING)
        self.assertEqual(fr[0][1], "새 테마")

    def test_only_top3(self):
        d = day(*[(th, [st(th + "주", v)]) for th, v in (("로봇 부품", 5), ("기판", 4), ("장비", 3), ("화장품", 2), ("게임", 1))])
        self.assertEqual(len(t.top_frames(d, MAPPING)), 3)


class TestCompute(unittest.TestCase):
    def build(self, days):
        detail = {f"2026-10-{i + 1:02d}": d for i, d in enumerate(days)}
        return detail, sorted(detail)

    def test_counts_only_days_theme_was_top3_and_only_todays_candidates(self):
        filler = day(("기판", [st("D", 500)]), ("장비", [st("E", 400)]), ("화장품", [st("F", 300)]))  # 로봇이 4위 밖인 날
        robot_day = day(("로봇 부품", [st("A", 100), st("B", 90)]), ("기판", [st("D", 50)]))
        today = day(("로봇 부품", [st("A", 100), st("C", 300)]), ("기판", [st("D", 10)]))
        detail, dates = self.build([robot_day, robot_day, filler, today])
        res = t.compute(detail, MAPPING, dates, dates[-1])
        robot = [x for x in res["themes"] if x["theme"] == "로봇"][0]
        names = [r["name"] for r in robot["top"]]
        self.assertEqual(names, ["A", "C"])            # B는 그날 로봇 종목이 아니라 후보가 아님
        self.assertEqual(robot["top"][0]["count"], 3)  # A: 로봇이 1~3위였던 3일 모두
        self.assertEqual(robot["top"][1]["count"], 1)
        self.assertEqual(robot["stocksToday"], 2)
        self.assertEqual(robot["top"][0]["todayChange"], 1.0)

    def test_tiebreak_by_25day_value_then_today_value_and_tied_out(self):
        today = day(("장비", [st("P", 10), st("Q", 20), st("R", 30), st("S", 40)]))
        detail, dates = self.build([today])
        res = t.compute(detail, MAPPING, dates, dates[-1])
        top = res["themes"][0]
        self.assertEqual([r["name"] for r in top["top"]], ["S", "R", "Q"])  # 모두 1회 → 25일 합계 거래대금 순
        self.assertEqual(top["tiedOut"], ["P"])

    def test_window_is_25_trading_days(self):
        old = day(("로봇 부품", [st("A", 100)]))
        new = day(("로봇 부품", [st("B", 100)]))
        today = day(("로봇 부품", [st("A", 100), st("B", 100)]))
        detail = {f"2026-{m:02d}-{d:02d}": None for m in (9, 10) for d in range(1, 29)}
        dates = sorted(detail)[:30]
        detail = {k: (old if i < 5 else new) for i, k in enumerate(dates[:-1])}
        detail[dates[-1]] = today
        res = t.compute(detail, MAPPING, dates, dates[-1])
        top = {r["name"]: r["count"] for r in res["themes"][0]["top"]}
        self.assertEqual(res["days"], t.WINDOW)
        self.assertEqual(top["B"], 25)  # 마지막 25일(오늘 포함) 전부
        self.assertEqual(top["A"], 1)   # 앞쪽 5일 등장분은 기간 밖, 오늘만

    def test_max_three_per_theme(self):
        today = day(("로봇 부품", [st(n, 10) for n in "ABCDE"]))
        detail, dates = self.build([today])
        self.assertEqual(len(t.compute(detail, MAPPING, dates, dates[-1])["themes"][0]["top"]), 3)


if __name__ == "__main__":
    unittest.main()
