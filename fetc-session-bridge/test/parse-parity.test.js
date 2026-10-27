'use strict';
// fetc-parse.js 對 etag-relay/lib/parse.js 的 parity(同一輸入 → 同一輸出)＋ golden 守門。
// golden/*.json 是 relay parse.js 對 etag-relay/fixtures 的輸出;重生方式見 golden 案說明。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RELAY_DIR, GOLDEN_DIR, fixture, parseHtml } = require('./helpers/env');

const mine = require('../fetc-parse');

let relay = null;
try {
  relay = require(path.join(RELAY_DIR, 'lib', 'parse'));
} catch (e) {
  relay = null; // b6 拆中繼後可能不存在:parity 案跳過,golden 案仍守門
}
const relayOpts = { skip: relay ? false : 'etag-relay/lib/parse.js 不存在(只比 golden)' };

const readGolden = (n) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, n), 'utf8'));
// 與 JSON golden 比較前先 JSON 往返(NaN→null、undefined 欄位消失,與 golden 序列化一致)
const rt = (v) => JSON.parse(JSON.stringify(v));

test('parity: parseSearchBatches(search.html)', relayOpts, () => {
  const html = fixture('search.html');
  assert.deepStrictEqual(mine.parseSearchBatches(html, parseHtml), relay.parseSearchBatches(html));
});

test('parity: parseDetailGantries(detail.html,裸 <tr> 片段)', relayOpts, () => {
  const html = fixture('detail.html');
  const a = mine.parseDetailGantries(html, '2026/07/20', parseHtml);
  assert.equal(a.length, 3);
  assert.deepStrictEqual(a, relay.parseDetailGantries(html, '2026/07/20'));
});

test('parity: parsePrintRows(print.html)', relayOpts, () => {
  const html = fixture('print.html');
  assert.deepStrictEqual(mine.parsePrintRows(html, parseHtml), relay.parsePrintRows(html));
});

test('parity: 純量函式 wallTsFromParts/combineDateTime/parseAmount', relayOpts, () => {
  const dates = ['2026/07/20', '2026-7-5', ' 2026/07/20 ', '2026/07', '', null, undefined, 'abc'];
  const times = ['12:30:45', '1:02:03', '25:61:61', '12:30', '', null, 'xx'];
  for (const d of dates) for (const t of times) {
    assert.deepStrictEqual(mine.wallTsFromParts(d, t), relay.wallTsFromParts(d, t), `wallTs ${d} ${t}`);
  }
  assert.equal(mine.combineDateTime('2026/07/20', '01:02:03'), relay.combineDateTime('2026/07/20', '01:02:03'));
  for (const s of ['650.4元', '7元', '1,234.5元', ' 1.6 元', '-3', '元', '', null, undefined, 'abc', 12]) {
    assert.deepStrictEqual(mine.parseAmount(s), relay.parseAmount(s), `parseAmount ${s}`);
  }
});

test('parity: 邊角輸入(缺 data-date、缺 checkbox、td 不足、巢狀、實體、重複 id)', relayOpts, () => {
  const detailCases = [
    '',
    '<tr data-level="3"><td></td></tr>',
    '<tr data-level="3" data-date="01:02:03"><td></td><td></td></tr>',
    '<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="chkPrint_1_B_G"></td><td>x</td><td>A &amp; B</td><td>1</td><td>1,234.5元</td></tr>',
    '<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="chkPrint_1_B_G_X_Y"></td><td>x</td><td> 路線 </td><td>1</td><td>abc</td></tr>',
    '<tr data-level="2" data-date="01:02:03"><td>level2</td></tr><tr data-level="3" data-date="9:5:7"><td></td><td></td><td>r</td><td></td><td>3元</td></tr>',
    '<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="other_1_B_G"><input class="chkPrint" id="chkPrint_2_B2_G2"></td><td></td><td>R</td><td></td><td>2元</td></tr>',
  ];
  for (const h of detailCases) {
    assert.deepStrictEqual(mine.parseDetailGantries(h, '2026/07/20', parseHtml), relay.parseDetailGantries(h, '2026/07/20'), h);
  }
  const searchCases = [
    '',
    '<table id="tblFeeList"><tr data-level="1" data-batchid=" B1 " data-date=" 2026/07/20 "></tr><tr data-level="2" data-batchid="B2" data-date="2026/07/21"></tr></table>',
    '<tr data-level="1" data-batchid="B1" data-date="2026/07/20"></tr>',
  ];
  for (const h of searchCases) {
    assert.deepStrictEqual(mine.parseSearchBatches(h, parseHtml), relay.parseSearchBatches(h), h);
  }
  const printCases = [
    '',
    '<table id="tblFeeList"><tr class="detail-row"><td>a</td></tr></table>',
    '<table id="tblFeeList"><tr><td class="date total">總計</td><td></td><td>1</td><td>2元</td></tr><tr><td class="date total">總計</td><td></td><td>3</td><td>4元</td></tr></table>',
    '<table id="tblFeeList"><tr class="detail-row"><td> 1 </td><td>A<b>B</b></td><td>2</td><td>3元</td><td>extra</td></tr></table>',
  ];
  for (const h of printCases) {
    assert.deepStrictEqual(mine.parsePrintRows(h, parseHtml), relay.parsePrintRows(h), h);
  }
});

