// ── 解析器本機驗證(0.5.1 改合成 fixture 版)──────────────────────────────
// 用 fixtures/ 內三份手造的合成 HTML(零真實資料)驗證 lib/parse.js,全離線、
// CI/斷網環境皆可跑。跑法:
//   node etag-relay/test-parse.js
'use strict';

const fs = require('fs');
const path = require('path');

const {
  parseSearchBatches,
  parseDetailGantries,
  parsePrintRows,
} = require('./lib/parse');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ok  - ${msg}`);
  } else {
    fail++;
    console.log(`FAIL  - ${msg}`);
  }
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

// ── 1. parseSearchBatches ────────────────────────────────────────────────
console.log('\n[parseSearchBatches] fixtures/search.html(合成資料)');
{
  const html = readFixture('search.html');
  const batches = parseSearchBatches(html);
  assert(batches.length === 2, `2 個有效批次,第 3 列缺 data-batchid 應跳過(實得 ${batches.length})`);

  const b1 = batches.find((b) => b.batchId === '2607200000000000001');
  assert(!!b1, '含 batchId 2607200000000000001');
  assert(!!b1 && b1.date === '2026/07/20', `date 為 2026/07/20(實得 ${b1 && b1.date})`);

  const b2 = batches.find((b) => b.batchId === '2607200000000000002');
  assert(!!b2, '含 batchId 2607200000000000002');
  assert(!!b2 && b2.date === '2026/07/21', `date 為 2026/07/21(實得 ${b2 && b2.date})`);
}

// ── 2. parseDetailGantries ───────────────────────────────────────────────
console.log('\n[parseDetailGantries] fixtures/detail.html(合成資料,裸 <tr> 片段)');
{
  const html = readFixture('detail.html');
  const gantries = parseDetailGantries(html, '2026/07/20');
  assert(gantries.length === 3, `3 列(實得 ${gantries.length})`);

  const allValid = gantries.every(
    (g) =>
      typeof g.timeStr === 'string' &&
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(g.timeStr) &&
      Number.isFinite(g.timeTs) &&
      typeof g.gantry === 'string' &&
      g.gantry.length > 0
  );
  assert(allValid, '每列皆有合法 timeStr/timeTs/gantry');

  const allAmountsPositive = gantries.every((g) => Number.isFinite(g.amount) && g.amount > 0);
  assert(allAmountsPositive, 'amount 皆為 number 且 > 0');

  const target = gantries.find((g) => g.gantry === '01F0293N');
  assert(!!target, '抽驗含門架 01F0293N');
  if (target) {
    assert(
      target.timeStr === '2026/07/20 12:30:45',
      `01F0293N timeStr=2026/07/20 12:30:45(實得 ${target.timeStr})`
    );
    // 牆鐘法校驗:Date.UTC(2026,6,20,12,30,45) 應與 timeTs 相等,且與本地時區解析無關
    const expectedTs = Date.UTC(2026, 6, 20, 12, 30, 45);
    assert(
      target.timeTs === expectedTs,
      `01F0293N timeTs 用牆鐘法(Date.UTC 分量)算出(實得 ${target.timeTs}, 預期 ${expectedTs})`
    );
    assert(target.amount === 7, `01F0293N amount=7(實得 ${target.amount})`);
  }
}

// ── 3. parsePrintRows ────────────────────────────────────────────────────
console.log('\n[parsePrintRows] fixtures/print.html(合成資料)');
{
  const html = readFixture('print.html');
  const { rows, total } = parsePrintRows(html);
  assert(rows.length === 2, `2 列(實得 ${rows.length})`);

  const row1 = rows.find((r) => r.time === '04:01:47');
  assert(!!row1, '含 time 04:01:47');
  if (row1) {
    assert(row1.route === '五股-高公局', `route=五股-高公局(實得 ${row1.route})`);
    assert(row1.mileage === '1.4', `mileage=1.4(實得 ${row1.mileage})`);
    assert(row1.toll === '1.6元', `toll=1.6元(實得 ${row1.toll})`);
  }

  assert(!!total, '有 total 列');
  if (total) {
    assert(total.mileage === '7.0', `total.mileage=7.0(實得 ${total.mileage})`);
    assert(total.toll === '9.4元', `total.toll=9.4元(實得 ${total.toll})`);
  }
}

// ── 4. 上限測試(JS 迴圈生字串,免 fixture)───────────────────────────────
console.log('\n[cap] parseDetailGantries 超過 MAX_DETAIL_ROWS(500)應截斷');
{
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
  const gantries = parseDetailGantries(parts.join(''), '2026/07/20');
  assert(gantries.length === 500, `601 列輸入應截斷為 500(MAX_DETAIL_ROWS,實得 ${gantries.length})`);
}

console.log('\n[cap] parseSearchBatches 超過 MAX_SEARCH_BATCHES(100)應截斷');
{
  const parts = [];
  for (let i = 0; i < 101; i++) {
    const batchId = `26072000000000${String(i).padStart(5, '0')}`;
    parts.push(
      `<tr data-level="1" data-batchid="${batchId}" data-date="2026/07/20"><td>2026/07/20</td></tr>`
    );
  }
  const html = `<table id="tblFeeList"><tbody>${parts.join('')}</tbody></table>`;
  const batches = parseSearchBatches(html);
  assert(batches.length === 100, `101 批應截斷為 100(MAX_SEARCH_BATCHES,實得 ${batches.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
