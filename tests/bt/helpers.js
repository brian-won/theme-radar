/*
 * 테스트 공용 도우미 — 손으로 만든 작은 일봉 자료를 설계서 4장 형식 조각으로 바꿔 엔진에 넣는다.
 */
'use strict';
const assert = require('node:assert/strict');
const BT = require('../../dashboard/bt/strategies.js');
const { businessDays } = require('./fixtures/synth.js');

// 봉 표기: 숫자 c → 시가=고가=저가=종가=c(거래대금 100억), [o,h,l,c] 또는 [o,h,l,c,거래대금] 또는 [o,h,l,c,거래대금,등락률], null → 시세 없음(0)
// 등락률을 생략하면 전일 종가 대비로 계산한다.
function toRows(bars, n) {
  const R = { o: [], h: [], l: [], c: [], a: [], chg: [] };
  let pc = 0;
  for (let t = 0; t < n; t++) {
    let b = bars[t];
    if (b == null) { ['o', 'h', 'l', 'c', 'a', 'chg'].forEach(function (f) { R[f].push(0); }); continue; }
    if (typeof b === 'number') b = [b, b, b, b];
    const c = b[3], a = b[4] == null ? 100 : b[4];
    const chg = b[5] != null ? b[5] : (pc > 0 ? Math.round((c / pc - 1) * 10000) / 100 : 0);
    R.o.push(b[0]); R.h.push(b[1]); R.l.push(b[2]); R.c.push(c); R.a.push(a); R.chg.push(chg);
    if (c > 0) pc = c;
  }
  return R;
}

/*
 * mk({ stocks: { A: [봉...], B: [...] }, start, names: {A:'가'}, mkt: {A:'KOSDAQ'}, delisted: {A:{date, why}},
 *      capQ: {A: [[날짜, 억]]}, index: { KOSPI: [종가...], KOSDAQ: [...] }, flow: { A: { frg: [...], ins: [...] } } })
 * → { data, dates, parts }  (일봉·수급은 달 단위 조각으로 잘라 넣어 적재 과정까지 함께 검증)
 */
function mk(spec) {
  const tks = Object.keys(spec.stocks);
  const n = Math.max.apply(null, tks.map(function (k) { return spec.stocks[k].length; }));
  const dates = spec.dates || businessDays(spec.start || '2026-01-05', n);
  const rows = {}; tks.forEach(function (k) { rows[k] = toRows(spec.stocks[k], n); });
  const px = [], flow = [];
  let s = 0;
  for (let t = 1; t <= n; t++) {
    if (t === n || dates[t].slice(0, 7) !== dates[s].slice(0, 7)) {
      const ch = { ym: dates[s].slice(0, 7), dates: dates.slice(s, t), tickers: tks.slice() };
      ['o', 'h', 'l', 'c', 'a', 'chg'].forEach(function (f) { ch[f] = tks.map(function (k) { return rows[k][f].slice(s, t); }); });
      px.push(ch);
      if (spec.flow) {
        const z = function (k, f) { const src = (spec.flow[k] || {})[f] || []; const out = []; for (let u = s; u < t; u++) out.push(src[u] || 0); return out; };
        flow.push({ ym: ch.ym, dates: ch.dates.slice(), tickers: tks.slice(), frg: tks.map(function (k) { return z(k, 'frg'); }), ins: tks.map(function (k) { return z(k, 'ins'); }) });
      }
      s = t;
    }
  }
  const meta = { asOf: dates[n - 1], tickers: {}, capQ: spec.capQ || {}, nameToTicker: {} };
  tks.forEach(function (k) {
    const dl = (spec.delisted || {})[k];
    meta.tickers[k] = { name: (spec.names || {})[k] || k, mkt: (spec.mkt || {})[k] || 'KOSPI', listed: dates[0], delisted: dl ? dl.date : null, delistWhy: dl ? dl.why || null : null };
  });
  let index = null;
  if (spec.index) {
    index = { dates: dates.slice() };
    ['KOSPI', 'KOSDAQ'].forEach(function (nm) { const c = spec.index[nm] || dates.map(function () { return 1000; }); index[nm] = { o: c.slice(), h: c.slice(), l: c.slice(), c: c.slice() }; });
  }
  const parts = { px: px, flow: flow, meta: meta, index: index };
  return { data: BT.buildData(parts), dates: dates, parts: parts };
}

// 대상 종목 조건·시장 필터·주문 한도를 끄고 비용을 0으로 둔 공통 변수(규칙만 보려는 테스트용)
function OFF(extra) {
  return Object.assign({ minCapEok: 0, minAvgValEok: 0, minPrice: 0, mktFilter: 'off', liqCapPct: 100,
    feePct: 0, slipPct: 0, taxMode: 'fixed', taxPct: 0, stopPct: 0, takePct: 0, trailPct: 0, maxHoldDays: 0 }, extra || {});
}

// 정해 준 날에만 사고파는 시험용 기법: buy/sell = { 종목코드: [신호 날짜번호...] }
function scripted(buy, sell, more) {
  return Object.assign({
    key: 'scripted', label: '시험용', params: [],
    prepare: function (ctx) {
      const tk = ctx.data.tickers;
      return {
        entry: function (i, t) { return (buy[tk[i]] || []).indexOf(t) >= 0 ? 1 : NaN; },
        exit: function (pos, t) { return ((sell || {})[tk[pos.i]] || []).indexOf(t) >= 0 ? 1 : 0; }
      };
    }
  }, more || {});
}

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= (eps == null ? 1e-6 : eps), (msg || '') + ' 기대 ' + b + ' 실제 ' + a);
}
// n개짜리 같은 봉
function rep(bar, n) { const out = []; for (let i = 0; i < n; i++) out.push(bar); return out; }

module.exports = { BT: BT, mk: mk, OFF: OFF, scripted: scripted, near: near, rep: rep, toRows: toRows, businessDays: businessDays };
