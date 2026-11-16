/*
 * 엔진 규칙 검증 (설계서 8.2) — node --test tests/bt
 * 손으로 만든 작은 자료로 적재·지표·비용·체결 예외·청산·상식 검사를 한다.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { BT, mk, OFF, scripted, near, rep } = require('./helpers.js');
const { parseChunkText, buildFrameDetail } = require('../../scripts/bt_run.js');
const { makeSynth } = require('./fixtures/synth.js');

// ---------------------------------------------------------------- 적재
test('적재: 여러 달 조각을 합치고, 종목 구성이 달라도 날짜·종목이 맞게 들어간다', function () {
  const jan = { ym: '2026-01', dates: ['2026-01-29', '2026-01-30'], tickers: ['000001', '000002'],
    o: [[10, 11], [20, 21]], h: [[12, 13], [22, 23]], l: [[9, 10], [19, 20]], c: [[11, 12], [21, 22]], a: [[5, 6], [7, 8]], chg: [[0, 9.09], [0, 4.76]] };
  const feb = { ym: '2026-02', dates: ['2026-02-02', '2026-02-03'], tickers: ['000002', '000003'],
    o: [[22, 0], [0, 30]], h: [[24, 0], [0, 33]], l: [[21, 0], [0, 29]], c: [[23, 0], [0, 31]], a: [[9, 0], [0, 4]], chg: [[4.55, 0], [0, 0]] };
  const st = BT.createStore();
  assert.equal(BT.receive(st, feb), 'px');   // 순서를 뒤집어 넣어도 된다
  assert.equal(BT.receive(st, jan), 'px');
  assert.equal(BT.receive(st, { asOf: '2026-02-03', tickers: { '000001': { name: '가', mkt: 'KOSDAQ' } } }), 'meta');
  const d = BT.finalize(st);
  assert.deepEqual(d.dates, ['2026-01-29', '2026-01-30', '2026-02-02', '2026-02-03']);
  assert.deepEqual(d.tickers, ['000001', '000002', '000003']);
  assert.equal(d.D, 4); assert.equal(d.N, 3);
  assert.equal(d.c[1 * 4 + 2], 23);           // 000002의 2월 첫날 종가
  assert.equal(d.first[2], 3);                // 000003은 마지막 날 상장
  assert.equal(d.c[2 * 4 + 0], 0);            // 상장 전은 0
  // 시세가 끊긴 뒤(종가 0)는 직전 종가로 채우고 거래대금 0 → 거래정지로 취급
  assert.equal(d.c[0 * 4 + 2], 12); assert.equal(d.a[0 * 4 + 2], 0);
  assert.equal(d.c[1 * 4 + 3], 23); assert.equal(d.a[1 * 4 + 3], 0);
  assert.equal(d.names[0], '가'); assert.equal(d.mkt[0], 1);
  assert.equal(d.nameToTicker['가'], '000001');
});

test('적재: 조각 파일 글자(함수로 감싼 형식·순수 JSON)를 읽는다', function () {
  const obj = { ym: '2026-01', dates: ['2026-01-02'], tickers: ['000001'], o: [[1]], h: [[1]], l: [[1]], c: [[1]], a: [[1]], chg: [[0]] };
  // (다른 실행 환경에서 만든 객체라 글자로 바꿔 비교한다)
  const same = function (text) { assert.equal(JSON.stringify(parseChunkText(text)), JSON.stringify([obj])); };
  same('window.__btChunk(' + JSON.stringify(obj) + ');');
  same('__btChunk(' + JSON.stringify(obj) + ')');
  same(JSON.stringify(obj));
  same('window.__btAnything(' + JSON.stringify(obj) + ');');
});

test('적재: 시가총액은 그 달 1일보다 앞선 가장 최근 값만 쓴다(전월 말 값)', function () {
  const m = mk({ stocks: { A: rep(100, 15) }, start: '2026-01-20', capQ: { A: [['2025-12-30', 500], ['2026-01-30', 2000], ['2026-02-27', 9000]] } });
  const d = m.data, jan = d.monthOf[0], feb = d.monthOf[d.D - 1];
  assert.notEqual(jan, feb);
  assert.equal(d.cap[0 * d.NM + jan], 500);
  assert.equal(d.cap[0 * d.NM + feb], 2000);
});

// ---------------------------------------------------------------- 지표
test('지표: 손 계산 값과 일치', function () {
  const S = BT.series;
  assert.deepEqual(Array.from(S.sma([1, 2, 3, 4, 5], 3)), [NaN, NaN, 2, 3, 4]);
  // EMA(3): 처음 3개 평균 2에서 시작, 계수 0.5 → 3, 4
  assert.deepEqual(Array.from(S.ema([1, 2, 3, 4, 5], 3)), [NaN, NaN, 2, 3, 4]);
  // 모집단 표준편차: [2,4,4,4,5,5,7,9] → 2
  near(S.std([2, 4, 4, 4, 5, 5, 7, 9], 8)[7], 2);
  // RSI(2) 와일더: 변화 +1,+1,−1,+2 → 100, 50, 83.333
  const r = S.rsi([10, 11, 12, 11, 13], 2);
  assert.ok(isNaN(r[1])); near(r[2], 100); near(r[3], 50); near(r[4], 100 - 100 / (1 + 1.25 / 0.25));
  // HH·LL은 당일 제외
  assert.deepEqual(Array.from(S.hh([1, 3, 2, 5, 4], 2)), [NaN, NaN, 3, 3, 5]);
  assert.deepEqual(Array.from(S.ll([5, 3, 4, 1, 2], 2)), [NaN, NaN, 3, 3, 1]);
  assert.deepEqual(Array.from(S.rollMax([1, 3, 2, 5, 4], 2)), [NaN, 3, 3, 5, 5]);
  // ATR(2): TR = 2, 3, 2 → 2.5, 2.5
  const atr = S.atr([10, 12, 13], [8, 9, 11], [9, 11, 12], 2);
  near(atr[1], 2.5); near(atr[2], 2.5);
  // 스토캐스틱(3,1,2): rawK = 100, 50 → D = 75
  const st = S.stoch([10, 11, 12, 13], [8, 9, 10, 11], [9, 10, 12, 11], 3, 1, 2);
  near(st.K[2], 100); near(st.K[3], 50); near(st.D[3], 75);
  // MACD(2,3,2): macd = EMA2 − EMA3, signal = macd의 EMA2(3번째 값부터)
  const c = [10, 11, 13, 12, 15, 14], mc = S.macd(c, 2, 3, 2), e2 = S.ema(c, 2), e3 = S.ema(c, 3);
  near(mc.macd[4], e2[4] - e3[4]);
  near(mc.signal[3], (mc.macd[2] + mc.macd[3]) / 2);
  near(mc.signal[4], mc.signal[3] + (2 / 3) * (mc.macd[4] - mc.signal[3]));
});

test('지표: 종목×날짜 행렬 계산이 한 줄 계산과 같고, 상장 전 구간은 NaN', function () {
  const bars = [null, null, null].concat([100, 102, 101, 105, 107, 104, 108, 111, 109, 113].map(function (c) { return [c - 1, c + 2, c - 2, c]; }));
  const m = mk({ stocks: { A: bars, B: rep(50, 13) } }), d = m.data, I = BT.indicators(d);
  const c = bars.slice(3).map(function (b) { return b[3]; }), h = bars.slice(3).map(function (b) { return b[1]; }), l = bars.slice(3).map(function (b) { return b[2]; });
  const sma = I.sma('c', 3), rsi = I.rsi(2), hh = I.hh(3), atr = I.atr(3), s1 = BT.series.sma(c, 3), r1 = BT.series.rsi(c, 2), h1 = BT.series.hh(h, 3), a1 = BT.series.atr(h, l, c, 3);
  assert.ok(isNaN(sma[0]) && isNaN(sma[4]));
  for (let t = 0; t < c.length; t++) {
    const k = 0 * d.D + 3 + t;
    [[sma[k], s1[t]], [rsi[k], r1[t]], [hh[k], h1[t]], [atr[k], a1[t]]].forEach(function (p) {
      if (isNaN(p[1])) assert.ok(isNaN(p[0])); else near(p[0], p[1], 1e-3);
    });
  }
});

// ---------------------------------------------------------------- 비용
// 자료: 1일 종가 신호 → 2일 시가 1,000원 매수, 4일 종가 청산 신호 → 5일 시가 1,100원 매도
const COST_BARS = [1000, 1000, [1000, 1010, 990, 1000], 1050, 1080, [1100, 1100, 1090, 1095], 1095];

test('비용: 손 계산과 원 단위까지 일치(수수료 0.015%, 슬리피지 0.1%, 거래세 0.2%)', function () {
  const m = mk({ stocks: { A: COST_BARS } });
  const res = BT.run(m.data, scripted({ A: [1] }, { A: [4] }), { common: OFF({ feePct: 0.015, slipPct: 0.1, taxMode: 'fixed', taxPct: 0.2, startDate: m.dates[0] }) });
  assert.equal(res.trades.length, 1);
  const tr = res.trades[0];
  // 매수: 예산 = 1,000만 × 10% = 1,000,000원, 체결가 1,000 × 1.001 = 1,001원, 수량 999.000999주, 나간 돈 1,000,150원
  near(tr.inPx, 1001, 1e-9); near(tr.amt, 1000000, 1e-6);
  // 매도: 체결가 1,100 × 0.999 = 1,098.9원, 대금 1,097,802.1978원, 수수료+세금 0.215% → 받은 돈 1,095,441.9231원
  near(tr.outPx, 1098.9, 1e-9);
  assert.equal(Math.round(tr.pnl), 95292);               // 1,095,441.92 − 1,000,150
  near(tr.ret, 1095441.9230769 / 1000150 - 1, 1e-9);
  assert.equal(tr.inD, m.dates[2]); assert.equal(tr.outD, m.dates[5]); assert.equal(tr.hold, 3); assert.equal(tr.why, 'rule');
  const last = res.equity[res.equity.length - 1];
  assert.equal(Math.round(last.eq), 10095292);
  assert.equal(last.eq, last.cash);
  near(res.stats.roundTripCostPct, 0.015 * 2 + 0.2 + 0.1 * 2, 1e-12);
});

test('비용: 0으로 두면 가격 변화율 그대로, 비용을 넣으면 그만큼 줄어든다', function () {
  const m = mk({ stocks: { A: COST_BARS } }), st = scripted({ A: [1] }, { A: [4] });
  const zero = BT.run(m.data, st, { common: OFF({ startDate: m.dates[0] }) });
  near(zero.trades[0].ret, 0.10, 1e-12);
  near(zero.metrics.totalRet, 0.10 * 0.10, 1e-12);      // 비중 10% × 수익 10%
  const fee = BT.run(m.data, st, { common: OFF({ startDate: m.dates[0], feePct: 0.5 }) });
  near(fee.trades[0].ret, 1.1 * (1 - 0.005) / (1 + 0.005) - 1, 1e-12);
  assert.ok(fee.trades[0].ret < zero.trades[0].ret);
});

test('비용: 연도별 거래세 — 2025년 0.15%, 2026년 0.20%', function () {
  [['2025-03-03', 0.0015], ['2026-03-02', 0.0020]].forEach(function (p) {
    const m = mk({ stocks: { A: COST_BARS }, start: p[0] });
    const res = BT.run(m.data, scripted({ A: [1] }, { A: [4] }), { common: OFF({ taxMode: 'byYear', startDate: m.dates[0] }) });
    near(res.trades[0].ret, 1.1 * (1 - p[1]) - 1, 1e-12);
  });
  assert.equal(BT.taxPctOfYear(2030), BT.TAX_BY_YEAR[2026]); // 표에 없는 해는 가장 가까운 해
});

// ---------------------------------------------------------------- 체결 예외
test('상한가: 다음 날 시가가 상한가면 매수 취소', function () {
  const m = mk({ stocks: { A: [1000, 1000, [1300, 1300, 1300, 1300], 1300, 1300] } });
  const res = BT.run(m.data, scripted({ A: [1] }), { common: OFF({ startDate: m.dates[0] }) });
  assert.equal(res.trades.length, 0);
});

test('상한가: 종가 체결인데 종가가 상한가면 매수 취소, 아니면 체결', function () {
  const up = mk({ stocks: { A: [1000, [1000, 1300, 1000, 1300], 1300, 1300] } });
  assert.equal(BT.run(up.data, scripted({ A: [1] }), { common: OFF({ entryFill: 'close', startDate: up.dates[0] }) }).trades.length, 0);
  const ok = mk({ stocks: { A: [1000, [1000, 1200, 1000, 1200], 1200, 1200] } });
  const res = BT.run(ok.data, scripted({ A: [1] }), { common: OFF({ entryFill: 'close', startDate: ok.dates[0] }) });
  assert.equal(res.trades.length, 1); assert.equal(res.trades[0].inD, ok.dates[1]); assert.equal(res.trades[0].inPx, 1200);
});

test('하한가: 하루 종일 하한가인 날은 못 팔고 다음 날 시가로 넘어간다', function () {
  // 2일 시가 매수, 2일 종가 청산 신호 → 3일은 종일 하한가(시=고=저=종, −30%) → 4일 시가 500원에 매도
  const m = mk({ stocks: { A: [1000, 1000, 1000, [700, 700, 700, 700, 50, -30], [500, 520, 480, 500], 500] } });
  const res = BT.run(m.data, scripted({ A: [1] }, { A: [2] }), { common: OFF({ startDate: m.dates[0] }) });
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].outD, m.dates[4]); assert.equal(res.trades[0].outPx, 500);
});

test('거래정지: 거래대금 0인 날은 체결 없이 넘기고, 재개일 시가에 판다. 평가는 마지막 종가', function () {
  const m = mk({ stocks: { A: [1000, 1000, 1000, [1000, 1000, 1000, 1000, 0], [1000, 1000, 1000, 1000, 0], [900, 910, 890, 900], 900] } });
  const res = BT.run(m.data, scripted({ A: [1] }, { A: [2] }), { common: OFF({ startDate: m.dates[0] }) });
  assert.equal(res.trades[0].outD, m.dates[5]); assert.equal(res.trades[0].outPx, 900); assert.equal(res.trades[0].hold, 3);
  assert.equal(res.equity[3].eq, 10000000);   // 정지 중에는 마지막 종가(1,000원)로 평가
  assert.equal(res.equity[3].n, 1);
});

test('거래정지: 다음 날이 거래정지면 매수 예약은 취소된다', function () {
  const m = mk({ stocks: { A: [1000, 1000, [1000, 1000, 1000, 1000, 0], 1000, 1000] } });
  assert.equal(BT.run(m.data, scripted({ A: [1] }), { common: OFF({ startDate: m.dates[0] }) }).trades.length, 0);
});

test('상장폐지: 기본은 마지막 종가의 100% 손실, 합병은 마지막 종가로 청산', function () {
  const bars = [1000, 1000, 1000, 1000, null, null, null], other = rep(500, 7);
  const dates = mk({ stocks: { B: other } }).dates;
  const dl = mk({ stocks: { A: bars, B: other }, delisted: { A: { date: dates[4], why: '폐지' } } });
  const r1 = BT.run(dl.data, scripted({ A: [1] }), { common: OFF({ startDate: dates[0] }) });
  assert.equal(r1.trades.length, 1);
  assert.equal(r1.trades[0].why, 'delist'); assert.equal(r1.trades[0].outD, dates[4]);
  near(r1.trades[0].ret, -1, 1e-12);
  near(r1.equity[6].eq, 9000000, 1e-6);       // 10% 넣은 돈을 전부 잃음
  assert.equal(r1.dataRange.delisted, 1);
  const half = BT.run(dl.data, scripted({ A: [1] }), { common: OFF({ startDate: dates[0], delistLossPct: 50 }) });
  near(half.trades[0].ret, -0.5, 1e-12);
  const mg = mk({ stocks: { A: bars, B: other }, delisted: { A: { date: dates[4], why: '합병' } } });
  const r2 = BT.run(mg.data, scripted({ A: [1] }), { common: OFF({ startDate: dates[0] }) });
  assert.equal(r2.trades[0].why, 'delist'); near(r2.trades[0].ret, 0, 1e-12);
});

// ---------------------------------------------------------------- 공통 청산
function stopRun(bars, common) {
  const m = mk({ stocks: { A: bars } });
  return { res: BT.run(m.data, scripted({ A: [1] }), { common: OFF(Object.assign({ startDate: m.dates[0] }, common)) }), dates: m.dates };
}

test('손절: 장중에 손절가에 닿으면 손절가에, 갭 하락이면 시가에 체결', function () {
  // 2일 시가 1,000원 매수, 손절 5% → 950원
  let r = stopRun([1000, 1000, 1000, [990, 995, 940, 960], 960], { stopPct: 5 });
  assert.equal(r.res.trades[0].why, 'stop'); assert.equal(r.res.trades[0].outPx, 950); assert.equal(r.res.trades[0].outD, r.dates[3]);
  r = stopRun([1000, 1000, 1000, [900, 920, 880, 910], 910], { stopPct: 5 });
  assert.equal(r.res.trades[0].why, 'stop'); assert.equal(r.res.trades[0].outPx, 900);
});

test('손절: 진입 당일에는 판정하지 않는다', function () {
  const r = stopRun([1000, 1000, [1000, 1000, 900, 990], 990, 990], { stopPct: 5 });
  assert.equal(r.res.trades.length, 1);
  assert.equal(r.res.trades[0].why, 'end');   // 진입일 저가 900은 무시, 이후로는 950에 닿지 않음
});

test('익절: 익절가에 닿으면 익절가에, 갭 상승이면 시가에. 같은 날 손절·익절 모두 닿으면 손절', function () {
  let r = stopRun([1000, 1000, 1000, [1010, 1120, 1005, 1100], 1100], { takePct: 10 });
  assert.equal(r.res.trades[0].why, 'take'); near(r.res.trades[0].outPx, 1100, 1e-9);
  r = stopRun([1000, 1000, 1000, [1150, 1160, 1140, 1150], 1150], { takePct: 10 });
  assert.equal(r.res.trades[0].why, 'take'); assert.equal(r.res.trades[0].outPx, 1150);
  r = stopRun([1000, 1000, 1000, [1000, 1120, 940, 1000], 1000], { takePct: 10, stopPct: 5 });
  assert.equal(r.res.trades[0].why, 'stop'); assert.equal(r.res.trades[0].outPx, 950);
});

test('최대 보유일: 시가 매수일을 1일째로 세어 N일째 종가 뒤 다음 날 시가에 판다', function () {
  const r = stopRun([1000, 1000, 1000, 1010, 1020, [1030, 1040, 1020, 1030], 1040, 1050], { maxHoldDays: 3 });
  assert.equal(r.res.trades[0].why, 'time');
  assert.equal(r.res.trades[0].inD, r.dates[2]); assert.equal(r.res.trades[0].outD, r.dates[5]); assert.equal(r.res.trades[0].outPx, 1030);
  assert.equal(r.res.trades[0].hold, 3);
});

test('추적 손절: 진입 후 최고 종가 대비 하락률에 닿으면 다음 날 시가에 판다', function () {
  // 최고 종가 1,200 → 10% 아래 1,080 이하로 마감한 5일 다음 날(6일) 시가 1,070에 매도
  const r = stopRun([1000, 1000, 1000, 1100, 1200, 1080, [1070, 1075, 1060, 1065], 1065], { trailPct: 10 });
  assert.equal(r.res.trades[0].why, 'trail'); assert.equal(r.res.trades[0].outD, r.dates[6]); assert.equal(r.res.trades[0].outPx, 1070);
});

test('매도 체결을 당일 종가로 바꾸면 기법 청산 신호일 종가에 판다', function () {
  const m = mk({ stocks: { A: COST_BARS } });
  const res = BT.run(m.data, scripted({ A: [1] }, { A: [4] }), { common: OFF({ exitFill: 'close', startDate: m.dates[0] }) });
  assert.equal(res.trades[0].outD, m.dates[4]); assert.equal(res.trades[0].outPx, 1080);
  assert.ok(res.warnings.some(function (w) { return w.indexOf('종가 체결') >= 0; }));
});

// ---------------------------------------------------------------- 자금 관리
test('자금: 종목당 비중·최대 보유 수·하루 신규 한도·점수 순서·주문 한도·재매수 금지', function () {
  const stocks = {}; ['A', 'B', 'C', 'D'].forEach(function (k) { stocks[k] = rep(1000, 8); });
  const m = mk({ stocks: stocks });
  // 점수: D > C > B > A 순으로 준다
  const st = { key: 's', label: 's', params: [], prepare: function (ctx) { return { entry: function (i, t) { return t === 1 ? i : NaN; } }; } };
  let res = BT.run(m.data, st, { common: OFF({ startDate: m.dates[0], maxPositions: 3, maxNewPerDay: 2, weightPct: 30 }) });
  assert.deepEqual(res.trades.map(function (t) { return t.tk; }).sort(), ['C', 'D']);     // 하루 2종목까지, 점수 높은 순
  near(res.trades[0].amt, 3000000, 1e-6);
  res = BT.run(m.data, st, { common: OFF({ startDate: m.dates[0], maxPositions: 3, maxNewPerDay: 5, weightPct: 40 }) });
  assert.equal(res.trades.length, 3);                                                    // 최대 3종목
  near(res.trades[2].amt, 2000000, 1e-6);                                                // 세 번째는 남은 현금만큼만
  assert.ok(res.stats.minCash >= -1e-6);
  assert.equal(res.stats.maxPositionsSeen, 3);
  // 주문 한도: 당일 거래대금 100억의 0.01% = 100만원
  res = BT.run(m.data, st, { common: OFF({ startDate: m.dates[0], liqCapPct: 0.01, weightPct: 30 }) });
  near(res.trades[0].amt, 1000000, 1e-3);
  // 재매수 금지: 2일 매수 → 3일 종가 신호로 4일 시가 매도. 4일 종가의 재매수 신호는 금지일 3일 안이라 무시된다
  const again = scripted({ A: [1, 4] }, { A: [3] });
  assert.equal(BT.run(m.data, again, { common: OFF({ startDate: m.dates[0] }) }).trades.length, 2);
  assert.equal(BT.run(m.data, again, { common: OFF({ startDate: m.dates[0], cooldownDays: 3 }) }).trades.length, 1);
});

test('대상 종목 조건: 전일까지 값으로 시장·주가·평균 거래대금·시가총액을 거른다', function () {
  const stocks = { A: rep([1000, 1000, 1000, 1000, 10], 30), B: rep([500, 500, 500, 500, 100], 30), C: rep([1000, 1000, 1000, 1000, 100], 30) };
  const m = mk({ stocks: stocks, start: '2026-01-05', mkt: { C: 'KOSDAQ' }, capQ: { A: [['2025-12-30', 5000]], B: [['2025-12-30', 5000]], C: [['2025-12-30', 200]] } });
  const st = { key: 's', label: 's', params: [], prepare: function () { return { entry: function (i, t) { return t === 25 ? 1 : NaN; } }; } };
  const tk = function (common) { return BT.run(m.data, st, { common: OFF(Object.assign({ startDate: m.dates[0] }, common)) }).trades.map(function (t) { return t.tk; }).sort(); };
  assert.deepEqual(tk({}), ['A', 'B', 'C']);
  assert.deepEqual(tk({ minAvgValEok: 50 }), ['B', 'C']);
  assert.deepEqual(tk({ minPrice: 800 }), ['A', 'C']);
  assert.deepEqual(tk({ minCapEok: 1000 }), ['A', 'B']);
  assert.deepEqual(tk({ market: 'KOSDAQ' }), ['C']);
});

test('시장 필터: 지수가 이평선 위일 때만(또는 아래일 때만) 산다', function () {
  const idx = [100, 100, 100, 100, 100, 110, 110, 110, 90, 90, 90, 90];
  const m = mk({ stocks: { A: rep(1000, 12) }, index: { KOSPI: idx, KOSDAQ: idx } });
  const days = function (filter) {
    const st = { key: 's', label: 's', params: [], prepare: function () { return { entry: function (i, t) { return 1; }, exit: function () { return 2; } }; } };
    const res = BT.run(m.data, st, { common: OFF({ startDate: m.dates[0], mktFilter: filter, mktMaN: 3, entryFill: 'close' }) });
    return res.trades.map(function (t) { return m.dates.indexOf(t.inD); });
  };
  // 3일 이평선: 5일(110 > 103.3), 6일(110 > 106.7)만 위. 7일은 110 = 110 이라 위가 아님
  assert.deepEqual(days('above'), [5, 6]);
  assert.deepEqual(days('below'), [2, 3, 4, 7, 8, 9, 10]);
});

// ---------------------------------------------------------------- 산출물·지표
test('산출물: 형식(설계서 3.8)과 성과 지표 정의', function () {
  const idx = [100, 100, 100, 101, 102, 103, 104];
  const m = mk({ stocks: { A: COST_BARS }, index: { KOSPI: idx, KOSDAQ: idx } });
  const res = BT.run(m.data, scripted({ A: [1] }, { A: [4] }), { common: OFF({ startDate: m.dates[1], splitTest: true }) });
  ['strategy', 'params', 'dataRange', 'metrics', 'equity', 'trades', 'monthly', 'warnings'].forEach(function (k) { assert.ok(k in res, k); });
  ['totalRet', 'cagr', 'mdd', 'mddFrom', 'mddTo', 'winRate', 'payoff', 'expectancy', 'avgHold', 'trades', 'sharpe', 'benchCagr', 'excessCagr', 'exposure'].forEach(function (k) { assert.ok(k in res.metrics, k); });
  ['tk', 'name', 'inD', 'inPx', 'outD', 'outPx', 'amt', 'ret', 'hold', 'why'].forEach(function (k) { assert.ok(k in res.trades[0], k); });
  ['d', 'eq', 'cash', 'n', 'bench'].forEach(function (k) { assert.ok(k in res.equity[0], k); });
  assert.equal(res.equity.length, 6);
  near(res.metrics.totalRet, 0.01, 1e-12);
  near(res.metrics.cagr, Math.pow(1.01, 252 / 6) - 1, 1e-12);
  near(res.metrics.benchRet, 0.04, 1e-12);                 // 지수 100 → 104 (시작 전날 기준)
  near(res.metrics.excessRet, 0.01 - 0.04, 1e-12);
  assert.equal(res.metrics.winRate, 1); assert.equal(res.metrics.trades, 1); assert.equal(res.metrics.avgHold, 3);
  near(res.metrics.expectancy, 0.10, 1e-12);
  // 자산: 2일 시가 1,000 매수 → 종가 1,000 / 1,050 / 1,080 → 5일 시가 1,100 매도
  near(res.equity[2].eq, 10050000, 1e-6); near(res.equity[3].eq, 10080000, 1e-6); near(res.equity[4].eq, 10100000, 1e-6);
  near(res.metrics.exposure, (1000000 / 10000000 + 1050000 / 10050000 + 1080000 / 10080000) / 6, 1e-12);
  assert.ok(res.split && res.split.first.metrics.days === 3 && res.split.second.metrics.days === 3);
  assert.ok(res.warnings.some(function (w) { return w.indexOf('30건 미만') >= 0; }));
  const sum = BT.summarize(res);
  assert.ok(!('trades' in sum) && Array.isArray(sum.equityWeekly) && sum.metrics.trades === 1);
  assert.ok(sum.equityWeekly.length <= res.equity.length);
  assert.deepEqual(sum.exitReasons, { rule: { n: 1, ret: 0.1 } });
});

test('MDD: 고점 대비 최대 하락률과 구간', function () {
  const d = ['a', 'b', 'c', 'd', 'e'], eq = [110, 120, 90, 100, 130], cash = eq;
  const m = BT.calcMetrics(d, eq, cash, null, [], 100, 100, 0);
  near(m.mdd, 90 / 120 - 1, 1e-12); assert.equal(m.mddFrom, 'b'); assert.equal(m.mddTo, 'c');
});

// ---------------------------------------------------------------- 잠금·스키마
test('잠금: 2번 ORB·3번 VWAP 눌림은 스키마만 있고 실행되지 않는다', function () {
  const list = BT.listStrategies();
  assert.equal(list.length, 20);
  assert.deepEqual(list.map(function (s) { return s.no; }), Array.from({ length: 20 }, function (_, i) { return i + 1; }));
  const locked = list.filter(function (s) { return s.locked; });
  assert.deepEqual(locked.map(function (s) { return s.key; }), ['orb', 'vwapPullback']);
  locked.forEach(function (s) { assert.equal(s.lockReason, '분봉 준비 중'); assert.ok(s.params.length >= 5); });
  const m = mk({ stocks: { A: rep(1000, 5) } });
  assert.throws(function () { BT.run(m.data, 'orb'); }, /분봉 준비 중/);
  assert.throws(function () { BT.run(m.data, 'vwapPullback'); }, /분봉 준비 중/);
  assert.equal(BT.unavailableReason(m.data, 'flowFollow'), '종목별 수급 자료 없음');
  assert.equal(BT.unavailableReason(m.data, 'themeLeader', {}), '테마 데이터 없음');
  assert.equal(BT.unavailableReason(m.data, 'crashSurvivor'), '지수 자료 없음');
  assert.equal(BT.unavailableReason(m.data, 'maCross'), '');
});

test('스키마: 모든 변수에 key·라벨·타입·기본값이 있고 숫자형은 최소·최대·단계가 있다', function () {
  const check = function (it, where) {
    assert.ok(it.key && it.label && it.type, where + ' ' + it.key);
    assert.ok(['int', 'float', 'pct', 'bool', 'select', 'date'].indexOf(it.type) >= 0, where + ' ' + it.key);
    assert.ok('def' in it, where + ' ' + it.key);
    if (it.type === 'int' || it.type === 'float' || it.type === 'pct') {
      assert.ok(typeof it.min === 'number' && typeof it.max === 'number' && typeof it.step === 'number', where + ' ' + it.key);
      assert.ok(it.def >= it.min && it.def <= it.max, where + ' ' + it.key + ' 기본값 범위');
    }
    if (it.type === 'select') assert.ok(it.options.some(function (o) { return o.v === it.def; }), where + ' ' + it.key + ' 기본값이 선택지에 없음');
  };
  BT.commonSchema.forEach(function (g) { g.items.forEach(function (it) { check(it, '공통'); }); });
  const commonKeys = Object.keys(BT.commonDefaults());
  BT.listStrategies().forEach(function (s) {
    assert.ok(s.label && s.group && s.desc, s.key);
    s.params.forEach(function (it) { check(it, s.key); });
    Object.keys(s.commonDefaults).concat(Object.keys(s.fixed)).forEach(function (k) { assert.ok(commonKeys.indexOf(k) >= 0, s.key + ' 공통 변수 ' + k); });
  });
  // 기법이 공통 기본값을 덮어쓰고, 사용자가 준 값이 그 위에, 고정값이 맨 위에 온다
  assert.equal(BT.resolveParams('closeBet').common.entryFill, 'close');
  assert.equal(BT.resolveParams('closeBet', { common: { entryFill: 'nextOpen' } }).common.entryFill, 'nextOpen');
  assert.equal(BT.resolveParams('themeLeader', { common: { entryFill: 'close' } }).common.entryFill, 'nextOpen');
  assert.equal(BT.resolveParams('rsi2', { own: { rsiTh: 5 } }).own.rsiTh, 5);
});

// ---------------------------------------------------------------- 테마 구조
test('테마: buildFrameDetail — 큰 틀로 묶고, 합계는 종목 중복 제거, 거래대금 내림차순 1~3위(그 외 4)', function () {
  const dd = { '2026-01-05': { groups: [
    { theme: '소부장', rank: 1, avgChange: 5, sumValue: 300, stocks: [{ name: '가', change: 4, value: 200 }, { name: '나', change: 6, value: 100 }] },
    { theme: 'HBM', rank: 2, avgChange: 5, sumValue: 250, stocks: [{ name: '가', change: 4, value: 200 }, { name: '다', change: 6, value: 50 }] },
    { theme: '로봇', rank: 3, avgChange: 8, sumValue: 340, stocks: [{ name: '라', change: 8, value: 340 }] },
    { theme: '게임', rank: 4, avgChange: 3, sumValue: 30, stocks: [{ name: '마', change: 3, value: 30 }] },
    { theme: '엔터', rank: 4, avgChange: 3, sumValue: 20, stocks: [{ name: '바', change: 3, value: 20 }] }
  ] } };
  const fd = buildFrameDetail(dd, { '소부장': '반도체', 'HBM': '반도체' });
  const g = fd['2026-01-05'].groups;
  assert.deepEqual(g.map(function (x) { return [x.theme, x.rank, x.sumValue]; }), [['반도체', 1, 350], ['로봇', 2, 340], ['게임', 3, 30], ['엔터', 4, 20]]);
  assert.deepEqual(g[0].stocks.map(function (s) { return s.name; }), ['가', '나', '다']);   // '가'는 한 번만
  near(g[0].avgChange, 5.33, 1e-9);
  assert.equal(g[0].subs.length, 2);
});

// ---------------------------------------------------------------- 브라우저 방식과 Node 결과 일치
test('브라우저 방식: 전역 BT + <script> 조각(window.__btChunk) 적재 결과가 Node와 같다', function () {
  const syn = makeSynth({ n: 40, days: 320, seed: 7 });
  const dir = path.join(__dirname, '..', '..', 'dashboard', 'bt');
  const win = {}; win.window = win; win.globalThis = win; win.self = win;
  const box = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'), box);      // module이 없으므로 전역 BT로 등록된다
  vm.runInContext(fs.readFileSync(path.join(dir, 'strategies.js'), 'utf8'), box);
  assert.ok(win.BT && win.BT.strategies.maCross);
  vm.runInContext('var store = BT.createStore(); BT.installHooks(store, window);', box);
  syn.px.forEach(function (c) { vm.runInContext('window.__btChunk(' + JSON.stringify(c) + ');', box); });
  vm.runInContext('window.__btMeta(' + JSON.stringify(syn.meta) + '); window.__btIndex(' + JSON.stringify(syn.index) + ');', box);
  const params = { common: { minCapEok: 0, minAvgValEok: 0 } };
  const a = vm.runInContext('JSON.stringify(BT.run(BT.finalize(store), "maCross", ' + JSON.stringify(params) + ').metrics)', box);
  const b = JSON.stringify(BT.run(BT.buildData(syn), 'maCross', params).metrics);
  assert.equal(a, b);
  assert.ok(JSON.parse(b).trades > 10);
});
