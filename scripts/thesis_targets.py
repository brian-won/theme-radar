# -*- coding: utf-8 -*-
"""
투자 논리 점검(thesis) 대상 종목을 뽑는다 — 2026-11-24 사용자 지시(같은 날 기준 변경 반영).

규칙:
  - 대상 테마: 그날의 큰 틀 1~3위(대시보드 buildFrameDetail()과 같은 방식: 작은 틀 → theme_taxonomy.json 큰 틀,
    종목 중복 뺀 거래대금 합계 내림차순).
  - 후보: 그날 그 테마에 속한 종목.
  - 순위: 최근 25거래일(기준일 포함) 동안 그 테마가 1~3위였던 날, 그 테마 안에 등장한 일수 → 동률이면 25일 합계 거래대금
    → 그날 거래대금. 테마마다 1~3위, 최대 9종목. 3위와 같은 등장 일수인데 밀린 종목은 tiedOut 으로 함께 기록한다.

사용법:
  python scripts/thesis_targets.py              # 가장 최근 스크리닝 날짜 기준으로 계산해 data/thesis_targets.json 에 합침
  python scripts/thesis_targets.py 2026-11-23   # 그 날짜 기준
  python scripts/thesis_targets.py --backfill   # 25거래일이 쌓인 날부터 모든 날짜를 다시 계산(이력 채우기)

출력: data/thesis_targets.json  {"window": 25, "tickers": {...}, "history": {날짜: {"from","to","themes":[...]}}}
      화면에는 테마별 대상 종목, 전일 대비 새로 들어온·빠진 종목, 논리 문서(data/theses/<종목>.md)가 없는 종목을 출력한다.
"""
import argparse
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).parent.parent
DETAIL = ROOT / "data" / "daily_detail_with_reasons.json"
TAXONOMY = ROOT / "data" / "theme_taxonomy.json"
OUT = ROOT / "data" / "thesis_targets.json"
THESES_DIR = ROOT / "data" / "theses"
BT_DB = ROOT / "data" / "backtest" / "raw" / "bt_raw.sqlite"
WINDOW = 25
TOP = 3


def top_frames(day: dict, mapping: dict) -> list:
    """그날 큰 틀 1~3위: [(rank, 큰 틀, {종목명: 종목})] — 대시보드 buildFrameDetail()과 같은 순서 규칙."""
    by_frame = {}
    for g in day["groups"]:
        f = mapping.get(g["theme"], g["theme"])
        stocks = by_frame.setdefault(f, {})
        for s in g["stocks"]:
            stocks.setdefault(s["name"], s)
    ordered = sorted(by_frame.items(), key=lambda kv: -sum(s["value"] for s in kv[1].values()))  # 안정 정렬(JS와 동일)
    return [(i + 1, f, stocks) for i, (f, stocks) in enumerate(ordered[:3])]


def compute(detail: dict, mapping: dict, all_dates: list, date: str) -> dict:
    win = [d for d in all_dates if d <= date][-WINDOW:]
    frames = {d: top_frames(detail[d], mapping) for d in win}
    themes = []
    for rank, frame, today in frames[date]:
        cnt, val, chg = {}, {}, {}
        for d in win:
            for _, f, stocks in frames[d]:
                if f != frame:
                    continue
                for n, s in stocks.items():
                    cnt[n] = cnt.get(n, 0) + 1
                    val[n] = val.get(n, 0) + s["value"]
                    chg.setdefault(n, []).append(s["change"])
        ranked = sorted(today, key=lambda n: (-cnt[n], -val[n], -today[n]["value"]))
        top = [{
            "rank": i + 1, "name": n, "count": cnt[n], "sumValue": val[n],
            "avgChange": round(sum(chg[n]) / len(chg[n]), 2),
            "todayChange": today[n]["change"], "todayValue": today[n]["value"],
        } for i, n in enumerate(ranked[:TOP])]
        cut = top[-1]["count"] if top else None
        themes.append({
            "rank": rank, "theme": frame, "stocksToday": len(today), "top": top,
            "tiedOut": [n for n in ranked[TOP:] if cnt[n] == cut],
        })
    return {"from": win[0], "to": win[-1], "days": len(win), "themes": themes}


