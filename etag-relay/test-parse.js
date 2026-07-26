// ── 解析器本機驗證(E1-a)──────────────────────────────────────────────
// 用 E0 已存的三份真實遠通回應檔驗證 lib/parse.js。跑法:
//   node etag-relay/test-parse.js
// 檔案位置為 scratchpad 根目錄(此 repo 骨架的上一層),供本輪本機驗證用;
// 正式 add-on repo 不會含這三份含真實資料的回應檔。
'use strict';

const fs = require('fs');
const path = require('path');

const {
  parseSearchBatches,
  parseDetailGantries,
  parsePrintRows,
} = require('./lib/parse');

const FIXTURE_DIR = path.join(__dirname, '..'); // scratchpad 根目錄

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
console.log('\n[parseSearchBatches] fetc-search-resp.txt');
{
  const html = readFixture('fetc-search-resp.txt');
  const batches = parseSearchBatches(html);
  assert(Array.isArray(batches) && batches.length >= 1, `回至少 1 個批次(實得 ${batches.length})`);
  const target = batches.find((b) => b.batchId === '2607200006857440405');
  assert(!!target, '含 batchId 2607200006857440405');
  assert(!!target && target.date === '2026/07/20', `date 為 2026/07/20(實得 ${target && target.date})`);
}

// ── 2. parseDetailGantries ───────────────────────────────────────────────
console.log('\n[parseDetailGantries] fetc-detail-resp.txt');
{
  const html = readFixture('fetc-detail-resp.txt');
  const gantries = parseDetailGantries(html, '2026/07/20');
  assert(gantries.length === 93, `93 列(實得 ${gantries.length})`);

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
    assert(target.timeStr === '2026/07/20 23:28:23', `01F0293N timeStr=2026/07/20 23:28:23(實得 ${target.timeStr})`);
    // 牆鐘法校驗:Date.UTC(2026,6,20,23,28,23) 應與 timeTs 相等,且與本地時區解析無關
    const expectedTs = Date.UTC(2026, 6, 20, 23, 28, 23);
    assert(target.timeTs === expectedTs, `01F0293N timeTs 用牆鐘法(Date.UTC 分量)算出(實得 ${target.timeTs}, 預期 ${expectedTs})`);
    assert(target.amount === 7, `01F0293N amount=7(實得 ${target.amount})`);
  }
}

// ── 3. parsePrintRows ────────────────────────────────────────────────────
console.log('\n[parsePrintRows] fetc-print-resp.txt');
{
  const html = readFixture('fetc-print-resp.txt');
  const { rows, total } = parsePrintRows(html);
  assert(rows.length === 2, `2 列(我測時只丟 2 個時間戳,實得 ${rows.length})`);

  const row1 = rows.find((r) => r.time === '04:01:47');
  assert(!!row1, '含 time 04:01:47');
  if (row1) {
    assert(row1.route.includes('五股-高公局'), `route 含「五股-高公局」(實得 ${row1.route})`);
    assert(row1.mileage === '1.4', `mileage=1.4(實得 ${row1.mileage})`);
    assert(row1.toll.includes('1.6'), `toll 含 1.6(實得 ${row1.toll})`);
  }

  assert(!!total, '有 total 列');
  if (total) {
    assert(total.toll.includes('9.4'), `total 含 9.4(實得 ${JSON.stringify(total)})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
