"""백테스트 원본(data/backtest/raw/bt_raw.sqlite) → 분석 탭용 시세 조각(docs/bt/*.js)

사용법:
    python scripts/build_bt_data.py                 # 전체 빌드 + 형식 검사
    python scripts/build_bt_data.py --check-only    # 이미 만든 docs/bt 조각의 형식 검사만
    python scripts/build_bt_data.py --no-mirror     # dashboard/bt 로 복사하지 않음
    python scripts/build_bt_data.py --min-cap 1000  # 시가총액 기준(억원)

만드는 파일 (설계서 4장 형식, 모두 `window.__btChunk({...});` 한 줄로 감싼다. "kind"로 종류 구분):
    px_YYYYMM.js    kind="px"    수정주가 시·고·저·종(원, 정수), 거래대금(억원, 정수), 등락률(%, 원래 값)
    flow_YYYYMM.js  kind="flow"  외국인·기관 순매수 금액(억원, 소수 1자리)
    meta.js         kind="meta"  종목 정보, 월말 시가총액(capQ), 종목명→코드(nameToTicker)
    index.js        kind="index" 코스피·코스닥 지수 일봉
  docs/bt 가 원본이고, 로컬 미리보기(dashboard/index.html 을 file:// 로 열 때)에서도 같은 상대 경로
  `bt/...` 로 읽히도록 dashboard/bt 에 같은 파일을 복사한다(engine.js 등 다른 파일은 건드리지 않음).

대상 종목: 기간 중 하루라도 시가총액이 기준 이상이었던 코스피·코스닥 보통주(상장폐지 포함).
    우선주(코드 끝자리가 0이 아님)·스팩(그날 이름에 '스팩')·코넥스 거래일은 제외.
    + 테마 레이더(data/daily_detail_with_reasons.json)에 나온 종목은 기준 미달이어도 넣고 themeOnly 로 표시.

수정주가: KRX 일봉은 수정 전 가격이다. 그날의 기준가(= 종가 − 전일대비)가 전날 종가와 다르면
    그 비율(기준가 ÷ 전날 종가)을 그 전날까지의 가격에 곱한다(분할·병합·감자·권리락 반영, 현금배당은 미반영).
    등락률로 역산한 기준가(종가 ÷ (1+등락률))와 맞는지도 같이 검사한다.
    단, 거래정지 뒤 "시초가 = 기준가"로 재개된 날은 그 비율에 실제 가격 변동이 섞여 있으므로 주식 수 변화로
    회사 행위 몫만 반영하고(reopen_factor), 그날 등락률은 직전 종가 대비 실제 값으로 바꿔 넣는다.
거래정지·무거래일: 시·고·저를 종가(마지막 종가)로 채우고 거래대금 0, 등락률 0. → 0은 상장 전·폐지 후에만 나온다.

이 스크립트는 네트워크를 쓰지 않는다. 수집은 scripts/fetch_bt_raw.py (사용자가 요청할 때만 실행).
"""
import argparse
import gzip
import json
import math
import re
import shutil
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
DB_PATH = ROOT / "data" / "backtest" / "raw" / "bt_raw.sqlite"
OUT_DIR = ROOT / "docs" / "bt"
MIRROR_DIR = ROOT / "dashboard" / "bt"
REPORT_PATH = ROOT / "data" / "backtest" / "bt_build_report.json"
THEME_PATH = ROOT / "data" / "daily_detail_with_reasons.json"
CALLBACK = "window.__btChunk"
OWN_FILE = re.compile(r"^(px_\d{6}|flow_\d{6}|meta|index)\.js$")  # 이 스크립트가 만든 파일만 지우고 복사한다

# 테마 레이더 표기 → KRX 종목명 (scripts/fetch_recent_prices.py 의 NAME_ALIAS 와 같은 내용)
NAME_ALIAS = {"네이버": "NAVER", "LS일렉트릭": "LS ELECTRIC", "포스코홀딩스": "POSCO홀딩스",
              "LIG D&A": "LIG디펜스앤에어로스페이스", "엔씨소프트": "NC"}
