// ── 遠通(FETC)通行明細 HTML 解析器 ──────────────────────────────────────
// 三支解析函式對應 E0 實測的三步查詢鏈回應(皆為 server-rendered HTML,cheerio 可解):
//   1. search  → UX050506TrafficAdvancedSearch 回應:批次列(#tblFeeList tr[data-level=1])
//   2. detail  → UX050507AdvancedSearchDetail  回應:逐門架列(tr[data-level=3])
//   3. print   → UX050508TrafficAdvancedSearchPrint 回應:列印表格(tr.detail-row + 總計列)
//
// 時間一律用「牆鐘 timestamp」法(比照 gafferland-main/public/js/rent-time.js wallTs):
// 字串分量 → Date.UTC(...),禁止 new Date('yyyy/mm/dd hh:mm:ss') 本地解析(HA 容器
// 時區未知,本地解析在非 Asia/Taipei 環境會偏移)。
'use strict';

const cheerio = require('cheerio');

// ── 列數上限(0.5.1)──────────────────────────────────────────────────────
// 防禦性上限,非預期回應內容爆量時截斷而非放任記憶體/CPU 無限吃(截斷＋warn,
// 不 throw——契約沒有 too-many-rows 這個 reason,throw 會讓 /query|/print 變 500
// 斷結算,截斷仍回可用的部分結果對呼叫端更友善)。
// 上限論證(基準=E0/E1 實測正常值,取數倍寬鬆空間):
//   detail 單日單批(實測 93 列)→ 500 = 5 倍以上
//   search 一次查詢窗涵蓋的天數(批次數)→ 100
//   print 整段租期(93 × 30 天 ≈ 2790 列量級)→ 5000
const MAX_SEARCH_BATCHES = 100;
const MAX_DETAIL_ROWS = 500;
const MAX_PRINT_ROWS = 5000;

// "2026/07/20" + "23:28:23" → 牆鐘 ts(ms)。日期或時間格式不符回 NaN。
function wallTsFromParts(dateStr, timeStr) {
  const dm = String(dateStr || '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  const tm = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!dm || !tm) return NaN;
  return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +tm[3]);
}

// "yyyy/MM/dd" + "HH:mm:ss" → "yyyy/MM/dd HH:mm:ss"(遠通 dateTimeJSON 用的格式)
function combineDateTime(dateStr, timeStr) {
  return `${dateStr} ${timeStr}`;
}

// 金額字串("650.4元"、"7元"、"1.6元")→ number。解析失敗回 NaN。
function parseAmount(text) {
  if (text == null) return NaN;
  const m = String(text).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

// search 回應 → 批次列 [{batchId, date:'yyyy/MM/dd'}]
// #tblFeeList 內 tr.expander-cus[data-level="1"][data-batchid][data-date]
function parseSearchBatches(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('#tblFeeList tr[data-level="1"]').each((_, el) => {
    if (out.length >= MAX_SEARCH_BATCHES) {
      console.warn(`[parse] parseSearchBatches 已達上限 ${MAX_SEARCH_BATCHES} 批,其餘列略過`);
      return false; // cheerio each() return false = 中斷迭代
    }
    const $el = $(el);
    const batchId = $el.attr('data-batchid');
    const date = $el.attr('data-date');
    if (!batchId || !date) return; // 無 batchId/date 的列視為無效,跳過(比照「無 lux＝無效列」慣例)
    out.push({ batchId: String(batchId).trim(), date: String(date).trim() });
  });
  return out;
}

// detail 回應 → 逐門架列 [{timeStr, timeTs, gantry, route, amount}]
// tr.expander-cus[data-level="3"][data-date="HH:MM:SS"],checkbox id=chkPrint_{idx}_{batchId}_{門架碼}
// batchDate('yyyy/MM/dd')由呼叫端傳入(來自 parseSearchBatches 該批次的 date)。
//
// ⚠ 遠通此端點回的是「AJAX 局部 HTML」(裸 <tr> 列,無外層 <table>)——瀏覽器端是
// 直接插入既有表格 DOM,但 cheerio 預設用 parse5 樹狀建構規則解析,會依 HTML5
// 「tr/td 不可存在於 table 語境外」規則整段丟棄(foster parenting 把它們吃掉,
// 實測 tr 數變 0)。解法:解析前先包一層 <table><tbody>…</tbody></table> 補回合法
// table 語境,cheerio 就能正常抓到列。
function parseDetailGantries(html, batchDate) {
  const $ = cheerio.load(`<table><tbody>${html}</tbody></table>`);
  const out = [];
  $('tr[data-level="3"]').each((_, el) => {
    if (out.length >= MAX_DETAIL_ROWS) {
      console.warn(`[parse] parseDetailGantries 已達上限 ${MAX_DETAIL_ROWS} 列,其餘列略過`);
      return false;
    }
    const $tr = $(el);
    const timeStr = $tr.attr('data-date');
    if (!timeStr) return;

    const chk = $tr.find('input.chkPrint[id^="chkPrint_"]').first();
    const id = chk.attr('id') || '';
    // chkPrint_{idx}_{batchId}_{門架碼},門架碼本身可能含底線以外字元但不含底線,故用 3 段切法
    const idParts = id.split('_');
    const gantry = idParts.length >= 4 ? idParts.slice(3).join('_') : null;

    const tds = $tr.find('> td');
    // td 順序:0=checkbox,1=時間,2=行車路線,3=里程,4=門架牌價,5=狀態
    const route = tds.eq(2).text().trim();
    const amount = parseAmount(tds.eq(4).text());

    const timeTs = wallTsFromParts(batchDate, timeStr);

    out.push({
      timeStr: combineDateTime(batchDate, timeStr),
      timeTs,
      gantry,
      route,
      amount,
    });
  });
  return out;
}

// print 回應 → { rows:[{time, route, mileage, toll}], total:{mileage, toll} }
// tr.detail-row 逐列;總計列=tr 內含 td.date.total(文字「總計」)
function parsePrintRows(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('#tblFeeList tr.detail-row').each((_, el) => {
    if (rows.length >= MAX_PRINT_ROWS) {
      console.warn(`[parse] parsePrintRows 已達上限 ${MAX_PRINT_ROWS} 列,其餘列略過`);
      return false;
    }
    const tds = $(el).find('> td');
    rows.push({
      time: tds.eq(0).text().trim(),
      route: tds.eq(1).text().trim(),
      mileage: tds.eq(2).text().trim(),
      toll: tds.eq(3).text().trim(),
    });
  });

  let total = null;
  $('#tblFeeList tr').each((_, el) => {
    const $tr = $(el);
    if ($tr.find('td.date.total').length) {
      const tds = $tr.find('> td');
      total = {
        mileage: tds.eq(2).text().trim(),
        toll: tds.eq(3).text().trim(),
      };
    }
  });

  return { rows, total };
}

module.exports = {
  wallTsFromParts,
  combineDateTime,
  parseAmount,
  parseSearchBatches,
  parseDetailGantries,
  parsePrintRows,
};
