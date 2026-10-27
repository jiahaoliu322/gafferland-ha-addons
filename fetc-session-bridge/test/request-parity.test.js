'use strict';
// 請求 parity:同一組輸入,relay fetc-client.js(stub globalThis.fetch)與 fetc-chain.js
// (注入 fetchImpl)送出的請求逐筆相等(扣掉瀏覽器自帶的 UA/Cookie/Referer);
// buildPdfContentFromPrintHtml 兩邊逐字相等;golden 比對不依賴 relay。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/env');

const { createFetcChain, buildPdfContentFromPrintHtml, utf8ToBase64 } = require('../fetc-chain');
const parser = require('../fetc-parse');

let rc = null;
try {
  rc = require(path.join(H.RELAY_DIR, 'lib', 'fetc-client'));
} catch (e) {
  rc = null;
}
const relayOpts = { skip: rc ? false : 'etag-relay/lib/fetc-client.js 不存在' };

const WINDOW = { startDate: '2026/07/20', endDate: '2026/07/21' };

function newChain(site, log, extra = {}) {
  return createFetcChain({
    fetchImpl: H.makeStubFetch(site, log),
    parseHtml: H.parseHtml,
    parser,
    now: () => 1700000000000,
    ...extra,
  });
}

async function withRelayFetch(site, log, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = H.makeStubFetch(site, log);
  try {
    return await fn(new rc.CookieJar());
  } finally {
    globalThis.fetch = orig;
  }
}

test('請求 parity: queryPlate(GET /Member → /Member/Setting → search → 逐批 detail)', relayOpts, async () => {
  const rLog = [];
  const rRes = await withRelayFetch(H.makeSite(), rLog, async (jar) => {
    const cin = await rc.resolveCin(jar, H.TEST_PLATE);
    return rc.queryAll(jar, { plate: H.TEST_PLATE, cin, ...WINDOW }, { skipPrint: true });
  });
  const cLog = [];
  const cRes = await newChain(H.makeSite(), cLog).queryPlate({ plate: H.TEST_PLATE, ...WINDOW });

  assert.equal(rLog.length, 5); // member, setting, search, detail×2
  assert.deepStrictEqual(cLog.map(H.normalize), rLog.map(H.normalize));
  assert.deepStrictEqual(cRes.transactions, rRes.transactions);
  assert.equal(cRes.total, rRes.total);
  assert.equal(cRes.transactions.length, 6);

  // search 表單:weekend 重複鍵確實在、順序一致
  const search = H.normalize(cLog[2]);
  const weekend = search.body.filter(([k]) => k === 'weekend').map(([, v]) => v);
  assert.deepStrictEqual(weekend, ['-1', '0', '1', '2', '3', '4', '5', '6']);
  assert.equal(search.headers['__requestverificationtoken'], H.TEST_TOKEN);
  assert.equal(search.headers['x-requested-with'], 'XMLHttpRequest');
});

