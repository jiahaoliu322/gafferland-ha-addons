// ── 遠通(FETC)列印 PDF 產生(Round H1;0.3.7 依真實 DOM 改版)───────────────
// 鐵則(使用者裁示):PDF 是收款憑證,必須是遠通自己生成的檔案。
//
// 0.3.7 關鍵發現(使用者 DevTools 實查):**列印不是獨立頁面,是會員頁上的彈窗**——
// 會員頁以 XHR(anti-forgery token 放 **header**)POST UX050508 拿回列印 HTML 片段,
// 塞進 `#printDetail .popupCon`;「下載PDF文件」按鈕=`a.btn-download-pdf`,屬**會員頁
// 彈窗骨架**,不在列印片段裡。0.3.6 用表單 POST 直接導航到列印端點只會拿到裸片段,
// 頁上根本沒有按鈕(當時 selector 全落空的真正原因)。
//
// 正確做法=完全照遠通自己的流程:進會員頁 → 頁內發同樣的 XHR → 片段塞進它自己的彈窗
// → 打開彈窗 → 按真正的 a.btn-download-pdf(其 JS 在會員頁,瀏覽器端生成有文字層的
// PDF)→ 攔截 download。fallback(按鈕流程失敗)退 0.3.6 的「表單 POST 導航裸片段
// → page.pdf()」——內容/字型仍是遠通原生(同一片段、原站資源),但檔案是我們印的,
// via:'page-pdf' 明確標示非原生件。
'use strict';

const fs = require('fs').promises;
const { parsePrintRows, parseAmount } = require('./parse');
const { PRINT_PATH } = require('./fetc-client');

const MEMBER_URL = 'https://www.fetc.net.tw/Member';
const COOKIE_URL = 'https://www.fetc.net.tw';

// 會員頁彈窗骨架的下載鈕(2026-07-27 使用者 DevTools 實查確認);後兩個是保險。
const DOWNLOAD_SELECTORS = [
  '#printDetail a.btn-download-pdf',
  'a.btn-download-pdf',
  'a:has-text("下載PDF文件")',
];

async function findDownloadButton(page) {
  for (const sel of DOWNLOAD_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) return loc;
    } catch (e) {
      // selector 語法不受支援等——換下一個候選,不中斷流程
    }
  }
  return null;
}

// 列印片段 → 總計通行費。重用 parse.js 既有、已用真實回應驗證過的 parsePrintRows
// (單一權威來源,不另開一套選擇器邏輯)。抓不到不擋 PDF 產出,回 null。
function totalFromPrintHtml(html) {
  try {
    const { total } = parsePrintRows(html);
    if (!total || !total.toll) return null;
    const amt = parseAmount(total.toll);
    return Number.isFinite(amt) ? amt : null;
  } catch (e) {
    return null;
  }
}

