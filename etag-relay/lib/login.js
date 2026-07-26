// ── 遠通(FETC)登入流程(playwright)──────────────────────────────────
// 2026-07-27 E1-d 活測校正:依真實登入頁 DOM 重寫(首頁 #section-2 會員登入分頁)。
//
// 職責分離(機制③):HA 只持 FETC_ACCOUNT/FETC_PASSWORD(add-on secret);老闆的
// LINE 金鑰只在 Vercel。此模組只管「開瀏覽器登入、截驗證碼、等 4 碼餵回、拿 session」。
//
// 登入頁真實結構(E1-d dump)：https://www.fetc.net.tw/ 首頁內含登入區,分頁 `._login_tab`：
//   #section-1 車號登入(sForm1) / #section-2 會員登入(sForm2,預設隱藏,要點分頁才顯示)
// section-2 欄位：
//   帳號 #smart-account-login-account (name smartIDLogin.smartAccount)
//   密碼 #smartIDLogin_smartPassword   (name smartIDLogin.smartPassword)
//   驗證碼 #smartIDLogin_validateCode  (name smartIDLogin.validateCode, maxlength 4)
//   驗證碼圖 `#section-2 .vcodeImage`(src 由 JS 帶入;刷新 `#section-2 a.refresh` _reflashVcode)
//   recaptcha 隱藏欄 #smartIDLogin_recaptchaToken(頁面 recaptchaLoginSubmit 自動填)
//   送出＝連結 onclick="recaptchaLoginSubmit('sForm2', ...)"（會跑 grecaptcha v3 → AJAX POST
//        /UX0301UserLogin/UX030101SmartIDLogin，data-ajax-success=SmartIDHandler）
// 成功偵測＝AJAX 後 FETC_P 認證 cookie 出現（E0 證實登入後才有此 cookie）或導向 /Member。
'use strict';

const crypto = require('crypto');

const HOME_URL = 'https://www.fetc.net.tw/';
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const pending = new Map();

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function getCaptchaImage(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CAPTCHA_TTL_MS) {
    pending.delete(token);
    return null;
  }
  return entry.imageBuffer;
}

// 送出後判定成功:遠通登入是 AJAX(data-ajax-success="SmartIDHandler"),成功不一定導航,
// 故三路並行判定 —— ①FETC_P 認證 cookie 出現(E0 證實登入後才有) ②URL 變 /Member
// ③攔截到的登入 AJAX 回應內容(由 startLogin 掛的 response listener 寫入 ctx.loginResponse)。
// 逾時回 {ok:false, detail}:detail 帶遠通實際回應片段/頁面錯誤訊息,供日誌診斷(不含帳密)。
async function waitLoginSuccess(page, context, ctx, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const cookies = await context.cookies();
      if (cookies.some((c) => c.name === 'FETC_P' && c.value)) return { ok: true };
      if (/\/Member/i.test(page.url())) return { ok: true };
    } catch (e) { /* 導航中讀 cookie 可能短暫失敗,續輪詢 */ }
    await page.waitForTimeout(500);
  }

  // 逾時:蒐集診斷資訊(遠通 AJAX 回應 + 頁面上的驗證訊息)
  let detail = '';
  if (ctx.loginResponse) detail += `ajax=${String(ctx.loginResponse).slice(0, 300)}`;
  try {
    const msgs = await page.$$eval(
      '#section-2 .validate-error, #_alert_message, #_alert_withTitle_message',
      (els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | ')
    );
    if (msgs) detail += ` page="${msgs.slice(0, 200)}"`;
  } catch (e) { /* 頁面可能已變動 */ }
  return { ok: false, detail: detail || '(無可用診斷資訊)' };
}

