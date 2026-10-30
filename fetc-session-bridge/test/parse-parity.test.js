'use strict';
// fetc-parse.js 與 etag-relay(≤0.7.1)lib/parse.js 的 parity(同一輸入 → 同一輸出)＋ golden 守門。
// 中繼 0.8.0(Gafferland Relay)拆掉 lib/parse.js／lib/fetc-client.js 後,parity 改對
// golden/relay-parity.json:拆除前用 relay 對 helpers/parity-inputs.js 同一組輸入跑出的輸出
// (helpers/canon.js 無損編碼:NaN、undefined 欄位與 relay 直比時一樣分得出來)。
// golden/*.json(search/detail/print)是 relay parse.js 對同一份 fixtures(已搬進 test/fixtures)的輸出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GOLDEN_DIR, fixture, parseHtml } = require('./helpers/env');
const { encode, digest } = require('./helpers/canon');
const I = require('./helpers/parity-inputs');

const mine = require('../fetc-parse');

const readGolden = (n) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, n), 'utf8'));
const RELAY = readGolden('relay-parity.json');
// 與 JSON golden 比較前先 JSON 往返(NaN→null、undefined 欄位消失,與 golden 序列化一致)
const rt = (v) => JSON.parse(JSON.stringify(v));

test('relay parity golden: 輸入筆數與 golden 一致(輸入被改就對不上)', () => {
  assert.equal(RELAY.scalars.wallTs.length, I.DATES.length * I.TIMES.length);
  assert.equal(RELAY.scalars.parseAmount.length, I.AMOUNTS.length);
  assert.equal(RELAY.edge.detail.length, I.DETAIL_CASES.length);
  assert.equal(RELAY.edge.search.length, I.SEARCH_CASES.length);
  assert.equal(RELAY.edge.print.length, I.PRINT_CASES.length);
  assert.equal(RELAY.fieldToken.length, I.TOKEN_CASES.length);
  assert.equal(RELAY.loginRedirect.length, I.LOGIN_CASES.length);
});

test('parity: parseSearchBatches(search.html)', () => {
  const html = fixture('search.html');
  assert.deepStrictEqual(encode(mine.parseSearchBatches(html, parseHtml)), RELAY.fixtures.search);
});

test('parity: parseDetailGantries(detail.html,裸 <tr> 片段)', () => {
  const html = fixture('detail.html');
  const a = mine.parseDetailGantries(html, '2026/07/20', parseHtml);
  assert.equal(a.length, 3);
  assert.deepStrictEqual(encode(a), RELAY.fixtures.detail);
});

test('parity: parsePrintRows(print.html)', () => {
  const html = fixture('print.html');
  assert.deepStrictEqual(encode(mine.parsePrintRows(html, parseHtml)), RELAY.fixtures.print);
});

test('parity: 純量函式 wallTsFromParts/combineDateTime/parseAmount', () => {
  let i = 0;
  for (const d of I.DATES) for (const t of I.TIMES) {
    assert.deepStrictEqual(encode(mine.wallTsFromParts(d, t)), RELAY.scalars.wallTs[i++], `wallTs ${d} ${t}`);
  }
  assert.deepStrictEqual(encode(mine.combineDateTime('2026/07/20', '01:02:03')), RELAY.scalars.combine);
  I.AMOUNTS.forEach((s, j) => {
    assert.deepStrictEqual(encode(mine.parseAmount(s)), RELAY.scalars.parseAmount[j], `parseAmount ${s}`);
  });
});

test('parity: 邊角輸入(缺 data-date、缺 checkbox、td 不足、巢狀、實體、重複 id)', () => {
  I.DETAIL_CASES.forEach((h, j) => {
    assert.deepStrictEqual(encode(mine.parseDetailGantries(h, '2026/07/20', parseHtml)), RELAY.edge.detail[j], h);
  });
  I.SEARCH_CASES.forEach((h, j) => {
    assert.deepStrictEqual(encode(mine.parseSearchBatches(h, parseHtml)), RELAY.edge.search[j], h);
  });
  I.PRINT_CASES.forEach((h, j) => {
    assert.deepStrictEqual(encode(mine.parsePrintRows(h, parseHtml)), RELAY.edge.print[j], h);
  });
});

test('parity: extractFieldToken / findCinForPlate(對照 relay resolveCin 的選擇規則)', () => {
  I.TOKEN_CASES.forEach((h, j) => {
    assert.deepStrictEqual(encode(mine.extractFieldToken(h, parseHtml)), RELAY.fieldToken[j], h);
  });
  // findCinForPlate:掃 [data-cln],[data-plate],後面命中的覆蓋前面;無 data-cin 退 value
  const member =
    '<div data-cln="TEST-001" data-cin="C1"></div><span data-plate=" TEST-001 " value="C2"></span>' +
    '<div data-cln="TEST-002" data-cin="C3"></div>';
  assert.equal(mine.findCinForPlate(member, 'TEST-001', parseHtml), 'C2');
  assert.equal(mine.findCinForPlate(member, 'TEST-002', parseHtml), 'C3');
  assert.equal(mine.findCinForPlate(member, 'NOPE', parseHtml), null);
  assert.equal(mine.findCinForPlate('', 'TEST-001', parseHtml), null);
});