test('parity: extractFieldToken / findCinForPlate(對照 relay resolveCin 的選擇規則)', relayOpts, () => {
  const relayClient = require(path.join(RELAY_DIR, 'lib', 'fetc-client'));
  const tokenCases = [
    '<input name="__RequestVerificationToken" value="t1"><input name="__RequestVerificationToken" value="t2">',
    '<input name="__RequestVerificationToken">',
    '<input name="other" value="x">',
    '',
  ];
  for (const h of tokenCases) {
    assert.equal(mine.extractFieldToken(h, parseHtml), relayClient.extractFieldToken(h), h);
  }
  // findCinForPlate:掃 [data-cln],[data-plate],後面命中的覆蓋前面;無 data-cin 退 value
  const member =
    '<div data-cln="TEST-001" data-cin="C1"></div><span data-plate=" TEST-001 " value="C2"></span>' +
    '<div data-cln="TEST-002" data-cin="C3"></div>';
  assert.equal(mine.findCinForPlate(member, 'TEST-001', parseHtml), 'C2');
  assert.equal(mine.findCinForPlate(member, 'TEST-002', parseHtml), 'C3');
  assert.equal(mine.findCinForPlate(member, 'NOPE', parseHtml), null);
  assert.equal(mine.findCinForPlate('', 'TEST-001', parseHtml), null);
});

test('上限 parity: detail 601 列→500、search 101 批→100、print 5001 列→5000(同 relay test-parse)', relayOpts, () => {
  const parts = [];
  for (let i = 0; i < 601; i++) {
    const hh = String(i % 24).padStart(2, '0');
    const mm = String(i % 60).padStart(2, '0');
    const ss = String((i * 7) % 60).padStart(2, '0');
    const gantry = `01F${String(i).padStart(4, '0')}N`;
    parts.push(
      `<tr data-level="3" data-date="${hh}:${mm}:${ss}">` +
        `<td><input type="checkbox" class="chkPrint" id="chkPrint_${i}_2607200000000000001_${gantry}"></td>` +
        `<td>${hh}:${mm}:${ss}</td><td>測試路線</td><td>1.0</td><td>1元</td><td>已收費</td></tr>`
    );
  }
  const g = mine.parseDetailGantries(parts.join(''), '2026/07/20', parseHtml);
  assert.equal(g.length, 500);
  assert.deepStrictEqual(g, relay.parseDetailGantries(parts.join(''), '2026/07/20'));

  const sp = [];
  for (let i = 0; i < 101; i++) {
    sp.push(`<tr data-level="1" data-batchid="26072000000000${String(i).padStart(5, '0')}" data-date="2026/07/20"><td>x</td></tr>`);
  }
  const sh = `<table id="tblFeeList"><tbody>${sp.join('')}</tbody></table>`;
  const b = mine.parseSearchBatches(sh, parseHtml);
  assert.equal(b.length, 100);
  assert.deepStrictEqual(b, relay.parseSearchBatches(sh));

  const pp = [];
  for (let i = 0; i < 5001; i++) pp.push(`<tr class="detail-row"><td>00:00:${i % 60}</td><td>r</td><td>1</td><td>1元</td></tr>`);
  const ph = `<table id="tblFeeList"><tbody>${pp.join('')}</tbody></table>`;
  const pr = mine.parsePrintRows(ph, parseHtml);
  assert.equal(pr.rows.length, 5000);
  assert.deepStrictEqual(pr, relay.parsePrintRows(ph));
});

// ── golden:不依賴 relay(b6 拆中繼後仍有守門)────────────────────────────────
// 重生:用 etag-relay/lib/parse.js 對 etag-relay/fixtures 跑一次,JSON.stringify(…,null,2) 寫回 golden/。
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
  if (relay) {
    const rc = require(path.join(RELAY_DIR, 'lib', 'fetc-client'));
    for (const [u, h] of [['x/UX0301UserLogin', ''], ['x', 'smartAccount smartPassword'], ['x', 'nothing']]) {
      assert.equal(mine.looksLikeLoginRedirect(u, h), rc.looksLikeLoginRedirect(u, h));
    }
  }
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
