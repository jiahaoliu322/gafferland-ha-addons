'use strict';
// fetc-chain.js 的工作層(runQueryJob/runPrintJob/runScanJob)行為與錯誤轉換。
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/env');
const { createFetcChain, bytesToBase64 } = require('../fetc-chain');
const parser = require('../fetc-parse');

const WINDOW = { startDate: '2026/07/20', endDate: '2026/07/21' };

function mk(overrides, extra = {}) {
  const log = [];
  const chain = createFetcChain({
    fetchImpl: H.makeStubFetch(H.makeSite(overrides), log),
    parseHtml: H.parseHtml,
    parser,
    now: () => 1700000000000,
    ...extra,
  });
  return { chain, log };
}
const paths = (log) => log.map((e) => e.pathQuery);

test('runQueryJob: 兩台車皆成功,交易欄位為 timeStr/route/gantry/amount(不含 timeTs)', async () => {
  const { chain } = mk();
  const r = await chain.runQueryJob({ plates: ['TEST-001', 'TEST-002'], ...WINDOW });
  assert.deepStrictEqual(Object.keys(r.perPlate), ['TEST-001', 'TEST-002']);
  const a = r.perPlate['TEST-001'];
  assert.equal(a.ok, true);
  assert.equal(a.transactions.length, 6);
  assert.deepStrictEqual(Object.keys(a.transactions[0]).sort(), ['amount', 'gantry', 'route', 'timeStr']);
  assert.deepStrictEqual(a.transactions[0], { timeStr: '2026/07/20 12:30:45', route: '五股-高公局', gantry: '01F0293N', amount: 7 });
  assert.equal(r.perPlate['TEST-002'].ok, true);
});

test('runScanJob: 與 runQueryJob 同輸出', async () => {
  const a = await mk().chain.runQueryJob({ plates: ['TEST-001'], ...WINDOW });
  const b = await mk().chain.runScanJob({ plates: ['TEST-001'], ...WINDOW });
  assert.deepStrictEqual(a, b);
});

test('登入頁 → login-required,後續車牌不再打', async () => {
  const { chain, log } = mk({
    member: { body: H.LOGIN_HTML, url: 'https://www.fetc.net.tw/UX0301UserLogin?ReturnUrl=%2FMember' },
  });
  const r = await chain.runQueryJob({ plates: ['TEST-001', 'TEST-002', 'NOPE-999'], ...WINDOW });
  assert.deepStrictEqual(r.perPlate, {
    'TEST-001': { ok: false, reason: 'login-required' },
    'TEST-002': { ok: false, reason: 'login-required' },
    'NOPE-999': { ok: false, reason: 'login-required' },
  });
  assert.equal(log.length, 1); // 只打了第一車的 GET /Member
});

