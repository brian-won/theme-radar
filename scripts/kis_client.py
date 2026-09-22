"""
한국투자증권(KIS) Open API 최소 클라이언트 (모의투자 전용, 시세 조회 용도).

python-kis 라이브러리는 실전투자 appkey를 필수로 요구해서(모의투자 키만 있는
경우 사용 불가) 여기서는 requests로 직접 REST 호출한다.

핵심: FID_COND_MRKT_DIV_CODE="UN" 을 쓰면 KRX+넥스트레이드(NXT) 통합
(애프터마켓 포함) 거래대금/등락률을 받을 수 있다. "J"는 KRX 단독(정규장) 기준.

토큰 발급은 1분당 1회로 제한되므로 발급받은 토큰을 파일에 캐시해 재사용한다.
"""
import os
import json
import time
from pathlib import Path

import requests

BASE_URL = "https://openapivts.koreainvestment.com:29443"  # 모의투자
TOKEN_CACHE = Path(__file__).parent.parent / "data" / "kis_token_cache.json"
MIN_REQUEST_INTERVAL = 0.8  # 모의투자 API 제한: 초당 2건 (여유 두고 보수적으로)
MAX_RETRIES = 3


class KisClient:
    def __init__(self, appkey: str | None = None, appsecret: str | None = None):
        self.appkey = appkey or os.environ["KIS_APP_KEY"]
        self.appsecret = appsecret or os.environ["KIS_APP_SECRET"]
        self._token = self._load_or_issue_token()
        self._last_request_time = 0.0

    def _load_or_issue_token(self) -> str:
        if TOKEN_CACHE.exists():
            cached = json.loads(TOKEN_CACHE.read_text(encoding="utf-8"))
            if cached.get("appkey") == self.appkey and cached.get("expires_at", 0) > time.time() + 600:
                return cached["access_token"]

        resp = requests.post(
            f"{BASE_URL}/oauth2/tokenP",
            json={"grant_type": "client_credentials", "appkey": self.appkey, "appsecret": self.appsecret},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        token = data["access_token"]
        TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_CACHE.write_text(json.dumps({
            "appkey": self.appkey,
            "access_token": token,
            "expires_at": time.time() + data.get("expires_in", 86400) - 600,
        }, ensure_ascii=False), encoding="utf-8")
        return token

    def _throttle(self):
        elapsed = time.time() - self._last_request_time
        if elapsed < MIN_REQUEST_INTERVAL:
            time.sleep(MIN_REQUEST_INTERVAL - elapsed)
        self._last_request_time = time.time()

    def _get(self, path: str, tr_id: str, params: dict, label: str) -> dict:
        headers = {
            "authorization": f"Bearer {self._token}",
            "appkey": self.appkey,
            "appsecret": self.appsecret,
            "tr_id": tr_id,
            "custtype": "P",
        }
        last_error = None
        for attempt in range(MAX_RETRIES):
            self._throttle()
            resp = requests.get(f"{BASE_URL}{path}", headers=headers, params=params, timeout=10)
            if resp.status_code == 500 and "초당 거래건수" in resp.text:
                last_error = RuntimeError(f"KIS 초당 요청 제한 초과({label}), 재시도 {attempt + 1}/{MAX_RETRIES}")
                time.sleep(1.0 * (attempt + 1))
                continue
            resp.raise_for_status()
            data = resp.json()
            if data.get("rt_cd") != "0":
                raise RuntimeError(f"KIS API 오류({label}): {data.get('msg1')}")
            return data
        raise last_error

    def inquire_price_integrated(self, ticker: str) -> dict:
        """KRX+NXT 통합(애프터마켓 포함) 현재가/등락률/누적거래대금 조회."""
        data = self._get(
            "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100",
            {"FID_COND_MRKT_DIV_CODE": "UN", "FID_INPUT_ISCD": ticker}, ticker,
        )
        out = data["output"]
        return {
            "close": float(out["stck_prpr"]),
            "change_rate_pct": float(out["prdy_ctrt"]),
            "trading_value_eok": round(float(out["acml_tr_pbmn"]) / 1e8),
            "trading_volume": int(out["acml_vol"]),
        }

    def inquire_daily_prices_integrated(self, ticker: str, start_date: str, end_date: str) -> dict:
        """KRX+NXT 통합 일봉. 날짜(YYYY-MM-DD) → {close, change_rate_pct, trading_value_eok}.

        등락률은 KIS 현재가 API(prdy_ctrt)와 같은 규약(전일 KRX 종가 대비)으로
        전일대비(prdy_vrss)에서 역산한다 — 리포트의 통합 수치와 일치함을 확인함(SK하이닉스 2026-09-18).
        """
        data = self._get(
            "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100",
            {"FID_COND_MRKT_DIV_CODE": "UN", "FID_INPUT_ISCD": ticker,
             "FID_INPUT_DATE_1": start_date, "FID_INPUT_DATE_2": end_date,
             "FID_PERIOD_DIV_CODE": "D", "FID_ORG_ADJ_PRC": "0"},
            ticker,
        )
        result = {}
        for row in data.get("output2") or []:
            d = row.get("stck_bsop_date")
            if not d:
                continue
            close, vrss = float(row["stck_clpr"]), float(row["prdy_vrss"])
            prev = close - vrss
            result[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = {
                "close": close,
                "change_rate_pct": round(vrss / prev * 100, 2) if prev else 0.0,
                "trading_value_eok": round(float(row["acml_tr_pbmn"]) / 1e8),
            }
        return result