test('請求 parity: buildDateTimeMapForTimes + print + generateNativePdf', relayOpts, async () => {
  const times = ['2026/07/20 12:30:45', '2026/07/21 14:00:10', '2026/07/20 03:00:00'];
  const rLog = [];
  const rOut = await withRelayFetch(H.makeSite(), rLog, async (jar) => {
    const cin = await rc.resolveCin(jar, H.TEST_PLATE);
    const { dateTimeMap, fieldToken } = await rc.buildDateTimeMapForTimes(jar, { plate: H.TEST_PLATE, cin, ...WINDOW, times });
    const printHtml = await rc.print(jar, fieldToken, { plate: H.TEST_PLATE, cin, dateTimeMap });
    const pdf = await rc.generateNativePdf(jar, fieldToken, printHtml);
    return { dateTimeMap, pdf };
  });
  const cLog = [];
  const chain = newChain(H.makeSite(), cLog);
  const cin = await chain.getCin(H.TEST_PLATE);
  const { dateTimeMap, fieldToken } = await chain.buildDateTimeMapForTimes({ plate: H.TEST_PLATE, cin, ...WINDOW, times });
  const printHtml = await chain.print(fieldToken, { plate: H.TEST_PLATE, cin, dateTimeMap });
  const pdf = await chain.generateNativePdf(fieldToken, printHtml);

  assert.deepStrictEqual(dateTimeMap, rOut.dateTimeMap);
  assert.deepStrictEqual(Array.from(pdf), Array.from(rOut.pdf));
  assert.deepStrictEqual(cLog.map(H.normalize), rLog.map(H.normalize));
  // 最後一筆是 GetPDF:路徑含 ?&r=(已正規化)、Content-Type 一致
  const last = H.normalize(cLog[cLog.length - 1]);
  assert.equal(last.path, '/UX0000Common/UX000006GetPDF?&r=N');
  assert.equal(last.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.ok(last.body.some(([k]) => k === 'content'));
  // times 只含 07/20 12:30:45 與 07/21 14:00:10(07/20 03:00:00 不在明細)
  assert.deepStrictEqual(dateTimeMap, {
    '2607200000000000001': ['2026/07/20 12:30:45'],
    '2607200000000000002': ['2026/07/21 14:00:10'],
  });
});

test('瀏覽器守門: 不送 User-Agent/Cookie/Referer,credentials=include,redirect=follow', async () => {
  const cLog = [];
  const chain = newChain(H.makeSite(), cLog);
  const cin = await chain.getCin(H.TEST_PLATE);
  const { dateTimeMap, fieldToken } = await chain.buildDateTimeMapForTimes({
    plate: H.TEST_PLATE, cin, ...WINDOW, times: ['2026/07/20 12:30:45'],
  });
  const printHtml = await chain.print(fieldToken, { plate: H.TEST_PLATE, cin, dateTimeMap });
  await chain.generateNativePdf(fieldToken, printHtml);
  assert.ok(cLog.length >= 6);
  for (const e of cLog) {
    for (const k of ['user-agent', 'cookie', 'referer']) assert.ok(!(k in e.headers), `${e.pathQuery} 不該送 ${k}`);
    assert.equal(e.credentials, 'include');
    assert.equal(e.redirect, 'follow');
    assert.ok(e.url.startsWith(H.BASE + '/'));
  }
  if (rc) {
    const rLog = [];
    await withRelayFetch(H.makeSite(), rLog, async (jar) => { await rc.resolveCin(jar, H.TEST_PLATE); });
    assert.ok('user-agent' in rLog[0].headers); // 確認 normalize 扣的東西真的存在於 relay 側
  }
});

test('buildPdfContentFromPrintHtml: 與 relay 逐字相等(經 GetPDF body 的 content 還原)', relayOpts, async () => {
  for (const html of [H.RICH_PRINT_HTML, H.fixture('print.html'), '<div>沒有 head/body 的片段 <img src="/a.png"></div>', '']) {
    const rLog = [];
    await withRelayFetch(H.makeSite(), rLog, (jar) => rc.generateNativePdf(jar, 'tok', html));
    const relayContent = Buffer.from(new URLSearchParams(rLog[0].body).get('content'), 'base64').toString('utf8');
    assert.equal(buildPdfContentFromPrintHtml(html), relayContent);
    const chain = newChain(H.makeSite(), []);
    assert.equal(chain.buildPdfContentFromPrintHtml(html), relayContent);
  }
});

test('golden: buildPdfContentFromPrintHtml(RICH) 等於 relay 當年輸出(不依賴 relay)', () => {
  const golden = fs.readFileSync(path.join(H.GOLDEN_DIR, 'pdf-content.html'), 'utf8');
  assert.equal(buildPdfContentFromPrintHtml(H.RICH_PRINT_HTML), golden);
  assert.ok(!/不該留下|大寫也要移除/.test(golden));
  assert.ok(golden.includes('href="https://www.fetc.net.tw/Content/print.css"'));
  assert.ok(golden.includes('src="https://www.fetc.net.tw/Content/images/logo.png"'));
  assert.ok(golden.includes('src="//cdn.example.test/x.png"')); // 雙斜線不補
});

test('base64: 中文 HTML 往返相等;大 HTML(>1MB)不爆堆疊', () => {
  const zh = '<p>通行費 五股-高公局 1.6元 😀</p>';
  assert.equal(Buffer.from(utf8ToBase64(zh), 'base64').toString('utf8'), zh);
  assert.equal(utf8ToBase64(zh), Buffer.from(zh, 'utf8').toString('base64'));
  const big = '通行費'.repeat(600000); // ~5.4MB UTF-8
  const b64 = utf8ToBase64(big);
  assert.equal(b64, Buffer.from(big, 'utf8').toString('base64'));
  const { bytesToBase64 } = require('../fetc-chain');
  const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});
