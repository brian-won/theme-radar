/*
 * 합성 시세 생성기 (테스트·성능 측정용) — 설계서 4장 형식의 조각을 만든다.
 * 실제 시세가 아니다. 같은 seed면 항상 같은 자료가 나온다.
 *   makeSynth({ n, days, seed, start, flow, theme }) → { px:[월 조각], flow:[월 조각], meta, index, dailyDetail, themeParent }
 *   writeSynth(dir, synth) → px_YYYYMM.js, flow_YYYYMM.js, meta.js, index.js 를 window.__bt*( ... ) 한 줄 형식으로 저장
 */
'use strict';
const fs = require('fs');
const path = require('path');

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// 평일만 뽑은 날짜 목록(공휴일은 따지지 않음)
function businessDays(start, n) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function makeSynth(opt) {
  opt = opt || {};
  const N = opt.n || 200, D = opt.days || 500, r = rng(opt.seed || 1);
  const dates = businessDays(opt.start || '2023-11-01', D);

  // ---- 지수 2개: 완만한 추세 + 가끔 급락일 ----
  const idxRet = [new Float64Array(D), new Float64Array(D)];
  const index = { dates: dates.slice(), KOSPI: { o: [], h: [], l: [], c: [] }, KOSDAQ: { o: [], h: [], l: [], c: [] } };
  ['KOSPI', 'KOSDAQ'].forEach(function (nm, q) {
    let c = q === 0 ? 2500 : 850;
    for (let t = 0; t < D; t++) {
      const regime = Math.sin(t / 55 + q) * 0.0012;
      let ret = regime + gauss(r) * (q === 0 ? 0.009 : 0.012);
      if (r() < 0.02) ret -= 0.02 + r() * 0.02; // 급락일
      idxRet[q][t] = ret;
      const o = c * (1 + gauss(r) * 0.003);
      c = c * (1 + ret);
      const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.003), l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.003);
      index[nm].o.push(+o.toFixed(2)); index[nm].h.push(+h.toFixed(2)); index[nm].l.push(+l.toFixed(2)); index[nm].c.push(+c.toFixed(2));
    }
  });

  // ---- 종목 ----
  const tickers = [], meta = { asOf: dates[D - 1], months: [], tickers: {}, capQ: {}, nameToTicker: {} };
  const rows = { o: [], h: [], l: [], c: [], a: [], chg: [], frg: [], ins: [] };
  for (let i = 0; i < N; i++) {
    const tk = String(100000 + i * 7).slice(-6).padStart(6, '0');
    tickers.push(tk);
    const mkt = i % 2, name = '합성종목' + (i + 1);
    const listT = r() < 0.08 ? Math.floor(r() * D * 0.5) : 0;                 // 일부는 기간 중 상장
    const delT = r() < 0.03 ? Math.floor(D * 0.4 + r() * D * 0.5) : -1;       // 일부는 기간 중 상장폐지
    const haltT = r() < 0.05 ? Math.floor(D * 0.2 + r() * D * 0.6) : -1;      // 일부는 며칠 거래정지
    const beta = 0.6 + r() * 1.0, vol = 0.012 + r() * 0.025, drift = (r() - 0.48) * 0.0012;
    const shares = (2 + r() * 60) * 1e6, baseVal = Math.exp(Math.log(8) + gauss(r) * 1.3); // 평균 거래대금(억)
    let c = Math.round(1500 + Math.exp(gauss(r) * 1.0 + 9.5)), hot = 0;
    const O = new Array(D).fill(0), H = new Array(D).fill(0), L = new Array(D).fill(0), C = new Array(D).fill(0), A = new Array(D).fill(0), G = new Array(D).fill(0);
    const FR = new Array(D).fill(0), IN = new Array(D).fill(0);
    const capQ = [];
    let fTrend = 0, iTrend = 0;
    for (let t = listT; t < D; t++) {
      if (delT >= 0 && t >= delT) break;
      if (haltT >= 0 && t >= haltT && t < haltT + 4) { O[t] = H[t] = L[t] = C[t] = c; A[t] = 0; G[t] = 0; continue; }
      const pc = c;
      let ret = drift + beta * idxRet[mkt][t] + gauss(r) * vol;
      if (r() < 0.012) { ret += 0.08 + r() * 0.25; hot = 4; }   // 급등일
      if (r() < 0.004) ret -= 0.08 + r() * 0.25;                 // 급락일
      if (ret > 0.3) ret = 0.3; if (ret < -0.3) ret = -0.3;
      c = Math.max(100, Math.round(pc * (1 + ret)));
      const hiLim = Math.floor(pc * 1.3), loLim = Math.ceil(pc * 0.7);
      if (c > hiLim) c = hiLim; if (c < loLim) c = loLim;
      let o = Math.round(pc * (1 + ret * (0.1 + r() * 0.3) + gauss(r) * 0.004));
      o = Math.min(hiLim, Math.max(loLim, o));
      let h = Math.round(Math.max(o, c) * (1 + Math.abs(gauss(r)) * vol * 0.6)), l = Math.round(Math.min(o, c) * (1 - Math.abs(gauss(r)) * vol * 0.6));
      h = Math.min(hiLim, h); l = Math.max(loLim, l);
      if (c === loLim && r() < 0.5) { o = h = l = c; }         // 가끔 종일 하한가
      O[t] = o; H[t] = h; L[t] = l; C[t] = c;
      G[t] = +((c / pc - 1) * 100).toFixed(2);
      const act = 1 + Math.abs(ret) * 60 + (hot > 0 ? 2 : 0); hot--;
      A[t] = Math.max(1, Math.round(baseVal * act * Math.exp(gauss(r) * 0.5)));
      fTrend = fTrend * 0.7 + gauss(r); iTrend = iTrend * 0.6 + gauss(r);
      FR[t] = +(fTrend * A[t] * 0.04).toFixed(1); IN[t] = +(iTrend * A[t] * 0.03).toFixed(1);
      // 월말 시가총액(억)
      if (t === D - 1 || dates[t + 1].slice(0, 7) !== dates[t].slice(0, 7)) capQ.push([dates[t], Math.round(c * shares / 1e8)]);
    }
    rows.o.push(O); rows.h.push(H); rows.l.push(L); rows.c.push(C); rows.a.push(A); rows.chg.push(G); rows.frg.push(FR); rows.ins.push(IN);
    meta.tickers[tk] = { name: name, mkt: mkt === 0 ? 'KOSPI' : 'KOSDAQ', listed: dates[listT],
      delisted: delT >= 0 && delT < D ? dates[delT] : null, delistWhy: delT >= 0 && delT < D ? (i % 3 === 0 ? '합병' : '폐지') : null };
    meta.capQ[tk] = capQ; meta.nameToTicker[name] = tk;
  }

  // ---- 월 조각으로 자르기 ----
  const months = [], px = [], flow = [];
  let s = 0;
  for (let t = 0; t <= D; t++) {
    if (t === D || (t > 0 && dates[t].slice(0, 7) !== dates[s].slice(0, 7))) {
      const ym = dates[s].slice(0, 7), sl = function (arr) { return arr.map(function (x) { return x.slice(s, t); }); };
      // 그 달에 시세가 하나도 없는 종목은 조각에서 뺀다(상장 전·폐지 후)
      const keep = [];
      for (let i = 0; i < N; i++) { let any = false; for (let u = s; u < t; u++) if (rows.c[i][u] > 0) { any = true; break; } if (any) keep.push(i); }
      const pick = function (arr) { return keep.map(function (i) { return arr[i].slice(s, t); }); };
      px.push({ ym: ym, dates: dates.slice(s, t), tickers: keep.map(function (i) { return tickers[i]; }),
        o: pick(rows.o), h: pick(rows.h), l: pick(rows.l), c: pick(rows.c), a: pick(rows.a), chg: pick(rows.chg) });
      if (opt.flow !== false) flow.push({ ym: ym, dates: dates.slice(s, t), tickers: keep.map(function (i) { return tickers[i]; }), frg: pick(rows.frg), ins: pick(rows.ins) });
      months.push(ym); s = t; void sl;
    }
  }
  meta.months = months;

  // ---- 테마 레이더 흉내(daily_detail_with_reasons.json 형태): 뒤쪽 themeDays일 동안, 그날 +3% 이상 오른 종목 중 거래대금 상위 ----
  const dailyDetail = {}, themeParent = {};
  if (opt.theme !== false) {
    const themeDays = Math.min(opt.themeDays || 210, D - 1);
    for (let n = 0; n < 40; n++) themeParent['세부테마' + n] = '큰틀' + (n % 12);
    for (let t = D - themeDays; t < D; t++) {
      const movers = [];
      for (let i = 0; i < N; i++) if (rows.chg[i][t] >= 3 && rows.a[i][t] >= 5) movers.push(i);
      movers.sort(function (x, y) { return rows.a[y][t] - rows.a[x][t]; });
      const by = {};
      movers.slice(0, 40).forEach(function (i) {
        const th = '세부테마' + (i % 40);
        (by[th] || (by[th] = [])).push({ name: '합성종목' + (i + 1), change: rows.chg[i][t], value: rows.a[i][t], reason: '합성' });
        if (i % 9 === 0) { const th2 = '세부테마' + ((i + 12) % 40); (by[th2] || (by[th2] = [])).push({ name: '합성종목' + (i + 1), change: rows.chg[i][t], value: rows.a[i][t], reason: '합성' }); }
      });
      const groups = Object.keys(by).map(function (th) {
        const st = by[th];
        return { theme: th, stocks: st, sumValue: st.reduce(function (a, x) { return a + x.value; }, 0),
          avgChange: +(st.reduce(function (a, x) { return a + x.change; }, 0) / st.length).toFixed(2), note: '' };
      }).sort(function (a, b) { return b.sumValue - a.sumValue; });
      groups.forEach(function (g, n) { g.rank = n < 3 ? n + 1 : 4; });
      if (groups.length) dailyDetail[dates[t]] = { groups: groups };
    }
  }
  return { px: px, flow: flow, meta: meta, index: index, dailyDetail: dailyDetail, themeParent: themeParent, dates: dates, tickers: tickers };
}

