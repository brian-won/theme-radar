#!/usr/bin/env node
/*
 * 백테스트 명령줄 도구 (설계서 8.1의 5단계) — 순수 Node 내장 기능만 사용
 *
 *   node scripts/bt_run.js --list                              기법 목록(잠금 표시)
 *   node scripts/bt_run.js -s maCross                          기법 1개를 기본 변수로 실행
 *   node scripts/bt_run.js -s maCross --set fastN=10 --set slowN=60 --common stopPct=5 --trades 20
 *   node scripts/bt_run.js -s rsi2 --json out.json             전체 결과(자산곡선·거래 내역)를 파일로
 *   node scripts/bt_run.js --defaults                          실행 가능한 전 기법 기본값 요약 → data/bt_defaults.json
 *   node scripts/bt_run.js --make-synth <폴더> [--n 1600 --days 750 --seed 1]   합성 조각 만들기(테스트·성능 측정용)
 *   node scripts/bt_run.js --dir <폴더> ...                    docs/bt 대신 다른 조각 폴더 사용
 *
 * 조각 폴더(기본 docs/bt)에는 설계서 4장 형식의 meta.js, index.js, px_YYYYMM.js, (선택) flow_YYYYMM.js 가 있어야 한다.
 * 13번(테마 대장주)·themeOnly 조건은 data/daily_detail_with_reasons.json + data/theme_taxonomy.json 을 읽어
 * template.html의 buildFrameDetail()과 같은 구조(FRAME_DETAIL)를 만들어 넘긴다.
 * 조각 폴더에 synth_daily_detail.json 이 있으면(합성 자료) 그쪽을 쓴다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const BT = require('../dashboard/bt/strategies.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'docs', 'bt');

// ---------------------------------------------------------------------
// 조각 파일 읽기: window.__btChunk({...}) 처럼 함수로 감싼 한 줄, 또는 순수 JSON 둘 다 받는다.
// 어떤 이름으로 감쌌는지와 상관없이, 호출에 넘겨진 객체를 모두 돌려준다.
// ---------------------------------------------------------------------
function parseChunkText(text) {
  const t = text.trim();
  if (t[0] === '{') { try { return [JSON.parse(t)]; } catch (e) { /* 아래 방식으로 다시 시도 */ } }
  const got = [];
  const collect = function (obj) { got.push(obj); };
  const win = new Proxy({}, { get: function () { return collect; }, set: function (o, k, v) { if (v && typeof v === 'object') got.push(v); return true; } });
  const sandbox = { window: win, self: win, globalThis: win, __btChunk: collect, __btMeta: collect, __btIndex: collect, __btFlow: collect };
  vm.runInNewContext(text, sandbox, { timeout: 60000 });
  return got;
}

