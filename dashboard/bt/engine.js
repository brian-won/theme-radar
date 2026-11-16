/*
 * 백테스트 공통 엔진 (설계서 3장·4장)
 * - 브라우저: 전역 BT 객체 / Node: module.exports. 외부 의존성 없음.
 * - 자료: 월 조각(px_YYYYMM.js 등, 설계서 4장 형식)을 받아 종목×날짜 숫자 배열(Float32Array)로 합친다.
 * - 한 칸의 위치는 k = 종목번호 * D + 날짜번호 (D = 전체 거래일 수).
 * - 기법(strategies.js)은 BT.register()로 등록하고 BT.run()으로 실행한다.
 *
 * 설계서 문구가 모호해 이 파일에서 정한 점(자세한 내용은 각 위치 주석):
 *  [결정1] 거래정지 판정: 거래대금 0 이고 고가=저가인 날(또는 종가 0). 거래대금이 억 단위 정수라 0.5억 미만 거래가 0으로 보일 수 있어 고가=저가 조건을 함께 본다.
 *  [결정2] 거래정지·시가 상한가로 못 산 매수 예약은 취소한다(설계서는 "재개일 시가로 넘김"). 며칠 묵은 신호로 사는 것을 막기 위해서다. 매도 예약은 설계서대로 계속 넘긴다.
 *  [결정3] 보유일: 시가·장중에 산 날은 1일째, 종가에 산 날은 0일째로 센다. maxHoldDays=1 이면 시가 매수 → 다음 날 시가 매도.
 *  [결정4] 'end'(검증 끝까지 보유) 거래는 마지막 종가로 평가만 하고 매도 비용은 빼지 않는다(자산곡선 마지막 값 = 현금 + 평가액 유지).
 *  [결정5] 손절가가 하한가보다 낮은 경우는 저가가 닿을 수 없어 자연히 체결되지 않는다(별도 처리 없음).
 *  [결정6] 시가총액 조건은 "그 달 1일보다 앞선 가장 최근 capQ 값"으로 판정. 값이 없는 종목은 탈락. meta에 capQ가 아예 없으면 조건을 끄고 경고.
 *  [결정7] 주문 한도(liqCapPct)는 체결되는 날의 거래대금 기준. 최소 주문 금액은 1만원(MIN_ORDER_WON).
 *  [결정8] 지수(듀얼 모멘텀 지수 모드)는 가상 종목 2줄(코스피·코스닥)로 붙여 같은 체결 코드로 처리. 거래세 0, 수수료·슬리피지는 적용.
 *  [결정9] 추적 손절(trail)·최대 보유일(time)은 설계서 3.5 표대로 항상 다음 날 시가에 판다(exitFill과 무관).
 *  [결정10] 검증 마지막 날에는 새로 사지 않는다(종가 신호 기법). 사자마자 'end'로 끝나는 거래를 만들지 않기 위해서다.
 */