# KRX 상장폐지 사유 → 설계서 구분. 주주가 대가(합병 신주·공개매수 대금)를 받는 경우는 "합병"으로 묶는다.
MERGE_WORDS = ("합병", "완전자회사", "주식교환", "주식의 포괄적", "신청에 의한", "자진", "해산")
MOVE_WORDS = ("이전상장", "유가증권시장 상장", "코스닥시장 상장", "시장 이전")


def norm(name):
    return re.sub(r"[\s&().]", "", name)


def iso(day):
    return f"{day[:4]}-{day[4:6]}-{day[6:]}"


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write_chunk(path, obj):
    path.write_text(f"{CALLBACK}({dumps(obj)});\n", encoding="utf-8", newline="\n")


def read_chunk(path):
    text = path.read_text(encoding="utf-8").strip()
    head, tail = CALLBACK + "(", ");"
    if not (text.startswith(head) and text.endswith(tail)):
        raise ValueError(f"{path.name}: {CALLBACK}(...) 한 줄 형식이 아님")
    return json.loads(text[len(head):-len(tail)])


# ───────────────────────── 원본 읽기 ─────────────────────────

def load_raw(db):
    days = [r[0] for r in db.execute("SELECT date FROM done WHERE kind='px' ORDER BY date")]
    if not days:
        sys.exit("원본에 일봉이 없습니다. 먼저 scripts/fetch_bt_raw.py 를 실행하세요.")
    pos = {d: i for i, d in enumerate(days)}
    rows = defaultdict(list)       # ticker → [(dayIdx, name, mkt, o, h, l, c, diff, chg, val, cap, shrs)]
    for d, t, name, mkt, o, h, l, c, diff, chg, val, cap, shrs in db.execute(
            "SELECT date,ticker,name,mkt,o,h,l,c,diff,chg,val,cap,shrs FROM px ORDER BY ticker,date"):
        if d in pos:
            rows[t].append((pos[d], name, mkt, o, h, l, c, diff, chg, val, cap, shrs))
    info = {k: json.loads(v) for k, v in db.execute("SELECT kind, rows FROM info")}
    return days, rows, info


def load_theme_names():
    """테마 레이더의 종목명 → 등장 날짜 목록(YYYYMMDD)."""
    if not THEME_PATH.exists():
        return {}
    seen = defaultdict(list)
    for day, body in json.loads(THEME_PATH.read_text(encoding="utf-8")).items():
        for group in body.get("groups", []):
            for s in group.get("stocks", []):
                seen[s["name"]].append(day.replace("-", ""))
    return seen


def is_common(ticker):
    return ticker[-1] == "0"


def pick_universe(rows, min_cap_won):
    picked = set()
    for t, rs in rows.items():
        if not is_common(t):
            continue
        for r in rs:
            if r[10] >= min_cap_won and r[2] != "KONEX" and "스팩" not in r[1]:
                picked.add(t)
                break
    return picked


def map_theme_names(theme_names, days, rows):
    """테마 종목명을 '등장한 날의 KRX 이름표'로 코드에 연결한다(사명 변경·상장폐지에도 안전)."""
    pos = {d: i for i, d in enumerate(days)}
    need = defaultdict(set)                     # dayIdx → 그날 찾아야 할 정규화 이름
    for name, seen in theme_names.items():
        key = norm(NAME_ALIAS.get(name, name))
        for d in seen:
            if d in pos:
                need[pos[d]].add(key)
    by_day = defaultdict(dict)                  # dayIdx → {정규화 이름: ticker}
    latest = {}                                 # 정규화 이름 → (dayIdx, ticker): 날짜 매칭 실패 시 예비
    for t, rs in rows.items():
        for r in rs:
            key = norm(r[1])
            if key in need.get(r[0], ()):
                by_day[r[0]][key] = t
            if key not in latest or latest[key][0] < r[0]:
                latest[key] = (r[0], t)
    mapped, missing, conflict = {}, [], []
    for name, seen in theme_names.items():
        key = norm(NAME_ALIAS.get(name, name))
        found = [by_day[pos[d]][key] for d in seen if d in pos and key in by_day[pos[d]]]
        if not found and key in latest:
            found = [latest[key][1]]
        if not found:
            missing.append(name)
            continue
        if len(set(found)) > 1:
            conflict.append({"name": name, "tickers": sorted(set(found))})
        mapped[name] = found[-1]                # 가장 최근 등장일 기준
    return mapped, missing, conflict