// 啟動一次登入流程。回 Promise<{cookies}>,失敗 reject。
// onCaptchaReady(token, loginId):通知 Vercel 圖好了(server.js 提供)。
async function startLogin({ account, password, onCaptchaReady }) {
  const { chromium } = require('playwright');

  const loginId = crypto.randomUUID();
  const token = newToken();

  // headless:false ＋ xvfb 虛擬螢幕(Dockerfile CMD 用 xvfb-run 包住整個 process)——
  // 2026-07-27 E1-d 實測:headless 模式下遠通回 {"isSucceed":false,"errorMessage":"驗證失敗,
  // 請重新整理頁面後再試"} ＝ reCAPTCHA v3 判定為機器人(4 碼驗證碼本身是對的)。
  // v3 主要看瀏覽器指紋/行為,headless 是最大扣分項;改跑真實 Chrome on xvfb 提高分數。
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
    ],
  });
  try {
    const context = await browser.newContext({
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
      viewport: { width: 1440, height: 900 },
      userAgent: UA,
    });
    // 抹掉 navigator.webdriver 等自動化指紋(v3 會讀)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-TW', 'zh', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    const page = await context.newPage();

    // 攔截登入 AJAX 回應(SmartIDLogin),供成功判定與失敗診斷用(只留內容片段,不含帳密)
    const ctx = { loginResponse: null };
    page.on('response', async (resp) => {
      try {
        if (/UX030101SmartIDLogin/i.test(resp.url())) {
          const body = await resp.text().catch(() => '');
          ctx.loginResponse = `status=${resp.status()} body=${body.slice(0, 300)}`;
        }
      } catch (e) { /* 忽略:診斷用途,不可影響主流程 */ }
    });

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 1. 開登入彈窗:整個登入區在 <div class="popup is_hide" id="_login"> 內(預設隱藏),
    //    要先點首頁登入入口才顯示(E1-d 活測:不開彈窗則分頁連結與欄位皆 not visible)。
    //    先試點真實入口(較忠於使用者流程、會跑到頁面自己的初始化);點不到再直接拆 is_hide 保險。
    const opener = 'a[href*="_login"], a[onclick*="_login"], .js_login, a.login, header a:has-text("登入")';
    await page.click(opener, { timeout: 5000 }).catch(() => {});
    const loginVisible = async () => {
      try { return await page.locator('#_login').first().isVisible(); } catch (e) { return false; }
    };
    if (!(await loginVisible())) {
      // fallback:直接移除 is_hide（該彈窗的顯示只靠此 class 切換）
      await page.evaluate(() => {
        const el = document.querySelector('#_login');
        if (el) { el.classList.remove('is_hide'); el.style.display = 'block'; }
      }).catch(() => {});
    }

    // 2. 切到「會員登入」分頁(section-2),等表單顯示
    await page.click('._login_tab a[href="#section-2"]', { timeout: 15000 });
    await page.waitForSelector('#smart-account-login-account', { state: 'visible', timeout: 15000 });

    // 2. 填帳密
    // 逐字輸入(帶延遲)＋滑鼠移動:v3 也看互動行為,fill() 瞬間灌值是機器人特徵
    await page.mouse.move(700, 400);
    await page.click('#smart-account-login-account');
    await page.type('#smart-account-login-account', account, { delay: 90 });
    await page.click('#smartIDLogin_smartPassword');
    await page.type('#smartIDLogin_smartPassword', password, { delay: 90 });

    // 3. 等驗證碼圖載入(vcodeImage src 由 JS 帶入);沒載到就點刷新再等
    const imgSel = '#section-2 .vcodeImage';
    const imgLoaded = (sel) => {
      const img = document.querySelector(sel);
      return !!(img && img.complete && img.naturalWidth > 0);
    };
    try {
      await page.waitForFunction(imgLoaded, imgSel, { timeout: 8000 });
    } catch (e) {
      await page.click('#section-2 a.refresh').catch(() => {});
      await page.waitForFunction(imgLoaded, imgSel, { timeout: 8000 }).catch(() => {});
    }
    const captchaEl = await page.$(imgSel);
    const imageBuffer = captchaEl ? await captchaEl.screenshot() : null;

    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = async (fn, arg) => {
        if (settled) return;
        settled = true;
        pending.delete(token);
        await browser.close().catch(() => {});
        fn(arg);
      };

      pending.set(token, {
        imageBuffer,
        createdAt: Date.now(),
        loginId,
        resolve: async (code) => {
          try {
            await page.click('#smartIDLogin_validateCode');
            await page.type('#smartIDLogin_validateCode', code, { delay: 120 });
            // 4. 頁面原生送出(grecaptcha v3 + AJAX);點含 sForm2 的送出連結
            await page.click("a[onclick*=\"'sForm2'\"]");
            // 5. 成功偵測(AJAX 式登入,45s——含 grecaptcha 執行與遠通回應時間)
            const res = await waitLoginSuccess(page, context, ctx, 45000);
            if (!res.ok) return finish(reject, new Error('login-failed: ' + res.detail));
            const cookies = await context.cookies();
            return finish(resolve, { cookies });
          } catch (e) {
            return finish(reject, e);
          }
        },
        reject: (e) => finish(reject, e),
      });

      if (onCaptchaReady) {
        Promise.resolve(onCaptchaReady(token, loginId)).catch((e) => finish(reject, e));
      }

      setTimeout(() => { if (!settled) finish(reject, new Error('captcha-timeout')); }, CAPTCHA_TTL_MS);
    });
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

// server.js POST /captcha {loginId, code}:把 4 碼餵給對應 pending 登入。
function submitCaptcha(loginId, code) {
  for (const entry of pending.values()) {
    if (entry.loginId === loginId) {
      return entry.resolve(code);
    }
  }
  throw new Error('no-pending-login-for-id');
}

// keep-alive:每 ~15 分 ping 會員頁偵測 session 是否仍有效(借用 getAntiForgeryToken 的
// 登入頁重導向偵測)。
function startKeepAlive({ jar, intervalMs = 15 * 60 * 1000, onExpired }) {
  const { getAntiForgeryToken } = require('./fetc-client');
  const timer = setInterval(async () => {
    try {
      const token = await getAntiForgeryToken(jar);
      if (!token && onExpired) onExpired();
    } catch (e) {
      if (onExpired) onExpired(e);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  startLogin,
  submitCaptcha,
  getCaptchaImage,
  startKeepAlive,
};