(function (root, factory) {
  var BT = factory();
  if (typeof module === 'object' && module.exports) module.exports = BT;
  else root.BT = BT;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var BT = { version: '1.0.0', strategies: {}, order: [] };

  // =====================================================================
  // 상수
  // =====================================================================
  // 매도 거래세(%) — 증권거래세 + 농어촌특별세 합계. 코스피·코스닥 합계가 같은 해만 있어 한 값으로 둔다.
  // 출처·확인 상태:
  //   2026년 0.20% (코스피 = 거래세 0.05 + 농특세 0.15, 코스닥 0.20) — 2026-01-01 양도분부터. 세정일보 기사(기재부 개정안)로 확인.
  //   2025년 0.15% (코스피 = 거래세 0 + 농특세 0.15, 코스닥 0.15) — 웹 검색으로 확인.
  //   2024년 0.18%, 2023년 0.20%, 2021~2022년 0.23%, 2020년 0.25% — 기억에 의존한 값. **확인 필요**(국세청·한국거래소 자료로 재확인할 것).
  // 표에 없는 해는 가장 가까운 해의 값을 쓴다. 값을 고칠 때는 여기 한 곳만 고치면 된다.
  var TAX_BY_YEAR = { 2020: 0.25, 2021: 0.23, 2022: 0.23, 2023: 0.20, 2024: 0.18, 2025: 0.15, 2026: 0.20 };
  var LIMIT_PCT = 29.5;          // 상·하한가 판정 등락률(%)
  var LIMIT_UP_MULT = 1.295;     // 전일 종가 대비 상한가 판정 배수
  var MIN_ORDER_WON = 10000;     // 최소 주문 금액
  var INDEX_NAMES = ['KOSPI', 'KOSDAQ'];
  BT.TAX_BY_YEAR = TAX_BY_YEAR;
  BT.LIMIT_PCT = LIMIT_PCT;

  function taxPctOfYear(y) {
    if (TAX_BY_YEAR[y] != null) return TAX_BY_YEAR[y];
    var ys = Object.keys(TAX_BY_YEAR).map(Number).sort(function (a, b) { return a - b; });
    return y < ys[0] ? TAX_BY_YEAR[ys[0]] : TAX_BY_YEAR[ys[ys.length - 1]];
  }
  BT.taxPctOfYear = taxPctOfYear;

  // =====================================================================
  // 지표 계산 알맹이 — 배열 x의 [s, e) 구간을 읽어 out의 같은 위치에 쓴다. 값이 모자란 곳은 NaN.
  // 모두 "t까지의 값"만 쓴다(미래 참조 없음).
  // =====================================================================
  function kSma(x, out, s, e, n) {
    var sum = 0, t;
    for (t = s; t < e; t++) {
      sum += x[t];
      if (t - s >= n) sum -= x[t - n];
      out[t] = (t - s >= n - 1) ? sum / n : NaN;
    }
  }
  // 지수이동평균: 처음 n개의 단순평균으로 시작, 계수 2/(n+1)
  function kEma(x, out, s, e, n) {
    var a = 2 / (n + 1), sum = 0, v = NaN, t;
    for (t = s; t < e; t++) {
      if (t - s < n - 1) { sum += x[t]; out[t] = NaN; }
      else if (t - s === n - 1) { sum += x[t]; v = sum / n; out[t] = v; }
      else { v = v + a * (x[t] - v); out[t] = v; }
    }
  }
  // n일 표준편차(모집단 기준 — 볼린저밴드 표준 정의)
  function kStd(x, out, s, e, n) {
    var t, j, m, q, d;
    for (t = s; t < e; t++) {
      if (t - s < n - 1) { out[t] = NaN; continue; }
      m = 0; for (j = t - n + 1; j <= t; j++) m += x[j];
      m /= n; q = 0;
      for (j = t - n + 1; j <= t; j++) { d = x[j] - m; q += d * d; }
      out[t] = Math.sqrt(q / n);
    }
  }
  // RSI — 와일더 방식. 첫 값은 처음 n개 변화의 단순평균, 이후 (이전×(n−1)+오늘)/n
  function kRsi(x, out, s, e, n) {
    var g = 0, l = 0, t, d, up, dn;
    for (t = s; t < e; t++) {
      if (t === s) { out[t] = NaN; continue; }
      d = x[t] - x[t - 1];
      up = d > 0 ? d : 0; dn = d < 0 ? -d : 0;
      if (t - s <= n) {
        g += up; l += dn;
        if (t - s < n) { out[t] = NaN; continue; }
        g /= n; l /= n;
      } else {
        g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
      }
      out[t] = (l === 0) ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    }
  }
  // 구간 최댓값/최솟값. shift=1이면 당일 제외(HH·LL), 0이면 당일 포함. minP = 필요한 최소 개수.
  function kRoll(x, out, s, e, n, isMax, shift, minP) {
    var cap = n + 2, dq = new Int32Array(cap), head = 0, size = 0, t, j, b, v;
    for (t = s; t < e; t++) {
      j = t - shift;
      if (j < s) { out[t] = NaN; continue; }
      v = x[j];
      while (size > 0) {
        b = dq[(head + size - 1) % cap];
        if (isMax ? x[b] <= v : x[b] >= v) size--; else break;
      }
      dq[(head + size) % cap] = j; size++;
      while (dq[head] < j - n + 1) { head = (head + 1) % cap; size--; }
      out[t] = (j - s + 1 >= minP) ? x[dq[head]] : NaN;
    }
  }
  // 진폭(TR) = max(H−L, |H−전일C|, |L−전일C|), ATR = TR의 n일 단순평균(설계서 5.3)
  function kAtr(h, l, c, out, s, e, n) {
    var tr = new Float64Array(e - s), t, a, b, d, sum = 0;
    for (t = s; t < e; t++) {
      a = h[t] - l[t];
      if (t > s) { b = Math.abs(h[t] - c[t - 1]); d = Math.abs(l[t] - c[t - 1]); if (b > a) a = b; if (d > a) a = d; }
      tr[t - s] = a;
    }
    for (t = s; t < e; t++) {
      sum += tr[t - s];
      if (t - s >= n) sum -= tr[t - s - n];
      out[t] = (t - s >= n - 1) ? sum / n : NaN;
    }
  }

  // ---- 한 줄짜리 수열용(테스트·지수 계산) : 배열을 받아 Float64Array를 돌려준다 ----
  function ser(fn) {
    return function (x) {
      var out = new Float64Array(x.length), args = [x, out, 0, x.length], i;
      for (i = 1; i < arguments.length; i++) args.push(arguments[i]);
      fn.apply(null, args);
      return out;
    };
  }
  var SR = {
    sma: ser(kSma), ema: ser(kEma), std: ser(kStd), rsi: ser(kRsi),
    hh: function (x, n) { var o = new Float64Array(x.length); kRoll(x, o, 0, x.length, n, true, 1, n); return o; },
    ll: function (x, n) { var o = new Float64Array(x.length); kRoll(x, o, 0, x.length, n, false, 1, n); return o; },
    rollMax: function (x, n) { var o = new Float64Array(x.length); kRoll(x, o, 0, x.length, n, true, 0, n); return o; },
    rollMin: function (x, n) { var o = new Float64Array(x.length); kRoll(x, o, 0, x.length, n, false, 0, n); return o; },
    atr: function (h, l, c, n) { var o = new Float64Array(c.length); kAtr(h, l, c, o, 0, c.length, n); return o; },
    stoch: function (h, l, c, kN, kS, dN) {
      var n = c.length, hi = SR.rollMax(h, kN), lo = SR.rollMin(l, kN), raw = new Float64Array(n), K = new Float64Array(n), Dm = new Float64Array(n), t, r;
      for (t = 0; t < n; t++) { r = hi[t] - lo[t]; raw[t] = r > 0 ? (c[t] - lo[t]) / r * 100 : (r === 0 ? 50 : NaN); }
      K.fill(NaN); Dm.fill(NaN);
      if (n >= kN) { kSma(raw, K, kN - 1, n, kS); if (n >= kN + kS - 1) kSma(K, Dm, kN + kS - 2, n, dN); }
      return { K: K, D: Dm };
    },
    macd: function (c, f, sl, sg) {
      var n = c.length, a = SR.ema(c, f), b = SR.ema(c, sl), m = new Float64Array(n), s = new Float64Array(n), t;
      for (t = 0; t < n; t++) m[t] = a[t] - b[t];
      s.fill(NaN);
      if (n >= sl) kEma(m, s, sl - 1, n, sg);
      return { macd: m, signal: s };
    }
  };
  BT.series = SR;

  // =====================================================================
  // 자료 적재 — 조각을 받아 숫자 배열로 옮겨 두었다가 finalize()에서 하나로 합친다
  // =====================================================================
  function createStore() { return { px: {}, flow: {}, meta: null, index: null }; }

  function toMatrix(rows, nT, nD) {
    var m = new Float32Array(nT * nD), j, d, r;
    if (!rows) return m;
    for (j = 0; j < nT; j++) {
      r = rows[j]; if (!r) continue;
      for (d = 0; d < nD; d++) m[j * nD + d] = +r[d] || 0;
    }
    return m;
  }
  // 일봉 조각(설계서 4.1). 원본 객체는 붙잡지 않으므로 호출 뒤 버려도 된다. 같은 달을 다시 넣으면 바꿔치기한다.
  function addChunk(store, ch) {
    var nT = ch.tickers.length, nD = ch.dates.length;
    store.px[ch.ym || ch.dates[0].slice(0, 7)] = {
      dates: ch.dates.slice(), tickers: ch.tickers.slice(),
      o: toMatrix(ch.o, nT, nD), h: toMatrix(ch.h, nT, nD), l: toMatrix(ch.l, nT, nD),
      c: toMatrix(ch.c, nT, nD), a: toMatrix(ch.a, nT, nD), chg: toMatrix(ch.chg, nT, nD)
    };
  }
  // 수급 조각(설계서 4.4)
  function addFlowChunk(store, ch) {
    var nT = ch.tickers.length, nD = ch.dates.length;
    store.flow[ch.ym || ch.dates[0].slice(0, 7)] = {
      dates: ch.dates.slice(), tickers: ch.tickers.slice(),
      frg: toMatrix(ch.frg, nT, nD), ins: toMatrix(ch.ins, nT, nD)
    };
  }
  function setMeta(store, meta) { store.meta = meta; if (meta && meta.index && !store.index) store.index = meta.index; }
  function setIndex(store, idx) { store.index = idx; }
  // 모양을 보고 알아서 분류해 넣는다(조각 파일이 어떤 함수 이름으로 감싸져 있어도 받을 수 있게)
  function receive(store, obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 자료 팀 조각은 모두 window.__btChunk({ kind: 'px'|'flow'|'meta'|'index', ... }) 형식 — kind가 있으면 그대로 따른다
    if (obj.kind === 'px') { addChunk(store, obj); return 'px'; }
    if (obj.kind === 'flow') { addFlowChunk(store, obj); return 'flow'; }
    if (obj.kind === 'meta') { setMeta(store, obj); return 'meta'; }
    if (obj.kind === 'index') { setIndex(store, obj); return 'index'; }
    if (Array.isArray(obj.frg) || Array.isArray(obj.ins)) { addFlowChunk(store, obj); return 'flow'; }
    if (Array.isArray(obj.tickers) && Array.isArray(obj.c)) { addChunk(store, obj); return 'px'; }
    if (obj.tickers && !Array.isArray(obj.tickers)) {
      setMeta(store, obj);
      if (obj.KOSPI || obj.KOSDAQ) setIndex(store, obj);
      return 'meta';
    }
    if (obj.KOSPI || obj.KOSDAQ) { setIndex(store, obj); return 'index'; }
    return null;
  }
  // 브라우저용: <script src="bt/px_202611.js">가 부르는 window.__btChunk 등을 store로 연결
  function installHooks(store, target) {
    target = target || (typeof window !== 'undefined' ? window : globalThis);
    var fn = function (obj) { return receive(store, obj); };
    ['__btChunk', '__btMeta', '__btIndex', '__btFlow'].forEach(function (k) { target[k] = fn; });
    return fn;
  }

  function finalize(store) {
    var yms = Object.keys(store.px).sort();
    if (!yms.length) throw new Error('일봉 조각이 없습니다');
    var dateSet = {}, tkSet = {}, i, j, d, ch, k;
    yms.forEach(function (ym) {
      var c = store.px[ym];
      c.dates.forEach(function (x) { dateSet[x] = 1; });
      c.tickers.forEach(function (x) { tkSet[x] = 1; });
    });
    var dates = Object.keys(dateSet).sort(), tickers = Object.keys(tkSet).sort();
    var D = dates.length, N = tickers.length;
    var dIdx = {}, tkIdx = {};
    dates.forEach(function (x, n) { dIdx[x] = n; });
    tickers.forEach(function (x, n) { tkIdx[x] = n; });
    var hasIndex = !!(store.index && store.index.dates && (store.index.KOSPI || store.index.KOSDAQ));
    var NR = N + (hasIndex ? 2 : 0);
    var F = ['o', 'h', 'l', 'c', 'a', 'chg'];
    var data = { dates: dates, tickers: tickers, D: D, N: N, NR: NR, dIdx: dIdx, tkIdx: tkIdx, hasIndex: hasIndex };
    F.forEach(function (f) { data[f] = new Float32Array(NR * D); });
    yms.forEach(function (ym) {
      var c = store.px[ym], nD = c.dates.length, cols = c.dates.map(function (x) { return dIdx[x]; }), jj, fi, dd;
      for (jj = 0; jj < c.tickers.length; jj++) {
        var base = tkIdx[c.tickers[jj]] * D;
        for (fi = 0; fi < F.length; fi++) {
          var src = c[F[fi]], dst = data[F[fi]];
          for (dd = 0; dd < nD; dd++) dst[base + cols[dd]] = src[jj * nD + dd];
        }
      }
    });

    // ---- 종목 정보 ----
    var meta = store.meta || {}, mt = meta.tickers || {};
    data.asOf = meta.asOf || dates[D - 1];
    data.names = new Array(NR); data.mkt = new Uint8Array(NR);
    data.first = new Int32Array(NR).fill(-1); data.last = new Int32Array(NR).fill(-1);
    data.delistT = new Int32Array(NR).fill(-1); data.delistKeep = new Uint8Array(NR); // 1 = 합병·이전상장(마지막 종가로 청산)
    data.isIndex = new Uint8Array(NR);
    for (i = 0; i < N; i++) {
      var info = mt[tickers[i]] || {};
      data.names[i] = info.name || tickers[i];
      data.mkt[i] = info.mkt === 'KOSDAQ' ? 1 : 0;
    }

    // ---- 지수: 날짜를 맞춰 넣고, 가상 종목 2줄로도 붙인다 [결정8] ----
    data.idx = null;
    if (hasIndex) {
      data.idx = {};
      var imap = {}; store.index.dates.forEach(function (x, n) { imap[x] = n; });
      INDEX_NAMES.forEach(function (nm, q) {
        var src = store.index[nm] || {}, row = N + q, base = row * D, prev = 0, o, h, l, c, n, dd;
        data.names[row] = nm === 'KOSPI' ? '코스피 지수' : '코스닥 지수';
        data.mkt[row] = q; data.isIndex[row] = 1;
        var cc = new Float64Array(D);
        for (dd = 0; dd < D; dd++) {
          n = imap[dates[dd]];
          c = (n != null && src.c) ? +src.c[n] || 0 : 0;
          if (c > 0) {
            o = (src.o && +src.o[n]) || c; h = (src.h && +src.h[n]) || Math.max(o, c); l = (src.l && +src.l[n]) || Math.min(o, c);
            data.o[base + dd] = o; data.h[base + dd] = h; data.l[base + dd] = l; data.c[base + dd] = c;
            data.a[base + dd] = 1e9; data.chg[base + dd] = prev > 0 ? (c / prev - 1) * 100 : 0;
            prev = c;
          }
          cc[dd] = c > 0 ? c : (prev > 0 ? prev : NaN); // 지수 값이 빠진 날은 직전 값
        }
        data.idx[nm] = { c: cc };
      });
    }

    // ---- 빈 칸 정리: 상장 뒤 종가가 0인 날(거래정지·폐지 후)은 직전 종가로 채우고 거래대금 0으로 둔다 ----
    // 자료 끝까지 같은 방식으로 채우므로 "미래에 자료가 있느냐"에 따라 과거 값이 달라지지 않는다.
    var O = data.o, H = data.h, L = data.l, C = data.c, A = data.a, G = data.chg;
    for (i = 0; i < NR; i++) {
      var pc = 0;
      for (d = 0; d < D; d++) {
        k = i * D + d;
        if (C[k] > 0) {
          if (data.first[i] < 0) data.first[i] = d;
          data.last[i] = d;
          if (!(O[k] > 0)) O[k] = C[k];
          if (!(H[k] > 0)) H[k] = Math.max(O[k], C[k]);
          if (!(L[k] > 0)) L[k] = Math.min(O[k], C[k]);
          pc = C[k];
        } else if (pc > 0) {
          O[k] = H[k] = L[k] = C[k] = pc; A[k] = 0; G[k] = 0;
        }
      }
    }
    // ---- 상장폐지: meta에 폐지일이 있는 종목만 폐지로 본다. 처리 시점 = 마지막 시세 뒤, 폐지일 이후 첫 거래일 ----
    var delisted = 0;
    for (i = 0; i < N; i++) {
      var inf = mt[tickers[i]];
      if (!inf || !inf.delisted || data.last[i] < 0) continue;
      delisted++;
      for (d = data.last[i] + 1; d < D; d++) if (dates[d] >= inf.delisted) { data.delistT[i] = d; break; }
      if (inf.delistWhy === '합병' || inf.delistWhy === '이전상장') data.delistKeep[i] = 1;
    }
    data.delisted = delisted;

    // ---- 시가총액(억): 달마다 "그 달 1일보다 앞선 가장 최근 값" [결정6] ----
    var months = [], monthOf = new Int16Array(D);
    for (d = 0; d < D; d++) {
      var ym = dates[d].slice(0, 7);
      if (!months.length || months[months.length - 1] !== ym) months.push(ym);
      monthOf[d] = months.length - 1;
    }
    data.months = months; data.monthOf = monthOf; data.NM = months.length;
    data.cap = null;
    if (meta.capQ && Object.keys(meta.capQ).length) {
      var cap = new Float32Array(NR * months.length);
      for (i = 0; i < N; i++) {
        var q = meta.capQ[tickers[i]]; if (!q || !q.length) continue;
        q = q.slice().sort(function (x, y) { return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0); });
        var p = 0, cur = 0;
        for (var m = 0; m < months.length; m++) {
          var lim = months[m] + '-01';
          while (p < q.length && q[p][0] < lim) { cur = +q[p][1] || 0; p++; }
          cap[i * months.length + m] = cur;
        }
      }
      data.cap = cap;
    }

    // ---- 이름 → 종목코드 (13번 기법용) ----
    var n2t = {};
    for (i = 0; i < N; i++) n2t[data.names[i]] = tickers[i];
    if (meta.nameToTicker) Object.keys(meta.nameToTicker).forEach(function (nm) { n2t[nm] = meta.nameToTicker[nm]; });
    data.nameToTicker = n2t;

    // ---- 종목별 수급 ----
    data.frg = null; data.ins = null;
    var fyms = Object.keys(store.flow).sort();
    data.flowMonths = fyms; // 수급 조각이 있는 달(없는 달은 0으로 채워져 19번 신호가 나지 않는다)
    if (fyms.length) {
      data.frg = new Float32Array(NR * D); data.ins = new Float32Array(NR * D);
      fyms.forEach(function (fym) {
        var c = store.flow[fym], nD = c.dates.length, cols = c.dates.map(function (x) { return dIdx[x]; }), jj, dd;
        for (jj = 0; jj < c.tickers.length; jj++) {
          var ti = tkIdx[c.tickers[jj]]; if (ti == null) continue;
          for (dd = 0; dd < nD; dd++) {
            if (cols[dd] == null) continue;
            data.frg[ti * D + cols[dd]] = c.frg[jj * nD + dd]; data.ins[ti * D + cols[dd]] = c.ins[jj * nD + dd];
          }
        }
      });
    }
    data._ic = {}; data._icKeys = [];
    return data;
  }
  // 한 번에: { px: [조각...], flow: [조각...], meta, index } → data
  function buildData(parts) {
    var st = createStore();
    (parts.px || []).forEach(function (c) { addChunk(st, c); });
    (parts.flow || []).forEach(function (c) { addFlowChunk(st, c); });
    if (parts.meta) setMeta(st, parts.meta);
    if (parts.index) setIndex(st, parts.index);
    return finalize(st);
  }
  BT.createStore = createStore; BT.addChunk = addChunk; BT.addFlowChunk = addFlowChunk;
  BT.setMeta = setMeta; BT.setIndex = setIndex; BT.receive = receive; BT.installHooks = installHooks;
  BT.finalize = finalize; BT.buildData = buildData;

  // =====================================================================
  // 지표 행렬(종목×날짜) — 계산 결과는 data에 보관해 같은 변수로 다시 돌릴 때 재사용한다(최대 40개)
  // =====================================================================
  var IC_MAX = 40;
  function cached(data, key, make) {
    var ic = data._ic;
    if (ic[key]) return ic[key];
    var v = make();
    ic[key] = v; data._icKeys.push(key);
    if (data._icKeys.length > IC_MAX) delete ic[data._icKeys.shift()];
    return v;
  }
  function clearCache(data) { data._ic = {}; data._icKeys = []; }
  function newMat(data) { var m = new Float32Array(data.NR * data.D); m.fill(NaN); return m; }
  function eachRow(data, fn) {
    var D = data.D, i, f;
    for (i = 0; i < data.NR; i++) { f = data.first[i]; if (f >= 0) fn(i * D + f, (i + 1) * D, i); }
  }
  function indicators(data) {
    var I = {};
    function simple(name, kern) {
      I[name] = function (f, n) {
        return cached(data, name + ':' + f + ':' + n, function () {
          var out = newMat(data), x = data[f];
          eachRow(data, function (s, e) { kern(x, out, s, e, n); });
          return out;
        });
      };
    }
    simple('sma', kSma); simple('ema', kEma); simple('std', kStd);
    I.rsi = function (n) {
      return cached(data, 'rsi:' + n, function () {
        var out = newMat(data); eachRow(data, function (s, e) { kRsi(data.c, out, s, e, n); }); return out;
      });
    };
    // HH(n)[t] = max(H[t−n..t−1]), LL(n)[t] = min(L[t−n..t−1]) — 당일 제외, n개가 다 있어야 값이 나온다
    I.hh = function (n) { return I.roll('h', n, true, 1, n); };
    I.ll = function (n) { return I.roll('l', n, false, 1, n); };
    I.roll = function (f, n, isMax, shift, minP) {
      return cached(data, 'roll:' + [f, n, isMax ? 1 : 0, shift, minP].join(':'), function () {
        var out = newMat(data), x = data[f];
        eachRow(data, function (s, e) { kRoll(x, out, s, e, n, isMax, shift, minP); });
        return out;
      });
    };
    I.atr = function (n) {
      return cached(data, 'atr:' + n, function () {
        var out = newMat(data); eachRow(data, function (s, e) { kAtr(data.h, data.l, data.c, out, s, e, n); }); return out;
      });
    };
    // 스토캐스틱: rawK는 당일 포함 kN일 고가·저가 기준, K = SMA(rawK, kS), D = SMA(K, dN)
    I.stoch = function (kN, kS, dN) {
      return cached(data, 'stoch:' + [kN, kS, dN].join(':'), function () {
        var hi = I.roll('h', kN, true, 0, kN), lo = I.roll('l', kN, false, 0, kN);
        var raw = newMat(data), K = newMat(data), Dm = newMat(data), c = data.c, k, n = raw.length, r;
        for (k = 0; k < n; k++) { r = hi[k] - lo[k]; raw[k] = r > 0 ? (c[k] - lo[k]) / r * 100 : (r === 0 ? 50 : NaN); }
        eachRow(data, function (s, e) {
          if (e - s < kN) return;
          kSma(raw, K, s + kN - 1, e, kS);
          if (e - s >= kN + kS - 1) kSma(K, Dm, s + kN + kS - 2, e, dN);
        });
        return { K: K, D: Dm };
      });
    };
    I.macd = function (f, sl, sg) {
      return cached(data, 'macd:' + [f, sl, sg].join(':'), function () {
        var a = I.ema('c', f), b = I.ema('c', sl), m = newMat(data), s = newMat(data), k, n = m.length;
        for (k = 0; k < n; k++) m[k] = a[k] - b[k];
        eachRow(data, function (st, e) { if (e - st >= sl) kEma(m, s, st + sl - 1, e, sg); });
        return { macd: m, signal: s };
      });
    };
    I.custom = function (key, make) { return cached(data, 'x:' + key, make); };
    I.newMat = function () { return newMat(data); };
    I.eachRow = function (fn) { eachRow(data, fn); };
    return I;
  }
  BT.indicators = indicators; BT.clearCache = clearCache;

  // =====================================================================
  // 변수 스키마 도우미
  // =====================================================================
  BT.commonSchema = []; // strategies.js가 채운다(설계서 5.2)
  function commonDefaults() {
    var o = {};
    BT.commonSchema.forEach(function (g) { g.items.forEach(function (it) { o[it.key] = (it.type === 'date') ? null : it.def; }); });
    return o;
  }
  function ownDefaults(strat) {
    var o = {};
    (strat.params || []).forEach(function (it) { o[it.key] = it.def; });
    return o;
  }
  function assign(dst) {
    for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) dst[k] = s[k]; }
    return dst;
  }
  // 우선순위: 공통 기본값 < 기법의 commonDefaults < 사용자가 준 값 < 기법이 고정한 값(fixed)
  function resolveParams(strat, params) {
    if (typeof strat === 'string') strat = BT.strategies[strat];
    params = params || {};
    return {
      common: assign(commonDefaults(), strat.commonDefaults, params.common, strat.fixed),
      own: assign(ownDefaults(strat), params.own)
    };
  }
  function register(strat) {
    if (!BT.strategies[strat.key]) BT.order.push(strat.key);
    BT.strategies[strat.key] = strat;
  }
  // 화면용 기법 목록(잠금 여부 포함)
  function listStrategies() {
    return BT.order.map(function (k) {
      var s = BT.strategies[k];
      return { key: s.key, no: s.no, label: s.label, group: s.group, desc: s.desc || '', needs: s.needs || 'daily',
        locked: !!s.locked, lockReason: s.lockReason || '', sizing: s.sizing || 'weight', notes: s.notes || [],
        params: s.params || [], commonDefaults: s.commonDefaults || {}, fixed: s.fixed || {} };
    });
  }
  // 왕복 비용(%) = 수수료×2 + 거래세 + 슬리피지×2 — 화면 표시용
  function roundTripCostPct(common, year) {
    var tax = common.taxMode === 'fixed' ? +common.taxPct : taxPctOfYear(year || new Date().getFullYear());
    return 2 * (+common.feePct) + tax + 2 * (+common.slipPct);
  }
  BT.commonDefaults = commonDefaults; BT.ownDefaults = ownDefaults; BT.resolveParams = resolveParams;
  BT.register = register; BT.listStrategies = listStrategies; BT.roundTripCostPct = roundTripCostPct;

  // 기법이 필요한 자료가 있는지 — 실행 불가면 사유 문자열, 가능하면 ''
  function unavailableReason(data, strat, extras) {
    if (typeof strat === 'string') strat = BT.strategies[strat];
    if (!strat) return '알 수 없는 기법';
    if (strat.locked) return strat.lockReason || '잠금';
    if (strat.needs === 'flow' && !(data && data.frg)) return '종목별 수급 자료 없음';
    if (strat.needs === 'theme' && !(extras && extras.theme)) return '테마 데이터 없음';
    if (strat.needs === 'index' && !(data && data.idx)) return '지수 자료 없음';
    return '';
  }
  BT.unavailableReason = unavailableReason;

  // =====================================================================
  // 성과 지표(설계서 3.7)
  // eq/bench/cash: 날짜별 값 배열, base/benchBase: 구간 시작 직전 값
  // =====================================================================
  function calcMetrics(dates, eq, cash, bench, trades, base, benchBase, rfPct) {
    var n = eq.length, m = { totalRet: 0, cagr: 0, mdd: 0, mddFrom: '', mddTo: '', winRate: 0, payoff: null, expectancy: 0,
      avgHold: 0, trades: trades.length, openTrades: 0, sharpe: 0, benchRet: null, benchCagr: null, excessCagr: null, excessRet: null, exposure: 0, days: n };
    if (!n) return m;
    m.totalRet = eq[n - 1] / base - 1;
    m.cagr = Math.pow(eq[n - 1] / base, 252 / n) - 1;
    var peak = base, peakD = dates[0], t, dd, sum = 0, sq = 0, prev = base, r, ex = 0;
    for (t = 0; t < n; t++) {
      if (eq[t] > peak) { peak = eq[t]; peakD = dates[t]; }
      dd = eq[t] / peak - 1;
      if (dd < m.mdd) { m.mdd = dd; m.mddFrom = peakD; m.mddTo = dates[t]; }
      r = eq[t] / prev - 1; sum += r; sq += r * r; prev = eq[t];
      ex += eq[t] > 0 ? (eq[t] - cash[t]) / eq[t] : 0;
    }
    m.exposure = ex / n;
    var mean = sum / n, sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : 0;
    m.sharpe = sd > 1e-12 ? (mean - rfPct / 100 / 252) / sd * Math.sqrt(252) : 0;
    var w = 0, ws = 0, l = 0, ls = 0, rs = 0, hs = 0;
    trades.forEach(function (tr) {
      rs += tr.ret; hs += tr.hold;
      if (tr.why === 'end') m.openTrades++;
      if (tr.ret > 0) { w++; ws += tr.ret; } else if (tr.ret < 0) { l++; ls += tr.ret; }
    });
    if (trades.length) {
      m.winRate = w / trades.length; m.expectancy = rs / trades.length; m.avgHold = hs / trades.length;
      m.payoff = (w && l) ? (ws / w) / Math.abs(ls / l) : null;
    }
    if (bench && benchBase > 0 && bench[n - 1] === bench[n - 1]) {
      m.benchRet = bench[n - 1] / benchBase - 1;
      m.benchCagr = Math.pow(bench[n - 1] / benchBase, 252 / n) - 1;
      m.excessCagr = m.cagr - m.benchCagr; m.excessRet = m.totalRet - m.benchRet;
    }
    return m;
  }
  BT.calcMetrics = calcMetrics;

  // 테마 레이더에 처음 등장한 날짜번호(종목별, 없으면 −1) — themeOnly 조건용
  function themeFirstDay(data, theme) {
    var f = new Int32Array(data.NR).fill(-1);
    Object.keys(theme).sort().forEach(function (d) {
      var t = data.dIdx[d]; if (t == null) return;
      (theme[d].groups || []).forEach(function (g) {
        (g.stocks || []).forEach(function (s) {
          var tk = data.nameToTicker[s.name], i = tk != null ? data.tkIdx[tk] : null;
          if (i != null && f[i] < 0) f[i] = t;
        });
      });
    });
    return f;
  }
  BT.themeFirstDay = themeFirstDay;

  // =====================================================================
  // 실행
  //   BT.run(data, 기법키 또는 기법객체, { common: {...}, own: {...} }, { theme: FRAME_DETAIL })
  //   실행할 수 없으면(잠금·자료 없음·변수 오류) Error를 던진다.
  // =====================================================================
  function run(data, strat, params, extras) {
    if (typeof strat === 'string') { var key0 = strat; strat = BT.strategies[strat]; if (!strat) throw new Error('알 수 없는 기법: ' + key0); }
    extras = extras || {};
    var why0 = unavailableReason(data, strat, extras);
    if (why0) throw new Error('실행할 수 없는 기법(' + strat.key + '): ' + why0);
    var rp = resolveParams(strat, params), Cm = rp.common, P = rp.own;
    var D = data.D, N = data.N, dates = data.dates;
    var O = data.o, H = data.h, L = data.l, C = data.c, A = data.a, G = data.chg;
    var warnings = [];
    var t, i, k;

    // ---- 기간 ----
    var startT = -1, endT = -1;
    if (Cm.startDate) { for (t = 0; t < D; t++) if (dates[t] >= Cm.startDate) { startT = t; break; } }
    else {
      startT = D > 270 ? 250 : 0; // 기본 시작 = 자료 시작 + 250거래일(자료가 그보다 짧으면 처음부터)
      var ds = strat.defaultStart ? strat.defaultStart(data, extras) : null; // 기법이 정한 더 늦은 시작일(13번: 테마 데이터 시작일)
      if (ds) for (t = startT; t < D; t++) if (dates[t] >= ds) { startT = t; break; }
    }
    if (Cm.endDate) { for (t = D - 1; t >= 0; t--) if (dates[t] <= Cm.endDate) { endT = t; break; } } else endT = D - 1;
    if (startT < 0 || endT < 0 || startT > endT) throw new Error('검증 기간에 해당하는 거래일이 없습니다');

    // ---- 비용·자금 ----
    var fee = Cm.feePct / 100, slip = Cm.slipPct / 100, weight = Cm.weightPct / 100, liq = Cm.liqCapPct / 100;
    var stopR = Cm.stopPct / 100, takeR = Cm.takePct / 100, trailR = Cm.trailPct / 100, maxHold = Cm.maxHoldDays | 0;
    var delistLoss = Cm.delistLossPct / 100, cooldown = Cm.cooldownDays | 0;
    var maxPos = Cm.maxPositions | 0, maxNew = Cm.maxNewPerDay | 0;
    var taxT = new Float64Array(D);
    for (t = 0; t < D; t++) taxT[t] = (Cm.taxMode === 'fixed' ? Cm.taxPct : taxPctOfYear(+dates[t].slice(0, 4))) / 100;
    var entryClose = Cm.entryFill === 'close', exitCloseFill = Cm.exitFill === 'close';
    if (entryClose) warnings.push('종가 체결 가정 사용(매수): 종가로 신호를 판단하고 그 종가에 산다는 가정이라 실제보다 좋게 나올 수 있음');
    if (exitCloseFill) warnings.push('종가 체결 가정 사용(매도)');

    // ---- 지표·대상 종목 조건·시장 필터 ----
    var I = indicators(data);
    var mktSel = Cm.market === 'KOSPI' ? 0 : (Cm.market === 'KOSDAQ' ? 1 : -1);
    var minCap = +Cm.minCapEok || 0, minAvg = +Cm.minAvgValEok || 0, minPrice = +Cm.minPrice || 0;
    var avgA = minAvg > 0 ? I.sma('a', 20) : null;
    var cap = data.cap, NM = data.NM, monthOf = data.monthOf, mkt = data.mkt;
    if (minCap > 0 && !cap) { warnings.push('시가총액 자료(capQ)가 없어 최소 시가총액 조건을 적용하지 못함'); minCap = 0; }
    var themeFirst = null;
    if (Cm.themeOnly) {
      if (extras.theme) themeFirst = themeFirstDay(data, extras.theme);
      else warnings.push('테마 데이터가 없어 "테마 레이더 등장 종목만" 조건을 적용하지 못함');
    }
    // 대상 종목 조건: t−1까지의 값으로 판정(설계서 3.6)
    function univ(i, t) {
      if (t < 1) return false;
      var k1 = i * D + t - 1, cp = C[k1];
      if (!(cp > 0) || cp < minPrice) return false;
      if (mktSel >= 0 && mkt[i] !== mktSel) return false;
      if (avgA && !(avgA[k1] >= minAvg)) return false;
      if (minCap > 0 && !(cap[i * NM + monthOf[t]] >= minCap)) return false;
      if (themeFirst && !(themeFirst[i] >= 0 && themeFirst[i] <= t - 1)) return false;
      return true;
    }
    // 시장 필터: 지수 종가가 이평선 위(+1)/아래(−1). 종가 신호는 t, 장중 진입은 t−1 값으로 본다.
    var mfMode = Cm.mktFilter === 'above' ? 1 : (Cm.mktFilter === 'below' ? -1 : 0), mfState = null;
    if (mfMode && !data.idx) { warnings.push('지수 자료가 없어 시장 필터를 적용하지 못함'); mfMode = 0; }
    if (mfMode) {
      mfState = INDEX_NAMES.map(function (nm) {
        var c = data.idx[nm].c, ma = SR.sma(c, Cm.mktMaN | 0), st = new Int8Array(D), d;
        for (d = 0; d < D; d++) st[d] = c[d] > ma[d] ? 1 : (c[d] <= ma[d] ? -1 : 0);
        return st;
      });
    }
    var mfFixed = Cm.mktIndex === 'KOSPI' ? 0 : (Cm.mktIndex === 'KOSDAQ' ? 1 : -1);
    function mktOK(i, tt) {
      if (!mfMode) return true;
      if (tt < 0) return false;
      return mfState[mfFixed >= 0 ? mfFixed : mkt[i]][tt] === mfMode;
    }
    function halted(k) { return !(C[k] > 0) || (A[k] <= 0 && H[k] === L[k]); } // [결정1]
    function lockedDown(k) { return O[k] === H[k] && H[k] === L[k] && L[k] === C[k] && G[k] <= -LIMIT_PCT; } // 하루 종일 하한가

    // ---- 기법 준비 ----
    var ctx = { data: data, D: D, N: N, P: P, C: Cm, I: I, extras: extras, warnings: warnings, startT: startT, endT: endT,
      univ: univ, mktOK: mktOK, halted: halted, x: null };
    var S = strat.prepare ? (strat.prepare(ctx) || {}) : {};
    var kind = strat.kind || 'signal';

    // ---- 상태 ----
    var cash = +Cm.initCash, init = cash, positions = [], held = new Uint8Array(data.NR), outT = new Int32Array(data.NR).fill(-100000);
    var trades = [], pendBuys = null, pendSlots = 0; // pendSlots > 0: 회전형(총자산 / 자리 수 균등 배분)
    var nDays = endT - startT + 1, eqA = new Float64Array(nDays), cashA = new Float64Array(nDays), nA = new Int32Array(nDays), benchA = new Float64Array(nDays);
    var maxSeen = 0, minCash = cash;

    function equityNow() { var e = cash, j; for (j = 0; j < positions.length; j++) e += positions[j].qty * positions[j].last; return e; }
    function coolBlocked(i, t) { return cooldown > 0 && t - outT[i] <= cooldown; }

    // 매수 체결: raw = 슬리피지 전 가격. 성공하면 포지션을 돌려준다.
    // 금액 = 총자산 × 비중(회전형은 총자산 / 자리 수), 당일 거래대금 한도와 남은 현금 안에서. 수량은 소수 주 허용.
    function buy(i, t, raw, how, cand, slots) {
      var k = i * D + t, eqN = equityNow();
      var budget = slots ? eqN / slots : eqN * weight;
      if (!data.isIndex[i]) { var lc = A[k] * 1e8 * liq; if (budget > lc) budget = lc; } // [결정7]
      var mc = cash / (1 + fee); if (budget > mc) budget = mc;
      if (!(budget >= MIN_ORDER_WON)) return null;
      var px = raw * (1 + slip), cost = budget * (1 + fee);
      cash -= cost;
      var pos = { i: i, qty: budget / px, inT: t, inPx: px, amt: budget, cost: cost, last: raw, hiC: raw,
        d0: how === 'close' ? t : t - 1,        // 보유일 기준 [결정3]
        stopPx: stopR > 0 ? px * (1 - stopR) : 0, takePx: takeR > 0 ? px * (1 + takeR) : 0,
        pend: null, why: null, x: cand ? cand.x : null, sigT: cand && cand.sigT != null ? cand.sigT : t, how: how, dead: false };
      positions.push(pos); held[i] = 1;
      if (S.onEntry) S.onEntry(pos, t, k);
      return pos;
    }
    function record(pos, t, px, net, why) {
      trades.push({ tk: data.isIndex[pos.i] ? INDEX_NAMES[pos.i - N] : data.tickers[pos.i], name: data.names[pos.i],
        inD: dates[pos.inT], inPx: pos.inPx, outD: dates[t], outPx: px, amt: pos.amt,
        ret: net / pos.cost - 1, pnl: net - pos.cost, hold: t - pos.inT, why: why });
    }
    // 매도 체결: raw = 슬리피지 전 가격. 수수료와 그 해의 거래세를 뗀다.
    function sell(pos, t, raw, why, noSlip) {
      var px = noSlip ? raw : raw * (1 - slip), gross = pos.qty * px;
      var net = gross * (1 - fee - (data.isIndex[pos.i] ? 0 : taxT[t]));
      cash += net;
      record(pos, t, px, net, why);
      pos.dead = true; held[pos.i] = 0; outT[pos.i] = t;
    }
    function sweep() { var w = 0, j; for (j = 0; j < positions.length; j++) if (!positions[j].dead) positions[w++] = positions[j]; positions.length = w; }
    function byScore(a, b) { return (b.score - a.score) || (a.i - b.i); }

    var benchC = data.idx ? data.idx[Cm.bench === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI'].c : null;
    var benchBase = benchC ? (startT > 0 ? benchC[startT - 1] : benchC[startT]) : NaN;
    if (!benchC) warnings.push('지수 자료가 없어 지수 대비 비교를 계산하지 못함');

    for (t = startT; t <= endT; t++) {
      var j, pos, cand, newToday = 0;

      // ---------- 0. 상장폐지: 마지막 종가 × (1 − 손실률), 합병·이전상장은 마지막 종가 ----------
      for (j = 0; j < positions.length; j++) {
        pos = positions[j];
        if (data.delistT[pos.i] >= 0 && t >= data.delistT[pos.i]) {
          sell(pos, t, pos.last * (data.delistKeep[pos.i] ? 1 : 1 - delistLoss), 'delist', true);
        }
      }
      sweep();

      // ---------- 1. 시가 단계: 예약 매도 → 예약 매수 ----------
      for (j = 0; j < positions.length; j++) {
        pos = positions[j];
        if (!pos.pend) continue;
        k = pos.i * D + t;
        if (halted(k) || lockedDown(k)) continue;      // 거래정지·종일 하한가 → 다음 날로 넘김
        sell(pos, t, O[k], pos.pend);
      }
      sweep();
      if (pendBuys) {
        var lim = pendSlots || maxPos, newLim = pendSlots || maxNew;
        for (j = 0; j < pendBuys.length && positions.length < lim && newToday < newLim; j++) {
          cand = pendBuys[j]; i = cand.i; k = i * D + t;
          if (held[i] || halted(k) || coolBlocked(i, t)) continue;
          if (t > 0 && O[k] >= C[k - 1] * LIMIT_UP_MULT) continue; // 시가가 상한가 → 주문 취소
          if (buy(i, t, O[k], 'open', cand, pendSlots)) newToday++;
        }
        pendBuys = null; // 못 산 예약은 취소 [결정2]
      }

      // ---------- 2. 장중 단계: 손절·익절(진입 당일은 판정하지 않음) → 장중 돌파 진입 ----------
      for (j = 0; j < positions.length; j++) {
        pos = positions[j];
        if (pos.inT === t || pos.pend) continue;
        k = pos.i * D + t;
        if (halted(k) || lockedDown(k)) continue;
        if (pos.stopPx > 0 && L[k] <= pos.stopPx) { sell(pos, t, Math.min(pos.stopPx, O[k]), 'stop'); continue; } // 같은 날 둘 다 닿으면 손절 먼저
        var lp = pos.takePx, lw = 'take', sp;
        if (S.limit) { sp = S.limit(pos, t, k); if (sp > 0 && (!(lp > 0) || sp < lp)) { lp = sp; lw = strat.limitWhy || 'take'; } }
        if (lp > 0 && H[k] >= lp) sell(pos, t, Math.max(lp, O[k]), lw);
      }
      sweep();
      if (kind === 'intraday' && S.trigger && t >= 1) {
        var ic = [], trig;
        for (i = 0; i < N; i++) {
          if (held[i]) continue;
          k = i * D + t;
          if (!(C[k - 1] > 0) || halted(k) || !univ(i, t) || !mktOK(i, t - 1) || coolBlocked(i, t)) continue;
          trig = S.trigger(i, t, k);
          if (trig > 0 && H[k] >= trig) ic.push({ i: i, score: S.score ? S.score(i, t, k) : A[k - 1], px: trig > O[k] ? trig : O[k], x: null, sigT: t });
        }
        ic.sort(byScore);
        for (j = 0; j < ic.length && positions.length < maxPos && newToday < maxNew; j++) {
          if (buy(ic[j].i, t, ic[j].px, 'intraday', ic[j], 0)) newToday++;
        }
      }

      // ---------- 3. 종가 단계: 청산 판정 → 진입 판정 ----------
      for (j = 0; j < positions.length; j++) {
        pos = positions[j];
        k = pos.i * D + t;
        var hlt = halted(k);
        if (!hlt) { pos.last = C[k]; if (C[k] > pos.hiC) pos.hiC = C[k]; }
        if (pos.pend) continue;
        var why = null, mode = 0; // mode: 1 = 공통 exitFill, 2 = 당일 종가, 3 = 다음 날 시가
        if (!hlt && S.exit) { mode = S.exit(pos, t, k) | 0; if (mode) why = pos.why || 'rule'; pos.why = null; }
        if (!why && trailR > 0 && !hlt && C[k] <= pos.hiC * (1 - trailR)) { why = 'trail'; mode = 3; }   // [결정9]
        if (!why && maxHold > 0 && !strat.ownTime && t - pos.d0 >= maxHold) { why = 'time'; mode = 3; }
        if (!why) continue;
        if (mode === 1) mode = exitCloseFill ? 2 : 3;
        if (mode === 2 && !hlt && !lockedDown(k)) sell(pos, t, C[k], why);
        else pos.pend = why;
      }
      sweep();

      if (t < endT) { // [결정10]
        if (kind === 'rotation') {
          var rb = S.rebalance ? S.rebalance(t, positions) : null;
          if (rb) {
            (rb.sell || []).forEach(function (p) { if (!p.pend) p.pend = 'rule'; });
            pendSlots = rb.slots; pendBuys = [];
            (rb.buy || []).forEach(function (row, n) { if (!held[row] && mktOK(row, t)) pendBuys.push({ i: row, score: -n, x: null, sigT: t }); });
          }
        } else if (S.entry && (!S.dayGate || S.dayGate(t))) {
          var cs = [], sc;
          for (i = 0; i < N; i++) {
            if (held[i]) continue;
            k = i * D + t;
            if (t < 1 || !(C[k - 1] > 0) || halted(k) || !univ(i, t) || !mktOK(i, t) || coolBlocked(i, t)) continue;
            ctx.x = null;
            sc = S.entry(i, t, k);
            if (sc === sc && sc !== null && sc !== false && sc !== undefined) cs.push({ i: i, score: +sc, x: ctx.x, sigT: t });
          }
          if (cs.length) {
            cs.sort(byScore);
            if (S.maxCand && cs.length > S.maxCand) cs.length = S.maxCand;
            if (entryClose) {
              for (j = 0; j < cs.length && positions.length < maxPos && newToday < maxNew; j++) {
                k = cs[j].i * D + t;
                if (G[k] >= LIMIT_PCT) continue; // 종가가 상한가 → 살 수 없음
                if (buy(cs[j].i, t, C[k], 'close', cs[j], 0)) newToday++;
              }
            } else { pendBuys = cs; pendSlots = 0; }
          }
        }
      }

      // ---------- 4. 평가: 현금 + Σ(수량 × 종가), 거래정지 종목은 마지막 종가 ----------
      var n = t - startT;
      eqA[n] = equityNow(); cashA[n] = cash; nA[n] = positions.length;
      benchA[n] = benchC ? init * benchC[t] / benchBase : NaN;
      if (positions.length > maxSeen) maxSeen = positions.length;
      if (cash < minCash) minCash = cash;
    }

    // ---------- 끝까지 보유한 종목: 마지막 종가로 평가 [결정4] ----------
    for (i = 0; i < positions.length; i++) {
      var p = positions[i];
      record(p, endT, p.last, p.qty * p.last, 'end');
    }

    if (S.finish) S.finish();

    // ---------- 산출물(설계서 3.8) ----------
    var runDates = dates.slice(startT, endT + 1), equity = new Array(nDays);
    for (i = 0; i < nDays; i++) equity[i] = { d: runDates[i], eq: eqA[i], cash: cashA[i], n: nA[i], bench: benchC ? benchA[i] : null };
    var rf = +Cm.rfPct || 0;
    var metrics = calcMetrics(runDates, eqA, cashA, benchC ? benchA : null, trades, init, init, rf);
    var monthly = [], pe = init, pb = init;
    for (i = 0; i < nDays; i++) {
      if (i === nDays - 1 || runDates[i + 1].slice(0, 7) !== runDates[i].slice(0, 7)) {
        monthly.push({ ym: runDates[i].slice(0, 7), ret: eqA[i] / pe - 1, bench: benchC ? benchA[i] / pb - 1 : null });
        pe = eqA[i]; pb = benchA[i];
      }
    }
    if (metrics.trades < 30) warnings.push('거래 수 30건 미만(표본 부족)');
    (strat.notes || []).forEach(function (s) { warnings.push(s); });
    var result = {
      strategy: strat.key, label: strat.label, params: { common: Cm, own: P },
      dataRange: { start: runDates[0], end: runDates[nDays - 1], days: nDays, tickers: N, delisted: data.delisted || 0, asOf: data.asOf },
      metrics: metrics, equity: equity, trades: trades, monthly: monthly, warnings: warnings,
      stats: { maxPositionsSeen: maxSeen, minCash: minCash, roundTripCostPct: roundTripCostPct(Cm, +runDates[nDays - 1].slice(0, 4)) }
    };
    // 앞·뒤 구간 나눠 보기(과최적화 점검)
    if (Cm.splitTest && nDays >= 4) {
      var mid = nDays >> 1, midD = runDates[mid];
      result.split = {
        first: { start: runDates[0], end: runDates[mid - 1], metrics: calcMetrics(runDates.slice(0, mid), eqA.subarray(0, mid), cashA.subarray(0, mid),
          benchC ? benchA.subarray(0, mid) : null, trades.filter(function (x) { return x.outD < midD; }), init, init, rf) },
        second: { start: midD, end: runDates[nDays - 1], metrics: calcMetrics(runDates.slice(mid), eqA.subarray(mid), cashA.subarray(mid),
          benchC ? benchA.subarray(mid) : null, trades.filter(function (x) { return x.outD >= midD; }), eqA[mid - 1], benchA[mid - 1], rf) }
      };
    }
    return result;
  }
  BT.run = run;

  // =====================================================================
  // 요약(비교표·기본값 내장용, 설계서 2.5): 지표 + 주 단위로 줄인 자산곡선. 거래 내역은 뺀다.
  // =====================================================================
  function r4(v) { return (v == null || v !== v) ? null : Math.round(v * 10000) / 10000; }
  function weekKey(d) { // 주 번호(월요일 시작). 1970-01-05가 월요일.
    var ms = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    return Math.floor((ms / 86400000 - 4) / 7);
  }
  function summarize(res) {
    var m = {}, k, wk = [], e = res.equity, i, byWhy = {};
    for (k in res.metrics) m[k] = typeof res.metrics[k] === 'number' ? r4(res.metrics[k]) : res.metrics[k];
    for (i = 0; i < e.length; i++) {
      // 한 주의 마지막 거래일만 남긴다
      if (i === e.length - 1 || weekKey(e[i + 1].d) !== weekKey(e[i].d)) wk.push({ d: e[i].d, eq: Math.round(e[i].eq), bench: e[i].bench == null ? null : Math.round(e[i].bench) });
    }
    res.trades.forEach(function (t) { var b = byWhy[t.why] || (byWhy[t.why] = { n: 0, ret: 0 }); b.n++; b.ret += t.ret; });
    Object.keys(byWhy).forEach(function (w) { byWhy[w].ret = r4(byWhy[w].ret / byWhy[w].n); });
    return { strategy: res.strategy, label: res.label, params: res.params, dataRange: res.dataRange, metrics: m,
      equityWeekly: wk, exitReasons: byWhy, warnings: res.warnings };
  }
  BT.summarize = summarize;

  return BT;
});