test('上限 parity: detail 601 列→500、search 101 批→100、print 5001 列→5000(同 relay test-parse)', () => {
  const L = I.limitInputs();
  const g = mine.parseDetailGantries(L.detail, '2026/07/20', parseHtml);
  assert.equal(g.length, 500);
  assert.deepStrictEqual(digest(g), RELAY.limits.detail);
  const b = mine.parseSearchBatches(L.search, parseHtml);
  assert.equal(b.length, 100);
  assert.deepStrictEqual(digest(b), RELAY.limits.search);
  const pr = mine.parsePrintRows(L.print, parseHtml);
  assert.equal(pr.rows.length, 5000);
  assert.deepStrictEqual(digest(pr), RELAY.limits.print);
});

// ── golden:relay 當年輸出(JSON 往返版)──────────────────────────────────────
// 產生方式:etag-relay ≤0.7.1 的 lib/parse.js 對同一份 fixtures 跑一次,JSON.stringify(…,null,2)。
// 0.8.0 起 relay 已無 parse.js,不再重生;fetc-parse 要改行為就得先論證與這份輸出不同的理由。
test('golden: fetc-parse 對 fixtures 的輸出等於 relay 當年輸出(不依賴 relay)', () => {
  assert.deepStrictEqual(rt(mine.parseSearchBatches(fixture('search.html'), parseHtml)), readGolden('search.json'));
  assert.deepStrictEqual(rt(mine.parseDetailGantries(fixture('detail.html'), '2026/07/20', parseHtml)), readGolden('detail.json'));
  assert.deepStrictEqual(rt(mine.parsePrintRows(fixture('print.html'), parseHtml)), readGolden('print.json'));
});

test('golden: 上限(不依賴 relay)與牆鐘 ts', () => {
  const g = mine.parseDetailGantries(fixture('detail.html'), '2026/07/20', parseHtml);
  const t = g.find((x) => x.gantry === '01F0293N');
  assert.equal(t.timeTs, Date.UTC(2026, 6, 20, 12, 30, 45));
  assert.equal(t.amount, 7);
  const many = Array.from({ length: 601 }, (_, i) =>
    `<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="chkPrint_${i}_B_G"></td><td></td><td>r</td><td></td><td>1元</td></tr>`).join('');
  assert.equal(mine.parseDetailGantries(many, '2026/07/20', parseHtml).length, 500);
});

test('登入頁／挑戰頁偵測', () => {
  assert.equal(mine.looksLikeLoginRedirect('https://www.fetc.net.tw/UX0301UserLogin?x=1', ''), true);
  assert.equal(mine.looksLikeLoginRedirect('https://www.fetc.net.tw/Member', '<input id="smartAccount"><input id="smartPassword">'), true);
  assert.equal(mine.looksLikeLoginRedirect('https://www.fetc.net.tw/Member', '<input id="smartAccount">'), false);
  assert.equal(mine.isCfChallengeBody(403, '<title>Just a moment...</title>'), true);
  assert.equal(mine.isCfChallengeBody(503, 'just a moment'), true);
  assert.equal(mine.isCfChallengeBody(200, 'Just a moment'), false);
  assert.equal(mine.isCfChallengeBody(403, 'forbidden'), false);
  // parity:與 relay fetc-client.looksLikeLoginRedirect 同一輸入同一輸出(golden)
  I.LOGIN_CASES.forEach(([u, h], j) => {
    assert.deepStrictEqual(encode(mine.looksLikeLoginRedirect(u, h)), RELAY.loginRedirect[j], `${u} ${h}`);
  });
});

test('parseDetailGantries 必須先包 <table><tbody>…</tbody></table> 再交給 parseHtml', () => {
  // linkedom 的寬鬆解析不會丟棄裸 <tr>,所以光比輸出抓不到「少包 table」;
  // 真實瀏覽器 DOMParser 會(HTML5 foster parenting),故以 spy 鎖住傳入字串。
  const seen = [];
  const spy = (html) => { seen.push(html); return parseHtml(html); };
  const frag = fixture('detail.html');
  mine.parseDetailGantries(frag, '2026/07/20', spy);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], `<table><tbody>${frag}</tbody></table>`);
  // 另兩個解析函式不包 table(直接解析原文)
  seen.length = 0;
  mine.parseSearchBatches('<p>x</p>', spy);
  mine.parsePrintRows('<p>y</p>', spy);
  assert.deepStrictEqual(seen, ['<p>x</p>', '<p>y</p>']);
});