# ───────────────────────── 종목별 시계열 만들기 ─────────────────────────

def adj_price(value, cum):
    return max(1, int(round(value * cum))) if value > 0 else 0


def reopen_factor(f_total, shr_total, spun_off):
    """거래정지 뒤 '시초가가 곧 기준가'로 재개된 날의 실제 수정 계수를 고른다.

    이런 날 KRX 기준가는 동시호가로 정해진 시초가(평가가격의 50~200%)라서, 기준가 ÷ 전 종가에는
    회사 행위(병합·감자·분할)와 실제 가격 변동이 섞여 있다. 주식 수 변화로 회사 행위 몫만 가려낸다.
      · 주식 수 그대로 → 1 (전부 실제 가격 변동)
      · 같은 날 주식 수 감소분에 맞는 신규 상장이 있음(인적분할) → KRX 비율 그대로
        (떼어 간 회사 몫까지 합친 가치가 재개 시점에 보존된다고 보는 중립 가정)
      · 그 외 → 1/주식수비 와 1 중 기준가 비율에 더 가까운 쪽
    """
    if spun_off:
        return f_total
    if shr_total <= 0 or abs(shr_total - 1) < 0.005:
        return 1.0
    by_shares = 1 / shr_total
    return by_shares if abs(math.log(f_total / by_shares)) < abs(math.log(f_total)) else 1.0


def is_spinoff(name, lost_shares, new_name, new_shares):
    """신규 상장 종목이 이 종목에서 떼어 낸 회사인지: 신주 수가 줄어든 주식 수의 정수배(액면이 다를 수 있음)."""
    ratio = new_shares / lost_shares
    k = round(ratio)
    if not 1 <= k <= 20:
        return False
    off = abs(ratio / k - 1)
    return off < 0.005 or (off < 0.10 and name[:2] == new_name[:2])   # 자사주 등으로 정확히 안 맞는 경우는 이름 앞 2글자로 확인


