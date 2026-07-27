// ── 遠通(FETC)列印頁 PDF 產生(Round H1)───────────────────────────────────
// 鐵則(使用者裁示):PDF 是收款憑證,必須是遠通自己生成的檔案。E0 實測列印頁上的
// 「下載PDF文件」按鈕按下去無任何網路請求=瀏覽器端由遠通頁面自己的 JS 生成 PDF
// (有文字層,天然含 CJK)。之前 Vercel 端用 serverless chromium 把中繼回的 printHtml
// 另外 render 成 PDF 踩了兩個雷:①serverless 無 CJK 字型,中文全消失;②print 傳了整日
// 全部門架時間戳,PDF 混入租期外的通行紀錄。正確做法=中繼開 headless 瀏覽器進**真正的
// 遠通列印頁**、按**遠通自己的下載按鈕**、攔截 download——絕不用 page.setContent() 塞
// 自家 HTML(那樣產出的 PDF 就不是「遠通生成的檔案」,鐵則不成立)。
//
// 下載按鈕 selector 未能實測確認(供本模組開發時參考的 fixture 檔案已於前一輪工作階段的
// scratchpad 清空,詳見工單回報):採寬鬆多選一 fallback,任何一個比對到就試。找不到/
// 點擊逾時一律降級 page.pdf() 印同一張真列印頁(via:'page-pdf'),不是遠通原生產出但至少
// 是同一頁真實 DOM(CSS/字型原生載入,不會有 CJK 缺字問題),而不是讓查詢直接失敗。
'use strict';

const fs = require('fs').promises;
const { parsePrintRows, parseAmount } = require('./parse');
const { PRINT_PATH } = require('./fetc-client');

const HOME_URL = 'https://www.fetc.net.tw/';
const COOKIE_URL = 'https://www.fetc.net.tw';

// 「下載PDF文件」按鈕:寬鬆多選一,依可能性排序。onclick 含 pdf 字樣是最後手段
// (遠通頁面若把下載邏輯掛在別的元素上,靠這條抓到的機率不高,但總比完全放棄好)。
const DOWNLOAD_SELECTORS = [
  'a:has-text("下載PDF文件")',
  'button:has-text("下載PDF文件")',
  'a:has-text("下載PDF")',
  'button:has-text("下載PDF")',
  '[onclick*="pdf" i]',
];

async function findDownloadButton(page) {
  for (const sel of DOWNLOAD_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) return loc;
    } catch (e) {
      // selector 語法本身在這個 Playwright 版本不受支援等——換下一個候選,不中斷流程
    }
  }
  return null;
}

// 讀列印頁「總計」通行費——重用 parse.js 既有、已用真實回應驗證過的 parsePrintRows,
// 而不是在這裡另開一套 page.evaluate 選擇器邏輯(單一權威來源,少一處會跟 parse.js 走鐘)。
// 抓不到不擋 PDF 產出,回 null。
async function extractPrintTotal(page) {
  try {
    const html = await page.content();
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
// 已取得、與目前 jar 配對的那份——不在這裡重新拿,理由同 queryAll 既有模式(search→detail→
// print 全程共用同一枚 field token,E0 實測過這樣是可行的)。
async function renderPrintPdf({ jar, plate, cin, dateTimeMap, fieldToken }) {
  const { chromium } = require('playwright'); // 沿用 lib/login.js 的 lazy require 慣例:平時查詢是純 HTTP,不必啟動就載入瀏覽器模組
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

    // 中繼手上的 session 只有純 cookie(lib/fetc-client.js CookieJar),這是把它接進
    // playwright context 的唯一橋樑——不這樣做瀏覽器進站會是未登入狀態。
    const cookies = Object.entries(jar.toObject()).map(([name, value]) => ({
      name,
      value,
      url: COOKIE_URL,
    }));
    if (cookies.length) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 動態組真表單 POST 進真列印頁——這是鐵則「PDF 必須遠通自己生成」在瀏覽器這一步的
    // 落地:絕不 setContent() 塞自家 HTML,連 DOM 都要是遠通伺服器原生吐出來的那份。
    try {
      await page.evaluate(
        ({ action, cln, cin: cinVal, dateTimeJSON, token }) => {
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
        { action: PRINT_PATH, cln: plate, cin, dateTimeJSON: JSON.stringify(dateTimeMap), token: fieldToken }
      );
    } catch (e) {
      // form.submit() 觸發的導航有時會在 evaluate() 的 IPC 往返完成前就摧毀當時的執行
      // 環境,拋出良性的「execution context destroyed」——不代表提交失敗,下面
      // waitForLoadState 仍會正確等到列印頁載入完成,吞掉即可。
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    // 額外給版面/字型/(可能存在的)PDF 產生用 JS 一點餘裕——遠通按鈕的 PDF 是瀏覽器端當場
    // 生成,若相關資源(圖片/字型)還沒 load 完就點,產出的 PDF 可能缺圖或版面跑掉。load
    // 事件若遲遲不發(如頁面有長輪詢)也不致命,逾時就繼續往下走,不讓它卡住整條流程。
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});

    let pdfBuffer = null;
    let via = null;
    const dlButton = await findDownloadButton(page);
    if (dlButton) {
      try {
        const dlPromise = page.waitForEvent('download', { timeout: 20000 });
        await dlButton.click();
        const download = await dlPromise;
        const dlPath = await download.path();
        pdfBuffer = await fs.readFile(dlPath);
        via = 'fetc-button';
      } catch (e) {
        console.warn('[etag-relay] 遠通下載按鈕點擊/攔截失敗,降級整頁列印:', e && e.message);
      }
    } else {
      console.warn('[etag-relay] 找不到遠通下載按鈕(selector 全數落空),降級整頁列印');
    }

    if (!pdfBuffer) {
      try {
        pdfBuffer = await page.pdf({ format: 'A4' });
        via = 'page-pdf';
      } catch (e) {
        console.error('[etag-relay] page.pdf() 降級也失敗:', e && e.message);
        return { ok: false, reason: 'pdf-failed' };
      }
    }

    const printTotal = await extractPrintTotal(page);

    return { ok: true, pdfBase64: pdfBuffer.toString('base64'), via, printTotal };
  } catch (e) {
    console.error('[etag-relay] 列印 PDF 流程例外:', e && e.message);
    return { ok: false, reason: 'pdf-failed' };
  } finally {
    // 任何路徑都要關瀏覽器——常駐的 headless chromium 是白吃 CPU/RAM,且不可讓 relay
    // 因為忘了收尾而慢慢堆滿殭屍程序。
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderPrintPdf };
