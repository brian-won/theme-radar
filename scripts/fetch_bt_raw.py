"""백테스트용 원본 시세 수집 (KRX 정규장) → data/backtest/raw/bt_raw.sqlite

사용법:
    python scripts/fetch_bt_raw.py 20231101 20261116            # 일봉+수급+지수
    python scripts/fetch_bt_raw.py 20231101 20261116 --only px  # 일봉만 (px / flow / idx)
    python scripts/fetch_bt_raw.py 20231101 20261116 --delay 1.0  # 호출 간 지연(초) 늘리기
    python scripts/fetch_bt_raw.py 20261116 20261116 --force    # 이미 받은 날짜도 다시 받음

받는 것 (모두 날짜 단위 이어받기 — 이미 받은 날짜는 건너뜀):
  px    날짜별 전 종목 일봉 1회 호출(KRX [12001] 전종목 시세): 종목명·시장·시가·고가·저가·종가·
        전일대비(원)·등락률·거래량·거래대금·시가총액·상장주식수. 코넥스·우선주·스팩도 원본에는 그대로 둔다.
  flow  날짜별 종목별 외국인·기관합계 순매수 금액 2회 호출(KRX [12010]).
  idx   코스피(1001)·코스닥(2001) 지수 일봉. 거래일 목록도 여기서 얻는다.
  info  현재 상장 종목 기본정보(상장일·주식 종류)와 기간 중 상장폐지 종목 현황(폐지일·사유). 매번 새로 받음.

주의: 일일 스크리닝과 연결하지 않는다. 사용자가 요청할 때만 실행한다.
필요 환경변수: KRX_ID, KRX_PW (pykrx가 읽는다. 값은 어디에도 출력·저장하지 않는다)
"""
import argparse
import contextlib
import io
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
RAW_DIR = ROOT / "data" / "backtest" / "raw"
DB_PATH = RAW_DIR / "bt_raw.sqlite"

_sink = io.StringIO()  # pykrx가 표준출력에 찍는 로그인 안내(아이디 포함)를 화면에 내보내지 않는다
with contextlib.redirect_stdout(_sink):
    from pykrx import stock
    from pykrx.website.krx.krxio import KrxWebIo
    from pykrx.website.krx.market import core

SCHEMA = """
CREATE TABLE IF NOT EXISTS px(
  date TEXT, ticker TEXT, name TEXT, mkt TEXT,
  o INTEGER, h INTEGER, l INTEGER, c INTEGER, diff INTEGER, chg REAL,
  vol INTEGER, val INTEGER, cap INTEGER, shrs INTEGER,
  PRIMARY KEY(date, ticker)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS flow(
  date TEXT, ticker TEXT, frg INTEGER, ins INTEGER,
  PRIMARY KEY(date, ticker)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS idx(
  date TEXT, code TEXT, o REAL, h REAL, l REAL, c REAL, val INTEGER,
  PRIMARY KEY(date, code)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS done(kind TEXT, date TEXT, n INTEGER, PRIMARY KEY(kind, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS info(kind TEXT PRIMARY KEY, fetched TEXT, rows TEXT);
"""


class DelistStatus(KrxWebIo):
    """[20037] 상장폐지종목 현황 (pykrx에 없는 화면이라 직접 정의)"""

    @property
    def bld(self):
        return "dbms/MDC/STAT/issue/MDCSTAT23801"

    def fetch(self, start: str, end: str):
        return self.read(mktId="ALL", isuCd="ALL", isuCd2="ALL", strtDd=start, endDd=end,
                         share="1", csvxls_isNo="false").get("output", [])


def num(text, cast=int):
    """쉼표가 든 숫자 문자열을 수로 바꾼다. 값이 없으면(빈칸, 줄표) None."""
    text = str(text).replace(",", "").strip()
    if text in ("", "-"):
        return None
    return cast(float(text)) if cast is int else cast(text)


def call(label, func, delay, tries=6):
    """KRX 호출 1회. 실패·빈 응답이면 점점 길게 쉬고 다시 시도한다."""
    last = None
    for attempt in range(tries):
        try:
            with contextlib.redirect_stdout(_sink):
                result = func()
            time.sleep(delay)
            if result is not None and len(result) > 0:
                return result
            last = "빈 응답"
        except Exception as exc:  # 네트워크 오류·차단(LOGOUT 응답 등) 모두 재시도 대상
            last = f"{type(exc).__name__}: {str(exc)[:120]}"
        wait = min(120, 5 * 2 ** attempt)
        print(f"  [재시도 {attempt + 1}/{tries}] {label}: {last} → {wait}초 대기", file=sys.stderr, flush=True)
        time.sleep(wait)
    raise RuntimeError(f"{label} 실패: {last}")


def fetch_index(db, start, end, delay):
    for code in ("1001", "2001"):
        frame = call(f"지수 {code}", lambda: stock.get_index_ohlcv_by_date(start, end, code), delay)
        rows = [(d.strftime("%Y%m%d"), code, float(r["시가"]), float(r["고가"]), float(r["저가"]),
                 float(r["종가"]), int(r["거래대금"])) for d, r in frame.iterrows()]
        db.executemany("INSERT OR REPLACE INTO idx VALUES(?,?,?,?,?,?,?)", rows)
    db.commit()


def fetch_px_day(db, day, delay):
    frame = call(f"일봉 {day}", lambda: core.전종목시세().fetch(day, "ALL"), delay)
    rows = []
    for r in frame.to_dict("records"):
        close = num(r["TDD_CLSPRC"])
        if close is None:  # 휴장일 조회 시 값이 전부 줄표
            continue
        rows.append((day, r["ISU_SRT_CD"], r["ISU_ABBRV"], r["MKT_NM"],
                     num(r["TDD_OPNPRC"]) or 0, num(r["TDD_HGPRC"]) or 0, num(r["TDD_LWPRC"]) or 0, close,
                     num(r["CMPPREVDD_PRC"]) or 0, num(r["FLUC_RT"], float) or 0.0,
                     num(r["ACC_TRDVOL"]) or 0, num(r["ACC_TRDVAL"]) or 0, num(r["MKTCAP"]) or 0,
                     num(r["LIST_SHRS"]) or 0))
    if not rows:
        raise RuntimeError(f"{day}: 시세 값이 없음(휴장일?)")
    db.execute("DELETE FROM px WHERE date=?", (day,))
    db.executemany("INSERT INTO px VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.execute("INSERT OR REPLACE INTO done VALUES('px',?,?)", (day, len(rows)))
    db.commit()
    return len(rows)


def fetch_flow_day(db, day, delay):
    merged = {}
    for pos, code in ((0, "9000"), (1, "7050")):  # 외국인, 기관합계
        frame = call(f"수급 {day} {code}", lambda: core.투자자별_순매수상위종목().fetch(day, day, "ALL", code), delay)
        for r in frame.to_dict("records"):
            merged.setdefault(r["ISU_SRT_CD"], [0, 0])[pos] = num(r["NETBID_TRDVAL"]) or 0
    db.execute("DELETE FROM flow WHERE date=?", (day,))
    db.executemany("INSERT INTO flow VALUES(?,?,?,?)", [(day, t, v[0], v[1]) for t, v in merged.items()])
    db.execute("INSERT OR REPLACE INTO done VALUES('flow',?,?)", (day, len(merged)))
    db.commit()
    return len(merged)


def fetch_info(db, start, end, delay):
    basic = call("종목 기본정보", lambda: core.전종목기본정보().fetch("ALL"), delay)
    delist = call("상장폐지 현황", lambda: DelistStatus().fetch(start, end), delay)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    db.execute("INSERT OR REPLACE INTO info VALUES('basic',?,?)",
               (stamp, json.dumps(basic.to_dict("records"), ensure_ascii=False)))
    db.execute("INSERT OR REPLACE INTO info VALUES('delist',?,?)", (stamp, json.dumps(list(delist), ensure_ascii=False)))
    db.commit()
    return len(basic), len(delist)


def main():
    parser = argparse.ArgumentParser(description="백테스트 원본 시세 수집")
    parser.add_argument("start")
    parser.add_argument("end")
    parser.add_argument("--only", choices=["px", "flow", "idx"], help="한 종류만 받기")
    parser.add_argument("--delay", type=float, default=0.3, help="호출 간 지연(초)")
    parser.add_argument("--force", action="store_true", help="이미 받은 날짜도 다시 받기")
    args = parser.parse_args()
    if not (os.getenv("KRX_ID") and os.getenv("KRX_PW")):
        sys.exit("환경변수 KRX_ID / KRX_PW 가 필요합니다.")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    began = time.time()

    fetch_index(db, args.start, args.end, args.delay)
    days = [r[0] for r in db.execute(
        "SELECT date FROM idx WHERE code='1001' AND date BETWEEN ? AND ? ORDER BY date", (args.start, args.end))]
    print(f"거래일 {len(days)}일 ({days[0]} ~ {days[-1]}), 지수 저장 완료", flush=True)
    if args.only == "idx":
        return

    if not args.only:
        # 상장폐지 현황은 이번 인자 범위가 아니라 "저장된 전체 기간"으로 받는다(하루치만 이어받아도 목록이 줄지 않게)
        first, last = db.execute("SELECT MIN(date), MAX(date) FROM idx").fetchone()
        n_basic, n_delist = fetch_info(db, first, last, args.delay)
        print(f"종목 기본정보 {n_basic}행, 상장폐지 현황 {n_delist}행", flush=True)

    for kind, worker in (("px", fetch_px_day), ("flow", fetch_flow_day)):
        if args.only and args.only != kind:
            continue
        have = set() if args.force else {r[0] for r in db.execute("SELECT date FROM done WHERE kind=?", (kind,))}
        todo = [d for d in days if d not in have]
        print(f"[{kind}] 받을 날짜 {len(todo)}일 (건너뜀 {len(days) - len(todo)}일)", flush=True)
        t0 = time.time()
        for i, day in enumerate(todo, 1):
            try:
                n = worker(db, day, args.delay)
            except RuntimeError as exc:
                print(f"[{kind}] 중단: {exc} — 받은 곳까지 저장됨. 같은 명령으로 다시 실행하면 이어받습니다.", flush=True)
                sys.exit(2)
            if i % 25 == 0 or i == len(todo):
                print(f"[{kind}] {i}/{len(todo)} {day} {n}행, 경과 {time.time() - t0:.0f}초", flush=True)
    print(f"완료: {DB_PATH} ({DB_PATH.stat().st_size / 1e6:.1f}MB), 총 {time.time() - began:.0f}초", flush=True)


if __name__ == "__main__":
    main()