// 조각 폴더 → data. opts.flow=false 면 수급 조각을 읽지 않는다.
function loadDir(dir, opts) {
  opts = opts || {};
  const t0 = Date.now();
  if (!fs.existsSync(dir)) throw new Error('조각 폴더가 없습니다: ' + dir);
  const files = fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); }).sort();
  const want = files.filter(function (f) {
    if (/^px_\d{6}\.js$/.test(f) || f === 'meta.js' || f === 'index.js') return true;
    return opts.flow !== false && /^flow_\d{6}\.js$/.test(f);
  });
  if (!want.some(function (f) { return /^px_/.test(f); })) throw new Error('일봉 조각(px_YYYYMM.js)이 없습니다: ' + dir);
  const store = BT.createStore(), kinds = { px: 0, flow: 0, meta: 0, index: 0 };
  let bytes = 0;
  want.forEach(function (f) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    bytes += text.length;
    parseChunkText(text).forEach(function (obj) { const k = BT.receive(store, obj); if (k) kinds[k]++; });
  });
  const data = BT.finalize(store);
  return { data: data, files: want.length, kinds: kinds, bytes: bytes, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------
// 테마 데이터: template.html의 buildFrameDetail()과 같은 로직
//  - 작은 틀(세부 테마) 그룹을 큰 틀(themeParent 매핑, 없으면 이름 그대로)로 다시 묶는다
//  - 큰 틀 합계는 종목 중복을 빼고 계산, 거래대금 합계 내림차순으로 1~3위(그 외는 4)
// ---------------------------------------------------------------------
function round2(v) { return Math.round(v * 100) / 100; }
function buildFrameDetail(dailyDetail, themeParent) {
  themeParent = themeParent || {};
  const out = {};
  Object.keys(dailyDetail || {}).forEach(function (date) {
    const byFrame = {};
    (dailyDetail[date].groups || []).forEach(function (g) {
      const f = themeParent[g.theme] || g.theme;
      const fr = byFrame[f] || (byFrame[f] = { theme: f, subs: [], stockMap: {} });
      fr.subs.push({ theme: g.theme, rank: g.rank, avgChange: g.avgChange, sumValue: g.sumValue, note: g.note || '', stocks: g.stocks });
      g.stocks.forEach(function (s) { if (!fr.stockMap[s.name]) fr.stockMap[s.name] = s; });
    });
    const groups = Object.keys(byFrame).map(function (f) {
      const fr = byFrame[f];
      const stocks = Object.keys(fr.stockMap).map(function (n) { return fr.stockMap[n]; });
      fr.subs.sort(function (a, b) { return b.sumValue - a.sumValue; });
      return {
        theme: f, subs: fr.subs, stocks: stocks,
        sumValue: stocks.reduce(function (t, s) { return t + s.value; }, 0),
        avgChange: round2(stocks.reduce(function (t, s) { return t + s.change; }, 0) / (stocks.length || 1))
      };
    }).sort(function (a, b) { return b.sumValue - a.sumValue; });
    groups.forEach(function (g, i) { g.rank = i < 3 ? i + 1 : 4; });
    out[date] = { groups: groups };
  });
  return out;
}
// 테마 데이터 읽기: 조각 폴더에 합성용 파일이 있으면 그것, 없으면 프로젝트 data/ 의 실제 파일. 없으면 null.
function loadTheme(dir) {
  let dd = path.join(dir || '', 'synth_daily_detail.json'), tx = path.join(dir || '', 'synth_theme_taxonomy.json');
  if (!dir || !fs.existsSync(dd)) {
    dd = path.join(ROOT, 'data', 'daily_detail_with_reasons.json'); tx = path.join(ROOT, 'data', 'theme_taxonomy.json');
  }
  if (!fs.existsSync(dd)) return null;
  const daily = JSON.parse(fs.readFileSync(dd, 'utf8'));
  const mapping = fs.existsSync(tx) ? (JSON.parse(fs.readFileSync(tx, 'utf8')).mapping || {}) : {};
  return buildFrameDetail(daily, mapping);
}

// ---------------------------------------------------------------------
// 실행 가능한 전 기법을 기본 변수로 돌린 요약(설계서 2.5·3.8) — 거래 내역은 빼고 지표 + 주 단위 자산곡선
// ---------------------------------------------------------------------
function runDefaults(data, extras, log) {
  const out = { generatedAt: new Date().toISOString(), asOf: data.asOf,
    data: { start: data.dates[0], end: data.dates[data.D - 1], days: data.D, tickers: data.N, delisted: data.delisted || 0 },
    order: BT.order.slice(), strategies: {} };
  BT.order.forEach(function (key) {
    const s = BT.strategies[key], why = BT.unavailableReason(data, s, extras);
    if (why) { out.strategies[key] = { strategy: key, label: s.label, locked: true, lockReason: why }; if (log) log(key, null, why, 0); return; }
    const t0 = process.hrtime.bigint();
    try {
      const res = BT.run(data, key, null, extras), ms = Number(process.hrtime.bigint() - t0) / 1e6;
      out.strategies[key] = BT.summarize(res);
      if (log) log(key, res, null, ms);
    } catch (e) {
      out.strategies[key] = { strategy: key, label: s.label, locked: true, lockReason: '실행 오류: ' + e.message };
      if (log) log(key, null, '실행 오류: ' + e.message, 0);
    }
  });
  return out;
}

// ---------------------------------------------------------------------
// 명령줄
// ---------------------------------------------------------------------
function parseVal(v) {
  if (v === 'true') return true; if (v === 'false') return false;
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}
function parseArgs(argv) {
  const a = { set: {}, common: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], next = function () { return argv[++i]; };
    if (k === '--list') a.list = true;
    else if (k === '--defaults') a.defaults = true;
    else if (k === '-s' || k === '--strategy') a.strategy = next();
    else if (k === '--dir') a.dir = path.resolve(next());
    else if (k === '--out') a.out = path.resolve(next());
    else if (k === '--json') a.json = path.resolve(next());
    else if (k === '--trades') a.trades = +next();
    else if (k === '--set' || k === '--common') { const kv = next().split('='); a[k.slice(2)][kv[0]] = parseVal(kv.slice(1).join('=')); }
    else if (k === '--make-synth') a.makeSynth = path.resolve(next());
    else if (k === '--n') a.n = +next();
    else if (k === '--days') a.days = +next();
    else if (k === '--seed') a.seed = +next();
    else if (k === '--no-flow') a.noFlow = true;
    else if (k === '--repeat') a.repeat = +next();
    else if (k === '-h' || k === '--help') a.help = true;
    else { console.error('알 수 없는 옵션: ' + k); a.help = true; }
  }
  return a;
}
const pct = function (v) { return v == null ? '   n/a' : (v * 100).toFixed(1).padStart(7) + '%'; };
function line(key, res, why, ms) {
  if (!res) { console.log(key.padEnd(14) + '  (건너뜀: ' + why + ')'); return; }
  const m = res.metrics;
  console.log(key.padEnd(14) + ' 총수익 ' + pct(m.totalRet) + '  CAGR ' + pct(m.cagr) + '  MDD ' + pct(m.mdd) + '  승률 ' + pct(m.winRate) +
    '  손익비 ' + (m.payoff == null ? ' n/a' : m.payoff.toFixed(2)) + '  거래 ' + String(m.trades).padStart(5) + '  보유 ' + m.avgHold.toFixed(1).padStart(5) +
    '일  샤프 ' + m.sharpe.toFixed(2).padStart(6) + '  초과 ' + pct(m.excessCagr) + '  투자비중 ' + pct(m.exposure) + '  ' + ms.toFixed(0) + 'ms');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || process.argv.length <= 2) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(2).map(function (s) { return s.replace(/^ \* ?/, ''); }).join('\n'));
    return 0;
  }
  if (a.list) {
    BT.listStrategies().forEach(function (s) {
      console.log(String(s.no).padStart(2) + '. ' + s.key.padEnd(14) + ' ' + s.label + (s.locked ? '  [잠금: ' + s.lockReason + ']' : '') + '  (' + s.needs + ')');
    });
    return 0;
  }
  if (a.makeSynth) {
    const synth = require('../tests/bt/fixtures/synth.js');
    const syn = synth.makeSynth({ n: a.n || 1600, days: a.days || 750, seed: a.seed || 1 });
    synth.writeSynth(a.makeSynth, syn);
    console.log('합성 조각 생성: ' + a.makeSynth + ' (' + syn.tickers.length + '종목 × ' + syn.dates.length + '일, 일봉 조각 ' + syn.px.length + '개) — 실제 시세가 아님');
    return 0;
  }
  const dir = a.dir || DEFAULT_DIR;
  if (!fs.existsSync(path.join(dir, 'meta.js')) && !(fs.existsSync(dir) && fs.readdirSync(dir).some(function (f) { return /^px_\d{6}\.js$/.test(f); }))) {
    console.log('시세 조각이 아직 없습니다: ' + dir);
    console.log('자료 팀의 scripts/build_bt_data.py 가 docs/bt/px_YYYYMM.js, meta.js, index.js 를 만든 뒤 다시 실행하세요.');
    console.log('흐름만 확인하려면: node scripts/bt_run.js --make-synth <임시 폴더> 후 --dir <임시 폴더> 로 실행(합성 자료, 실제 시세 아님).');
    return 2;
  }
  const ld = loadDir(dir, { flow: !a.noFlow }), data = ld.data;
  console.log('자료: ' + dir + ' — ' + data.N + '종목(상장폐지 ' + data.delisted + ') × ' + data.D + '거래일 ' + data.dates[0] + ' ~ ' + data.dates[data.D - 1] +
    ', 조각 ' + ld.files + '개 ' + (ld.bytes / 1048576).toFixed(1) + 'MB, 읽기 ' + ld.ms + 'ms' +
    (data.idx ? '' : ', 지수 없음') + (data.frg ? ', 수급 있음' : ', 수급 없음') + (data.cap ? '' : ', 시가총액 없음'));
  const theme = loadTheme(dir), extras = { theme: theme };
  if (!theme) console.log('테마 데이터 없음 → 13번 기법은 건너뜀');

  if (a.defaults) {
    const isReal = path.resolve(dir) === path.resolve(DEFAULT_DIR);
    const t0 = Date.now(), out = runDefaults(data, extras, line);
    console.log('전체 ' + (Date.now() - t0) + 'ms');
    const outPath = a.out || (isReal ? path.join(ROOT, 'data', 'bt_defaults.json') : null);
    if (outPath) { fs.writeFileSync(outPath, JSON.stringify(out)); console.log('저장: ' + outPath + ' (' + (fs.statSync(outPath).size / 1024).toFixed(0) + 'KB)'); }
    else console.log('docs/bt 가 아닌 폴더의 자료라 data/bt_defaults.json 은 건드리지 않음(--out 으로 저장 위치 지정 가능)');
    return 0;
  }
  if (a.strategy) {
    const params = { own: a.set, common: a.common };
    let res, ms = 0;
    for (let n = 0; n < (a.repeat || 1); n++) { // --repeat: 같은 변수로 다시 돌린 시간(지표 재사용)도 확인
      const t0 = process.hrtime.bigint();
      res = BT.run(data, a.strategy, params, extras);
      ms = Number(process.hrtime.bigint() - t0) / 1e6;
      line(a.strategy, res, null, ms);
    }
    console.log('기간 ' + res.dataRange.start + ' ~ ' + res.dataRange.end + ' (' + res.dataRange.days + '일), 최대 동시 보유 ' + res.stats.maxPositionsSeen +
      ', 왕복 비용 ' + res.stats.roundTripCostPct.toFixed(3) + '%, 미청산 ' + res.metrics.openTrades + '건');
    res.warnings.forEach(function (w) { console.log('  경고: ' + w); });
    if (a.trades) {
      res.trades.slice(0, a.trades).forEach(function (t) {
        console.log('  ' + t.tk + ' ' + String(t.name).padEnd(12) + ' ' + t.inD + ' ' + t.inPx.toFixed(1).padStart(10) + ' → ' + t.outD + ' ' + t.outPx.toFixed(1).padStart(10) +
          '  ' + (t.ret * 100).toFixed(2).padStart(7) + '%  ' + String(t.hold).padStart(3) + '일  ' + t.why);
      });
    }
    if (a.json) { fs.writeFileSync(a.json, JSON.stringify(res)); console.log('저장: ' + a.json); }
    return 0;
  }
  console.log('할 일을 지정하세요: --list, -s <기법>, --defaults (도움말: --help)');
  return 0;
}

module.exports = { parseChunkText: parseChunkText, loadDir: loadDir, buildFrameDetail: buildFrameDetail, loadTheme: loadTheme, runDefaults: runDefaults, BT: BT };

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) { console.error('오류: ' + e.message); process.exitCode = 1; }
}
