/*
 * 기법별 고정 예제 (설계서 6장) — 신호가 나야 하는 날과 안 나야 하는 날을 손으로 만든 자료로 확인한다.
 * 비용 0, 대상 종목 조건·시장 필터 끔(OFF). 날짜는 d[번호]로 적는다.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BT, mk, OFF, near, rep } = require('./helpers.js');

function runS(key, spec, own, common, extras) {
  const m = mk(spec);
  const res = BT.run(m.data, key, { own: own || {}, common: OFF(Object.assign({ startDate: m.dates[0] }, common || {})) }, extras);
  return { res: res, d: m.dates, tr: res.trades, data: m.data };
}
// 위아래 1씩 꼬리가 있는 봉
function hl(c, o) { return [o == null ? c : o, c + 1, c - 1, c]; }

// ------------------------------------------------------------------ 1
test('1 변동성 돌파: 시가 + 전일 변동폭×k 돌파 시 그 가격에 매수, 다음 날 시가(또는 당일 종가) 매도', function () {
  // 0일 변동폭 100 → 1일 돌파가 = 1,000 + 100×0.5 = 1,050
  const own = { k: 0.5, minRangePct: 2, stockMaN: 0 };
  const hit = [[1000, 1050, 950, 1000], [1000, 1060, 990, 1040], [1070, 1080, 1060, 1070], 1070, 1070];
  let r = runS('volBreakout', { stocks: { A: hit } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[1]); assert.equal(r.tr[0].inPx, 1050); assert.equal(r.tr[0].outD, r.d[2]); assert.equal(r.tr[0].outPx, 1070);
  r = runS('volBreakout', { stocks: { A: hit } }, Object.assign({ exitMode: 'sameClose' }, own));
  assert.equal(r.tr[0].outD, r.d[1]); assert.equal(r.tr[0].outPx, 1040);
  // 고가가 돌파가에 1원 모자라면 신호 없음
  const miss = [[1000, 1050, 950, 1000], [1000, 1049, 990, 1040], [1040, 1045, 1035, 1040], 1040, 1040];
  assert.equal(runS('volBreakout', { stocks: { A: miss } }, own).tr.length, 0);
  // 전일 변동폭이 최소 기준(20%)에 못 미치면 신호 없음
  assert.equal(runS('volBreakout', { stocks: { A: hit } }, Object.assign({}, own, { minRangePct: 15 })).tr.length, 0);
  // 종목 이평선 필터: 전일 종가가 3일선 아래면 신호 없음
  const down = [1100, 1050].concat(hit);
  assert.equal(runS('volBreakout', { stocks: { A: down } }, Object.assign({}, own, { stockMaN: 3 })).tr.length, 0);
  assert.equal(runS('volBreakout', { stocks: { A: down } }, own).tr.length, 1);
});

// ------------------------------------------------------------------ 4
test('4 종가 베팅: 등락률·거래대금·윗꼬리 조건을 채운 날 종가 매수', function () {
  // 1일: +9%, 거래대금 500억, 윗꼬리 (1,100−1,090)/100 = 10%
  const bars = [1000, [1000, 1100, 1000, 1090, 500], [1120, 1130, 1100, 1110], 1110, 1110];
  let r = runS('closeBet', { stocks: { A: bars } });
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[1]); assert.equal(r.tr[0].inPx, 1090); assert.equal(r.tr[0].outD, r.d[2]); assert.equal(r.tr[0].outPx, 1120);
  // 다음 날 종가 청산
  r = runS('closeBet', { stocks: { A: bars } }, { exitMode: 'nextClose' });
  assert.equal(r.tr[0].outD, r.d[2]); assert.equal(r.tr[0].outPx, 1110);
  // 목표가 +3% = 1,122.7 → 다음 날 고가 1,130이 닿아 그 가격에 익절
  r = runS('closeBet', { stocks: { A: bars } }, { exitMode: 'nextTarget', tpPct: 3 });
  assert.equal(r.tr[0].why, 'take'); near(r.tr[0].outPx, 1090 * 1.03, 1e-9);
  // 목표가 +5% = 1,144.5 → 못 닿아 다음 날 종가 청산
  r = runS('closeBet', { stocks: { A: bars } }, { exitMode: 'nextTarget', tpPct: 5 });
  assert.equal(r.tr[0].why, 'time'); assert.equal(r.tr[0].outPx, 1110); assert.equal(r.tr[0].outD, r.d[2]);
  // 신호가 안 나야 하는 경우: 윗꼬리 50%, 거래대금 부족, 등락률 부족, 상한가 마감
  assert.equal(runS('closeBet', { stocks: { A: [1000, [1000, 1180, 1000, 1090, 500], 1100, 1100] } }).tr.length, 0);
  assert.equal(runS('closeBet', { stocks: { A: [1000, [1000, 1100, 1000, 1090, 200], 1100, 1100] } }).tr.length, 0);
  assert.equal(runS('closeBet', { stocks: { A: bars } }, { minChgPct: 10 }).tr.length, 0);
  assert.equal(runS('closeBet', { stocks: { A: [1000, [1000, 1300, 1000, 1300, 500], 1300, 1300] } }).tr.length, 0);
  // 매수 체결을 다음 날 시가로 바꾸면 2일 시가에 사서 3일 시가에 판다
  r = runS('closeBet', { stocks: { A: bars } }, {}, { entryFill: 'nextOpen' });
  assert.equal(r.tr[0].inD, r.d[2]); assert.equal(r.tr[0].inPx, 1120); assert.equal(r.tr[0].outD, r.d[3]);
});

// ------------------------------------------------------------------ 5
test('5 RSI(2): 추세선 위에서 RSI가 기준 아래로 떨어진 날 신호, 단기선 회복 시 청산', function () {
  // 30일 동안 +2씩 상승(100→158) 뒤 155, 146 → RSI(2) = 40, 8.7. 20일선 141.95 < 146
  const c = []; for (let t = 0; t < 30; t++) c.push(100 + 2 * t);
  const bars = c.concat([155, 146, [147, 151, 146, 150], 156, [157, 158, 156, 157], 157]);
  const own = { rsiN: 2, rsiTh: 10, trendMa: 20, exitMa: 3 };
  let r = runS('rsi2', { stocks: { A: bars } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[32]); assert.equal(r.tr[0].inPx, 147);   // 31일 신호 → 32일 시가
  assert.equal(r.tr[0].outD, r.d[34]); assert.equal(r.tr[0].outPx, 157); // 33일 종가 156 > 3일선 150.67 → 34일 시가
  assert.equal(runS('rsi2', { stocks: { A: bars } }, Object.assign({}, own, { rsiTh: 5 })).tr.length, 0);   // RSI 8.7은 5 미만이 아님
  assert.equal(runS('rsi2', { stocks: { A: bars } }, Object.assign({}, own, { trendMa: 30 })).tr.length > 0, true);
  // 추세선 아래(하락 추세)에서는 RSI가 낮아도 신호 없음
  const dn = []; for (let t = 0; t < 30; t++) dn.push(300 - 2 * t);
  assert.equal(runS('rsi2', { stocks: { A: dn.concat([239, 230, 231, 232]) } }, own).tr.length, 0);
});

// ------------------------------------------------------------------ 6
test('6 볼린저 하단 반등: 하단 아래 마감 뒤 다시 안으로 들어온 날 신호, 전일 중심선 지정가에 청산', function () {
  // 5일 밴드(k=1): 5일 종가 90 < 하단 94, 6일 종가 97 > 하단 93.5 → 7일 시가 97 매수 → 8일 고가가 7일 중심선 96.8에 닿아 매도
  const bars = [100, 100, 100, 100, 100, 90, 97, 97, [96, 99, 95, 98], 98];
  const own = { n: 5, k: 1, exitAt: 'mid', slPct: 0 };
  let r = runS('bbRebound', { stocks: { A: bars } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[7]); assert.equal(r.tr[0].outD, r.d[8]); near(r.tr[0].outPx, 96.8, 1e-4); assert.equal(r.tr[0].why, 'rule');
  // k=3이면 하단이 86이라 90은 이탈이 아님 → 신호 없음
  assert.equal(runS('bbRebound', { stocks: { A: bars } }, Object.assign({}, own, { k: 3 })).tr.length, 0);
  // 고유 손절 3%: 97 × 0.97 = 94.09 → 8일 저가 94에 닿아 손절(같은 날 지정가보다 손절 우선)
  const sl = [100, 100, 100, 100, 100, 90, 97, 97, [96, 99, 94, 98], 98];
  r = runS('bbRebound', { stocks: { A: sl } }, Object.assign({}, own, { slPct: 3 }));
  assert.equal(r.tr[0].why, 'stop'); near(r.tr[0].outPx, 94.09, 1e-9);
});

// ------------------------------------------------------------------ 7
test('7 신고가 돌파: 기간 최고가를 처음 넘고 거래대금이 늘어난 날 신호', function () {
  // 25일 횡보(고가 100) 뒤 25일 종가 105, 거래대금 200억(20일 평균 100억의 2배)
  const base = rep(100, 25);
  const bars = base.concat([[100, 106, 100, 105, 200], [105, 111, 105, 110], 120, 107, [106, 107, 105, 106], 106]);
  const own = { lookback: 5, valMult: 1.5, exitMa: 0, trail: 10 };
  let r = runS('newHigh', { stocks: { A: bars } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[26]); assert.equal(r.tr[0].inPx, 105);
  assert.equal(r.tr[0].why, 'trail'); assert.equal(r.tr[0].outD, r.d[29]);   // 28일 종가 107 ≤ 최고 종가 120 × 0.9 → 29일 시가
  // 거래대금이 1.4배뿐이면 신호 없음
  const weak = base.concat([[100, 106, 100, 105, 140], 110, 120, 107, 106, 106]);
  assert.equal(runS('newHigh', { stocks: { A: weak } }, own).tr.length, 0);
  // 종가가 최고가를 넘지 못하면(고가만 넘음) 신호 없음
  const wick = base.concat([[100, 106, 100, 100, 200], 100, 100, 100]);
  assert.equal(runS('newHigh', { stocks: { A: wick } }, own).tr.length, 0);
});

// ------------------------------------------------------------------ 8
test('8 터틀: N일 최고가 돌파 신호, ATR 배수 손절가 고정, M일 최저가 이탈 청산', function () {
  // 10일 횡보(고 101, 저 99) 뒤 10일 종가 104 → ATR(3) = (2+2+4)/3 = 2.667 → 11일 시가 104 매수, 손절가 104 − 2×2.667 = 98.667
  const base = rep([100, 101, 99, 100], 10);
  const own = { entryN: 5, exitN: 3, atrN: 3, atrMult: 2 };
  let r = runS('turtle', { stocks: { A: base.concat([[100, 104, 100, 104], [104, 105, 103, 104], [103, 104, 98, 99], 99]) } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[11]); assert.equal(r.tr[0].why, 'stop'); assert.equal(r.tr[0].outD, r.d[12]); near(r.tr[0].outPx, 104 - 2 * 8 / 3, 1e-4);
  // 손절 끔: 12일 종가 101 < 최근 3일 최저가(9~11일 저가 99, 100, 103 → 99)? 아님. 13일 종가 98 < LL(3)=min(100,103,100.5) → 14일 시가 매도
  r = runS('turtle', { stocks: { A: base.concat([[100, 104, 100, 104], [104, 105, 103, 104], [103, 104, 100.5, 101], [101, 101, 97, 98], [97, 98, 96, 97], 97]) } }, Object.assign({}, own, { atrMult: 0 }));
  assert.equal(r.tr[0].why, 'rule'); assert.equal(r.tr[0].outD, r.d[14]); assert.equal(r.tr[0].outPx, 97);
  // 종가가 최고가와 같으면(넘지 못하면) 신호 없음
  assert.equal(runS('turtle', { stocks: { A: base.concat([[100, 101, 100, 101], 101, 101]) } }, own).tr.length, 0);
});

// ------------------------------------------------------------------ 9
test('9 VCP: 구간 폭이 단계적으로 줄어든 뒤 마지막 구간 고점을 거래대금과 함께 넘는 날 신호', function () {
  // 140일 상승(100→239) 뒤 45일 쉬는 구간: 폭 12% → 6.45% → 3.25%, 185일에 종가 250으로 마지막 구간 고점 246 돌파
  function series(lastSegHigh) {
    const b = [];
    for (let t = 0; t < 140; t++) b.push(hl(100 + t));
    for (let t = 0; t < 15; t++) b.push([235, 250, 220, 235]);
    for (let t = 0; t < 15; t++) b.push([240, 248, 232, 240]);
    for (let t = 0; t < 15; t++) b.push([242, lastSegHigh, 238, 242]);
    b.push([243, 251, 243, 250, 300]); b.push([250, 252, 249, 251]); b.push(251);
    return b;
  }
  const own = { baseN: 45, segs: 3, shrink: 0.75, lastDepthPct: 10, nearHighPct: 75, valMult: 1.5, exitMa: 0 };
  let r = runS('vcp', { stocks: { A: series(246) } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[186]); assert.equal(r.tr[0].inPx, 250);
  // 수축 비율을 0.4로 조이면(6.45% > 12%×0.4) 신호 없음
  assert.equal(runS('vcp', { stocks: { A: series(246) } }, Object.assign({}, own, { shrink: 0.4 })).tr.length, 0);
  // 마지막 구간 폭 한도를 3%로 조이면(3.25% > 3%) 신호 없음
  assert.equal(runS('vcp', { stocks: { A: series(246) } }, Object.assign({}, own, { lastDepthPct: 3 })).tr.length, 0);
  // 마지막 구간 고점이 250이면 종가 250이 넘지 못해 신호 없음
  assert.equal(runS('vcp', { stocks: { A: series(250) } }, own).tr.length, 0);
});

// ------------------------------------------------------------------ 10
test('10 20일선 눌림: 정배열에서 지지선 근처까지 내려온 양봉에 신호, 직전 고점에서 익절', function () {
  // 15일 동안 +2씩 상승(100→128, 양봉), 15일에 5일선(125.2) 근처까지 눌린 양봉 → 목표가 = 직전 5일 고가 129
  const up = []; for (let t = 0; t < 15; t++) up.push([99 + 2 * t, 101 + 2 * t, 99 + 2 * t, 100 + 2 * t]);
  const own = { maS: 3, maM: 5, maL: 10, nearPct: 2, swingN: 5, breakPct: 0 };
  const tail = [[127, 128, 126, 127], [128, 130, 127, 129]];   // 17일이 마지막 날(마지막 날에는 새로 사지 않는다)
  let r = runS('ma20Pullback', { stocks: { A: up.concat([[124, 127, 123, 126]], tail) } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[16]); assert.equal(r.tr[0].inPx, 127);
  assert.equal(r.tr[0].why, 'take'); assert.equal(r.tr[0].outD, r.d[17]); assert.equal(r.tr[0].outPx, 129);
  // 음봉이면 신호 없음
  assert.equal(runS('ma20Pullback', { stocks: { A: up.concat([[127, 127, 123, 126]], [[126, 127, 125.5, 126], 126]) } }, own).tr.length, 0);
  // 저가가 지지선 근처(이평선 +0.2% 이내)까지 오지 않으면 신호 없음
  assert.equal(runS('ma20Pullback', { stocks: { A: up.concat([[124, 127, 123, 126]], tail) } }, Object.assign({}, own, { nearPct: 0 })).tr.length, 1);
  assert.equal(runS('ma20Pullback', { stocks: { A: up.concat([[125.8, 127, 125.8, 126]], [[126.5, 127, 126.4, 126.5], 126.5]) } }, Object.assign({}, own, { nearPct: 0.2 })).tr.length, 0);
});

// ------------------------------------------------------------------ 11
test('11 기준봉 지지: 기준봉 뒤 거래대금이 줄며 지지선에서 버틴 날 신호, 기준봉 고가에서 익절', function () {
  // 22일 기준봉: +15%, 거래대금 500억(평균의 5배), 몸통 중간 1,075. 24일: 저가 1,080(≤ 1,085.75), 종가 1,090, 거래대금 200억(≤ 250억)
  const base = rep(1000, 22);
  function series(pullVal) {
    return base.concat([[1000, 1160, 1000, 1150, 500], [1150, 1150, 1110, 1120, 300], [1120, 1125, 1080, 1090, pullVal],
      [1095, 1100, 1090, 1095, 300], [1100, 1170, 1100, 1165, 300], [1165, 1166, 1164, 1165, 300]]);
  }
  const own = { sigChgPct: 10, sigValMult: 3, minDays: 2, maxDays: 7, support: 'mid', tolPct: 1, dryRatio: 0.5 };
  let r = runS('pivotBar', { stocks: { A: series(200) } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[25]); assert.equal(r.tr[0].inPx, 1095);
  assert.equal(r.tr[0].why, 'take'); assert.equal(r.tr[0].outD, r.d[26]); assert.equal(r.tr[0].outPx, 1160);
  // 눌림일 거래대금이 기준봉의 절반을 넘으면 신호 없음
  assert.equal(runS('pivotBar', { stocks: { A: series(300) } }, own).tr.length, 0);
  // 눌림 최소 일수 3일이면 24일(2일째)은 신호가 아님
  assert.equal(runS('pivotBar', { stocks: { A: series(200) } }, Object.assign({}, own, { minDays: 3 })).tr.length, 0);
  // 기준봉 거래대금 배수를 6배로 올리면 기준봉이 아님
  assert.equal(runS('pivotBar', { stocks: { A: series(200) } }, Object.assign({}, own, { sigValMult: 6 })).tr.length, 0);
});

// ------------------------------------------------------------------ 12
test('12 스토캐스틱: 추세선 위에서 %K가 과매도 구간에서 %D를 위로 넘는 날 신호, 과매수 도달 시 청산', function () {
  // +3씩 상승(…,147,150) 뒤 140(K 8.3) → 146(K 58.3 > D 33.3) → 신호. 다음 날 151(K 92) → 과매수 청산
  const b = []; for (let t = 0; t < 18; t++) b.push(hl(99 + 3 * t));   // 마지막 종가 150
  b.push(hl(140)); b.push(hl(146)); b.push([147, 152, 146, 151]); b.push([152, 153, 151, 152]); b.push(152);
  const own = { kN: 5, kSmooth: 1, dN: 2, osTh: 20, obTh: 80, trendMa: 10, tpPct: 0 };
  let r = runS('stochPullback', { stocks: { A: b } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[20]); assert.equal(r.tr[0].inPx, 147);
  assert.equal(r.tr[0].why, 'rule'); assert.equal(r.tr[0].outD, r.d[21]); assert.equal(r.tr[0].outPx, 152);
  // 과매도 기준을 5로 낮추면(K 8.3은 5 미만이 아님) 신호 없음
  assert.equal(runS('stochPullback', { stocks: { A: b } }, Object.assign({}, own, { osTh: 5 })).tr.length, 0);
  // 목표 수익 2%: 147 × 1.02 = 149.94 → 진입 다음 날(21일) 고가 153이 닿아 시가 152에 익절(갭 상승)
  r = runS('stochPullback', { stocks: { A: b } }, Object.assign({}, own, { tpPct: 2, obTh: 200 }));
  assert.equal(r.tr[0].why, 'take'); assert.equal(r.tr[0].outPx, 152);
});

// ------------------------------------------------------------------ 13
test('13 테마 대장주: 최근 N일 중 M번 이상 상위권에 든 테마의 대장주를 다음 날 시가에 매수', function () {
  const spec = { stocks: { A: rep(1000, 10), B: rep(2000, 10), C: rep(3000, 10) }, names: { A: '가', B: '나', C: '다' } };
  const d = mk(spec).dates;
  const g = function (theme, rank, stocks) { return { theme: theme, rank: rank, sumValue: 0, avgChange: 0, stocks: stocks }; };
  const theme = {};
  theme[d[4]] = { groups: [g('반도체', 1, [{ name: '가', value: 500, change: 5 }, { name: '나', value: 300, change: 9 }]), g('로봇', 4, [{ name: '다', value: 100, change: 3 }])] };
  theme[d[5]] = { groups: [g('반도체', 2, [{ name: '가', value: 400, change: 4 }, { name: '나', value: 350, change: 8 }]), g('로봇', 4, [{ name: '다', value: 100, change: 3 }])] };
  const own = { lookN: 3, minHits: 2, rankMax: 3, leaderBy: 'dayValue', leadersPerTheme: 1, exitMa: 5 };
  let r = runS('themeLeader', spec, own, {}, { theme: theme });
  assert.deepEqual(r.tr.map(function (t) { return [t.name, t.inD]; }), [['가', d[6]]]);   // 4일은 1회뿐 → 5일(2회째)에 신호 → 6일 시가
  r = runS('themeLeader', spec, Object.assign({}, own, { leaderBy: 'dayChange' }), {}, { theme: theme });
  assert.deepEqual(r.tr.map(function (t) { return t.name; }), ['나']);
  r = runS('themeLeader', spec, Object.assign({}, own, { leadersPerTheme: 2 }), {}, { theme: theme });
  assert.deepEqual(r.tr.map(function (t) { return t.name; }).sort(), ['가', '나']);
  assert.equal(runS('themeLeader', spec, Object.assign({}, own, { minHits: 3 }), {}, { theme: theme }).tr.length, 0);
  assert.equal(runS('themeLeader', spec, Object.assign({}, own, { rankMax: 1 }), {}, { theme: theme }).tr.length, 0);  // 5일은 2위
  // 매수 체결은 다음 날 시가로 고정(종가로 바꿔도 무시)
  r = runS('themeLeader', spec, own, { entryFill: 'close' }, { theme: theme });
  assert.equal(r.tr[0].inD, d[6]);
  // 코드로 못 바꾸는 종목이 대장주면 제외하고 경고
  theme[d[5]].groups[0].stocks.push({ name: '없는종목', value: 900, change: 1 });
  r = runS('themeLeader', spec, own, {}, { theme: theme });
  assert.equal(r.tr.length, 0);
  assert.ok(r.res.warnings.some(function (w) { return w.indexOf('없는종목') >= 0; }));
  // 시작일을 주지 않으면 테마 데이터 첫 날부터 검증
  const m = mk(spec);
  assert.equal(BT.run(m.data, 'themeLeader', { own: own, common: OFF() }, { theme: theme }).dataRange.start, d[4]);
});

// ------------------------------------------------------------------ 14
test('14 상대강도 회전: 재조정일마다 수익률 상위 K종목으로 갈아탄다', function () {
  // 6일 재조정: 5일 수익률 A > B > C > D → A·B 매수. 11일 재조정: C가 급등해 C > B > A > D → A 매도, C 매수
  const A = [], B = [], C = [], Dn = [];
  for (let t = 0; t < 16; t++) {
    A.push(t <= 8 ? 1000 + 40 * t : 1320 - 40 * (t - 8));
    B.push(1000 + 15 * t);
    C.push(t <= 8 ? 1000 : 1000 + 150 * (t - 8));
    Dn.push(1000 - 10 * t);
  }
  const r = runS('rsRotation', { stocks: { A: A, B: B, C: C, D: Dn } }, { lookD: 5, skipD: 0, topK: 2, rebalD: 5, keepMult: 1 }, { startDate: null });
  const m = mk({ stocks: { A: A } });
  const res = BT.run(mk({ stocks: { A: A, B: B, C: C, D: Dn } }).data, 'rsRotation',
    { own: { lookD: 5, skipD: 0, topK: 2, rebalD: 5, keepMult: 1 }, common: OFF({ startDate: m.dates[6] }) });
  const t = {}; res.trades.forEach(function (x) { t[x.tk] = x; });
  assert.deepEqual(Object.keys(t).sort(), ['A', 'B', 'C']);
  assert.equal(t.A.inD, m.dates[7]); assert.equal(t.A.outD, m.dates[12]); assert.equal(t.A.why, 'rule');
  assert.equal(t.B.inD, m.dates[7]); assert.equal(t.B.why, 'end');
  assert.equal(t.C.inD, m.dates[12]);
  near(t.A.amt, 5000000, 1e-6);            // 총자산 / 2
  assert.ok(res.stats.maxPositionsSeen <= 2);
  assert.ok(r.res.trades.length >= 2);     // 시작일을 처음으로 두어도 동작
});

// ------------------------------------------------------------------ 15
test('15 이평선 교차: 골든크로스 신호, 데드크로스 청산', function () {
  // 110→101 하락 뒤 104, 108: 2일선 106 > 4일선 103.75(전일은 102.5 = 102.5) → 11일 신호 → 12일 시가
  const c = [110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 104, 108, 109, 100, [99, 100, 98, 99], 99];
  const own = { fastN: 2, slowN: 4, maType: 'SMA', needRising: false };
  let r = runS('maCross', { stocks: { A: c } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[12]); assert.equal(r.tr[0].outD, r.d[14]); assert.equal(r.tr[0].outPx, 99); // 13일 2일선 104.5 < 4일선 105.25
  // 장기선이 5일 전보다 낮으면(상승 중 아님) 신호 없음
  assert.equal(runS('maCross', { stocks: { A: c } }, Object.assign({}, own, { needRising: true })).tr.length, 0);
  // 단기 ≥ 장기면 실행 오류
  assert.throws(function () { runS('maCross', { stocks: { A: c } }, { fastN: 20, slowN: 10 }); }, /짧아야/);
  // 지수이동평균도 동작
  assert.ok(runS('maCross', { stocks: { A: c } }, Object.assign({}, own, { maType: 'EMA' })).tr.length >= 1);
});

// ------------------------------------------------------------------ 16
test('16 이격도: 이격도가 기준 이하로 벌어진 날 신호, 회복 시 청산', function () {
  // 6일 종가 80 → 5일선 96, 이격도 83.3 → 7일 시가 매수. 7일 종가 95 → 5일선 95, 이격도 100 → 8일 시가 매도
  const bars = [100, 100, 100, 100, 100, 100, 80, [82, 96, 81, 95], [96, 97, 95, 96], 96];
  const own = { maN: 5, entryDisp: 90, exitDisp: 98, needUpBar: false };
  let r = runS('disparity', { stocks: { A: bars } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[7]); assert.equal(r.tr[0].inPx, 82); assert.equal(r.tr[0].outD, r.d[8]); assert.equal(r.tr[0].outPx, 96);
  assert.equal(runS('disparity', { stocks: { A: bars } }, Object.assign({}, own, { entryDisp: 80 })).tr.length, 0);
  assert.equal(runS('disparity', { stocks: { A: bars } }, Object.assign({}, own, { needUpBar: true })).tr.length, 0); // 6일은 양봉이 아님
});

// ------------------------------------------------------------------ 17
test('17 급락일 버틴 종목: 지수 급락일에 오른 종목을 등락률 순으로 매수, 고정 보유일 뒤 매도', function () {
  const n = 12, flat = rep(1000, n);
  const up = function (pct, val) { const b = rep([1000, 1000, 1000, 1000, 200], n); const c = Math.round(1000 * (1 + pct / 100)); for (let t = 5; t < n; t++) b[t] = [c, c, c, c, val]; return b; };
  const spec = { stocks: { A: up(2, 200), B: up(-1, 200), C: up(5, 50), D: up(4, 200) }, mkt: { A: 'KOSDAQ' },
    index: { KOSPI: flat, KOSDAQ: [1000, 1000, 1000, 1000, 1000, 970, 975, 980, 985, 990, 995, 1000] } };
  const own = { idx: 'KOSDAQ', dropPct: -2, minChgPct: 0, minValEok: 100, pickN: 5, exitMode: 'hold', holdDays: 3 };
  let r = runS('crashSurvivor', spec, own);
  assert.deepEqual(r.tr.map(function (t) { return t.tk; }).sort(), ['A', 'D']);   // B는 하락, C는 거래대금 부족
  r.tr.forEach(function (t) { assert.equal(t.inD, r.d[6]); assert.equal(t.outD, r.d[9]); assert.equal(t.why, 'time'); assert.equal(t.hold, 3); });
  r = runS('crashSurvivor', spec, Object.assign({}, own, { pickN: 1 }));
  assert.deepEqual(r.tr.map(function (t) { return t.tk; }), ['D']);              // 등락률 큰 순 1종목
  assert.equal(runS('crashSurvivor', spec, Object.assign({}, own, { dropPct: -4 })).tr.length, 0);   // 지수 −3%는 −4% 이하가 아님
  assert.equal(runS('crashSurvivor', spec, Object.assign({}, own, { idx: 'KOSPI' })).tr.length, 0);  // 코스피는 안 빠짐
  assert.equal(runS('crashSurvivor', spec, Object.assign({}, own, { idx: 'either' })).tr.length, 2);
  // 지수 5일선 회복 후 1일: 코스닥 5일선(7일 986, 8일 982, 9일 984)을 8일에 회복(985 > 982) → 9일 종가 뒤 → 10일 시가
  r = runS('crashSurvivor', spec, Object.assign({}, own, { exitMode: 'idxRecover', holdDays: 1 }));
  r.tr.forEach(function (t) { assert.equal(t.outD, r.d[10]); });
});

// ------------------------------------------------------------------ 18
test('18 MACD: 시그널 상향 교차 신호일이 지표 계산과 일치, 0선 조건', function () {
  const c = []; for (let t = 0; t < 30; t++) c.push(200 - 3 * t);
  for (let t = 0; t < 25; t++) c.push(113 + 4 * t);
  for (let t = 0; t < 15; t++) c.push(209 - 5 * t);
  const own = { fast: 5, slow: 10, sig: 4, zeroFilter: 'off' };
  const mc = BT.series.macd(c, 5, 10, 4), cross = [], dead = [];
  for (let t = 1; t < c.length; t++) {
    if (mc.macd[t - 1] <= mc.signal[t - 1] && mc.macd[t] > mc.signal[t]) cross.push(t);
    if (mc.macd[t] < mc.signal[t]) dead.push(t);
  }
  assert.equal(cross.length, 1);                 // V자 반등에서 한 번
  assert.ok(mc.macd[cross[0]] < 0);              // 0선 아래에서 교차
  const r = runS('macd', { stocks: { A: c } }, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[cross[0] + 1]);
  const firstDead = dead.filter(function (t) { return t > cross[0]; })[0];
  assert.equal(r.tr[0].outD, r.d[firstDead + 1]);
  assert.equal(runS('macd', { stocks: { A: c } }, Object.assign({}, own, { zeroFilter: 'above' })).tr.length, 0);
  assert.equal(runS('macd', { stocks: { A: c } }, Object.assign({}, own, { zeroFilter: 'below' })).tr.length, 1);
  assert.throws(function () { runS('macd', { stocks: { A: c } }, { fast: 30, slow: 20 }); }, /짧아야/);
});

// ------------------------------------------------------------------ 19
test('19 수급 추종: N일 연속 순매수를 처음 채운 날 신호(다음 날 시가), 순매도 전환 시 청산', function () {
  // 외국인: 3·4·5일 순매수(+5억씩) → 5일 신호 → 6일 시가. 8·9일 순매도 → 10일 시가 매도. 시가총액 1,000억 → 15억/1,000억 = 1.5%
  const spec = { stocks: { A: rep(1000, 14) }, capQ: { A: [['2025-12-30', 1000]] },
    flow: { A: { frg: [0, -1, -2, 5, 5, 5, 5, 3, -4, -4, 1, 1, -1, 1], ins: [0, 1, 1, -1, 2, 2, 2, -1, -1, -1, 0, 0, 0, 0] } } };
  const own = { who: 'frg', nDays: 3, minCapRatioPct: 0.1, exitMode: 'flip', sellDays: 2, exitMa: 20 };
  let r = runS('flowFollow', spec, own);
  assert.equal(r.tr.length, 1);
  assert.equal(r.tr[0].inD, r.d[6]); assert.equal(r.tr[0].outD, r.d[10]);
  assert.equal(runS('flowFollow', spec, Object.assign({}, own, { minCapRatioPct: 2 })).tr.length, 0);     // 1.5% < 2%
  assert.equal(runS('flowFollow', spec, Object.assign({}, own, { nDays: 6 })).tr.length, 0);             // 연속 순매수는 3~7일의 5일이 최대
  assert.equal(runS('flowFollow', spec, Object.assign({}, own, { nDays: 5 })).tr[0].inD, mk(spec).dates[8]); // 5일 연속을 채운 7일 → 8일 시가
  // 기관: 4·5·6일 순매수 → 6일 신호 → 7일 시가
  r = runS('flowFollow', spec, Object.assign({}, own, { who: 'ins', minCapRatioPct: 0 }));
  assert.equal(r.tr[0].inD, r.d[7]);
  // 둘 다: 외국인(3일~)·기관(4일~) 모두 3일 연속이 되는 첫날 = 6일 → 7일 시가
  r = runS('flowFollow', spec, Object.assign({}, own, { who: 'both', minCapRatioPct: 0 }));
  assert.equal(r.tr[0].inD, r.d[7]);
  // 매수 체결은 다음 날 시가로 고정
  r = runS('flowFollow', spec, own, { entryFill: 'close' });
  assert.equal(r.tr[0].inD, r.d[6]);
});

// ------------------------------------------------------------------ 20
test('20 듀얼 모멘텀: 월말에 수익률 상위·기준 초과 종목만 보유, 지수 모드는 강한 지수를 보유', function () {
  const n = 110, A = [], B = [], kp = [], kq = [];
  for (let t = 0; t < n; t++) { A.push(1000 + 5 * t); B.push(2000 - 5 * t); kp.push(2500 + 4 * t); kq.push(900 - 2 * t); }
  const spec = { stocks: { A: A, B: B }, index: { KOSPI: kp, KOSDAQ: kq } };
  const d = mk(spec).dates;
  // 3개월 = 63거래일 → 63일 뒤 첫 월말이 첫 재조정일
  let firstEnd = -1;
  for (let t = 63; t < n - 1; t++) if (d[t + 1].slice(0, 7) !== d[t].slice(0, 7)) { firstEnd = t; break; }
  const own = { assets: 'stocks', lookM: 3, topK: 2, rebalM: 1, absTh: 0, mktAbs: false };
  let r = runS('dualMomentum', spec, own);
  assert.deepEqual(r.tr.map(function (t) { return [t.tk, t.inD]; }), [['A', d[firstEnd + 1]]]);  // B는 수익률이 음수라 제외
  near(r.tr[0].amt, 5000000, 1e-6);                                                             // 총자산 / topK
  assert.equal(runS('dualMomentum', spec, Object.assign({}, own, { absTh: 10 })).tr.length, 1);
  assert.equal(runS('dualMomentum', spec, Object.assign({}, own, { absTh: 10 }), {}).res.metrics.trades, 1);
  // A의 3개월 수익률은 약 24~31% → 기준을 50%로 올리면 보유하지 않음(스키마 범위 밖 값이지만 규칙 확인용)
  assert.equal(runS('dualMomentum', spec, Object.assign({}, own, { absTh: 50 })).tr.length, 0);
  // 지수 모드: 코스피(상승)를 100% 보유
  r = runS('dualMomentum', spec, Object.assign({}, own, { assets: 'index' }));
  assert.deepEqual(r.tr.map(function (t) { return [t.tk, t.name, t.inD]; }), [['KOSPI', '코스피 지수', d[firstEnd + 1]]]);
  near(r.tr[0].amt, 10000000, 1e-6);
  assert.ok(r.res.warnings.some(function (w) { return w.indexOf('ETF') >= 0; }));
  // 비교 지수(코스닥) 수익률이 기준 이하면 전부 현금
  assert.equal(runS('dualMomentum', spec, Object.assign({}, own, { mktAbs: true }), { bench: 'KOSDAQ' }).tr.length, 0);
  assert.equal(runS('dualMomentum', spec, Object.assign({}, own, { mktAbs: true }), { bench: 'KOSPI' }).tr.length, 1);
});