def build_series(ticker, rs, n_days, new_listings):
    """한 종목의 원본 행 → 전체 날짜 축에 맞춘 수정주가 배열과 수정 이벤트."""
    rs = [r for r in rs if r[2] != "KONEX"]     # 코넥스 시절은 상장 전으로 본다
    if not rs:
        return None
    first, last = rs[0][0], rs[-1][0]
    span = last - first + 1
    raw = [None] * span
    for r in rs:
        raw[r[0] - first] = r
    events, warns, reopens = [], [], []
    factor = [1.0] * span                       # factor[i]: i일 기준가 ÷ 직전 종가 (i 이전 가격에 곱함)
    real_chg = {}                               # 재개일: 원본 등락률(시초가 대비) 대신 쓸 실제 등락률
    prev = None
    traded = None                               # 마지막으로 거래된 날의 행
    halt_f = 1.0                                # 그 뒤 거래정지 중에 이미 반영한 계수의 곱
    for i in range(span):
        r = raw[i]
        if r is None:
            continue
        if prev is not None:
            close, diff, chg, prev_close = r[6], r[7], r[8], prev[6]
            base = close - diff
            if base > 0 and prev_close > 0 and base != prev_close:
                f = base / prev_close
                reopen = prev[3] <= 0 and r[3] == base and traded is not None
                if reopen:
                    kept = f
                    if halt_f == 1.0:
                        shr_total = r[11] / traded[11] if traded[11] else 0
                        lost = traded[11] - r[11]
                        spun = lost > 0 and any(is_spinoff(r[1], lost, nm, n)
                                                for nm, n in new_listings.get(i + first, ()))
                        f = reopen_factor(kept, shr_total, spun)
                    else:                       # 정지 중에 KRX가 평가가격을 이미 줬으면 나머지는 실제 변동
                        f = 1.0
                    real_chg[i] = round((close / (prev_close * f) - 1) * 100, 2)
                    reopens.append({"t": ticker, "name": r[1], "date": i + first, "krxRatio": round(kept, 6),
                                    "used": round(f, 6), "shrRatio": round(r[11] / traded[11], 4) if traded[11] else 0,
                                    "prevClose": prev_close, "open": r[3], "close": close,
                                    "krxChg": chg, "realChg": real_chg[i]})
                    reopens[-1]["spinoff"] = halt_f == 1.0 and spun
                    if f == 1.0:
                        prev = r
                        traded, halt_f = r, 1.0
                        continue
                factor[i] = f
                base_by_chg = close / (1 + chg / 100) if chg > -100 else 0
                ok = base_by_chg > 0 and abs(base_by_chg / base - 1) <= max(0.006, 0.6 / base)
                shr = r[11] / prev[11] if prev[11] else 0
                events.append({"t": ticker, "name": r[1], "date": i + first, "f": round(f, 6),
                               "prevClose": prev_close, "base": base, "close": close, "chg": chg,
                               "shrRatio": round(shr, 4), "chgOk": ok})
                if not ok:
                    warns.append(f"{ticker} {r[1]} 기준가 불일치: 전일대비 기준 {base} / 등락률 역산 {base_by_chg:.1f}")
        prev = r
        if r[3] > 0:
            traded, halt_f = r, 1.0
        else:
            halt_f *= factor[i]
    o, h, l, c, a, chg_out = ([0] * n_days for _ in range(6))
    cum, last_close = 1.0, None
    filled = set()
    for i in range(span):                       # 빈 날(목록에서 빠진 날)은 직전 행으로 메움
        if raw[i] is None:
            filled.add(i)
        else:
            last_close = raw[i]
        raw[i] = raw[i] or last_close
    for i in range(span - 1, -1, -1):
        r = raw[i]
        g = first + i
        halted = i in filled or r[3] <= 0 or r[4] <= 0 or r[5] <= 0
        c[g] = adj_price(r[6], cum)
        if halted:
            o[g] = h[g] = l[g] = c[g]
            a[g], chg_out[g] = 0, 0
        else:
            o[g], h[g], l[g] = adj_price(r[3], cum), adj_price(r[4], cum), adj_price(r[5], cum)
            a[g] = max(1, int(round(r[9] / 1e8))) if r[9] > 0 else 0
            chg_out[g] = real_chg.get(i, round(r[8], 2)) + 0.0
        cum *= factor[i]
    return {"first": first, "last": last, "o": o, "h": h, "l": l, "c": c, "a": a, "chg": chg_out,
            "events": events, "warns": warns, "reopens": reopens, "gaps": len(filled), "rows": rs}


def delist_why(reason):
    if any(w in reason for w in MOVE_WORDS):
        return "이전상장"
    if any(w in reason for w in MERGE_WORDS):
        return "합병"
    return "폐지"


# ───────────────────────── 형식 검사 ─────────────────────────

