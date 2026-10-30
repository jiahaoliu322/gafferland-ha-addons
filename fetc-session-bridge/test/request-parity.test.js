'use strict';
// 請求 parity:同一組輸入,fetc-chain.js(注入 fetchImpl)送出的請求逐筆等於 relay fetc-client.js
// 當年送出的(扣掉瀏覽器自帶的 UA/Cookie/Referer);buildPdfContentFromPrintHtml 逐字相等。
// 中繼 0.8.0 拆掉 lib/fetc-client.js 後,relay 那一側改對 golden/relay-parity.json
// (拆除前用 relay 對 helpers/parity-inputs.js 同一組輸入、同一個 stub 站台跑出的請求紀錄與輸出)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/env');
const { encode } = require('./helpers/canon');
const I = require('./helpers/parity-inputs');

const { createFetcChain, buildPdfContentFromPrintHtml, utf8ToBase64 } = require('../fetc-chain');
const parser = require('../fetc-parse');

const RELAY = JSON.parse(fs.readFileSync(path.join(H.GOLDEN_DIR, 'relay-parity.json'), 'utf8'));
const WINDOW = I.WINDOW;

function newChain(site, log, extra = {}) {
  return createFetcChain({
    fetchImpl: H.makeStubFetch(site, log),
    parseHtml: H.parseHtml,
    parser,
    now: () => 1700000000000,
    ...extra,
  });
}

test('請求 parity: queryPlate(GET /Member → /Member/Setting → search → 逐批 detail)', async () => {
  const cLog = [];
  const cRes = await newChain(H.makeSite(), cLog).queryPlate({ plate: H.TEST_PLATE, ...WINDOW });

  assert.equal(RELAY.queryPlate.log.length, 5); // member, setting, search, detail×2
  assert.deepStrictEqual(encode(cLog.map(H.normalize)), RELAY.queryPlate.log);
  assert.deepStrictEqual(encode(cRes.transactions), RELAY.queryPlate.transactions);
  assert.deepStrictEqual(encode(cRes.total), RELAY.queryPlate.total);
  assert.equal(cRes.transactions.length, 6);

  // search 表單:weekend 重複鍵確實在、順序一致
  const search = H.normalize(cLog[2]);
  const weekend = search.body.filter(([k]) => k === 'weekend').map(([, v]) => v);
  assert.deepStrictEqual(weekend, ['-1', '0', '1', '2', '3', '4', '5', '6']);
  assert.equal(search.headers['__requestverificationtoken'], H.TEST_TOKEN);
  assert.equal(search.headers['x-requested-with'], 'XMLHttpRequest');
});

test('請求 parity: buildDateTimeMapForTimes + print + generateNativePdf', async () => {
  const times = I.PRINT_TIMES;
  const cLog = [];
  const chain = newChain(H.makeSite(), cLog);
  const cin = await chain.getCin(H.TEST_PLATE);
  const { dateTimeMap, fieldToken } = await chain.buildDateTimeMapForTimes({ plate: H.TEST_PLATE, cin, ...WINDOW, times });
  const printHtml = await chain.print(fieldToken, { plate: H.TEST_PLATE, cin, dateTimeMap });
  const pdf = await chain.generateNativePdf(fieldToken, printHtml);

  assert.deepStrictEqual(encode(dateTimeMap), RELAY.printChain.dateTimeMap);
  assert.deepStrictEqual(Array.from(pdf), RELAY.printChain.pdf);
  assert.deepStrictEqual(encode(cLog.map(H.normalize)), RELAY.printChain.log);
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
  // normalize 扣掉的 UA／Cookie／Referer 只是瀏覽器自帶的差異:有帶就被扣、其他鍵原樣保留
  const n = H.normalize({ method: 'GET', pathQuery: '/x?r=123', headers: { 'user-agent': 'u', cookie: 'c', referer: 'r', 'x-keep': 'k' }, body: null });
  assert.deepStrictEqual(n, { method: 'GET', path: '/x?r=N', headers: { 'x-keep': 'k' }, body: null });
});

test('buildPdfContentFromPrintHtml: 與 relay 逐字相等(golden=relay 當年 GetPDF body 的 content 還原)', async () => {
  const inputs = I.pdfContentInputs(H);
  assert.equal(RELAY.pdfContent.length, inputs.length);
  inputs.forEach((html, j) => {
    const relayContent = RELAY.pdfContent[j];
    assert.equal(buildPdfContentFromPrintHtml(html), relayContent);
    const chain = newChain(H.makeSite(), []);
    assert.equal(chain.buildPdfContentFromPrintHtml(html), relayContent);
  });
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
