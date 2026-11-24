# -*- coding: utf-8 -*-
"""scripts/build_dashboard.py — 캘린더(한국 시간·별점 규칙)와 종목 분석 문서 변환 테스트."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import build_dashboard as b  # noqa: E402


def write_json(obj) -> Path:
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(obj, f, ensure_ascii=False)
    f.close()
    return Path(f.name)


def ev(**kw):
    base = {"id": "x", "date": "2026-12-10", "time": "08:30", "tz": "ET", "kind": "macro", "country": "US", "stars": 3,
            "series": "us-cpi", "title": "미국 CPI"}
    base.update(kw)
    return base


class TestCatalysts(unittest.TestCase):
    def load(self, events, rules=None, today="2026-11-24", frames=("로봇",)):
        p = write_json({"events": events, "starRules": rules or {}})
        try:
            return b.load_catalysts(p, list(frames), today)
        finally:
            p.unlink()

    def test_kst_conversion_handles_daylight_saving(self):
        cat, _ = self.load([ev(id="w"), ev(id="s", date="2026-07-15")])
        kst = {e["id"]: e["kst"] for e in cat["events"]}
        self.assertEqual(kst["w"], "2026-12-10 22:30")  # 겨울(EST) +14시간
        self.assertEqual(kst["s"], "2026-07-15 21:30")  # 여름(EDT) +13시간

    def test_kst_next_day_and_korean_events_untouched(self):
        cat, _ = self.load([ev(id="a", time="14:00"), ev(id="k", tz="KST", time="10:00", country="KR")])
        e = {x["id"]: x for x in cat["events"]}
        self.assertEqual(e["a"]["kst"], "2026-12-11 04:00")
        self.assertNotIn("kst", e["k"])

    def test_invalid_events_are_dropped_with_warning(self):
        cat, warns = self.load([ev(id="ok"), ev(id="bad-tz", tz="XYZ"), ev(id="bad-kind", kind="nope"), ev(id="ok")])
        self.assertEqual([e["id"] for e in cat["events"]], ["ok"])
        self.assertTrue(any("bad-tz" in w for w in warns))
        self.assertTrue(any("bad-kind" in w for w in warns))
        self.assertTrue(any("id 중복" in w for w in warns))

    def test_star_rules_override_by_series(self):
        cat, _ = self.load([ev(id="a", stars=3), ev(id="b", date="2027-01-13", stars=3), ev(id="c", series="us-fomc", stars=2)],
                           rules={"us-cpi": {"stars": 1, "setOn": "2026-11-24"}})
        e = {x["id"]: x for x in cat["events"]}
        self.assertEqual((e["a"]["stars"], e["a"].get("starsByUser")), (1, True))
        self.assertEqual(e["b"]["stars"], 1)  # 같은 series의 이후 일정에도 적용
        self.assertEqual((e["c"]["stars"], e["c"].get("starsByUser")), (2, None))

    def test_past_event_without_result_warns(self):
        _, warns = self.load([ev(id="p", date="2026-11-01", metrics=[{"label": "CPI", "actual": None}])])
        self.assertTrue(any("결과값이 비어" in w for w in warns))

    def test_unknown_frame_warns(self):
        _, warns = self.load([ev(id="f", kind="theme", frames=["없는 큰 틀"])])
        self.assertTrue(any("없는 큰 틀" in w for w in warns))


class TestThesisMarkdown(unittest.TestCase):
    def test_html_is_escaped(self):
        html = b._md_block("<script>alert(1)</script> **굵게** [링크](https://example.com)")
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("<b>굵게</b>", html)
        self.assertIn('<a href="https://example.com" target="_blank" rel="noopener">링크</a>', html)

    def test_non_http_links_are_not_linked(self):
        html = b._md_block("[x](javascript:alert(1))")
        self.assertNotIn("<a ", html)

    def test_table_and_list(self):
        html = b._md_block("| a | b |\n|---|---|\n| 1 | 2 |\n\n- 하나\n- 둘")
        self.assertIn("<th>a</th>", html)
        self.assertIn("<td>2</td>", html)
        self.assertEqual(html.count("<li>"), 2)

    def test_load_theses_reads_meta_sections_records(self):
        doc = ("---\nname: 테스트\nticker: \"000001\"\nframes: [로봇, 반도체 관련주]\nconviction: 보통\n---\n# 테스트\n"
               "## 핵심 논리\n한 줄 논리.\n## 관련 일정 (캘린더)\n- 일정\n## 기록 (최신이 위)\n"
               "| 날짜 | 테마(순위) | 테마 안 순위(25일 등장) | 그날 등락 | 재료·변화 | 근거 영향 | 확신도 |\n|---|---|---|---|---|---|---|\n"
               "| 2026-11-24 | 로봇(2위) | 1위(5회) | +1.00% | 재료 | 강화 | 보통 |\n")
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "테스트.md").write_text(doc, encoding="utf-8")
            out = b.load_theses(Path(d))
        x = out["테스트"]
        self.assertEqual(x["meta"]["ticker"], "000001")
        self.assertEqual(x["meta"]["frames"], ["로봇", "반도체 관련주"])
        self.assertIn("관련 일정", x["sections"])          # "(캘린더)" 꼬리는 떼고 절 이름으로
        self.assertEqual(x["records"][0]["impact"], "강화")
        self.assertEqual(x["records"][0]["date"], "2026-11-24")


if __name__ == "__main__":
    unittest.main()
