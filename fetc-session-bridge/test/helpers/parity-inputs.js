'use strict';
// parity 案的輸入(逐字搬自 2.2.0 的 parse-parity／request-parity 測試)。
// etag-relay 0.8.0 拆掉 lib/parse.js、lib/fetc-client.js 後,「同一輸入 → 同一輸出」改對
// golden/relay-parity.json(拆除前用 relay 對這些輸入產生的輸出,無損編碼見 canon.js)。
// 輸入一改,golden 就對不上——要改輸入就等於要重新論證與當年 relay 行為相同。全部合成資料。

const DATES = ['2026/07/20', '2026-7-5', ' 2026/07/20 ', '2026/07', '', null, undefined, 'abc'];
const TIMES = ['12:30:45', '1:02:03', '25:61:61', '12:30', '', null, 'xx'];
const AMOUNTS = ['650.4元', '7元', '1,234.5元', ' 1.6 元', '-3', '元', '', null, undefined, 'abc', 12];

const DETAIL_CASES = [
  '',
  '<tr data-level="3"><td></td></tr>',
  '<tr data-level="3" data-date="01:02:03"><td></td><td></td></tr>',
  '<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="chkPrint_1_B_G"></td><td>x</td><td>A &amp; B</td><td>1</td><td>1,234.5元</td></tr>',
  '<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="chkPrint_1_B_G_X_Y"></td><td>x</td><td> 路線 </td><td>1</td><td>abc</td></tr>',
  '<tr data-level="2" data-date="01:02:03"><td>level2</td></tr><tr data-level="3" data-date="9:5:7"><td></td><td></td><td>r</td><td></td><td>3元</td></tr>',
  '<tr data-level="3" data-date="01:02:03"><td><input class="chkPrint" id="other_1_B_G"><input class="chkPrint" id="chkPrint_2_B2_G2"></td><td></td><td>R</td><td></td><td>2元</td></tr>',
];
const SEARCH_CASES = [
  '',
  '<table id="tblFeeList"><tr data-level="1" data-batchid=" B1 " data-date=" 2026/07/20 "></tr><tr data-level="2" data-batchid="B2" data-date="2026/07/21"></tr></table>',
  '<tr data-level="1" data-batchid="B1" data-date="2026/07/20"></tr>',
];
const PRINT_CASES = [
  '',
  '<table id="tblFeeList"><tr class="detail-row"><td>a</td></tr></table>',
  '<table id="tblFeeList"><tr><td class="date total">總計</td><td></td><td>1</td><td>2元</td></tr><tr><td class="date total">總計</td><td></td><td>3</td><td>4元</td></tr></table>',
  '<table id="tblFeeList"><tr class="detail-row"><td> 1 </td><td>A<b>B</b></td><td>2</td><td>3元</td><td>extra</td></tr></table>',
];
const TOKEN_CASES = [
  '<input name="__RequestVerificationToken" value="t1"><input name="__RequestVerificationToken" value="t2">',
  '<input name="__RequestVerificationToken">',
  '<input name="other" value="x">',
  '',
];
const LOGIN_CASES = [['x/UX0301UserLogin', ''], ['x', 'smartAccount smartPassword'], ['x', 'nothing']];

// 上限案:detail 601 列、search 101 批、print 5001 列
function limitInputs() {
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
  const sp = [];
  for (let i = 0; i < 101; i++) {
    sp.push(`<tr data-level="1" data-batchid="26072000000000${String(i).padStart(5, '0')}" data-date="2026/07/20"><td>x</td></tr>`);
  }
  const pp = [];
  for (let i = 0; i < 5001; i++) pp.push(`<tr class="detail-row"><td>00:00:${i % 60}</td><td>r</td><td>1</td><td>1元</td></tr>`);
  return {
    detail: parts.join(''),
    search: `<table id="tblFeeList"><tbody>${sp.join('')}</tbody></table>`,
    print: `<table id="tblFeeList"><tbody>${pp.join('')}</tbody></table>`,
  };
}

const WINDOW = { startDate: '2026/07/20', endDate: '2026/07/21' };
const PRINT_TIMES = ['2026/07/20 12:30:45', '2026/07/21 14:00:10', '2026/07/20 03:00:00'];

function pdfContentInputs(H) {
  return [H.RICH_PRINT_HTML, H.fixture('print.html'), '<div>沒有 head/body 的片段 <img src="/a.png"></div>', ''];
}

module.exports = {
  DATES, TIMES, AMOUNTS, DETAIL_CASES, SEARCH_CASES, PRINT_CASES, TOKEN_CASES, LOGIN_CASES,
  limitInputs, WINDOW, PRINT_TIMES, pdfContentInputs,
};