// 主函式:{ jar, plate, cin, dateTimeMap, fieldToken } → { ok, pdfBase64, via, printTotal }
// 或 { ok:false, reason:'pdf-failed' }。fieldToken 沿用呼叫端(buildDateTimeMapForTimes)
// 已取得、與目前 jar 配對的那份。
async function renderPrintPdf({ jar, plate, cin, dateTimeMap, fieldToken }) {
  const { chromium } = require('playwright'); // lazy require:平時查詢純 HTTP,不必載入瀏覽器模組
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    });

    // 中繼手上的 session 是純 cookie(lib/fetc-client.js CookieJar)——灌進 context,
    // 瀏覽器進站才是登入狀態。
    const cookies = Object.entries(jar.toObject()).map(([name, value]) => ({
      name,
      value,
      url: COOKIE_URL,
    }));
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(MEMBER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 會員頁的彈窗骨架/下載鈕 JS 都在這頁,給資源載入一點餘裕(逾時不致命,續走)
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

    // 頁內發遠通自己的那支 XHR(shape 照使用者 curl 實錄:urlencoded body、token 放
    // header、X-Requested-With)拿列印片段——same-origin,cookies 自動帶。
    const printHtml = await page.evaluate(
      async ({ action, cln, cinVal, dateTimeJSON, token }) => {
        const body = new URLSearchParams({ cln, cin: cinVal, dateTimeJSON }).toString();
        const resp = await fetch(action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            '__RequestVerificationToken': token,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body,
          credentials: 'include',
        });
        if (!resp.ok) throw new Error('print-xhr-status-' + resp.status);
        return await resp.text();
      },
      { action: PRINT_PATH, cln: plate, cinVal: cin, dateTimeJSON: JSON.stringify(dateTimeMap), token: fieldToken }
    ).catch((e) => {
      console.warn('[etag-relay] 列印片段 XHR 失敗:', e && e.message);
      return null;
    });

    const printTotal = printHtml ? totalFromPrintHtml(printHtml) : null;

    let pdfBuffer = null;
    let via = null;

    if (printHtml) {
      // 片段塞進遠通自己的彈窗容器並打開——完全比照站方 JS 的行為,讓 a.btn-download-pdf
      // 的處理器讀到它預期的 DOM 結構。
      const injected = await page.evaluate((html) => {
        const dlg = document.getElementById('printDetail');
        const con = dlg && dlg.querySelector('.popupCon');
        if (!dlg || !con) return false;
        con.innerHTML = html;
        dlg.classList.remove('is_hide');
        return true;
      }, printHtml).catch(() => false);

      if (injected) {
        // 等片段內圖片(遠通 logo/憑證章)載完再按——按鈕的 PDF 是當場從 DOM 生成,
        // 圖沒載完產出會缺圖。逾時不致命。
        await page.waitForTimeout(1500);
        const dlButton = await findDownloadButton(page);
        if (dlButton) {
          try {
            // 瀏覽器端生成 PDF(html2canvas 類)可能要幾秒,攔截窗給足 30s
            const dlPromise = page.waitForEvent('download', { timeout: 30000 });
            await dlButton.click();
            const download = await dlPromise;
            const dlPath = await download.path();
            pdfBuffer = await fs.readFile(dlPath);
            via = 'fetc-button';
          } catch (e) {
            console.warn('[etag-relay] 遠通下載按鈕點擊/攔截失敗,降級:', e && e.message);
          }
        } else {
          console.warn('[etag-relay] 會員頁上找不到 a.btn-download-pdf,降級');
        }
      } else {
        console.warn('[etag-relay] 會員頁上找不到 #printDetail 彈窗容器(可能未登入或版面改版),降級');
      }
    }

    // fallback:0.3.6 的表單 POST 導航裸片段 → page.pdf()。內容仍是遠通原生片段+原站
    // 資源,但檔案是我們印的——via 明確標示,Vercel 端會 warn。
    if (!pdfBuffer) {
      try {
        try {
          await page.evaluate(
            ({ action, cln, cinVal, dateTimeJSON, token }) => {
              const form = document.createElement('form');
              form.method = 'POST';
              form.action = action;
              const fields = { cln, cin: cinVal, dateTimeJSON, __RequestVerificationToken: token };
              for (const [name, value] of Object.entries(fields)) {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = name;
                input.value = value;
                form.appendChild(input);
              }
              document.body.appendChild(form);
              form.submit();
            },
            { action: PRINT_PATH, cln: plate, cinVal: cin, dateTimeJSON: JSON.stringify(dateTimeMap), token: fieldToken }
          );
        } catch (e) {
          // form.submit() 導航會摧毀 evaluate 的執行環境,拋良性錯誤——waitForLoadState 兜住
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
        pdfBuffer = await page.pdf({ format: 'A4' });
        via = 'page-pdf';
      } catch (e) {
        console.error('[etag-relay] page.pdf() 降級也失敗:', e && e.message);
        return { ok: false, reason: 'pdf-failed' };
      }
    }

    return { ok: true, pdfBase64: pdfBuffer.toString('base64'), via, printTotal };
  } catch (e) {
    console.error('[etag-relay] 列印 PDF 流程例外:', e && e.message);
    return { ok: false, reason: 'pdf-failed' };
  } finally {
    // 任何路徑都要關瀏覽器——不可讓 relay 堆滿殭屍 headless chromium
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderPrintPdf };
