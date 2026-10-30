// ── 遠通(FETC)通行明細 HTML 解析器(瀏覽器版,移植自 etag-relay/lib/parse.js)──────
// 輸出逐欄等同中繼 ≤0.7.1 版(test/parse-parity.test.js 以 golden/relay-parity.json 與 test/fixtures 鎖住)。
// 差別只有 DOM 來源:中繼用 cheerio,這裡用參數 parseHtml(html) → Document
//   瀏覽器:html => new DOMParser().parseFromString(html, 'text/html')
//   Node 測試:linkedom 的 DOMParser
// 不傳 parseHtml 時預設走 globalThis.DOMParser(瀏覽器環境)。
//
// 載入方式:<script> / chrome.scripting.executeScript({files}) → 掛 globalThis.GflFetcParse;
// Node → module.exports。不用 ES module、不 require 任何套件、不碰 chrome.*。
//
// 時間一律「牆鐘 ts」(Date.UTC 分量),禁止 new Date('yyyy/mm/dd hh:mm:ss') 本地解析。
(function (root) {
  'use strict';

  // 列數上限(同中繼 0.5.1;截斷＋warn,不 throw)
  const MAX_SEARCH_BATCHES = 100;
  const MAX_DETAIL_ROWS = 500;
  const MAX_PRINT_ROWS = 5000;

  function warn(msg) {
    if (typeof console !== 'undefined' && console.warn) console.warn(msg);
  }

  function defaultParseHtml(html) {
    return new root.DOMParser().parseFromString(html, 'text/html');
  }

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

  // ── DOM 小工具(對應 cheerio 的 .text().trim() 與 .find('> td'))──
  function textOf(el) {
    return el ? String(el.textContent == null ? '' : el.textContent).trim() : '';
  }
  function directTds(tr) {
    return Array.from(tr.children || []).filter((c) => String(c.tagName).toLowerCase() === 'td');
  }

  // search 回應 → 批次列 [{batchId, date:'yyyy/MM/dd'}]
  function parseSearchBatches(html, parseHtml) {
    const doc = (parseHtml || defaultParseHtml)(html);
    const out = [];
    const els = Array.from(doc.querySelectorAll('#tblFeeList tr[data-level="1"]'));
    for (const el of els) {
      if (out.length >= MAX_SEARCH_BATCHES) {
        warn(`[parse] parseSearchBatches 已達上限 ${MAX_SEARCH_BATCHES} 批,其餘列略過`);
        break;
      }
      const batchId = el.getAttribute('data-batchid');
      const date = el.getAttribute('data-date');
      if (!batchId || !date) continue; // 無 batchId/date 的列視為無效,跳過
      out.push({ batchId: String(batchId).trim(), date: String(date).trim() });
    }
    return out;
  }

  // detail 回應 → 逐門架列 [{timeStr, timeTs, gantry, route, amount}]
  // ⚠ 遠通此端點回「AJAX 局部 HTML」(裸 <tr>,無外層 <table>):HTML5 解析規則會把
  // table 語境外的 tr/td 整段丟棄,解析前必須先包 <table><tbody>…</tbody></table>。
  function parseDetailGantries(html, batchDate, parseHtml) {
    const doc = (parseHtml || defaultParseHtml)(`<table><tbody>${html}</tbody></table>`);
    const out = [];
    const trs = Array.from(doc.querySelectorAll('tr[data-level="3"]'));
    for (const tr of trs) {
      if (out.length >= MAX_DETAIL_ROWS) {
        warn(`[parse] parseDetailGantries 已達上限 ${MAX_DETAIL_ROWS} 列,其餘列略過`);
        break;
      }
      const timeStr = tr.getAttribute('data-date');
      if (!timeStr) continue;

      const chk = tr.querySelector('input.chkPrint[id^="chkPrint_"]');
      const id = (chk && chk.getAttribute('id')) || '';
      // chkPrint_{idx}_{batchId}_{門架碼}
      const idParts = id.split('_');
      const gantry = idParts.length >= 4 ? idParts.slice(3).join('_') : null;

      const tds = directTds(tr);
      // td 順序:0=checkbox,1=時間,2=行車路線,3=里程,4=門架牌價,5=狀態
      const route = textOf(tds[2]);
      const amount = parseAmount(textOf(tds[4]));
      const timeTs = wallTsFromParts(batchDate, timeStr);

      out.push({
        timeStr: combineDateTime(batchDate, timeStr),
        timeTs,
        gantry,
        route,
        amount,
      });
    }
    return out;
  }

  // print 回應 → { rows:[{time, route, mileage, toll}], total:{mileage, toll}|null }
  function parsePrintRows(html, parseHtml) {
    const doc = (parseHtml || defaultParseHtml)(html);
    const rows = [];
    const trs = Array.from(doc.querySelectorAll('#tblFeeList tr.detail-row'));
    for (const tr of trs) {
      if (rows.length >= MAX_PRINT_ROWS) {
        warn(`[parse] parsePrintRows 已達上限 ${MAX_PRINT_ROWS} 列,其餘列略過`);
        break;
      }
      const tds = directTds(tr);
      rows.push({
        time: textOf(tds[0]),
        route: textOf(tds[1]),
        mileage: textOf(tds[2]),
        toll: textOf(tds[3]),
      });
    }

    let total = null;
    for (const tr of Array.from(doc.querySelectorAll('#tblFeeList tr'))) {
      if (tr.querySelector('td.date.total')) {
        const tds = directTds(tr);
        total = {
          mileage: textOf(tds[2]),
          toll: textOf(tds[3]),
        };
      }
    }
    return { rows, total };
  }

  // 從 HTML 取 <input name="__RequestVerificationToken" value="...">(取第一個)
  function extractFieldToken(html, parseHtml) {
    const doc = (parseHtml || defaultParseHtml)(html);
    const el = doc.querySelector('input[name="__RequestVerificationToken"]');
    const val = el ? el.getAttribute('value') : null;
    return val || null;
  }

  // 會員主頁 → 該車牌的 cin(同中繼 resolveCin:掃 [data-cln],[data-plate],後者覆蓋前者)。
  // 找不到回 null。
  function findCinForPlate(memberHtml, plate, parseHtml) {
    const doc = (parseHtml || defaultParseHtml)(memberHtml);
    let cin = null;
    for (const el of Array.from(doc.querySelectorAll('[data-cln], [data-plate]'))) {
      const p = el.getAttribute('data-cln') || el.getAttribute('data-plate');
      if (p && p.trim() === plate) {
        cin = el.getAttribute('data-cin') || el.getAttribute('value') || null;
      }
    }
    return cin;
  }

  // 判斷回應是否被導回登入頁(session 失效)。
  function looksLikeLoginRedirect(finalUrl, html) {
    if (/UX0301UserLogin/i.test(finalUrl || '')) return true;
    if (html && /smartAccount/.test(html) && /smartPassword/.test(html)) return true;
    return false;
  }

  // 判斷回應是否為 Cloudflare 挑戰頁(403/503 且 body 含「Just a moment」)。
  function isCfChallengeBody(status, html) {
    if (status !== 403 && status !== 503) return false;
    return /Just a moment/i.test(html || '');
  }

  const api = {
    MAX_SEARCH_BATCHES,
    MAX_DETAIL_ROWS,
    MAX_PRINT_ROWS,
    wallTsFromParts,
    combineDateTime,
    parseAmount,
    parseSearchBatches,
    parseDetailGantries,
    parsePrintRows,
    extractFieldToken,
    findCinForPlate,
    looksLikeLoginRedirect,
    isCfChallengeBody,
  };

  root.GflFetcParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
