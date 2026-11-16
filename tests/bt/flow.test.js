/*
 * 전체 흐름·미래 참조·상식 검사 (설계서 8.2) — 합성 자료(실제 시세 아님) 사용
 *  - 미래 참조: 기준일 뒤의 시세·수급·지수·테마를 모두 바꿔도 기준일까지의 자산곡선과 거래가 한 글자도 달라지지 않아야 한다
 *  - 상식: 현금이 음수가 되지 않고, 최대 보유 수를 넘지 않고, 마지막 자산 = 시작 자금 + 거래 손익 합
 *  - 흐름: 조각 파일로 저장 → 폴더에서 읽기 → 전 기법 기본값 실행 → 요약 형식
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BT, near } = require('./helpers.js');
const { makeSynth, writeSynth, rng } = require('./fixtures/synth.js');
const { loadDir, loadTheme, buildFrameDetail, runDefaults } = require('../../scripts/bt_run.js');

const SYN_OPT = { n: 90, days: 420, seed: 11, themeDays: 160 };
const CUT = 345;                                   // 이 날짜번호까지는 그대로, 그 뒤는 전부 바꾼다
const LOOSE = { minCapEok: 0, minAvgValEok: 0 };   // 작은 합성 자료에서도 거래가 충분히 나오게 대상 조건을 푼다

// 실행 가능한 18개 기법 + 변형 몇 개
// (VCP는 기본값이 까다로워 작은 자료에서는 거래가 거의 없으므로 조건을 풀어서 돌린다)
const OWN = { vcp: { shrink: 1, lastDepthPct: 20, valMult: 1, nearHighPct: 50 } };
const CASES = BT.listStrategies().filter(function (s) { return !s.locked; }).map(function (s) { return { key: s.key, own: OWN[s.key] || {}, common: LOOSE, name: s.no + ' ' + s.label }; })
  .concat([
    { key: 'dualMomentum', own: { assets: 'index', lookM: 3, absTh: 2 }, common: LOOSE, startIdx: 70, name: '20 듀얼 모멘텀(지수 모드)' },   // 월 1회라 검증 구간을 앞당겨 재조정 횟수를 늘림
    { key: 'closeBet', own: { exitMode: 'nextTarget' }, common: Object.assign({ maxHoldDays: 3 }, LOOSE), name: '4 종가 베팅(목표가, 3일)' },
    { key: 'volBreakout', own: { exitMode: 'sameClose' }, common: Object.assign({ mktFilter: 'off' }, LOOSE), name: '1 변동성 돌파(당일 종가)' },
    { key: 'maCross', own: {}, common: Object.assign({ stopPct: 5, takePct: 15, trailPct: 8, maxHoldDays: 20, exitFill: 'close', themeOnly: true, cooldownDays: 3 }, LOOSE), name: '15 이평선 교차(공통 청산 전부 켬)' },
    { key: 'crashSurvivor', own: { exitMode: 'idxRecover', idx: 'either' }, common: LOOSE, name: '17 급락일(지수 회복 후 청산)' },
    { key: 'flowFollow', own: { who: 'both', exitMode: 'either' }, common: LOOSE, name: '19 수급(둘 다, 둘 중 먼저)' }
  ]);

function mutateFuture(syn, cutDate) {
  const r = rng(999);
  syn.px.forEach(function (ch) {
    ch.dates.forEach(function (d, j) {
      if (d <= cutDate) return;
      for (let i = 0; i < ch.tickers.length; i++) {
        if (!(ch.c[i][j] > 0)) continue;
        const f = 0.5 + r() * 1.2, c = Math.max(100, Math.round(ch.c[i][j] * f));
        const o = Math.max(100, Math.round(c * (0.9 + r() * 0.2)));
        ch.o[i][j] = o; ch.c[i][j] = c; ch.h[i][j] = Math.round(Math.max(o, c) * (1 + r() * 0.1)); ch.l[i][j] = Math.round(Math.min(o, c) * (1 - r() * 0.1));
        ch.a[i][j] = Math.round(1 + r() * 800); ch.chg[i][j] = +((r() - 0.5) * 60).toFixed(2);
      }
    });
  });
  syn.flow.forEach(function (ch) {
    ch.dates.forEach(function (d, j) { if (d > cutDate) for (let i = 0; i < ch.tickers.length; i++) { ch.frg[i][j] = +((r() - 0.5) * 40).toFixed(1); ch.ins[i][j] = +((r() - 0.5) * 40).toFixed(1); } });
  });
  syn.index.dates.forEach(function (d, j) {
    if (d <= cutDate) return;
    ['KOSPI', 'KOSDAQ'].forEach(function (nm) { const f = 0.7 + r() * 0.6; ['o', 'h', 'l', 'c'].forEach(function (k) { syn.index[nm][k][j] = +(syn.index[nm][k][j] * f).toFixed(2); }); });
  });
  Object.keys(syn.meta.capQ).forEach(function (tk) { syn.meta.capQ[tk].forEach(function (e) { if (e[0] > cutDate) e[1] = Math.round(e[1] * (0.2 + r() * 3)); }); });
  Object.keys(syn.dailyDetail).forEach(function (d) {
    if (d <= cutDate) return;
    syn.dailyDetail[d].groups.forEach(function (g) { g.stocks.forEach(function (s) { s.value = Math.round(1 + r() * 2000); s.change = +(r() * 25).toFixed(2); }); });
  });
}

let base = null, mut = null;
function setup() {
  if (base) return;
  const a = makeSynth(SYN_OPT), b = makeSynth(SYN_OPT);
  const cutDate = a.dates[CUT];
  mutateFuture(b, cutDate);
  base = { data: BT.buildData(a), extras: { theme: buildFrameDetail(a.dailyDetail, a.themeParent) }, cutDate: cutDate, syn: a };
  mut = { data: BT.buildData(b), extras: { theme: buildFrameDetail(b.dailyDetail, b.themeParent) } };
}

test('미래 참조 검사 준비: 기준일까지의 자료는 같고 그 뒤는 실제로 달라졌다', function () {
  setup();
  const A = base.data, B = mut.data, D = A.D;
  assert.equal(A.D, B.D); assert.equal(A.N, B.N);
  let samePast = true, diffFuture = 0;
  for (let i = 0; i < A.N; i++) for (let t = 0; t < D; t++) {
    const k = i * D + t;
    if (t <= CUT) { if (A.c[k] !== B.c[k] || A.o[k] !== B.o[k] || A.a[k] !== B.a[k] || A.chg[k] !== B.chg[k] || A.frg[k] !== B.frg[k]) samePast = false; }
    else if (A.c[k] !== B.c[k]) diffFuture++;
  }
  assert.ok(samePast);
  assert.ok(diffFuture > 1000);
});

CASES.forEach(function (cs) {
  test('미래 참조 없음 + 상식 검사: ' + cs.name, function () {
    setup();
    const p = { own: cs.own, common: cs.startIdx ? Object.assign({ startDate: base.syn.dates[cs.startIdx] }, cs.common) : cs.common };
    const ra = BT.run(base.data, cs.key, p, base.extras), rb = BT.run(mut.data, cs.key, p, mut.extras);
    const cut = base.cutDate;
    // ---- 기준일까지 자산곡선(자산·현금·보유 수)이 완전히 같다 ----
    const ea = ra.equity.filter(function (e) { return e.d <= cut; }), eb = rb.equity.filter(function (e) { return e.d <= cut; });
    assert.ok(ea.length > 50, '기준일 이전 검증 구간이 너무 짧음');
    assert.equal(JSON.stringify(ea), JSON.stringify(eb));
    // ---- 기준일까지 끝난 거래, 기준일까지 들어간 매수가 완전히 같다 ----
    const done = function (r) { return r.trades.filter(function (t) { return t.outD <= cut && t.why !== 'end'; }); };
    // (거래 내역은 청산 순서로 쌓이므로, 아직 안 끝난 매수까지 비교할 때는 매수일·종목 순으로 정렬해서 본다)
    const ins = function (r) {
      return r.trades.filter(function (t) { return t.inD <= cut; }).map(function (t) { return [t.inD, t.tk, t.inPx, t.amt]; })
        .sort(function (x, y) { return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : (x[1] < y[1] ? -1 : 1)); });
    };
    assert.equal(JSON.stringify(done(ra)), JSON.stringify(done(rb)));
    assert.equal(JSON.stringify(ins(ra)), JSON.stringify(ins(rb)));
    assert.ok(done(ra).length > 0, '기준일 이전에 끝난 거래가 없어 검사가 의미 없음(거래 ' + ra.trades.length + '건)');

    // ---- 상식 검사 ----
    [ra, rb].forEach(function (r) {
      const C = r.params.common, O = r.params.own, st = BT.strategies[cs.key];
      const lim = st.kind === 'rotation' ? (O.assets === 'index' ? 1 : O.topK) : C.maxPositions;
      assert.ok(r.stats.minCash >= -1e-6, '현금이 음수: ' + r.stats.minCash);
      assert.ok(r.stats.maxPositionsSeen <= lim, '최대 보유 수 초과: ' + r.stats.maxPositionsSeen + ' > ' + lim);
      const last = r.equity[r.equity.length - 1];
      const pnl = r.trades.reduce(function (s, t) { return s + t.pnl; }, 0);
      near(last.eq, C.initCash + pnl, 1e-3 * 100, '마지막 자산 = 시작 자금 + 거래 손익 합');   // 0.1원 이내
      const openVal = r.trades.filter(function (t) { return t.why === 'end'; }).reduce(function (s, t) { return s + t.pnl + t.amt * (1 + C.feePct / 100); }, 0);
      near(last.eq, last.cash + openVal, 0.1, '마지막 자산 = 현금 + 평가액');
      r.equity.forEach(function (e) { assert.ok(e.eq > 0 && e.cash >= -1e-6 && e.n <= lim); });
      r.trades.forEach(function (t) {
        assert.ok(t.inD <= t.outD && t.inPx > 0 && t.amt > 0 && t.ret >= -1 - 1e-9, JSON.stringify(t));
        if (t.why !== 'delist') assert.ok(t.outPx > 0, JSON.stringify(t));
        assert.ok(['stop', 'take', 'trail', 'time', 'rule', 'delist', 'end'].indexOf(t.why) >= 0, t.why);
        assert.ok(t.ret < 30, '수익률이 비현실적: ' + JSON.stringify(t));
      });
      // 같은 종목을 겹쳐서 보유한 적이 없다
      const by = {};
      r.trades.forEach(function (t) { (by[t.tk] || (by[t.tk] = [])).push(t); });
      Object.keys(by).forEach(function (tk) {
        const a = by[tk].sort(function (x, y) { return x.inD < y.inD ? -1 : 1; });
        for (let n = 1; n < a.length; n++) assert.ok(a[n].inD >= a[n - 1].outD, tk + ' 중복 보유');
      });
    });
  });
});

test('같은 자료·같은 변수로 다시 돌리면 결과가 같고(지표 재사용), 변수를 바꾸면 달라진다', function () {
  setup();
  const p = { common: LOOSE };
  const a = JSON.stringify(BT.run(base.data, 'maCross', p).metrics), b = JSON.stringify(BT.run(base.data, 'maCross', p).metrics);
  assert.equal(a, b);
  BT.clearCache(base.data);
  assert.equal(JSON.stringify(BT.run(base.data, 'maCross', p).metrics), a);
  const c = JSON.stringify(BT.run(base.data, 'maCross', { common: LOOSE, own: { fastN: 10, slowN: 60 } }).metrics);
  assert.notEqual(a, c);
  // 비용을 올리면 총수익률이 내려간다
  const cheap = BT.run(base.data, 'maCross', { common: Object.assign({ feePct: 0, slipPct: 0, taxMode: 'fixed', taxPct: 0 }, LOOSE) });
  const dear = BT.run(base.data, 'maCross', { common: Object.assign({ feePct: 0.5, slipPct: 0.5 }, LOOSE) });
  assert.ok(cheap.metrics.totalRet > dear.metrics.totalRet);
});

test('전체 흐름: 조각 파일 저장 → 폴더 읽기 → 전 기법 기본값 요약', function () {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-synth-'));
  try {
    writeSynth(dir, base.syn);
    const names = fs.readdirSync(dir);
    assert.ok(names.indexOf('meta.js') >= 0 && names.indexOf('index.js') >= 0 && names.some(function (f) { return /^px_\d{6}\.js$/.test(f); }) && names.some(function (f) { return /^flow_\d{6}\.js$/.test(f); }));
    assert.ok(/^window\.__btChunk\(\{/.test(fs.readFileSync(path.join(dir, names.filter(function (f) { return /^px_/.test(f); })[0]), 'utf8')));
    const ld = loadDir(dir), d = ld.data;
    assert.equal(d.N, base.data.N); assert.equal(d.D, base.data.D);
    ['o', 'h', 'l', 'c', 'a', 'chg', 'frg', 'ins'].forEach(function (f) { assert.deepEqual(d[f], base.data[f], f); });
    assert.deepEqual(d.cap, base.data.cap); assert.deepEqual(d.delistT, base.data.delistT);
    const noFlow = loadDir(dir, { flow: false }).data;
    assert.equal(noFlow.frg, null);
    assert.equal(BT.unavailableReason(noFlow, 'flowFollow'), '종목별 수급 자료 없음');

    const theme = loadTheme(dir);
    assert.deepEqual(theme, JSON.parse(JSON.stringify(base.extras.theme)));
    const out = runDefaults(d, { theme: theme });
    assert.equal(out.order.length, 20);
    assert.deepEqual(Object.keys(out.strategies).sort(), out.order.slice().sort());
    assert.equal(out.strategies.orb.locked, true); assert.equal(out.strategies.orb.lockReason, '분봉 준비 중');
    assert.equal(out.strategies.vwapPullback.locked, true);
    const ran = out.order.filter(function (k) { return !out.strategies[k].locked; });
    assert.equal(ran.length, 18);
    ran.forEach(function (k) {
      const s = out.strategies[k];
      assert.ok(s.metrics && typeof s.metrics.totalRet === 'number' && Array.isArray(s.equityWeekly) && s.equityWeekly.length > 10, k);
      assert.ok(!('trades' in s) && !('equity' in s), k);
      assert.equal(s.dataRange.tickers, d.N);
      assert.deepEqual(JSON.stringify(s.metrics), JSON.stringify(BT.summarize(BT.run(d, k, null, { theme: theme })).metrics), k + ' 재실행 결과 일치');
    });
    assert.ok(JSON.stringify(out).length < 300 * 1024, '요약이 너무 큼');
    // 수급이 없으면 19번만 잠긴다
    const out2 = runDefaults(noFlow, { theme: theme });
    assert.equal(out2.strategies.flowFollow.locked, true);
    assert.equal(out2.order.filter(function (k) { return out2.strategies[k].locked; }).length, 3);
    // 테마가 없으면 13번이 잠긴다
    assert.equal(runDefaults(d, {}).strategies.themeLeader.locked, true);
  } finally {
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
    fs.rmdirSync(dir);
  }
});