function writeSynth(dir, syn) {
  fs.mkdirSync(dir, { recursive: true });
  syn.px.forEach(function (c) { fs.writeFileSync(path.join(dir, 'px_' + c.ym.replace('-', '') + '.js'), 'window.__btChunk(' + JSON.stringify(c) + ');\n'); });
  syn.flow.forEach(function (c) { fs.writeFileSync(path.join(dir, 'flow_' + c.ym.replace('-', '') + '.js'), 'window.__btFlow(' + JSON.stringify(c) + ');\n'); });
  fs.writeFileSync(path.join(dir, 'meta.js'), 'window.__btMeta(' + JSON.stringify(syn.meta) + ');\n');
  fs.writeFileSync(path.join(dir, 'index.js'), 'window.__btIndex(' + JSON.stringify(syn.index) + ');\n');
  // 테마 흉내 자료(실제 data/*.json과 같은 모양)
  fs.writeFileSync(path.join(dir, 'synth_daily_detail.json'), JSON.stringify(syn.dailyDetail));
  fs.writeFileSync(path.join(dir, 'synth_theme_taxonomy.json'), JSON.stringify({ mapping: syn.themeParent }));
}

module.exports = { makeSynth: makeSynth, writeSynth: writeSynth, businessDays: businessDays, rng: rng };
