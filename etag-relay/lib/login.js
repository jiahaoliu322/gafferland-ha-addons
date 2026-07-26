// ── 遠通(FETC)登入流程(playwright)──────────────────────────────────
// 2026-07-27 E1-d 活測校正:依真實登入頁 DOM 重寫(首頁 #section-2 會員登入分頁)。
// 2026-07-27 Round F:reCAPTCHA v3 靠自動化瀏覽器分數過不了(4 碼驗證碼本身早就是對的),
// 改雙軌:①持久 profile + 真 Google Chrome 提高 v3 分數,自動登入仍先試一次;②失敗(或
// 逾時沒收到 4 碼)→ 不關瀏覽器,轉真人透過 noVNC 遠端手動登入,session 直接生在中繼。
//
// 職責分離(機制③):HA 只持 FETC_ACCOUNT/FETC_PASSWORD(add-on secret);老闆的
// LINE 金鑰只在 Vercel。此模組只管「開瀏覽器登入、截驗證碼、等 4 碼餵回/等真人手動登入、
// 拿 session」。
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
// CAPTCHA_TTL_MS:只管「軌道 A 等老闆回 4 碼」的視窗(逾時視同軌道 A 失敗 → 轉軌道 B)。
// 軌道 B(真人遠端登入)的等待時間是另一個計時器 manualTtlMs(由 server.js 傳入),兩者不可
// 混用——manualTtlMs 通常比 CAPTCHA_TTL_MS 長(給老闆走到 noVNC、輸密碼的時間)。
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MANUAL_TTL_MS = 15 * 60 * 1000;
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

// 開登入彈窗、切到會員登入分頁、填帳密——軌道 A/B 共用的前置動作,抽成函式避免重複。
async function openLoginForm(page, account, password) {
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

  // 3. 填帳密
  // 逐字輸入(帶延遲)＋滑鼠移動:v3 也看互動行為,fill() 瞬間灌值是機器人特徵
  await page.mouse.move(700, 400);
  await page.click('#smart-account-login-account');
  await page.type('#smart-account-login-account', account, { delay: 90 });
  await page.click('#smartIDLogin_smartPassword');
  await page.type('#smartIDLogin_smartPassword', password, { delay: 90 });
}

// 等驗證碼圖載入(vcodeImage src 由 JS 帶入);沒載到就點刷新再等。回截圖 buffer(可能 null)。
async function captureCaptchaImage(page) {
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
  return captchaEl ? await captchaEl.screenshot() : null;
}