def names_of(day: dict) -> set:
    return {r["name"] for t in day["themes"] for r in t["top"]}


def lookup_tickers(names: set) -> dict:
    """bt_raw.sqlite에서 종목명 → (종목코드, 시장). 없으면 빈 값."""
    if not BT_DB.exists() or not names:
        return {}
    con = sqlite3.connect(BT_DB)
    out = {}
    for n in names:
        r = con.execute("select ticker, mkt from px where name=? order by date desc limit 1", (n,)).fetchone()
        if r:
            out[n] = {"ticker": r[0], "market": r[1]}
    con.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("date", nargs="?", help="기준일 YYYY-MM-DD (생략 시 가장 최근 스크리닝 날짜)")
    ap.add_argument("--backfill", action="store_true", help="25거래일이 쌓인 날부터 모든 날짜 이력을 다시 계산")
    args = ap.parse_args()

    detail = json.loads(DETAIL.read_text(encoding="utf-8"))
    mapping = json.loads(TAXONOMY.read_text(encoding="utf-8"))["mapping"]
    all_dates = sorted(k for k in detail if k[:2] == "20")
    data = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    backfill = args.backfill or data.get("window") != WINDOW  # 기준이 바뀌었으면 이력 전체를 새 기준으로 다시 계산
    history = {} if backfill else data.get("history", {})

    if backfill:
        targets = all_dates[WINDOW - 1:]
    else:
        date = args.date or all_dates[-1]
        if date not in detail:
            raise SystemExit(f"{date}는 daily_detail_with_reasons.json에 없는 날짜입니다 — 그날 스크리닝을 먼저 기록하세요")
        targets = [date]
    for d in targets:
        history[d] = compute(detail, mapping, all_dates, d)

    names = set().union(*(names_of(day) for day in history.values()))
    known = data.get("tickers", {})
    tickers = {**known, **lookup_tickers(names - set(known))}
    out = {
        "_note": "투자 논리 점검 대상: 그날 큰 틀 1~3위 테마마다, 그날 그 테마 종목 중 최근 25거래일 등장 일수 1~3위(최대 9종목). "
                 "scripts/thesis_targets.py가 생성. 규칙은 skills/theme-thesis/SKILL.md",
        "window": WINDOW,
        "tickers": dict(sorted(tickers.items())),
        "history": dict(sorted(history.items())),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    d = args.date if (args.date and not args.backfill) else all_dates[-1]
    day = history[d]
    print(f"기준일 {d} · 최근 {day['days']}거래일 {day['from']} ~ {day['to']}" + (f" (이력 {len(targets)}일 다시 계산)" if backfill else ""))
    for t in day["themes"]:
        print(f"\n  테마 {t['rank']}위 {t['theme']} (그날 {t['stocksToday']}종목)")
        for r in t["top"]:
            print(f"    {r['rank']}위 {r['name']:<10} 25일 {r['count']:>2}회  합계 {r['sumValue']:>7,}억  평균 {r['avgChange']:+.2f}%  그날 {r['todayChange']:+.2f}%")
        if t["tiedOut"]:
            print(f"    (3위와 같은 등장 일수지만 거래대금 기준으로 밀린 종목: {', '.join(t['tiedOut'])})")
    cur = names_of(day)
    prev = max((k for k in history if k < d), default=None)
    if prev:
        p = names_of(history[prev])
        print(f"\n전일({prev}) 대비 새로 대상: {sorted(cur - p) or '없음'} / 대상에서 빠짐: {sorted(p - cur) or '없음'}")
    missing = sorted(n for n in cur if not (THESES_DIR / f"{n}.md").exists())
    print(f"논리 문서 없음(새로 작성 필요): {missing or '없음'}")


if __name__ == "__main__":
    main()