def check_output(out_dir, verbose=True):
    """만들어진 조각 파일을 다시 읽어 4장 형식을 검사한다. (오류 목록, 경고 목록, 통계)"""
    errors, warns = [], []
    meta = read_chunk(out_dir / "meta.js")
    index = read_chunk(out_dir / "index.js")
    for key in ("asOf", "months", "tickers", "capQ", "nameToTicker"):
        if key not in meta:
            errors.append(f"meta.js: {key} 없음")
    n = len(index["dates"])
    for mk in ("KOSPI", "KOSDAQ"):
        for f in "ohlc":
            arr = index[mk][f]
            if len(arr) != n or any(v <= 0 for v in arr):
                errors.append(f"index.js: {mk}.{f} 길이 불일치 또는 0 이하 값")
    all_dates, seen_tickers = [], set()
    last_close = {}                              # ticker → 직전 거래일 수정 종가
    ended = set()                                # 폐지 후 0이 나온 종목
    jumps, big_moves, tiny = [], [], 0
    cells = 0
    for ym in meta["months"]:
        name = f"px_{ym.replace('-', '')}.js"
        if not (out_dir / name).exists():
            errors.append(f"{name}: 파일 없음")
            continue
        ch = read_chunk(out_dir / name)
        if ch.get("ym") != ym:
            errors.append(f"{name}: ym 불일치")
        dates, tickers = ch["dates"], ch["tickers"]
        nd = len(dates)
        all_dates += dates
        if len(set(tickers)) != len(tickers):
            errors.append(f"{name}: 종목 코드 중복")
        for f in ("o", "h", "l", "c", "a", "chg"):
            if len(ch[f]) != len(tickers) or any(len(x) != nd for x in ch[f]):
                errors.append(f"{name}: {f} 배열 길이 불일치")
        for k, t in enumerate(tickers):
            if t not in meta["tickers"]:
                errors.append(f"{name}: {t} 가 meta.tickers 에 없음")
            seen_tickers.add(t)
            O, H, L, C, A, G = (ch[f][k] for f in ("o", "h", "l", "c", "a", "chg"))
            for i in range(nd):
                o, h, l, c = O[i], H[i], L[i], C[i]
                if c == 0:
                    if o or h or l or A[i]:
                        errors.append(f"{name}: {t} {dates[i]} 종가 0인데 다른 값이 있음")
                    if t in last_close:
                        ended.add(t)
                    continue
                cells += 1
                if t in ended:
                    errors.append(f"{name}: {t} {dates[i]} 0(폐지) 뒤에 값이 다시 나옴")
                    ended.discard(t)
                if min(o, h, l) <= 0 or h < max(o, c) or l > min(o, c) or A[i] < 0:
                    errors.append(f"{name}: {t} {dates[i]} 시고저종 관계 오류 {o}/{h}/{l}/{c}")
                if c < 100:
                    tiny += 1
                p = last_close.get(t)
                if p and A[i] > 0:
                    ret = (c / p - 1) * 100
                    tol = 0.6 + 100 * (0.5 / c + 0.5 / p) * 1.5   # 정수 반올림 + 등락률 소수 2자리 오차
                    if abs(ret - G[i]) > tol:
                        jumps.append(f"{t} {dates[i]} 수정종가 변화 {ret:+.2f}% ≠ 등락률 {G[i]:+.2f}%")
                    if abs(G[i]) > 30.5:
                        big_moves.append(f"{t} {meta['tickers'].get(t, {}).get('name', '')} {dates[i]} {G[i]:+.2f}%")
                last_close[t] = c
        fname = f"flow_{ym.replace('-', '')}.js"
        if (out_dir / fname).exists():
            fl = read_chunk(out_dir / fname)
            if fl["dates"] != dates or fl["tickers"] != tickers:
                errors.append(f"{fname}: dates/tickers 가 {name} 과 다름")
            for f in ("frg", "ins"):
                if len(fl[f]) != len(tickers) or any(len(x) != nd for x in fl[f]):
                    errors.append(f"{fname}: {f} 배열 길이 불일치")
    if all_dates != sorted(set(all_dates)):
        errors.append("px 조각의 날짜가 정렬돼 있지 않거나 중복됨")
    if all_dates != index["dates"]:
        errors.append("index.js 날짜가 px 조각 날짜와 다름")
    if all_dates and meta.get("asOf") != all_dates[-1]:
        errors.append("meta.asOf 가 마지막 날짜와 다름")
    lost = set(meta["tickers"]) - seen_tickers
    if lost:
        errors.append(f"meta.tickers 중 시세가 전혀 없는 종목 {len(lost)}개: {sorted(lost)[:5]}")
    bad_names = [k for k, v in meta["nameToTicker"].items() if v not in meta["tickers"]]
    if bad_names:
        errors.append(f"nameToTicker 중 meta.tickers 에 없는 코드 {len(bad_names)}개: {bad_names[:5]}")
    if jumps:
        errors.append(f"수정주가 급변(등락률과 불일치) {len(jumps)}건: {jumps[:5]}")
    if big_moves:
        warns.append(f"등락률 ±30% 초과 {len(big_moves)}건(재상장·정리매매·거래재개일 등): {big_moves[:8]}")
    if tiny:
        warns.append(f"수정주가 100원 미만 칸 {tiny}개(정수 반올림 오차 0.5% 이상 가능)")
    stats = {"days": len(all_dates), "tickers": len(seen_tickers), "cells": cells,
             "first": all_dates[0] if all_dates else None, "last": all_dates[-1] if all_dates else None}
    if verbose:
        for w in warns:
            print("  [경고]", w)
        for e in errors[:30]:
            print("  [오류]", e)
    return errors, warns, stats