// 啟動一次登入流程。回 Promise<{cookies, via, loginId}>(via: 'profile'|'auto'|'manual'),失敗 reject。
// - profileDir:持久 chrome profile 路徑(累積 cookie/瀏覽歷史,v3 分數的核心槓桿,也讓
//   遠通登入態有機會跨重啟存活)。
// - vncUrl/manualTtlMs:軌道 B(真人遠端登入)用——onNotify(mode:'manual') 帶給 Vercel。
// - onNotify(payload):單一物件參數,payload.mode 為 'auto'|'manual'|'manual-timeout'
//   (mode:'success' 由呼叫端 server.js 在 Promise resolve 之後自行發,不在這裡)。
// - mode:'auto'(預設,自動觸發用:keep-alive/查詢撞失效)先試軌道 A;**'manual' 直接跳軌道 B**
//   ——使用者從 /collect 按「重新登入遠通」時走這條,不必先白等 5 分鐘軌道 A 的 4 碼視窗
//   (v3 幾乎必擋自動登入,實測結論見計劃 E1-d 判定)。
async function startLogin({ account, password, profileDir, vncUrl, manualTtlMs, onNotify, mode }) {
  const { chromium } = require('playwright');

  const loginId = crypto.randomUUID();
  const token = newToken();
  const ttlMs = manualTtlMs || DEFAULT_MANUAL_TTL_MS;

  const launchOpts = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      // Xvfb 螢幕是 1440x900(run.sh),視窗高度留給瀏覽器 UI(網址列/分頁列 ~44px)——
      // 否則視窗比螢幕高,軌道 B 的真人在 noVNC 裡看不到頁面底部(含登入送出鈕)。
      '--window-size=1440,856',
      '--window-position=0,0',
    ],
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    // viewport:null＝頁面 viewport 跟著真實視窗大小。**軌道 B 的關鍵**:若鎖死 viewport,
    // playwright 會把視窗撐到「viewport + 瀏覽器 UI」而超出 Xvfb 螢幕,真人看到的畫面與
    // 自動化操作的座標也會不一致。
    viewport: null,
    userAgent: UA,
  };

  // 持久 profile ＋ 真 Chrome:headless:false ＋ xvfb 虛擬螢幕(run.sh 起 :99)——
  // 2026-07-27 E1-d 實測:headless 模式下遠通回 {"isSucceed":false,"errorMessage":"驗證失敗,
  // 請重新整理頁面後再試"} ＝ reCAPTCHA v3 判定為機器人(4 碼驗證碼本身是對的)。
  // Round F:改用 channel:'chrome'(真 Google Chrome,非 bundled Chromium)進一步拉高 v3 分數;
  // 若 Dockerfile 內 Chrome 安裝失敗(build 不因此掛掉,見 Dockerfile 註解),這裡 catch 後
  // 不帶 channel 重試一次,fallback 回 base image 內建的 chromium——不可讓中繼因此整個掛掉。
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' });
  } catch (e) {
    console.warn('[login] Chrome 不可用,fallback chromium:', e && e.message);
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  try {
    // 抹掉 navigator.webdriver 等自動化指紋(v3 會讀)——persistent context 也支援 addInitScript。
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-TW', 'zh', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    // persistent context 沒有獨立的 browser 物件,page 用既有分頁或開新的。
    const page = context.pages()[0] || (await context.newPage());

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

    // 持久 profile 的最大紅利:重啟後 FETC_P 可能還在(遠通登入態存活)→ 完全不需要重新登入。
    const existingCookies = await context.cookies();
    if (existingCookies.some((c) => c.name === 'FETC_P' && c.value)) {
      console.log(`[login] profile 已登入,略過登入流程(via=profile,loginId=${loginId})`);
      await context.close().catch(() => {});
      return { cookies: existingCookies, via: 'profile', loginId };
    }

    await openLoginForm(page, account, password);
    // mode==='manual' 直接走真人:不必截 4 碼圖(那張圖只有軌道 A 的 LINE 回碼流程用得到)。
    const imageBuffer = mode === 'manual' ? null : await captureCaptchaImage(page);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let captchaTimer = null;
      const finish = async (fn, arg) => {
        if (settled) return;
        settled = true;
        pending.delete(token);
        if (captchaTimer) clearTimeout(captchaTimer);
        await context.close().catch(() => {});
        fn(arg);
      };

      // 軌道 B(真人):不關瀏覽器——換一張新驗證碼(帳密留在欄位裡,讓老闆在 noVNC 看到的
      // 是張有效的圖)、通知 Vercel、輪詢 FETC_P cookie 最多 ttlMs。
      const toManual = async () => {
        if (settled) return;
        pending.delete(token); // 換軌:舊 4 碼圖即刻失效,不可再被提交(避免與軌道 A 競態)
        try {
          await page.click('#section-2 a.refresh').catch(() => {});
          if (onNotify) {
            await Promise.resolve(
              onNotify({ mode: 'manual', loginId, vncUrl, ttlMin: Math.round(ttlMs / 60000) })
            ).catch((e) => console.warn('[login] onNotify(manual) 失敗:', e && e.message));
          }
          const manualStart = Date.now();
          while (!settled && Date.now() - manualStart < ttlMs) {
            try {
              const cookies = await context.cookies();
              if (cookies.some((c) => c.name === 'FETC_P' && c.value)) {
                console.log(`[login] 軌道 B(真人)登入成功(loginId=${loginId})`);
                return finish(resolve, { cookies, via: 'manual', loginId });
              }
            } catch (e) { /* 輪詢中讀 cookie 短暫失敗,續輪詢 */ }
            await page.waitForTimeout(2000);
          }
          if (!settled) {
            console.warn(`[login] 軌道 B(真人)逾時未登入(loginId=${loginId})`);
            if (onNotify) {
              await Promise.resolve(onNotify({ mode: 'manual-timeout', loginId })).catch((e) =>
                console.warn('[login] onNotify(manual-timeout) 失敗:', e && e.message)
              );
            }
            return finish(reject, new Error('manual-login-timeout'));
          }
        } catch (e) {
          return finish(reject, e);
        }
      };

      // 直接指定真人模式:不掛 pending(沒有 4 碼圖可提交)、不設軌道 A 逾時計時器。
      if (mode === 'manual') {
        console.log(`[login] 依請求直接進軌道 B(真人,loginId=${loginId})`);
        toManual();
        return;
      }

      pending.set(token, {
        imageBuffer,
        createdAt: Date.now(),
        loginId,
        resolve: async (code) => {
          pending.delete(token); // 一次性:提交後不管成敗都不可再被同一張圖提交第二次
          try {
            await page.click('#smartIDLogin_validateCode');
            await page.type('#smartIDLogin_validateCode', code, { delay: 120 });
            // 頁面原生送出(grecaptcha v3 + AJAX);點含 sForm2 的送出連結
            await page.click("a[onclick*=\"'sForm2'\"]");
            // 成功偵測(AJAX 式登入,45s——含 grecaptcha 執行與遠通回應時間)
            const res = await waitLoginSuccess(page, context, ctx, 45000);
            if (res.ok) {
              const cookies = await context.cookies();
              console.log(`[login] 軌道 A(自動)登入成功(loginId=${loginId})`);
              return finish(resolve, { cookies, via: 'auto', loginId });
            }
            // 「失敗不重試登入」鐵則不變(遠通有鎖帳號風險)——轉軌道 B,不是再送一次帳密。
            console.warn(`[login] 軌道 A 失敗(${res.detail}),轉軌道 B(真人,loginId=${loginId})`);
            return await toManual();
          } catch (e) {
            console.warn('[login] 軌道 A 送出流程例外,轉軌道 B(真人):', e && e.message);
            return await toManual();
          }
        },
        reject: (e) => finish(reject, e),
      });

      if (onNotify) {
        Promise.resolve(onNotify({ mode: 'auto', loginId, token })).catch((e) => finish(reject, e));
      }

      // 軌道 A 逾時仍沒收到 4 碼(老闆沒回 LINE)→ 視同軌道 A 失敗,轉軌道 B。
      // 這是「等 4 碼」的計時器,與軌道 B 的 ttlMs 是兩個獨立計時器,互不干擾。
      captchaTimer = setTimeout(() => {
        if (!settled && pending.has(token)) {
          console.warn(`[login] 軌道 A 逾時未收到驗證碼,轉軌道 B(真人,loginId=${loginId})`);
          toManual();
        }
      }, CAPTCHA_TTL_MS);
    });
  } catch (e) {
    await context.close().catch(() => {});
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
