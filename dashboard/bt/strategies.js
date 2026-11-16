/*
 * 백테스트 기법 정의 (설계서 5장 공통 변수 + 6장 20개 기법)
 * - 브라우저: engine.js 다음에 불러오면 전역 BT에 등록된다 / Node: require하면 BT를 돌려준다.
 * - 화면의 입력 폼은 BT.commonSchema 와 BT.listStrategies()[n].params 만 읽어 자동으로 그리면 된다.
 *
 * 기법 객체의 모양
 *   key, no(번호), label, group(묶음), desc, needs('daily'|'index'|'theme'|'flow'|'minute'),
 *   locked/lockReason(실행 불가 표시), kind('signal' 기본 | 'intraday' 장중 돌파 | 'rotation' 회전형),
 *   commonDefaults(공통 변수 기본값 덮어쓰기), fixed(사용자가 바꿀 수 없는 공통 변수), params(고유 변수 스키마),
 *   prepare(ctx) → 아래 함수들을 담은 객체(실행 1회마다 새로 만든다)
 *     entry(i, t, k)    종가 단계 진입 신호. 점수(클수록 먼저 산다)를 돌려주고, 신호가 없으면 NaN. ctx.x에 넣은 값은 포지션 pos.x로 전달된다.
 *     dayGate(t)        그날 진입 판정을 할지(false면 종목 반복을 건너뜀)
 *     maxCand           하루 후보 수 상한(순위 상위만)
 *     trigger(i, t, k)  장중 돌파가(없으면 0) — kind 'intraday'
 *     exit(pos, t, k)   종가 단계 청산. 0 = 없음, 1 = 공통 매도 체결(exitFill)대로, 2 = 당일 종가, 3 = 다음 날 시가. pos.why로 사유 코드 지정 가능(기본 'rule')
 *     limit(pos, t, k)  그날 걸어 둘 지정가 매도 가격(없으면 0). 전일까지 값으로만 계산할 것. 진입 당일에는 불리지 않는다.
 *     onEntry(pos,t,k)  체결 직후(손절가 설정 등)
 *     rebalance(t, positions) → { sell: [pos], buy: [종목번호 순위순], slots: 자리 수 } 또는 null — kind 'rotation'
 *     finish()          실행 끝(경고 추가 등)
 *   i = 종목번호, t = 날짜번호, k = i * D + t. 모든 함수는 t까지의 값만 읽어야 한다(미래 참조 금지).
 *
 * 설계서와 다르게(또는 모호해서) 정한 점은 각 기법 주석의 [결정]에 적었다.
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var BT = isNode ? require('./engine.js') : root.BT;
  factory(BT);
  if (isNode) module.exports = BT;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (BT) {
  'use strict';

  // =====================================================================
  // 공통 변수 (설계서 5.2 그대로)
  // =====================================================================
  BT.commonSchema = [
    { group: '기간', items: [
      { key: 'startDate', label: '시작일', type: 'date', def: '자료 시작일 + 250거래일' },
      { key: 'endDate', label: '종료일', type: 'date', def: '자료 마지막 날' },
      { key: 'splitTest', label: '앞·뒤 구간 나눠 보기', type: 'bool', def: false }
    ] },
    { group: '대상 종목', items: [
      { key: 'market', label: '시장', type: 'select', def: 'ALL',
        options: [{ v: 'ALL', label: '전체' }, { v: 'KOSPI', label: '코스피' }, { v: 'KOSDAQ', label: '코스닥' }] },
      { key: 'minCapEok', label: '최소 시가총액', type: 'int', def: 1000, min: 300, max: 100000, step: 100, unit: '억' },
      { key: 'minAvgValEok', label: '최소 20일 평균 거래대금', type: 'int', def: 30, min: 0, max: 5000, step: 10, unit: '억' },
      { key: 'minPrice', label: '최소 주가', type: 'int', def: 1000, min: 0, max: 100000, step: 500, unit: '원' },
      { key: 'themeOnly', label: '테마 레이더 등장 종목만', type: 'bool', def: false }
    ] },
    { group: '자금', items: [
      { key: 'initCash', label: '시작 자금', type: 'int', def: 10000000, min: 1000000, max: 10000000000, step: 1000000, unit: '원' },
      { key: 'weightPct', label: '종목당 비중', type: 'pct', def: 10, min: 1, max: 100, step: 1 },
      { key: 'maxPositions', label: '최대 보유 종목 수', type: 'int', def: 10, min: 1, max: 50, step: 1 },
      { key: 'maxNewPerDay', label: '하루 최대 신규 매수', type: 'int', def: 5, min: 1, max: 50, step: 1 },
      { key: 'liqCapPct', label: '주문 한도(당일 거래대금 대비)', type: 'pct', def: 1, min: 0.1, max: 100, step: 0.1 },
      { key: 'cooldownDays', label: '청산 후 재매수 금지일', type: 'int', def: 0, min: 0, max: 60, step: 1, unit: '일' }
    ] },
    { group: '체결', items: [
      { key: 'entryFill', label: '매수 체결', type: 'select', def: 'nextOpen',
        options: [{ v: 'nextOpen', label: '다음 날 시가' }, { v: 'close', label: '당일 종가' }] },
      { key: 'exitFill', label: '매도 체결', type: 'select', def: 'nextOpen',
        options: [{ v: 'nextOpen', label: '다음 날 시가' }, { v: 'close', label: '당일 종가' }] }
    ] },
    { group: '비용', items: [
      { key: 'feePct', label: '수수료(편도)', type: 'pct', def: 0.015, min: 0, max: 0.5, step: 0.005 },
      { key: 'taxMode', label: '매도 거래세', type: 'select', def: 'byYear',
        options: [{ v: 'byYear', label: '연도별 실제 세율' }, { v: 'fixed', label: '직접 입력' }] },
      { key: 'taxPct', label: '거래세(직접 입력 시)', type: 'pct', def: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'slipPct', label: '슬리피지(편도)', type: 'pct', def: 0.1, min: 0, max: 2, step: 0.05 }
    ] },
    { group: '공통 청산 (0이면 끔)', items: [
      { key: 'stopPct', label: '손절', type: 'pct', def: 0, min: 0, max: 30, step: 0.5 },
      { key: 'takePct', label: '익절', type: 'pct', def: 0, min: 0, max: 200, step: 0.5 },
      { key: 'trailPct', label: '추적 손절(고점 대비)', type: 'pct', def: 0, min: 0, max: 50, step: 0.5 },
      { key: 'maxHoldDays', label: '최대 보유일', type: 'int', def: 0, min: 0, max: 250, step: 1, unit: '일' },
      { key: 'delistLossPct', label: '상장폐지 시 손실', type: 'pct', def: 100, min: 0, max: 100, step: 10 }
    ] },
    { group: '시장 필터', items: [
      { key: 'mktFilter', label: '지수 조건', type: 'select', def: 'off',
        options: [{ v: 'off', label: '사용 안 함' }, { v: 'above', label: '지수가 이평선 위일 때만 매수' }, { v: 'below', label: '지수가 이평선 아래일 때만 매수' }] },
      { key: 'mktIndex', label: '기준 지수', type: 'select', def: 'own',
        options: [{ v: 'own', label: '종목이 속한 시장' }, { v: 'KOSPI', label: '코스피' }, { v: 'KOSDAQ', label: '코스닥' }] },
      { key: 'mktMaN', label: '지수 이평선', type: 'int', def: 20, min: 5, max: 200, step: 5, unit: '일' }
    ] },
    { group: '비교 기준', items: [
      { key: 'bench', label: '비교 지수', type: 'select', def: 'KOSPI',
        options: [{ v: 'KOSPI', label: '코스피' }, { v: 'KOSDAQ', label: '코스닥' }] },
      { key: 'rfPct', label: '무위험 수익률(연)', type: 'pct', def: 2.5, min: 0, max: 10, step: 0.25 }
    ] }
  ];

  var G_DAY = '단타 (데이트레이딩)', G_SWING = '단기 스윙', G_BRK = '상승장 돌파', G_PULL = '상승장 눌림',
    G_LEAD = '주도주 추세매매', G_BEAR = '하락장 눌림 (낙폭 과대 반등)', G_ETC = '추천 추가';
  var LOCK_MINUTE = '분봉 준비 중';

  // =====================================================================
  // 1. 변동성 돌파
  // =====================================================================
  BT.register({
    key: 'volBreakout', no: 1, label: '변동성 돌파', group: G_DAY, needs: 'daily', kind: 'intraday',
    desc: "당일 가격이 '시가 + 전일 변동폭 × k'를 넘으면 사고, 다음 날 시가(또는 당일 종가)에 판다.",
    notes: ['후보가 자리보다 많으면 전일 거래대금 큰 순으로 채움(실제로는 먼저 돌파한 순서지만 일봉으로는 알 수 없음)'],
    commonDefaults: { weightPct: 10, maxPositions: 10, mktFilter: 'above', mktMaN: 5 },
    params: [
      { key: 'k', label: '돌파 계수 k', type: 'float', def: 0.5, min: 0.1, max: 1.0, step: 0.05, help: '전일 변동폭에 곱하는 값. 작을수록 자주 산다.' },
      { key: 'exitMode', label: '청산 시점', type: 'select', def: 'nextOpen',
        options: [{ v: 'nextOpen', label: '다음 날 시가' }, { v: 'sameClose', label: '당일 종가' }] },
      { key: 'minRangePct', label: '전일 변동폭 최소(전일 종가 대비)', type: 'pct', def: 2, min: 0, max: 15, step: 0.5 },
      { key: 'stockMaN', label: '종목 이평선 필터(0=끔)', type: 'int', def: 5, min: 0, max: 60, step: 1, unit: '일' }
    ],
    prepare: function (ctx) {
      var d = ctx.data, H = d.h, L = d.l, C = d.c, O = d.o, A = d.a, P = ctx.P;
      var kk = +P.k, minR = P.minRangePct / 100, ma = P.stockMaN > 0 ? ctx.I.sma('c', P.stockMaN | 0) : null, same = P.exitMode === 'sameClose';
      return {
        // 돌파가 = 당일 시가 + 전일 변동폭 × k (전일까지 값 + 당일 시가만 사용). 상한가 이상이면 살 수 없으므로 제외.
        trigger: function (i, t, k) {
          var r = H[k - 1] - L[k - 1], pc = C[k - 1];
          if (!(r > 0) || r / pc < minR) return 0;
          if (ma && !(pc > ma[k - 1])) return 0;
          var trig = O[k] + r * kk;
          return trig < pc * 1.295 ? trig : 0;
        },
        score: function (i, t, k) { return A[k - 1]; },
        exit: function () { return same ? 2 : 3; }
      };
    }
  });

  // =====================================================================
  // 2. 장 초반 범위 돌파(ORB) — 분봉 필요, 1차 잠금
  // =====================================================================
  BT.register({
    key: 'orb', no: 2, label: '장 초반 범위 돌파 (ORB)', group: G_DAY, needs: 'minute', locked: true, lockReason: LOCK_MINUTE,
    desc: '장 시작 후 처음 N분 동안의 고가를 넘어서면 사고, 당일 안에 판다. 일봉으로는 근사할 수 없어 분봉 확보 뒤 열린다(일봉판은 1번 변동성 돌파 참고).',
    params: [
      { key: 'rangeMin', label: '범위 시간', type: 'select', def: 15, options: [{ v: 5, label: '5분' }, { v: 15, label: '15분' }, { v: 30, label: '30분' }] },
      { key: 'valMult', label: '돌파 봉 거래대금 배수(범위 평균 대비)', type: 'float', def: 1.5, min: 1, max: 5, step: 0.25 },
      { key: 'stopMode', label: '손절 위치', type: 'select', def: 'rangeLow', options: [{ v: 'rangeLow', label: '범위 저가' }, { v: 'rangeMid', label: '범위 중간' }] },
      { key: 'tpR', label: '익절 배수(손절폭의 몇 배)', type: 'float', def: 2, min: 0.5, max: 5, step: 0.5 },
      { key: 'lastEntry', label: '신규 진입 마감', type: 'select', def: '11:00', options: [{ v: '10:00', label: '10시' }, { v: '11:00', label: '11시' }, { v: '13:00', label: '13시' }] },
      { key: 'pickFrom', label: '대상', type: 'select', def: 'prevTheme', options: [{ v: 'prevTheme', label: '전일 테마 레이더 등장 종목' }, { v: 'prevTop', label: '전일 거래대금 상위' }] }
    ]
  });

  // =====================================================================
  // 3. VWAP 눌림 매수 — 분봉 필요, 1차 잠금
  // =====================================================================
  BT.register({
    key: 'vwapPullback', no: 3, label: 'VWAP 눌림 매수', group: G_DAY, needs: 'minute', locked: true, lockReason: LOCK_MINUTE,
    desc: '강하게 오른 종목이 당일 거래량 가중 평균가(VWAP)까지 내려와 지지받을 때 산다. 가격이 VWAP에 닿은 시점을 일봉으로는 알 수 없어 분봉 확보 뒤 열린다.',
    params: [
      { key: 'minGainPct', label: '당일 상승률 조건(고가 기준)', type: 'pct', def: 5, min: 2, max: 25, step: 0.5 },
      { key: 'bandPct', label: 'VWAP 접근 허용폭', type: 'pct', def: 0.5, min: 0.1, max: 3, step: 0.1 },
      { key: 'stopPct', label: '손절(VWAP 아래)', type: 'pct', def: 1.5, min: 0.3, max: 5, step: 0.1 },
      { key: 'tpMode', label: '익절', type: 'select', def: 'dayHigh', options: [{ v: 'dayHigh', label: '당일 고가 재도달' }, { v: 'pct', label: '고정 %' }] },
      { key: 'tpPct', label: '고정 익절 %', type: 'pct', def: 3, min: 0.5, max: 15, step: 0.5 },
      { key: 'window', label: '진입 시간대', type: 'select', def: '0930-1430', options: [{ v: '0930-1130', label: '오전' }, { v: '0930-1430', label: '09:30~14:30' }] }
    ]
  });

  // =====================================================================
  // 4. 급등주 종가 매수(종가 베팅)
  // [결정] 보유일은 진입일 기준 h = t − 진입일. M = max(1, maxHoldDays).
  //   nextOpen  → 진입일 + M 번째 날 시가에 매도(M=1: 종가 매수 → 다음 날 시가)
  //   nextClose → 진입일 + M 번째 날 종가에 매도
  //   nextTarget→ 진입 다음 날부터 매일 목표가 지정가, 못 팔면 진입일 + M 번째 날 종가(사유 time)
  //   공통 최대 보유일(time)은 이 기법이 직접 처리한다(ownTime).
  // =====================================================================
  BT.register({
    key: 'closeBet', no: 4, label: '급등주 종가 매수 (종가 베팅)', group: G_SWING, needs: 'daily', ownTime: true,
    desc: '거래대금이 터지며 강하게 마감한 종목을 종가에 사서, 다음 날 시가·목표가·종가 중 정한 방식으로 판다.',
    commonDefaults: { entryFill: 'close', maxHoldDays: 1 },
    params: [
      { key: 'minChgPct', label: '당일 등락률 이상', type: 'pct', def: 7, min: 3, max: 29, step: 0.5 },
      { key: 'minValEok', label: '당일 거래대금 이상', type: 'int', def: 300, min: 50, max: 10000, step: 50, unit: '억' },
      { key: 'maxWickPct', label: '윗꼬리 비율 이하(고가−종가)/(고가−저가)', type: 'pct', def: 20, min: 0, max: 60, step: 5 },
      { key: 'exitMode', label: '청산 방식', type: 'select', def: 'nextOpen',
        options: [{ v: 'nextOpen', label: '다음 날 시가' }, { v: 'nextTarget', label: '다음 날 목표가(미달 시 종가)' }, { v: 'nextClose', label: '다음 날 종가' }] },
      { key: 'tpPct', label: '목표 수익(목표가 방식)', type: 'pct', def: 3, min: 0.5, max: 20, step: 0.5 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, H = d.h, L = d.l, C = d.c, A = d.a, G = d.chg, P = ctx.P;
      var minChg = +P.minChgPct, minVal = +P.minValEok, wick = P.maxWickPct / 100, mode = P.exitMode, tp = P.tpPct / 100;
      var M = Math.max(1, ctx.C.maxHoldDays | 0);
      return {
        entry: function (i, t, k) {
          var g = G[k], r = H[k] - L[k];
          if (!(g >= minChg) || g >= BT.LIMIT_PCT || !(A[k] >= minVal) || !(r > 0)) return NaN;
          if ((H[k] - C[k]) / r > wick) return NaN;
          return A[k];
        },
        onEntry: function (pos) { if (mode === 'nextOpen' && M <= 1 && pos.how === 'close') pos.pend = 'rule'; },
        limit: function (pos) { return mode === 'nextTarget' ? pos.inPx * (1 + tp) : 0; },
        exit: function (pos, t) {
          var h = t - pos.inT;
          if (mode === 'nextOpen') return h >= M - 1 ? 3 : 0;
          if (h >= M) { if (mode === 'nextTarget') pos.why = 'time'; return 2; }
          return 0;
        }
      };
    }
  });

  // =====================================================================
  // 5. RSI(2) 과매도 반등
  // =====================================================================
  BT.register({
    key: 'rsi2', no: 5, label: 'RSI(2) 과매도 반등', group: G_SWING, needs: 'daily',
    desc: '장기 상승 추세인 종목이 며칠 급락해 단기 RSI가 바닥일 때 사고, 단기 이평선 위로 회복하면 판다(코너스 기법).',
    commonDefaults: { maxHoldDays: 7 },
    params: [
      { key: 'rsiN', label: 'RSI 기간', type: 'int', def: 2, min: 2, max: 14, step: 1, unit: '일' },
      { key: 'rsiTh', label: '매수 기준(RSI 미만)', type: 'int', def: 10, min: 2, max: 40, step: 1 },
      { key: 'trendMa', label: '추세 이평선', type: 'int', def: 200, min: 60, max: 250, step: 10, unit: '일' },
      { key: 'exitMa', label: '청산 이평선', type: 'int', def: 5, min: 3, max: 20, step: 1, unit: '일' }
    ],
    prepare: function (ctx) {
      var C = ctx.data.c, P = ctx.P, rsi = ctx.I.rsi(P.rsiN | 0), tr = ctx.I.sma('c', P.trendMa | 0), ex = ctx.I.sma('c', P.exitMa | 0), th = +P.rsiTh;
      return {
        entry: function (i, t, k) { return (C[k] > tr[k] && rsi[k] < th) ? -rsi[k] : NaN; }, // RSI 낮은 순
        exit: function (pos, t, k) { return C[k] > ex[k] ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 6. 볼린저밴드 하단 반등
  // [결정] 후보 순위는 설계서에 없어 기본(거래대금 큰 순)을 쓴다. 밴드 지정가 매도 사유는 'rule', 고유 손절(slPct)은 'stop'.
  // =====================================================================
  BT.register({
    key: 'bbRebound', no: 6, label: '볼린저밴드 하단 반등', group: G_SWING, needs: 'daily', limitWhy: 'rule',
    desc: '종가가 볼린저밴드 하단 아래로 내려갔다가 다시 안으로 들어올 때 사고, 중심선(또는 상단)에서 판다.',
    commonDefaults: { maxHoldDays: 10 },
    params: [
      { key: 'n', label: '기간', type: 'int', def: 20, min: 10, max: 60, step: 1, unit: '일' },
      { key: 'k', label: '표준편차 배수', type: 'float', def: 2, min: 1, max: 3, step: 0.1 },
      { key: 'exitAt', label: '청산 위치', type: 'select', def: 'mid', options: [{ v: 'mid', label: '중심선' }, { v: 'upper', label: '상단 밴드' }] },
      { key: 'slPct', label: '손절(진입가 대비)', type: 'pct', def: 7, min: 0, max: 20, step: 0.5 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, C = d.c, A = d.a, P = ctx.P, n = P.n | 0, kk = +P.k, mid = ctx.I.sma('c', n), sd = ctx.I.std('c', n);
      var up = P.exitAt === 'upper', sl = P.slPct / 100;
      return {
        entry: function (i, t, k) {
          return (C[k - 1] < mid[k - 1] - kk * sd[k - 1] && C[k] > mid[k] - kk * sd[k]) ? A[k] : NaN;
        },
        onEntry: function (pos) { if (sl > 0) { var s = pos.inPx * (1 - sl); if (s > pos.stopPx) pos.stopPx = s; } },
        // 전일 밴드 값을 지정가로 걸어 둔 것으로 가정
        limit: function (pos, t, k) { return up ? mid[k - 1] + kk * sd[k - 1] : mid[k - 1]; }
      };
    }
  });

  // =====================================================================
  // 7. 52주 신고가 돌파
  // =====================================================================
  BT.register({
    key: 'newHigh', no: 7, label: '52주 신고가 돌파', group: G_BRK, needs: 'daily',
    desc: '종가가 1년(또는 26주) 최고가를 처음 넘는 날, 거래대금이 늘었으면 산다. 이평선 이탈이나 고점 대비 하락 시 판다.',
    commonDefaults: { mktFilter: 'above', mktMaN: 60 },
    params: [
      { key: 'lookback', label: '신고가 기간', type: 'select', def: 250, options: [{ v: 120, label: '26주' }, { v: 250, label: '52주' }] },
      { key: 'valMult', label: '거래대금 배수(20일 평균 대비)', type: 'float', def: 1.5, min: 1, max: 10, step: 0.25 },
      { key: 'exitMa', label: '청산 이평선(0=끔)', type: 'int', def: 20, min: 0, max: 120, step: 5, unit: '일' },
      { key: 'trail', label: '고점 대비 하락 청산(0=끔)', type: 'pct', def: 10, min: 0, max: 30, step: 1 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, C = d.c, A = d.a, P = ctx.P, hh = ctx.I.hh(P.lookback | 0), avgA = ctx.I.sma('a', 20);
      var vm = +P.valMult, ex = P.exitMa > 0 ? ctx.I.sma('c', P.exitMa | 0) : null, tr = P.trail / 100;
      return {
        entry: function (i, t, k) {
          if (!(C[k] > hh[k] && C[k - 1] <= hh[k - 1])) return NaN;   // 첫 돌파일만
          var av = avgA[k - 1];
          return (av > 0 && A[k] >= av * vm) ? A[k] / av : NaN;
        },
        exit: function (pos, t, k) {
          if (ex && C[k] < ex[k]) return 1;
          if (tr > 0 && C[k] <= pos.hiC * (1 - tr)) { pos.why = 'trail'; return 1; }
          return 0;
        }
      };
    }
  });

  // =====================================================================
  // 8. 박스권 돌파(터틀)
  // =====================================================================
  BT.register({
    key: 'turtle', no: 8, label: '박스권 돌파 (터틀)', group: G_BRK, needs: 'daily',
    desc: '종가가 최근 N일 최고가를 넘으면 사고, 최근 M일 최저가를 깨면 판다. 진입 때 ATR 배수로 손절가를 고정한다.',
    commonDefaults: { mktFilter: 'above', mktMaN: 60 },
    params: [
      { key: 'entryN', label: '진입 기간', type: 'int', def: 20, min: 10, max: 120, step: 5, unit: '일' },
      { key: 'exitN', label: '청산 기간', type: 'int', def: 10, min: 5, max: 60, step: 5, unit: '일' },
      { key: 'atrN', label: 'ATR 기간', type: 'int', def: 20, min: 5, max: 60, step: 1, unit: '일' },
      { key: 'atrMult', label: 'ATR 손절 배수(0=끔)', type: 'float', def: 2, min: 0, max: 5, step: 0.5 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, C = d.c, A = d.a, P = ctx.P, hh = ctx.I.hh(P.entryN | 0), ll = ctx.I.ll(P.exitN | 0);
      var am = +P.atrMult, atr = am > 0 ? ctx.I.atr(P.atrN | 0) : null;
      return {
        entry: function (i, t, k) {
          if (!(C[k] > hh[k] && C[k - 1] <= hh[k - 1])) return NaN;
          ctx.x = { atr: atr ? atr[k] : 0 };  // 신호일의 ATR
          return A[k];
        },
        // 손절가 = 진입가 − 배수 × ATR (고정). 공통 손절이 더 가까우면 그쪽을 쓴다.
        onEntry: function (pos) {
          if (am > 0 && pos.x && pos.x.atr > 0) { var s = pos.inPx - am * pos.x.atr; if (s > pos.stopPx) pos.stopPx = s; }
        },
        exit: function (pos, t, k) { return C[k] < ll[k] ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 9. 변동성 수축 후 돌파(VCP) — 단순화한 판정
  // [결정] 구간 경계는 t−baseN + round(j × baseN / segs). "52주 고가"는 당일 포함 최근 251일 고가의 최댓값이며
  //        자료가 120일 이상이면 있는 만큼으로 계산한다(상장 1년 미만 종목도 판정).
  // =====================================================================
  BT.register({
    key: 'vcp', no: 9, label: '변동성 수축 후 돌파 (VCP)', group: G_BRK, needs: 'daily',
    desc: '오른 뒤 등락 폭이 구간마다 줄어들며 쉬던 종목이 마지막 구간 고점을 거래대금과 함께 넘을 때 산다.',
    notes: ['VCP는 눈으로 보는 패턴을 구간 나누기 규칙으로 옮긴 단순화한 판정임'],
    commonDefaults: { mktFilter: 'above', mktMaN: 60, stopPct: 7 },
    params: [
      { key: 'baseN', label: '쉬는 구간 길이', type: 'int', def: 45, min: 20, max: 120, step: 5, unit: '일' },
      { key: 'segs', label: '수축 횟수(구간 수)', type: 'int', def: 3, min: 2, max: 4, step: 1 },
      { key: 'shrink', label: '다음 구간 폭 ≤ 이전 구간 폭 ×', type: 'float', def: 0.75, min: 0.4, max: 1, step: 0.05 },
      { key: 'lastDepthPct', label: '마지막 구간 폭 이하', type: 'pct', def: 10, min: 3, max: 20, step: 1 },
      { key: 'nearHighPct', label: '52주 고가 대비 위치 이상', type: 'pct', def: 75, min: 50, max: 95, step: 5 },
      { key: 'valMult', label: '돌파일 거래대금 배수', type: 'float', def: 1.5, min: 1, max: 10, step: 0.25 },
      { key: 'exitMa', label: '청산 이평선(0=끔)', type: 'int', def: 20, min: 0, max: 60, step: 5, unit: '일' }
    ],
    prepare: function (ctx) {
      var d = ctx.data, H = d.h, L = d.l, C = d.c, A = d.a, P = ctx.P, first = d.first;
      var baseN = P.baseN | 0, segs = P.segs | 0, shrink = +P.shrink, lastDepth = P.lastDepthPct / 100, near = P.nearHighPct / 100, vm = +P.valMult;
      var s60 = ctx.I.sma('c', 60), s120 = ctx.I.sma('c', 120), avgA = ctx.I.sma('a', 20), hi = ctx.I.roll('h', 251, true, 0, 120);
      var ex = P.exitMa > 0 ? ctx.I.sma('c', P.exitMa | 0) : null;
      return {
        entry: function (i, t, k) {
          var c = C[k], av = avgA[k - 1];
          if (!(c > s60[k] && s60[k] > s120[k])) return NaN;
          if (!(av > 0 && A[k] >= av * vm)) return NaN;
          if (!(c >= hi[k] * near)) return NaN;
          if (t - first[i] < baseN) return NaN;
          var prev = 0, pivot = 0, s, a, b, u, mx, mn, dd;
          for (s = 0; s < segs; s++) {
            a = k - baseN + Math.round(s * baseN / segs); b = k - baseN + Math.round((s + 1) * baseN / segs);
            mx = -Infinity; mn = Infinity;
            for (u = a; u < b; u++) { if (H[u] > mx) mx = H[u]; if (L[u] < mn) mn = L[u]; }
            dd = (mx - mn) / mx;
            if (s > 0 && !(dd <= prev * shrink)) return NaN;
            prev = dd; pivot = mx;
          }
          if (!(prev <= lastDepth)) return NaN;
          if (!(c > pivot && C[k - 1] <= pivot)) return NaN;
          return A[k] / av;
        },
        exit: function (pos, t, k) { return (ex && C[k] < ex[k]) ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 10. 20일선 눌림 매수
  // =====================================================================
  BT.register({
    key: 'ma20Pullback', no: 10, label: '20일선 눌림 매수', group: G_PULL, needs: 'daily',
    desc: '이평선이 정배열인 종목이 지지 이평선 근처까지 내려와 양봉으로 버틸 때 사고, 직전 고점에서 팔거나 이평선을 깨면 판다.',
    commonDefaults: { mktFilter: 'above', mktMaN: 20, maxHoldDays: 15 },
    params: [
      { key: 'maS', label: '단기 이평선', type: 'int', def: 5, min: 3, max: 10, step: 1, unit: '일' },
      { key: 'maM', label: '지지 이평선', type: 'int', def: 20, min: 10, max: 60, step: 5, unit: '일' },
      { key: 'maL', label: '장기 이평선', type: 'int', def: 60, min: 40, max: 200, step: 10, unit: '일' },
      { key: 'nearPct', label: '접근 허용폭(이평선 위 %)', type: 'pct', def: 2, min: 0, max: 5, step: 0.5 },
      { key: 'swingN', label: '직전 고점 기간', type: 'int', def: 20, min: 5, max: 60, step: 5, unit: '일' },
      { key: 'breakPct', label: '이탈 판정(이평선 아래 %)', type: 'pct', def: 0, min: 0, max: 5, step: 0.5 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, O = d.o, L = d.l, C = d.c, A = d.a, P = ctx.P;
      var s = ctx.I.sma('c', P.maS | 0), m = ctx.I.sma('c', P.maM | 0), l = ctx.I.sma('c', P.maL | 0), hh = ctx.I.hh(P.swingN | 0);
      var near = P.nearPct / 100, brk = P.breakPct / 100;
      return {
        entry: function (i, t, k) {
          var mm = m[k];
          if (!(s[k] > mm && mm > l[k])) return NaN;                 // 정배열
          if (!(L[k] <= mm * (1 + near) && C[k] >= mm && C[k] > O[k])) return NaN; // 이평선 근처 + 지지 + 양봉
          ctx.x = { target: hh[k] > 0 ? hh[k] : 0 };                 // 목표가 = 신호일 기준 직전 고점
          return A[k];
        },
        limit: function (pos) { return pos.x ? pos.x.target : 0; },
        exit: function (pos, t, k) { return C[k] < m[k] * (1 - brk) ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 11. 급등 후 첫 눌림(기준봉 지지)
  // [결정] 기준봉 = t 이전 maxDays일 안에서 가장 최근 기준봉(새 기준봉이 나오면 교체). 당일이 기준봉이면 진입하지 않는다.
  //        "기준봉 하나당 한 번"은 후보로 뽑힌 시점에 소진한 것으로 본다(체결 여부와 무관 — 결과가 자금 상태에 좌우되지 않게).
  //        후보 순위는 기준봉 거래대금 큰 순.
  // =====================================================================
  BT.register({
    key: 'pivotBar', no: 11, label: '급등 후 첫 눌림 (기준봉 지지)', group: G_PULL, needs: 'daily',
    desc: '거래대금이 터진 장대양봉(기준봉) 뒤, 거래대금이 줄며 내려와 기준봉 지지선에서 버틸 때 산다. 기준봉 고가에서 익절, 저가 이탈 시 손절.',
    notes: ['기준봉·지지선 판정은 설계서에서 정한 단순화 규칙임'],
    commonDefaults: { maxHoldDays: 10 },
    params: [
      { key: 'sigChgPct', label: '기준봉 등락률 이상', type: 'pct', def: 10, min: 5, max: 29, step: 1 },
      { key: 'sigValMult', label: '기준봉 거래대금 배수', type: 'float', def: 3, min: 1.5, max: 20, step: 0.5 },
      { key: 'minDays', label: '눌림 최소 일수', type: 'int', def: 2, min: 1, max: 5, step: 1, unit: '일' },
      { key: 'maxDays', label: '눌림 최대 일수', type: 'int', def: 7, min: 3, max: 15, step: 1, unit: '일' },
      { key: 'support', label: '지지 기준', type: 'select', def: 'mid',
        options: [{ v: 'mid', label: '기준봉 몸통 중간' }, { v: 'open', label: '기준봉 시가' }, { v: 'hl', label: '기준봉 고가·저가 중간' }] },
      { key: 'tolPct', label: '지지선 접근 허용폭', type: 'pct', def: 1, min: 0, max: 5, step: 0.5 },
      { key: 'dryRatio', label: '눌림일 거래대금 ≤ 기준봉 ×', type: 'float', def: 0.5, min: 0.1, max: 1, step: 0.1 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, D = ctx.D, O = d.o, H = d.h, L = d.l, C = d.c, A = d.a, G = d.chg, P = ctx.P, first = d.first;
      var sigChg = +P.sigChgPct, sigMult = +P.sigValMult, minD = P.minDays | 0, maxD = P.maxDays | 0, tol = P.tolPct / 100, dry = +P.dryRatio, sup = P.support;
      var avgA = ctx.I.sma('a', 20);
      var used = new Int32Array(d.NR).fill(-1); // 종목별로 이미 쓴 기준봉의 날짜번호
      function isSig(k) { return G[k] >= sigChg && C[k] > O[k] && avgA[k - 1] > 0 && A[k] >= avgA[k - 1] * sigMult; }
      return {
        entry: function (i, t, k) {
          if (isSig(k)) return NaN;
          var lo = Math.max(first[i] + 1, t - maxD), s = -1, u;
          for (u = t - 1; u >= lo; u--) if (isSig(i * D + u)) { s = u; break; }
          if (s < 0 || t - s < minD || used[i] === s) return NaN;
          var ks = i * D + s, line = sup === 'open' ? O[ks] : (sup === 'hl' ? (H[ks] + L[ks]) / 2 : (O[ks] + C[ks]) / 2);
          for (u = s + 1; u < t; u++) if (C[i * D + u] < line) return NaN;  // 그 사이 지지선 아래로 마감한 적 없음
          if (!(L[k] <= line * (1 + tol) && C[k] >= line)) return NaN;
          if (!(A[k] <= A[ks] * dry)) return NaN;
          used[i] = s;
          ctx.x = { tgt: H[ks], cut: L[ks], sig: s };
          return A[ks];
        },
        limit: function (pos) { return pos.x ? pos.x.tgt : 0; },                       // 기준봉 고가에 익절
        exit: function (pos, t, k) { return (pos.x && C[k] < pos.x.cut) ? 1 : 0; }      // 종가가 기준봉 저가 아래 → 손절
      };
    }
  });

  // =====================================================================
  // 12. 추세 중 스토캐스틱 과매도
  // =====================================================================
  BT.register({
    key: 'stochPullback', no: 12, label: '추세 중 스토캐스틱 과매도', group: G_PULL, needs: 'daily',
    desc: '추세 이평선 위에 있는 종목의 스토캐스틱 %K가 과매도 구간에서 %D를 위로 넘을 때 산다. 과매수 도달이나 목표 수익에 판다.',
    commonDefaults: { mktFilter: 'above', mktMaN: 20, maxHoldDays: 10 },
    params: [
      { key: 'kN', label: '%K 기간', type: 'int', def: 14, min: 5, max: 21, step: 1, unit: '일' },
      { key: 'kSmooth', label: '%K 평활', type: 'int', def: 3, min: 1, max: 5, step: 1, unit: '일' },
      { key: 'dN', label: '%D 기간', type: 'int', def: 3, min: 2, max: 9, step: 1, unit: '일' },
      { key: 'osTh', label: '과매도 기준', type: 'int', def: 20, min: 5, max: 40, step: 5 },
      { key: 'obTh', label: '과매수 기준', type: 'int', def: 80, min: 60, max: 95, step: 5 },
      { key: 'trendMa', label: '추세 이평선', type: 'int', def: 60, min: 20, max: 200, step: 10, unit: '일' },
      { key: 'tpPct', label: '목표 수익(0=끔)', type: 'pct', def: 10, min: 0, max: 50, step: 1 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, C = d.c, A = d.a, P = ctx.P, st = ctx.I.stoch(P.kN | 0, P.kSmooth | 0, P.dN | 0), K = st.K, Dm = st.D;
      var tr = ctx.I.sma('c', P.trendMa | 0), os = +P.osTh, ob = +P.obTh, tp = P.tpPct / 100;
      return {
        entry: function (i, t, k) {
          return (C[k] > tr[k] && K[k - 1] < os && K[k - 1] <= Dm[k - 1] && K[k] > Dm[k]) ? A[k] : NaN;
        },
        limit: function (pos) { return tp > 0 ? pos.inPx * (1 + tp) : 0; },
        exit: function (pos, t, k) { return K[k] >= ob ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 13. 주도 테마 대장주 추세매매 — extras.theme = FRAME_DETAIL (설계서 4.6)
  // [결정] 대장주는 상위 leadersPerTheme개를 먼저 뽑고, 그중 종목코드로 못 바꾼 종목은 뺀다(다음 순위로 채우지 않음).
  //        검증 시작일 기본값은 테마 데이터 첫 날. 테마 순위는 장 마감 뒤에 나오므로 매수는 다음 날 시가로 고정.
  // =====================================================================
  BT.register({
    key: 'themeLeader', no: 13, label: '주도 테마 대장주 추세매매', group: G_LEAD, needs: 'theme',
    desc: '테마 레이더에서 최근 N일 중 M번 이상 1~3위에 든 테마의 대장주를 다음 날 시가에 사서 단기 이평선을 깰 때까지 보유한다.',
    notes: [
      '테마 분류는 다음 날 소급 검증으로 고쳐지고 과거 날짜는 나중에 채운 것이라, 그날 저녁에 알 수 있었던 정보와 다를 수 있음(사후 보정 한계)',
      '테마에는 거래대금·등락률 스크리닝을 통과한 종목만 들어 있어 "스크리닝 통과 종목 안에서의 대장주"임',
      '검증 기간이 테마 데이터가 있는 날짜로 제한됨'
    ],
    commonDefaults: { minCapEok: 300, minAvgValEok: 0, maxPositions: 5, weightPct: 20 },
    fixed: { entryFill: 'nextOpen' },
    params: [
      { key: 'lookN', label: '최근 N거래일', type: 'int', def: 5, min: 1, max: 20, step: 1, unit: '일' },
      { key: 'minHits', label: '그중 상위권에 든 횟수 이상', type: 'int', def: 3, min: 1, max: 20, step: 1, unit: '회' },
      { key: 'rankMax', label: '상위권 기준(몇 위까지)', type: 'int', def: 3, min: 1, max: 3, step: 1, unit: '위' },
      { key: 'leaderBy', label: '대장주 선정', type: 'select', def: 'dayValue',
        options: [{ v: 'dayValue', label: '당일 테마 내 거래대금 1위' }, { v: 'sumValue', label: '최근 N일 누적 거래대금 1위' }, { v: 'dayChange', label: '당일 테마 내 등락률 1위' }] },
      { key: 'leadersPerTheme', label: '테마당 종목 수', type: 'int', def: 1, min: 1, max: 3, step: 1 },
      { key: 'exitMa', label: '청산 이평선', type: 'select', def: 5, options: [{ v: 5, label: '5일선' }, { v: 10, label: '10일선' }, { v: 20, label: '20일선' }] }
    ],
    defaultStart: function (data, extras) {
      var ks = Object.keys((extras && extras.theme) || {}).sort();
      return ks.length ? ks[0] : null;
    },
    prepare: function (ctx) {
      var d = ctx.data, D = ctx.D, C = d.c, P = ctx.P, theme = ctx.extras.theme, n2t = d.nameToTicker, tkIdx = d.tkIdx;
      var lookN = P.lookN | 0, minHits = P.minHits | 0, rankMax = P.rankMax | 0, by = P.leaderBy, per = P.leadersPerTheme | 0;
      var ex = ctx.I.sma('c', +P.exitMa | 0);
      var dayGroups = new Array(D), t0;
      Object.keys(theme).forEach(function (dt) { var t = d.dIdx[dt]; if (t != null) dayGroups[t] = theme[dt].groups || []; });
      var score = new Float64Array(d.NR).fill(NaN), touched = [], miss = {}, missN = 0;
      function groupOf(t, name) { var gs = dayGroups[t], j; if (!gs) return null; for (j = 0; j < gs.length; j++) if (gs[j].theme === name) return gs[j]; return null; }
      return {
        dayGate: function (t) {
          var j, u, g, any = false;
          for (j = 0; j < touched.length; j++) score[touched[j]] = NaN;
          touched.length = 0;
          var gs = dayGroups[t]; if (!gs) return false;
          for (j = 0; j < gs.length; j++) {
            g = gs[j];
            if (!(g.rank <= rankMax)) continue;
            var hits = 0, og;
            for (u = t; u > t - lookN && u >= 0; u--) { og = groupOf(u, g.theme); if (og && og.rank <= rankMax) hits++; }
            if (hits < minHits) continue;
            var list = (g.stocks || []).map(function (s) {
              var v = s.value;
              if (by === 'dayChange') v = s.change;
              else if (by === 'sumValue') {
                v = 0;
                for (var w = t; w > t - lookN && w >= 0; w--) {
                  var q = groupOf(w, g.theme); if (!q) continue;
                  for (var z = 0; z < q.stocks.length; z++) if (q.stocks[z].name === s.name) { v += q.stocks[z].value; break; }
                }
              }
              return { name: s.name, key: v, value: s.value };
            }).sort(function (a, b) { return b.key - a.key; }).slice(0, per);
            list.forEach(function (s) {
              var tk = n2t[s.name], i = tk != null ? tkIdx[tk] : null;
              if (i == null) { if (!miss[s.name]) { miss[s.name] = 1; missN++; } return; }
              var sc = (10 - g.rank) * 1e7 + s.value;      // 테마 순위 → 종목 거래대금 순
              if (!(score[i] >= sc)) { if (score[i] !== score[i]) touched.push(i); score[i] = sc; any = true; }
            });
          }
          return any;
        },
        entry: function (i) { return score[i]; },
        exit: function (pos, t, k) { return C[k] < ex[k] ? 1 : 0; },
        finish: function () {
          if (missN) ctx.warnings.push('종목코드로 바꾸지 못해 제외한 대장주 ' + missN + '종목: ' + Object.keys(miss).slice(0, 10).join(', ') + (missN > 10 ? ' 등' : ''));
        }
      };
    }
  });

  // =====================================================================
  // 14. 상대강도 상위 종목 회전
  // [결정] 재조정일의 대상 종목 조건은 다른 기법과 같이 t−1까지 값으로 판정. 자리 수(최대 보유)는 topK가 공통 maxPositions를 대신한다.
  //        체결이 무산될 때를 대비해 매수 후보는 빈 자리보다 5개 더 넘기고, 엔진이 topK까지만 채운다.
  // =====================================================================
  BT.register({
    key: 'rsRotation', no: 14, label: '상대강도 상위 종목 회전', group: G_LEAD, needs: 'daily', kind: 'rotation', sizing: 'equal',
    desc: '최근 수익률이 가장 높은 종목 K개를 같은 금액으로 보유하고, 주기마다 순위를 다시 매겨 갈아탄다.',
    notes: ['회전형: 종목당 금액 = 총자산 / 보유 종목 수(공통 변수의 종목당 비중·최대 보유 종목 수는 쓰지 않음)'],
    params: [
      { key: 'lookD', label: '수익률 기간', type: 'int', def: 60, min: 20, max: 250, step: 5, unit: '거래일' },
      { key: 'skipD', label: '최근 제외 일수', type: 'int', def: 0, min: 0, max: 20, step: 5, unit: '거래일' },
      { key: 'topK', label: '보유 종목 수', type: 'int', def: 10, min: 3, max: 30, step: 1 },
      { key: 'rebalD', label: '재조정 주기', type: 'select', def: 5, options: [{ v: 5, label: '1주' }, { v: 10, label: '2주' }, { v: 20, label: '4주' }] },
      { key: 'keepMult', label: '보유 유지 범위(상위 K의 몇 배까지)', type: 'float', def: 1.5, min: 1, max: 3, step: 0.25 }
    ],
    prepare: function (ctx) {
      var d = ctx.data, D = ctx.D, N = ctx.N, C = d.c, P = ctx.P, first = d.first;
      var look = P.lookD | 0, skip = P.skipD | 0, topK = P.topK | 0, reb = +P.rebalD | 0, keepN = Math.floor(topK * (+P.keepMult));
      var rank = new Int32Array(d.NR);
      return {
        rebalance: function (t, positions) {
          if ((t - ctx.startT) % reb !== 0) return null;
          var arr = [], i, k, a, b;
          for (i = 0; i < N; i++) {
            if (t - skip - look < first[i] || first[i] < 0 || !ctx.univ(i, t)) continue;
            k = i * D + t; a = C[k - skip]; b = C[k - skip - look];
            if (a > 0 && b > 0) arr.push({ i: i, s: a / b - 1 });
          }
          arr.sort(function (x, y) { return (y.s - x.s) || (x.i - y.i); });
          rank.fill(1e9);
          arr.forEach(function (x, n) { rank[x.i] = n + 1; });
          var sell = positions.filter(function (p) { return rank[p.i] > keepN; });
          var free = topK - (positions.length - sell.length), buy = [];
          for (i = 0; i < arr.length && buy.length < free + 5; i++) if (!positions.some(function (p) { return p.i === arr[i].i; })) buy.push(arr[i].i);
          return { sell: sell, buy: free > 0 ? buy : [], slots: topK };
        }
      };
    }
  });

  // =====================================================================
  // 15. 이평선 정배열 추세추종
  // =====================================================================
  BT.register({
    key: 'maCross', no: 15, label: '이평선 정배열 추세추종', group: G_LEAD, needs: 'daily',
    desc: '단기선이 장기선을 위로 뚫는 골든크로스에 사고, 데드크로스에 판다.',
    params: [
      { key: 'fastN', label: '단기 이평선', type: 'int', def: 5, min: 3, max: 60, step: 1, unit: '일' },
      { key: 'slowN', label: '장기 이평선', type: 'int', def: 20, min: 10, max: 200, step: 5, unit: '일' },
      { key: 'maType', label: '이평선 종류', type: 'select', def: 'SMA', options: [{ v: 'SMA', label: '단순' }, { v: 'EMA', label: '지수' }] },
      { key: 'needRising', label: '장기선 상승 중일 때만', type: 'bool', def: true }
    ],
    prepare: function (ctx) {
      var d = ctx.data, A = d.a, P = ctx.P, fn = P.fastN | 0, sn = P.slowN | 0;
      if (!(fn < sn)) throw new Error('단기 이평선은 장기 이평선보다 짧아야 합니다');
      var ma = P.maType === 'EMA' ? ctx.I.ema : ctx.I.sma, f = ma('c', fn), s = ma('c', sn), rising = !!P.needRising;
      return {
        entry: function (i, t, k) {
          if (!(f[k - 1] <= s[k - 1] && f[k] > s[k])) return NaN;
          if (rising && !(t >= 5 && s[k] > s[k - 5])) return NaN;
          return A[k];
        },
        exit: function (pos, t, k) { return f[k] < s[k] ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 16. 이격도 과매도 반등
  // =====================================================================
  BT.register({
    key: 'disparity', no: 16, label: '이격도 과매도 반등', group: G_BEAR, needs: 'daily',
    desc: '가격이 이평선에서 크게 아래로 벌어졌을 때 사서, 이평선 쪽으로 되돌아오면 판다.',
    commonDefaults: { mktFilter: 'below', mktMaN: 20, maxHoldDays: 7, stopPct: 10 },
    params: [
      { key: 'maN', label: '이평선 기간', type: 'int', def: 20, min: 5, max: 120, step: 5, unit: '일' },
      { key: 'entryDisp', label: '진입 이격도 이하', type: 'float', def: 90, min: 70, max: 98, step: 1 },
      { key: 'exitDisp', label: '청산 이격도 이상', type: 'float', def: 98, min: 90, max: 105, step: 1 },
      { key: 'needUpBar', label: '양봉일 때만 매수', type: 'bool', def: false }
    ],
    prepare: function (ctx) {
      var d = ctx.data, O = d.o, C = d.c, P = ctx.P, ma = ctx.I.sma('c', P.maN | 0), en = +P.entryDisp, ex = +P.exitDisp, up = !!P.needUpBar;
      return {
        entry: function (i, t, k) {
          var disp = C[k] / ma[k] * 100;
          if (!(disp <= en) || (up && !(C[k] > O[k]))) return NaN;
          return -disp;                                   // 이격도 낮은 순
        },
        exit: function (pos, t, k) { return C[k] / ma[k] * 100 >= ex ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 17. 급락일 버틴 종목 매수 — 지수 사용
  // [결정] hold: 보유일(시가 매수일 = 1일째)이 holdDays에 닿은 날 종가 뒤 매도 → 기본 체결이면 holdDays일 보유 후 다음 날 시가.
  //        idxRecover의 지수: '둘 중 하나라도'면 종목이 속한 시장의 지수.
  // =====================================================================
  BT.register({
    key: 'crashSurvivor', no: 17, label: '급락일 버틴 종목 매수', group: G_BEAR, needs: 'index',
    desc: '지수가 크게 빠진 날에도 오르거나 덜 빠진 종목을 사서, 지수 반등 때 먼저 오르는 것을 노린다.',
    notes: ['급락일이 드물어 거래 수가 모자랄 수 있음'],
    commonDefaults: { maxPositions: 5, weightPct: 20, minAvgValEok: 50 },
    params: [
      { key: 'idx', label: '기준 지수', type: 'select', def: 'KOSDAQ', options: [{ v: 'KOSPI', label: '코스피' }, { v: 'KOSDAQ', label: '코스닥' }, { v: 'either', label: '둘 중 하나라도' }] },
      { key: 'dropPct', label: '지수 등락률 이하', type: 'pct', def: -2, min: -10, max: -0.5, step: 0.5 },
      { key: 'minChgPct', label: '종목 등락률 이상', type: 'pct', def: 0, min: -3, max: 15, step: 0.5 },
      { key: 'minValEok', label: '당일 거래대금 이상', type: 'int', def: 100, min: 10, max: 5000, step: 10, unit: '억' },
      { key: 'pickN', label: '선정 종목 수', type: 'int', def: 5, min: 1, max: 20, step: 1 },
      { key: 'exitMode', label: '청산 방식', type: 'select', def: 'hold',
        options: [{ v: 'hold', label: '고정 보유일' }, { v: 'idxRecover', label: '지수 5일선 회복 후 N일' }, { v: 'stockMa', label: '종목 5일선 이탈' }] },
      { key: 'holdDays', label: '보유일(N)', type: 'int', def: 5, min: 1, max: 20, step: 1, unit: '일' }
    ],
    prepare: function (ctx) {
      var d = ctx.data, D = ctx.D, C = d.c, A = d.a, G = d.chg, P = ctx.P;
      var names = ['KOSPI', 'KOSDAQ'], ic = names.map(function (n) { return d.idx[n].c; }), ima = ic.map(function (c) { return BT.series.sma(c, 5); });
      var drop = +P.dropPct, minChg = +P.minChgPct, minVal = +P.minValEok, mode = P.exitMode, hold = P.holdDays | 0;
      var which = P.idx === 'KOSPI' ? 0 : (P.idx === 'KOSDAQ' ? 1 : -1), ma5 = mode === 'stockMa' ? ctx.I.sma('c', 5) : null;
      function idxChg(q, t) { return t > 0 ? (ic[q][t] / ic[q][t - 1] - 1) * 100 : NaN; }
      return {
        dayGate: function (t) { return which >= 0 ? idxChg(which, t) <= drop : (idxChg(0, t) <= drop || idxChg(1, t) <= drop); },
        maxCand: P.pickN | 0,
        entry: function (i, t, k) { var g = G[k]; return (g >= minChg && g < BT.LIMIT_PCT && A[k] >= minVal) ? g : NaN; },
        exit: function (pos, t, k) {
          if (mode === 'stockMa') return C[k] < ma5[k] ? 1 : 0;
          if (mode === 'hold') { if (t - pos.d0 >= hold) { pos.why = 'time'; return 1; } return 0; }
          var q = which >= 0 ? which : d.mkt[pos.i];
          if (!pos.x) pos.x = { rec: -1 };
          if (pos.x.rec < 0 && ic[q][t] > ima[q][t]) pos.x.rec = t;      // 지수가 5일선을 회복한 첫날
          if (pos.x.rec >= 0 && t - pos.x.rec >= hold) { pos.why = 'time'; return 1; }
          return 0;
        }
      };
    }
  });

  // =====================================================================
  // 18. MACD 시그널 교차
  // =====================================================================
  BT.register({
    key: 'macd', no: 18, label: 'MACD 시그널 교차', group: G_ETC, needs: 'daily',
    desc: 'MACD선이 시그널선을 위로 넘으면 사고, 아래로 내려가면 판다.',
    params: [
      { key: 'fast', label: '단기', type: 'int', def: 12, min: 5, max: 30, step: 1, unit: '일' },
      { key: 'slow', label: '장기', type: 'int', def: 26, min: 15, max: 60, step: 1, unit: '일' },
      { key: 'sig', label: '시그널', type: 'int', def: 9, min: 3, max: 20, step: 1, unit: '일' },
      { key: 'zeroFilter', label: '0선 조건', type: 'select', def: 'off',
        options: [{ v: 'off', label: '사용 안 함' }, { v: 'above', label: '0선 위에서만' }, { v: 'below', label: '0선 아래에서만' }] }
    ],
    prepare: function (ctx) {
      var A = ctx.data.a, P = ctx.P;
      if (!((P.fast | 0) < (P.slow | 0))) throw new Error('MACD 단기 기간은 장기 기간보다 짧아야 합니다');
      var mc = ctx.I.macd(P.fast | 0, P.slow | 0, P.sig | 0), m = mc.macd, s = mc.signal, z = P.zeroFilter;
      return {
        entry: function (i, t, k) {
          if (!(m[k - 1] <= s[k - 1] && m[k] > s[k])) return NaN;
          if ((z === 'above' && !(m[k] > 0)) || (z === 'below' && !(m[k] < 0))) return NaN;
          return A[k];
        },
        exit: function (pos, t, k) { return m[k] < s[k] ? 1 : 0; }
      };
    }
  });

  // =====================================================================
  // 19. 외국인·기관 연속 순매수 추종 — 종목별 수급 사용
  // [결정] '둘 다 동시에': 진입은 외국인·기관이 각각 nDays 연속 순매수(둘 중 늦은 쪽이 nDays를 처음 채운 날),
  //        누적 순매수·순매도 전환 판정은 외국인+기관 합계로 한다.
  //        시가총액은 전월 말 값(capQ). 시가총액 자료가 없으면 비율 조건을 건너뛰고 경고.
  // =====================================================================
  BT.register({
    key: 'flowFollow', no: 19, label: '외국인·기관 연속 순매수 추종', group: G_ETC, needs: 'flow',
    desc: '외국인이나 기관이 며칠 연속 사들이는 종목을 다음 날 시가에 따라 산다. 순매도 전환이나 이평선 이탈에 판다.',
    commonDefaults: { maxHoldDays: 15 },
    fixed: { entryFill: 'nextOpen' },
    params: [
      { key: 'who', label: '주체', type: 'select', def: 'frg',
        options: [{ v: 'frg', label: '외국인' }, { v: 'ins', label: '기관' }, { v: 'both', label: '둘 다 동시에' }, { v: 'sum', label: '외국인+기관 합계' }] },
      { key: 'nDays', label: '연속 순매수 일수', type: 'int', def: 3, min: 2, max: 10, step: 1, unit: '일' },
      { key: 'minCapRatioPct', label: '누적 순매수 / 시가총액 이상', type: 'pct', def: 0.1, min: 0, max: 3, step: 0.05 },
      { key: 'exitMode', label: '청산 방식', type: 'select', def: 'flip', options: [{ v: 'flip', label: '순매도 전환' }, { v: 'ma', label: '이평선 이탈' }, { v: 'either', label: '둘 중 먼저' }] },
      { key: 'sellDays', label: '순매도 연속 일수', type: 'int', def: 2, min: 1, max: 5, step: 1, unit: '일' },
      { key: 'exitMa', label: '청산 이평선', type: 'int', def: 20, min: 5, max: 60, step: 5, unit: '일' }
    ],
    prepare: function (ctx) {
      var d = ctx.data, D = ctx.D, C = d.c, P = ctx.P, F = d.frg, Ins = d.ins, who = P.who;
      var nD = P.nDays | 0, ratio = P.minCapRatioPct / 100, mode = P.exitMode, sellD = P.sellDays | 0, ma = ctx.I.sma('c', P.exitMa | 0);
      var cap = d.cap, NM = d.NM, monthOf = d.monthOf;
      if (!cap && ratio > 0) ctx.warnings.push('시가총액 자료가 없어 "누적 순매수 / 시가총액" 조건을 적용하지 못함');
      // 수급 조각이 없는 달은 순매수가 0으로 들어 있어 신호가 나지 않는다 → 검증 기간에 그런 달이 있으면 알린다
      var noFlow = [], fm = d.flowMonths || [], tt, ym;
      for (tt = ctx.startT; tt <= ctx.endT; tt++) { ym = d.dates[tt].slice(0, 7); if (fm.indexOf(ym) < 0 && noFlow.indexOf(ym) < 0) noFlow.push(ym); }
      if (noFlow.length) ctx.warnings.push('검증 기간 중 수급 자료가 없는 달 ' + noFlow.length + '개(' + noFlow[0] + ' ~ ' + noFlow[noFlow.length - 1] + ')는 신호가 나지 않음');
      function net(k) { return who === 'frg' ? F[k] : (who === 'ins' ? Ins[k] : F[k] + Ins[k]); }
      // 연속 순매수·순매도 일수(오늘 포함)
      var runs = ctx.I.custom('flowRuns:' + who, function () {
        var up = new Int16Array(d.NR * D), dn = new Int16Array(d.NR * D);
        ctx.I.eachRow(function (s, e) {
          var a = 0, b = 0, c = 0, k, v;
          for (k = s; k < e; k++) {
            v = net(k);
            if (who === 'both') {      // up = min(외국인 연속, 기관 연속)
              a = F[k] > 0 ? a + 1 : 0; b = Ins[k] > 0 ? b + 1 : 0; up[k] = Math.min(a, b, 32000);
            } else { a = v > 0 ? a + 1 : 0; up[k] = Math.min(a, 32000); }
            c = v < 0 ? c + 1 : 0; dn[k] = Math.min(c, 32000);
          }
        });
        return { up: up, dn: dn };
      });
      var up = runs.up, dn = runs.dn;
      return {
        entry: function (i, t, k) {
          if (up[k] !== nD) return NaN;                 // 연속 조건을 처음 채운 날만
          var sum = 0, u;
          for (u = k - nD + 1; u <= k; u++) sum += net(u);
          if (!cap) return sum;
          var cp = cap[i * NM + monthOf[t]];
          if (!(cp > 0)) return NaN;
          return sum / cp >= ratio ? sum / cp : NaN;    // 누적 순매수 / 시가총액 큰 순
        },
        exit: function (pos, t, k) {
          if (mode !== 'ma' && dn[k] >= sellD) return 1;
          if (mode !== 'flip' && C[k] < ma[k]) return 1;
          return 0;
        }
      };
    }
  });

  // =====================================================================
  // 20. 듀얼 모멘텀 — 지수 모드·"전부 현금" 조건은 지수 사용
  // [결정] 재조정일 = 그 달 마지막 거래일(다음 거래일의 달이 다름). 분기 주기는 3·6·9·12월 말.
  //        지수 모드는 지수 일봉을 가상 종목으로 사고판다(다음 날 지수 시가 체결, 수수료·슬리피지 적용, 거래세 없음).
  // =====================================================================
  BT.register({
    key: 'dualMomentum', no: 20, label: '듀얼 모멘텀', group: G_ETC, needs: 'daily', kind: 'rotation', sizing: 'equal',
    desc: '매월 말 수익률이 높은 쪽(종목·지수)을 고르되, 그 수익률이 기준 이하면 현금으로 쉰다.',
    notes: ['회전형: 종목당 금액 = 총자산 / 보유 수. 월 1회 거래라 재조정 횟수가 적음'],
    params: [
      { key: 'assets', label: '대상', type: 'select', def: 'stocks', options: [{ v: 'stocks', label: '종목' }, { v: 'index', label: '지수(코스피·코스닥 중 강한 쪽)' }] },
      { key: 'lookM', label: '수익률 기간', type: 'select', def: 6, options: [{ v: 3, label: '3개월' }, { v: 6, label: '6개월' }, { v: 12, label: '12개월' }] },
      { key: 'topK', label: '보유 수(종목 모드)', type: 'int', def: 5, min: 1, max: 30, step: 1 },
      { key: 'rebalM', label: '재조정 주기', type: 'select', def: 1, options: [{ v: 1, label: '매월' }, { v: 3, label: '분기' }] },
      { key: 'absTh', label: '절대 모멘텀 기준(수익률 초과)', type: 'pct', def: 0, min: -5, max: 10, step: 0.5 },
      { key: 'mktAbs', label: '지수 수익률이 기준 이하면 전부 현금', type: 'bool', def: false }
    ],
    prepare: function (ctx) {
      var d = ctx.data, D = ctx.D, N = ctx.N, C = d.c, P = ctx.P, first = d.first, dates = d.dates;
      var isIdx = P.assets === 'index', lb = (+P.lookM | 0) * 21, topK = isIdx ? 1 : (P.topK | 0), rebM = +P.rebalM | 0, th = P.absTh / 100, mktAbs = !!P.mktAbs;
      if ((isIdx || mktAbs) && !d.idx) throw new Error('지수 자료가 없어 듀얼 모멘텀의 지수 조건을 쓸 수 없습니다');
      if (isIdx) ctx.warnings.push('지수 모드: 지수 값을 그대로 사고판 것으로 계산(ETF 추적 오차·보수 미반영)');
      var bench = d.idx ? d.idx[ctx.C.bench === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI'].c : null;
      function mom(row, t) { var k = row * D + t; return (t - lb >= first[row] && first[row] >= 0 && C[k - lb] > 0) ? C[k] / C[k - lb] - 1 : NaN; }
      return {
        rebalance: function (t, positions) {
          if (t + 1 >= D || dates[t + 1].slice(0, 7) === dates[t].slice(0, 7)) return null;
          if (rebM === 3 && (+dates[t].slice(5, 7)) % 3 !== 0) return null;
          var targets = [], i, m;
          var cashOut = mktAbs && !(t - lb >= 0 && bench[t] / bench[t - lb] - 1 > th);
          if (!cashOut) {
            if (isIdx) {
              var m0 = mom(N, t), m1 = mom(N + 1, t), best = (m1 > m0 || m0 !== m0) ? N + 1 : N, bm = best === N ? m0 : m1;
              if (bm > th) targets.push(best);
            } else {
              var arr = [];
              for (i = 0; i < N; i++) { if (!ctx.univ(i, t)) continue; m = mom(i, t); if (m === m) arr.push({ i: i, s: m }); }
              arr.sort(function (x, y) { return (y.s - x.s) || (x.i - y.i); });
              for (i = 0; i < arr.length && i < topK; i++) if (arr[i].s > th) targets.push(arr[i].i);
            }
          }
          var sell = positions.filter(function (p) { return targets.indexOf(p.i) < 0; });
          var buy = targets.filter(function (r) { return !positions.some(function (p) { return p.i === r; }); });
          return { sell: sell, buy: buy, slots: topK };
        }
      };
    }
  });
});