def size_report(out_dir):
    groups = defaultdict(lambda: [0, 0, 0])
    for p in sorted(out_dir.iterdir()):
        if OWN_FILE.match(p.name):
            data = p.read_bytes()
            g = groups[p.name.split("_")[0].replace(".js", "")]
            g[0] += 1
            g[1] += len(data)
            g[2] += len(gzip.compress(data, 6))
    total = [sum(g[i] for g in groups.values()) for i in range(3)]
    for k, g in groups.items():
        print(f"  {k:6s} {g[0]:3d}개  원본 {g[1] / 1e6:6.2f}MB  gzip {g[2] / 1e6:6.2f}MB")
    print(f"  합계   {total[0]:3d}개  원본 {total[1] / 1e6:6.2f}MB  gzip {total[2] / 1e6:6.2f}MB")
    return {k: {"files": g[0], "bytes": g[1], "gzip": g[2]} for k, g in groups.items()} | {
        "total": {"files": total[0], "bytes": total[1], "gzip": total[2]}}


# ───────────────────────── 빌드 ─────────────────────────

def build(args):
    db = sqlite3.connect(DB_PATH)
    days, rows, info = load_raw(db)
    n_days = len(days)
    iso_days = [iso(d) for d in days]
    print(f"원본: {days[0]} ~ {days[-1]} {n_days}거래일, 전체 종목 {len(rows)}개")

    theme_names = load_theme_names()
    theme_map, theme_missing, theme_conflict = map_theme_names(theme_names, days, rows)
    cap_universe = pick_universe(rows, args.min_cap * 10 ** 8)
    theme_extra = {t for t in theme_map.values() if t not in cap_universe}
    universe = sorted(cap_universe | theme_extra)
    print(f"대상: 시총 {args.min_cap}억 이상 {len(cap_universe)}개 + 테마 레이더 전용 {len(theme_extra)}개 = {len(universe)}개")

    basic = {r["ISU_SRT_CD"]: r for r in info.get("basic", [])}
    delist = {r["ISU_CD"]: r for r in info.get("delist", []) if r.get("SECUGRP_NM") != "신주인수권증서"}

    new_listings = defaultdict(list)            # dayIdx → 그날 처음 나타난 종목의 (이름, 상장주식수) — 인적분할 판별용
    for t, rs in rows.items():
        if rs[0][0] > 0 and is_common(t) and "스팩" not in rs[0][1]:
            new_listings[rs[0][0]].append((rs[0][1], rs[0][11]))
    series, events, warns, reopens = {}, [], [], []
    for t in universe:
        s = build_series(t, rows[t], n_days, new_listings)
        if s is None:
            continue
        series[t] = s
        events += s["events"]
        warns += s["warns"]
        reopens += s["reopens"]
    for e in events + reopens:
        e["date"] = iso_days[e["date"]]

    # 종목 정보
    tickers_meta, cap_q, name_to_ticker = {}, {}, {}
    month_of = [d[:6] for d in days]
    name_clash = []
    for t, s in series.items():
        rs = s["rows"]
        gone = s["last"] < n_days - 1
        d_row = delist.get(t)
        listed = None
        if t in basic and basic[t].get("LIST_DD"):
            listed = basic[t]["LIST_DD"].replace("/", "-")
        elif d_row and d_row.get("LIST_DD"):
            listed = d_row["LIST_DD"].replace("/", "-")
        elif s["first"] > 0:
            listed = iso_days[s["first"]]
        entry = {"name": rs[-1][1], "mkt": "KOSPI" if rs[-1][2] == "KOSPI" else "KOSDAQ",
                 "listed": listed, "delisted": None, "delistWhy": None}
        if gone:
            reason = (d_row or {}).get("DELIST_RSN_DSC", "")
            entry["delisted"] = (d_row["DELIST_DD"].replace("/", "-") if d_row and d_row.get("DELIST_DD")
                                 else iso_days[s["last"]])
            entry["delistWhy"] = delist_why(reason) if reason else "폐지"
            entry["delistReason"] = reason or None
            entry["lastDate"] = iso_days[s["last"]]
        if t in theme_extra:
            entry["themeOnly"] = True
        tickers_meta[t] = entry
        q, seen_month = [], None
        for r in reversed(rs):                  # 달마다 그 종목의 마지막 거래일 시가총액
            if month_of[r[0]] != seen_month:
                seen_month = month_of[r[0]]
                q.append([iso_days[r[0]], int(round(r[10] / 1e8))])
        cap_q[t] = q[::-1]
        for r in rs:                            # 옛 이름 포함, 같은 이름이 여러 코드면 더 나중 것
            old = name_to_ticker.get(r[1])
            if old is None or old[0] <= r[0]:
                if old is not None and old[1] != t:
                    name_clash.append(r[1])
                name_to_ticker[r[1]] = (r[0], t)
    name_to_ticker = {k: v[1] for k, v in name_to_ticker.items()}
    for name, t in theme_map.items():           # 테마 레이더 표기(별칭·옛 이름)가 최우선
        if t in series:
            name_to_ticker[name] = t

    # 파일 쓰기
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for p in OUT_DIR.iterdir():
        if OWN_FILE.match(p.name):
            p.unlink()
    months = sorted(set(month_of))
    flow_days = {r[0] for r in db.execute("SELECT date FROM done WHERE kind='flow'")}
    flow_months = []
    for m in months:
        idxs = [i for i in range(n_days) if month_of[i] == m]
        lo, hi = idxs[0], idxs[-1] + 1
        ts = [t for t, s in series.items() if s["first"] < hi and s["last"] >= lo]
        ym = f"{m[:4]}-{m[4:]}"
        chunk = {"kind": "px", "ym": ym, "dates": iso_days[lo:hi], "tickers": ts}
        for f in ("o", "h", "l", "c", "a", "chg"):
            chunk[f] = [series[t][f][lo:hi] for t in ts]
        write_chunk(OUT_DIR / f"px_{m}.js", chunk)
        if all(days[i] in flow_days for i in idxs):
            tpos = {t: k for k, t in enumerate(ts)}
            frg = [[0] * (hi - lo) for _ in ts]
            ins = [[0] * (hi - lo) for _ in ts]
            for d, t, fv, iv in db.execute("SELECT date,ticker,frg,ins FROM flow WHERE date BETWEEN ? AND ?",
                                           (days[lo], days[hi - 1])):
                k = tpos.get(t)
                if k is None:
                    continue
                col = day_pos[d] - lo
                if series[t]["c"][lo + col] == 0:   # 상장 전·폐지 후(코넥스 시절 포함)는 0으로 둔다
                    continue
                frg[k][col] = compact(fv / 1e8)
                ins[k][col] = compact(iv / 1e8)
            write_chunk(OUT_DIR / f"flow_{m}.js",
                        {"kind": "flow", "ym": ym, "dates": iso_days[lo:hi], "tickers": ts, "frg": frg, "ins": ins})
            flow_months.append(ym)

    index = {"kind": "index", "dates": iso_days}
    for code, key in (("1001", "KOSPI"), ("2001", "KOSDAQ")):
        got = {d: (o, h, l, c) for d, o, h, l, c in
               db.execute("SELECT date,o,h,l,c FROM idx WHERE code=?", (code,))}
        lack = [d for d in days if d not in got]
        if lack:
            sys.exit(f"지수 {key} 일봉이 빠진 날짜 {len(lack)}일: {lack[:5]}")
        index[key] = {f: [round(got[d][j], 2) for d in days] for j, f in enumerate("ohlc")}
    write_chunk(OUT_DIR / "index.js", index)

    n_delisted = sum(1 for e in tickers_meta.values() if e["delisted"])
    meta = {"kind": "meta", "asOf": iso_days[-1], "months": [f"{m[:4]}-{m[4:]}" for m in months],
            "flowMonths": flow_months,
            "universe": {"minCapEok": args.min_cap, "price": "KRX 정규장", "tickers": len(tickers_meta),
                         "delisted": n_delisted, "themeOnly": len(theme_extra),
                         "start": iso_days[0], "end": iso_days[-1]},
            "tickers": tickers_meta, "capQ": cap_q, "nameToTicker": name_to_ticker}
    write_chunk(OUT_DIR / "meta.js", meta)

    # 수정 이벤트 요약(원인 확인용)
    def kind_of(e):
        f = e["f"]
        if f <= 0.55:
            return "분할·무상증자(가격 절반 이하)"
        if f >= 1.8:
            return "병합·감자(가격 1.8배 이상)"
        return "권리락·소폭 조정"
    by_kind = defaultdict(set)
    for e in events:
        by_kind[kind_of(e)].add(e["t"])
    adj_tickers = {e["t"] for e in events}
    print(f"수정 이벤트 {len(events)}건 / 종목 {len(adj_tickers)}개 "
          + " / ".join(f"{k} {len(v)}종목" for k, v in sorted(by_kind.items())))
    print(f"거래정지 뒤 시초가 기준 재개 {len(reopens)}건: 수정 없이 실제 변동으로 처리 "
          f"{sum(1 for e in reopens if e['used'] == 1.0)}건, 인적분할(KRX 비율 그대로) "
          f"{sum(1 for e in reopens if e['spinoff'])}건, 주식 수 비율로 수정 "
          f"{sum(1 for e in reopens if e['used'] != 1.0 and not e['spinoff'])}건")
    if warns:
        print(f"기준가 검증 불일치 {len(warns)}건: {warns[:5]}")
    matched = [n for n in theme_names if n in theme_map and theme_map[n] in series]
    print(f"테마 레이더 종목명 {len(theme_names)}개 중 매칭 {len(matched)}개, 미매칭 {theme_missing}")

    print("형식 검사:")
    errors, check_warns, stats = check_output(OUT_DIR)
    print(f"  {stats['first']} ~ {stats['last']} {stats['days']}거래일, 종목 {stats['tickers']}개"
          f"(상장폐지 {n_delisted}개), 값이 있는 칸 {stats['cells']:,}개, 오류 {len(errors)}건")
    print("용량:")
    sizes = size_report(OUT_DIR)

    REPORT_PATH.write_text(json.dumps({
        "range": [iso_days[0], iso_days[-1]], "days": n_days, "tickers": len(tickers_meta),
        "delisted": n_delisted, "capUniverse": len(cap_universe), "themeOnly": sorted(theme_extra),
        "themeNames": len(theme_names), "themeMatched": len(matched), "themeMissing": theme_missing,
        "themeConflict": theme_conflict, "nameClash": sorted(set(name_clash)),
        "adjEvents": events, "reopens": reopens, "adjWarns": warns, "checkErrors": errors, "checkWarns": check_warns,
        "sizes": sizes}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"빌드 보고서: {REPORT_PATH}")

    if errors:
        print("형식 검사 실패 — dashboard/bt 로 복사하지 않습니다.")
        return 1
    if not args.no_mirror:
        MIRROR_DIR.mkdir(parents=True, exist_ok=True)
        for p in MIRROR_DIR.iterdir():
            if OWN_FILE.match(p.name):
                p.unlink()
        for p in OUT_DIR.iterdir():
            if OWN_FILE.match(p.name):
                shutil.copy2(p, MIRROR_DIR / p.name)
        print(f"로컬 미리보기용 복사: {MIRROR_DIR}")
    return 0


day_pos = {}


def compact(v):
    """억원 소수 1자리. 정수면 정수로 써서 용량을 줄인다."""
    v = round(v, 1)
    return int(v) if v == int(v) else v


def main():
    parser = argparse.ArgumentParser(description="백테스트 시세 조각 빌드")
    parser.add_argument("--min-cap", type=int, default=1000, help="시가총액 기준(억원)")
    parser.add_argument("--no-mirror", action="store_true", help="dashboard/bt 로 복사하지 않음")
    parser.add_argument("--check-only", action="store_true", help="docs/bt 형식 검사만")
    args = parser.parse_args()
    if args.check_only:
        errors, _, stats = check_output(OUT_DIR)
        print(f"{stats['first']} ~ {stats['last']} {stats['days']}거래일, 종목 {stats['tickers']}개, 오류 {len(errors)}건")
        size_report(OUT_DIR)
        return 1 if errors else 0
    if not DB_PATH.exists():
        sys.exit(f"원본이 없습니다: {DB_PATH}")
    db = sqlite3.connect(DB_PATH)
    day_pos.update({r[0]: i for i, r in enumerate(db.execute("SELECT date FROM done WHERE kind='px' ORDER BY date"))})
    db.close()
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