test('token 頁被導登入 → login-required(runPrintJob 同樣停打)', async () => {
  const { chain, log } = mk({ setting: { body: H.LOGIN_HTML, url: 'https://www.fetc.net.tw/UX0301UserLogin' } });
  const r = await chain.runPrintJob({ ...WINDOW, plates: [
    { plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'] },
    { plateRaw: 'TEST-002', times: ['2026/07/20 12:30:45'] },
  ] });
  assert.deepStrictEqual(r.pdfs, [
    { plateRaw: 'TEST-001', ok: false, reason: 'login-required' },
    { plateRaw: 'TEST-002', ok: false, reason: 'login-required' },
  ]);
  assert.equal(log.filter((e) => e.pathQuery === '/Member/Setting').length, 1);
});

test('POST 回登入頁(session 中途失效)→ login-required', async () => {
  const { chain } = mk({ search: { body: H.LOGIN_HTML, url: 'https://www.fetc.net.tw/UX0301UserLogin' } });
  const r = await chain.runQueryJob({ plates: ['TEST-001'], ...WINDOW });
  assert.equal(r.perPlate['TEST-001'].reason, 'login-required');
});

test('挑戰頁 → cf-challenge,後續車牌不再打(body 與 header 兩種判定)', async () => {
  const a = mk({ member: { status: 403, body: H.CF_HTML } });
  const ra = await a.chain.runQueryJob({ plates: ['TEST-001', 'TEST-002'], ...WINDOW });
  assert.deepStrictEqual(ra.perPlate, {
    'TEST-001': { ok: false, reason: 'cf-challenge' },
    'TEST-002': { ok: false, reason: 'cf-challenge' },
  });
  assert.equal(a.log.length, 1);

  const b = mk({ member: { status: 503, body: 'blocked', headers: { 'cf-mitigated': 'challenge' } } });
  const rb = await b.chain.runQueryJob({ plates: ['TEST-001'], ...WINDOW });
  assert.equal(rb.perPlate['TEST-001'].reason, 'cf-challenge');

  // 一般 403(非挑戰)不是 cf-challenge
  const c = mk({ member: { status: 403, body: 'forbidden' } });
  const rc2 = await c.chain.runQueryJob({ plates: ['TEST-001'], ...WINDOW });
  assert.equal(rc2.perPlate['TEST-001'].reason, 'cin-not-found');
});

test('查無車牌 → cin-not-found,且不影響其他車牌', async () => {
  const { chain } = mk();
  const r = await chain.runQueryJob({ plates: ['NOPE-999', 'TEST-001'], ...WINDOW });
  assert.deepStrictEqual(r.perPlate['NOPE-999'], { ok: false, reason: 'cin-not-found' });
  assert.equal(r.perPlate['TEST-001'].ok, true);
  const p = await mk().chain.runPrintJob({ ...WINDOW, plates: [{ plateRaw: 'NOPE-999', times: ['2026/07/20 12:30:45'] }] });
  assert.deepStrictEqual(p.pdfs, [{ plateRaw: 'NOPE-999', ok: false, reason: 'cin-not-found' }]);
});

test('PDF 回非 %PDF- → 該車 pdf-failed,其他車照常', async () => {
  let n = 0;
  const { chain } = mk({
    pdf: () => (++n === 1 ? { body: '<html>error</html>', headers: { 'content-type': 'text/html' } } : undefined),
  });
  const r = await chain.runPrintJob({ ...WINDOW, plates: [
    { plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'] },
    { plateRaw: 'TEST-002', times: ['2026/07/20 12:30:45'] },
  ] });
  assert.deepStrictEqual(r.pdfs[0], { plateRaw: 'TEST-001', ok: false, reason: 'pdf-failed' });
  assert.equal(r.pdfs[1].ok, true);
  assert.equal(r.pdfs[1].pdfBase64, bytesToBase64(H.PDF_BYTES));
  assert.equal(Buffer.from(r.pdfs[1].pdfBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(r.pdfs[1].printTotal, 9.4);
});

test('GetPDF 回 HTTP 500 但內容像 PDF 也算 pdf-failed', async () => {
  const { chain } = mk({ pdf: { status: 500, body: H.PDF_BYTES } });
  const r = await chain.runPrintJob({ ...WINDOW, plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'] }] });
  assert.equal(r.pdfs[0].reason, 'pdf-failed');
});

test('times 全不在明細 → no-rows,且不呼叫 print／GetPDF', async () => {
  const { chain, log } = mk();
  const r = await chain.runPrintJob({ ...WINDOW, plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 03:00:00', '2025/01/01 00:00:00'] }] });
  assert.deepStrictEqual(r.pdfs, [{ plateRaw: 'TEST-001', ok: false, reason: 'no-rows' }]);
  assert.ok(!paths(log).some((p) => /Print|GetPDF/.test(p)));
  // 空 times 也是 no-rows(不打網路)
  const e = mk();
  const r2 = await e.chain.runPrintJob({ ...WINDOW, plates: [{ plateRaw: 'TEST-001', times: [] }] });
  assert.equal(r2.pdfs[0].reason, 'no-rows');
  assert.equal(e.log.length, 0);
});

test('runPrintJob 只把 payload 的 times 送進 print(dateTimeJSON＝times 子集)', async () => {
  const { chain, log } = mk();
  const times = ['2026/07/20 13:15:00', '2026/07/21 12:30:45']; // 明細共 6 筆,只收這 2 筆
  const r = await chain.runPrintJob({ ...WINDOW, plates: [{ plateRaw: 'TEST-001', times }] });
  assert.equal(r.pdfs[0].ok, true);
  const printReq = log.find((e) => e.pathQuery.endsWith('UX050508TrafficAdvancedSearchPrint'));
  const body = new URLSearchParams(printReq.body);
  assert.deepStrictEqual(JSON.parse(body.get('dateTimeJSON')), {
    '2607200000000000001': ['2026/07/20 13:15:00'],
    '2607200000000000002': ['2026/07/21 12:30:45'],
  });
  assert.equal(body.get('cln'), 'TEST-001');
  assert.equal(body.get('cin'), H.TEST_CIN);
  // 租期外的時間（12:30:45 在 07/20、14:00:10 等）不在其中
  assert.ok(!printReq.body.includes(encodeURIComponent('2026/07/20 12:30:45')));
});

test('attach-print 單車形狀也能跑(plateRaw+times)', async () => {
  const { chain } = mk();
  const r = await chain.runPrintJob({ ...WINDOW, recordId: 'R', rowId: 'W', filename: 'f.pdf', plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'] });
  assert.equal(r.pdfs.length, 1);
  assert.equal(r.pdfs[0].plateRaw, 'TEST-001');
  assert.equal(r.pdfs[0].ok, true);
});

test('網路例外 → error;其他車牌照常', async () => {
  let n = 0;
  const log = [];
  const base = H.makeStubFetch(H.makeSite(), log);
  const chain = createFetcChain({
    fetchImpl: (...a) => (++n === 1 ? Promise.reject(new TypeError('network down')) : base(...a)),
    parseHtml: H.parseHtml, parser,
  });
  const r = await chain.runQueryJob({ plates: ['TEST-001', 'TEST-002'], ...WINDOW });
  assert.deepStrictEqual(r.perPlate['TEST-001'], { ok: false, reason: 'error' });
  assert.equal(r.perPlate['TEST-002'].ok, true);
});

test('回應過大 → error', async () => {
  const { chain } = mk({ setting: { body: H.SETTING_HTML, headers: { 'content-length': String(11 * 1024 * 1024) } } });
  const r = await chain.runQueryJob({ plates: ['TEST-001'], ...WINDOW });
  assert.equal(r.perPlate['TEST-001'].reason, 'error');
});

test('cinCache 注入:命中不再打 /Member;查到會寫回', async () => {
  const cinCache = { 'TEST-001': 'PRE-CIN' };
  const { chain, log } = mk({}, { cinCache });
  await chain.queryPlate({ plate: 'TEST-001', ...WINDOW });
  assert.ok(!log.some((e) => e.pathQuery === '/Member'));
  const search = log.find((e) => e.pathQuery.endsWith('UX050506TrafficAdvancedSearch'));
  assert.equal(new URLSearchParams(search.body).get('cin'), 'PRE-CIN');
  await chain.getCin('TEST-002');
  assert.equal(cinCache['TEST-002'], 'CIN-SYNTH-002');
});

test('瀏覽器式載入(無 module/require):兩檔掛 globalThis.GflFetcParse/GflFetcChain 並可跑完一輪', async () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const { DOMParser } = require('linkedom');
  const ctx = {
    console, TextEncoder, TextDecoder, URLSearchParams, URL, AbortSignal, btoa, Date, JSON, Response,
    DOMParser, // 瀏覽器自帶,這裡用 linkedom 代替;不傳 parseHtml 時預設走它
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['fetc-parse.js', 'fetc-chain.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  assert.equal(typeof ctx.GflFetcParse.parseSearchBatches, 'function');
  assert.equal(typeof ctx.GflFetcChain.createFetcChain, 'function');
  const chain = ctx.GflFetcChain.createFetcChain({ fetchImpl: H.makeStubFetch(H.makeSite(), []) });
  const r = await chain.runQueryJob({ plates: ['TEST-001'], ...WINDOW });
  assert.equal(r.perPlate['TEST-001'].ok, true);
  assert.equal(r.perPlate['TEST-001'].transactions.length, 6);
});

test('原始碼守門: 兩檔無 require(/import/export/chrome.*', () => {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['fetc-parse.js', 'fetc-chain.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\brequire\s*\(/.test(src), `${f} 不得 require(`);
    assert.ok(!/^\s*(import|export)\s/m.test(src), `${f} 不得用 ES module 語法`);
    assert.ok(!/\bchrome\./.test(src), `${f} 不得碰 chrome.*`);
  }
});
