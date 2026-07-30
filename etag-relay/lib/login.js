// ── 遠通(FETC)登入流程(playwright)──────────────────────────────────
// 2026-07-27 E1-d 活測校正:依真實登入頁 DOM 重寫(首頁 #section-2 會員登入分頁)。
// 2026-07-27 Round F:reCAPTCHA v3 靠自動化瀏覽器分數過不了,曾嘗試雙軌(自動送 4 碼 +
// 真人 fallback)。
// Round G1:徹底刪除軌道 A(LINE 推 4 碼圖 → 老闆回碼 → 自動送出)。實測結論:v3 擋的是
// 「自動化瀏覽器觸發送出」這件事本身,不論那 4 碼是真人算出來的還是機器猜的都一樣被判定
// 為機器人——4 碼永遠是對的也沒用,留著軌道 A 只是白白多一套 LINE 推播/callback 機制與
// 攻擊面。現在**唯一登入路徑＝真人透過 noVNC 親手操作中繼裡的瀏覽器完成登入**,這裡只
// 負責開瀏覽器、填帳密、通知 Vercel、輪詢登入是否完成。
//
// 職責分離:HA 只持 FETC_ACCOUNT/FETC_PASSWORD(add-on secret);老闆的 LINE 金鑰只在
// Vercel。此模組只管「開瀏覽器、填帳密、等真人手動登入完成、拿 session」。
//
// 登入頁真實結構(E1-d dump)：https://www.fetc.net.tw/ 首頁內含登入區,分頁 `._login_tab`：
//   #section-1 車號登入(sForm1) / #section-2 會員登入(sForm2,預設隱藏,要點分頁才顯示)
// section-2 欄位：
//   帳號 #smart-account-login-account (name smartIDLogin.smartAccount)
//   密碼 #smartIDLogin_smartPassword   (name smartIDLogin.smartPassword)
//   驗證碼 #smartIDLogin_validateCode  (name smartIDLogin.validateCode, maxlength 4;
//     Round G1 起這欄一律由真人在 noVNC 裡自己輸入,程式不再讀寫)
//   recaptcha 隱藏欄 #smartIDLogin_recaptchaToken(頁面 recaptchaLoginSubmit 自動填)
//   送出＝連結 onclick="recaptchaLoginSubmit('sForm2', ...)"（會跑 grecaptcha v3 → AJAX POST
//        /UX0301UserLogin/UX030101SmartIDLogin，data-ajax-success=SmartIDHandler）
// 成功偵測＝FETC_P 認證 cookie 出現（E0 證實登入後才有此 cookie）。
'use strict';

const crypto = require('crypto');

const HOME_URL = 'https://www.fetc.net.tw/';
// 0.4.0:on-demand 之後,流程只在使用者真的在登入頁時才起——人就在畫面前,不需要留 15 分鐘
// 空等(空等=瀏覽器常駐吃 CPU、驗證碼與 v3 情境過期)。8 分鐘足夠輸碼與換一張重試。
const DEFAULT_MANUAL_TTL_MS = 8 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 進行中登入流程的 page(同一時間最多一個,server.js loginInFlight 互斥保證)——
// 給 refreshCaptcha()/captchaShot()/submitCode() 用(0.3.5 起登入頁可直接顯示驗證碼、
// 頁面輸碼,noVNC 遠端畫面降為同頁備援)。
let activePage = null;
// 登入 AJAX(UX030101SmartIDLogin)回應片段——submitCode() 失敗時給頁面看的診斷
// (只留內容片段,絕不含帳密)。每輪登入流程重置。
let activeCtx = null;
// 本輪流程網頁輸碼已嘗試次數。上限 3 次:遠通有鎖帳號風險,「機器不重試」鐵則對真人
// 驅動的送出放寬為「有限次」,超過就請老闆改走 noVNC(那邊是頁面原生行為,不經我們)。
let webAttempts = 0;
const WEB_ATTEMPT_MAX = 3;
// 本輪流程最終結果('success'|'failed')——submitCode() 輪詢中若 activePage 被主流程
// 收走(登入完成瀏覽器即關),靠這個判斷是成功收走還是失敗收走。
let lastFlowResult = null;
// 最近一次驗證碼取圖的來源診斷(0.4.0):{sel,w,h,fallback?}——抓錯圖時一看就知道命中哪個選擇器。
let lastCapMeta = null;
// 本輪流程開始時間(0.4.0 on-demand):登入頁用 /state 的 ageSec 判斷「這張驗證碼是不是放太久了」,
// 過期就自動重啟流程,不讓使用者對著幾小時前的頁面輸碼。
let flowStartedAt = 0;

// 確保 4 碼驗證碼圖已載入(src 由頁面 JS 帶入,實測**有時要點刷新才會出現**)。
// 0.3.4 拆軌道 A 時把 captureCaptchaImage 連同這段等待+刷新邏輯一起拆掉=拆過頭,
// 真人進 noVNC 看到的是空白圖、根本沒辦法輸碼(2026-07-27 使用者實測回報)——補回,
// 只確保載入、不再截圖。
// 驗證碼 img 候選選擇器(0.4.0):原本只認 `#section-2 .vcodeImage` 一個 class——遠通改版
// 或版面位移就抓錯東西。依序試,第一個「已載入且有像素」的就是它。
const CAP_IMG_SELECTORS = [
  '#section-2 .vcodeImage',
  '#section-2 img[src*="ValidateCode" i]',
  '#section-2 img[src*="vcode" i]',
  '#_login img[src*="ValidateCode" i]',
  '#section-2 form img',
];

async function ensureCaptchaLoaded(page) {
  const imgSel = CAP_IMG_SELECTORS;
  const imgLoaded = (sels) => {
    for (const sel of sels) {
      const img = document.querySelector(sel);
      if (img && img.complete && img.naturalWidth > 0) return true;
    }
    return false;
  };
  try {
    await page.waitForFunction(imgLoaded, imgSel, { timeout: 8000 });
  } catch (e) {
    await page.click('#section-2 a.refresh').catch(() => {});
    await page.waitForFunction(imgLoaded, imgSel, { timeout: 8000 }).catch(() => {});
  }
}

// 真人透過 noVNC 剛接上畫面時換一張新驗證碼(server.js 掛進 lib/vnc.js 的 onClientConnect)
// ——登入流程觸發到老闆真的點開連結中間可能隔好幾分鐘,舊圖可能已過期;連上當下刷新,
// 老闆看到的永遠是張新鮮有效的圖。沒有進行中的登入頁(頁面已關/尚未開)就靜默略過。
async function refreshCaptcha() {
  const page = activePage;
  if (!page) return;
  try {
    await page.click('#section-2 a.refresh');
    await ensureCaptchaLoaded(page);
    console.log('[login] noVNC 用戶端接上,已換一張新驗證碼圖');
  } catch (e) { /* 頁面可能導航中/已關閉——刷新失敗不致命,老闆仍可自己點頁面上的刷新 */ }
}

// 截目前的 4 碼驗證碼圖(給登入頁 <img> 顯示;refresh=true 先換一張再截)。
// 沒有進行中的登入流程回 null(頁面據此顯示「開始登入」而不是壞圖)。
// 0.4.0 重寫(使用者 07-30 回報「驗證碼圖的位子跑掉,看不到真的驗證碼」=登不進去的真凶:
// 顯示的不是真的那張圖,輸什麼都必被拒)。原本用元素區域截圖(page.$(sel).screenshot()),
// 只要遠通改 DOM/CSS、元素被遮住或版面位移,截到的就是旁邊空白。
// 改法:把瀏覽器**已經載入的那張 img** 畫進 canvas 取 dataURL——拿到的是實際像素,與螢幕
// 座標無關。⚠刻意不去重抓 img 的 src URL:重抓通常讓遠通伺服器端換一組新碼,與使用者要
// 對應的那組脫鉤。截圖 fallback 保留(canvas 被 CORS/tainted 擋時)。
async function captchaShot({ refresh } = {}) {
  const page = activePage;
  if (!page) return null;
  try {
    if (refresh) await page.click('#section-2 a.refresh').catch(() => {});
    await ensureCaptchaLoaded(page);

    const shot = await page.evaluate((sels) => {
      for (const sel of sels) {
        const img = document.querySelector(sel);
        if (!img || !img.complete || !img.naturalWidth) continue;
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          const src = String(img.getAttribute('src') || '');
          return {
            dataUrl: c.toDataURL('image/png'),
            sel, w: img.naturalWidth, h: img.naturalHeight,
            srcPath: src.split('?')[0].slice(-60),   // 只留路徑尾段供診斷,不帶 query
          };
        } catch (e) {
          return { error: String((e && e.message) || e), sel };
        }
      }
      return null;
    }, CAP_IMG_SELECTORS);

    if (shot && shot.dataUrl) {
      lastCapMeta = { sel: shot.sel, w: shot.w, h: shot.h };
      console.log(`[login] 驗證碼圖取得(canvas):sel=${shot.sel} ${shot.w}x${shot.h} src=…${shot.srcPath}`);
      return Buffer.from(shot.dataUrl.split(',')[1], 'base64');
    }
    console.warn('[login] canvas 取圖失敗' + (shot && shot.error ? `(${shot.error})` : '(找不到已載入的驗證碼 img)') + ',退回元素截圖');

    for (const sel of CAP_IMG_SELECTORS) {
      const el = await page.$(sel);
      if (!el) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const buf = await el.screenshot().catch(() => null);
      if (buf) {
        lastCapMeta = { sel, fallback: true };
        console.warn(`[login] 驗證碼圖取得(元素截圖 fallback):sel=${sel}`);
        return buf;
      }
    }
    return null;
  } catch (e) {
    return null; // 頁面導航中/已關閉,當作沒有圖
  }
}

// 最近一次取圖的診斷(server.js 掛進 /captcha.png 的回應 header,頁面 console 可見)
function capMeta() {
  return lastCapMeta;
}

// 網頁輸碼送出(0.3.5 使用者裁示:驗證碼顯示在登入頁、頁面直接輸碼=主要路徑)。
// 由中繼瀏覽器代填代送——這正是 reCAPTCHA v3 先前擋掉的動作,但當時跑的是 bundled
// chromium;0.3.4 起裝了真 Google Chrome+持久 profile,分數結構不同,值得實測。
// 若 v3 仍擋,回傳的 message 會帶遠通的「驗證失敗」訊息,頁面引導老闆改走同頁的
// noVNC 遠端畫面(真人親手操作,v3 必給分)。
// 回 {ok:true} 或 {ok:false, reason, message?}(message 已 sanitize,不含帳密)。
async function submitCode(code) {
  const page = activePage;
  if (!page) {
    // 主流程可能剛把瀏覽器收走:成功收走=登入其實已完成(例如老闆在 noVNC 先登了)
    if (lastFlowResult === 'success') return { ok: true };
    return { ok: false, reason: 'no-login-in-flight' };
  }
  if (!/^\d{4}$/.test(String(code || ''))) return { ok: false, reason: 'bad-code' };
  if (webAttempts >= WEB_ATTEMPT_MAX) {
    console.warn(`[login] 頁面輸碼已達 ${WEB_ATTEMPT_MAX} 次上限,本流程不再代送(防帳號鎖;請改走 noVNC 真人操作)`);
    return { ok: false, reason: 'too-many-attempts' };
  }
  webAttempts += 1;

  try {
    // 清掉舊碼再逐字輸入(帶延遲——v3 看互動行為,瞬間灌值是機器人特徵)。
    // 0.4.0:補滑鼠軌跡+抖動延遲,讓行為訊號更像真人(純加分,不改判定邏輯)。
    const box = await page.locator('#smartIDLogin_validateCode').boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5, { steps: 8 }).catch(() => {});
      await page.waitForTimeout(120 + Math.floor(Math.random() * 180));
    }
    await page.fill('#smartIDLogin_validateCode', '');
    await page.click('#smartIDLogin_validateCode');
    for (const ch of String(code)) {
      await page.keyboard.type(ch, { delay: 100 + Math.floor(Math.random() * 80) });
    }
    await page.waitForTimeout(250 + Math.floor(Math.random() * 350));
    // 頁面原生送出(grecaptcha v3 + AJAX);點含 sForm2 的送出連結
    await page.click("a[onclick*=\"'sForm2'\"]");
  } catch (e) {
    console.warn(`[login] 頁面輸碼代送失敗(第 ${webAttempts}/${WEB_ATTEMPT_MAX} 次,submit-error):`, e && e.message);
    return { ok: false, reason: 'submit-error' };
  }

  // 等結果:FETC_P 出現=成功(E0 證實);45s 含 grecaptcha 執行與遠通回應時間。
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (!activePage) {
      // 主流程收走瀏覽器:成功路徑會先標 lastFlowResult='success' 再關
      return lastFlowResult === 'success' ? { ok: true } : { ok: false, reason: 'flow-ended' };
    }
    try {
      const cookies = await page.context().cookies();
      if (cookies.some((c) => c.name === 'FETC_P' && c.value)) return { ok: true };
    } catch (e) { /* 導航中讀 cookie 可能短暫失敗,續輪詢 */ }
    // 遠通 AJAX 已回失敗就不用等滿 45s——立即回報,附遠通原話供頁面顯示
    if (activeCtx && activeCtx.loginResponse && /isSucceed"?\s*:\s*false/i.test(activeCtx.loginResponse)) {
      const m = activeCtx.loginResponse.match(/errorMessage"?\s*:\s*"([^"]{0,80})"/);
      activeCtx.loginResponse = null; // 一次性:別讓下一輪嘗試讀到上一輪的舊回應
      const msg = m ? m[1] : '遠通回覆登入失敗';
      // 0.3.13:失敗一律落 add-on 日誌(遠通原話,不含帳密/碼值)——2026-07-28 使用者回報
      // 「輸碼都失敗」時日誌全空無從診斷,只能事後猜是 v3 分數波動還是碼錯。
      console.warn(`[login] 頁面輸碼被遠通拒絕(第 ${webAttempts}/${WEB_ATTEMPT_MAX} 次): ${msg}`);
      return { ok: false, reason: 'fetc-rejected', message: msg };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[login] 頁面輸碼送出後 45s 未見成功/失敗回應(第 ${webAttempts}/${WEB_ATTEMPT_MAX} 次,timeout)`);
  return { ok: false, reason: 'timeout' };
}

// 開登入彈窗、切到會員登入分頁、填帳密——真人在 noVNC 接手前的前置動作,抽成函式避免重複。
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

// 啟動一次登入流程。回 Promise<{cookies, via, loginId}>(via: 'profile'|'manual'),失敗 reject。
// - profileDir:持久 chrome profile 路徑(累積 cookie/瀏覽歷史,v3 分數的核心槓桿,也讓
//   遠通登入態有機會跨重啟存活)。
// - vncUrl/manualTtlMs:onNotify(mode:'manual') 帶給 Vercel,讓老闆點連結進 noVNC 登入。
// - onNotify(payload):單一物件參數,payload.mode 為 'manual'|'manual-timeout'
//   (mode:'success' 由呼叫端 server.js 在 Promise resolve 之後自行發,不在這裡)。
//   通知失敗只 warn,不影響登入流程本身——即使 LINE 沒收到,老闆仍可能自己想到要去看
//   noVNC,不能讓通知失敗擋住整個登入流程。
async function startLogin({ account, password, profileDir, vncUrl, manualTtlMs, onNotify }) {
  const { chromium } = require('playwright');

  const loginId = crypto.randomUUID();
  const ttlMs = manualTtlMs || DEFAULT_MANUAL_TTL_MS;

  const launchOpts = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      // Xvfb 螢幕 0.4.0 起是 1280x720x16(run.sh,為 noVNC 流暢度降解析度/色深),視窗高度
      // 留給瀏覽器 UI(網址列/分頁列 ~44px)——否則視窗比螢幕高,真人在 noVNC 裡看不到
      // 頁面底部(含登入送出鈕)。改螢幕尺寸一定要同步改這裡。
      '--window-size=1280,676',
      '--window-position=0,0',
    ],
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    // viewport:null＝頁面 viewport 跟著真實視窗大小。**真人操作的關鍵**:若鎖死 viewport,
    // playwright 會把視窗撐到「viewport + 瀏覽器 UI」而超出 Xvfb 螢幕,真人看到的畫面與
    // 自動化操作的座標也會不一致。
    viewport: null,
    userAgent: UA,
  };

  // 持久 profile ＋ 真 Chrome:headless:false ＋ xvfb 虛擬螢幕(run.sh 起 :99)——
  // 2026-07-27 E1-d 實測:headless 模式下遠通回 {"isSucceed":false,"errorMessage":"驗證失敗,
  // 請重新整理頁面後再試"} ＝ reCAPTCHA v3 判定為機器人。
  // Round F:改用 channel:'chrome'(真 Google Chrome,非 bundled Chromium)進一步拉高 v3 分數
  // (真人操作也一樣吃瀏覽器指紋,見 Dockerfile 註解);若 Dockerfile 內 Chrome 安裝失敗
  // (build 不因此掛掉),這裡 catch 後不帶 channel 重試一次,fallback 回 base image 內建的
  // chromium——不可讓中繼因此整個掛掉。
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

    // 本輪流程狀態重置+攔截登入 AJAX 回應(SmartIDLogin)——submitCode() 失敗診斷用
    // (只留內容片段,不含帳密)。
    webAttempts = 0;
    lastFlowResult = null;
    lastCapMeta = null;
    flowStartedAt = Date.now();
    activeCtx = { loginResponse: null };
    const ctx = activeCtx;
    page.on('response', async (resp) => {
      try {
        if (/UX030101SmartIDLogin/i.test(resp.url())) {
          const body = await resp.text().catch(() => '');
          ctx.loginResponse = `status=${resp.status()} body=${body.slice(0, 300)}`;
        }
      } catch (e) { /* 診斷用途,不可影響主流程 */ }
    });

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 持久 profile 的最大紅利:重啟後 FETC_P 可能還在(遠通登入態存活)→ 完全不需要重新登入。
    // ⚠ 0.3.10:cookie 存在 ≠ session 活著——遠通 server 端作廢 session 後,cookie 本體仍留在
    // 持久 profile 裡。0.3.9 以前只驗存在就宣告成功,造成「假成功→keep-alive 又偵測失效→再假
    // 成功」每 10 分鐘 LINE ✅ 洗版死循環,且手動觸發同樣被短路、真登入頁永遠開不起來。
    // 改用與 keep-alive 同一把尺(getAntiForgeryToken)向遠通真驗證;失敗(含網路錯誤,保守
    // 視為失效)則清 fetc 網域 cookie 走真人登入——不清的話,下方真人輪詢(驗 FETC_P 存在)
    // 也會被殘留的死 cookie 立即誤判成功。只清 fetc 網域:Google/_GRECAPTCHA 的 v3 信譽
    // cookie 是持久 profile 的核心價值,絕不可全清。
    const existingCookies = await context.cookies();
    if (existingCookies.some((c) => c.name === 'FETC_P' && c.value)) {
      const { CookieJar, getAntiForgeryToken } = require('./fetc-client');
      let aliveToken = null;
      try {
        const asObj = {};
        for (const c of existingCookies) asObj[c.name] = c.value;
        aliveToken = await getAntiForgeryToken(new CookieJar(asObj));
      } catch (e) {
        aliveToken = null;
      }
      if (aliveToken) {
        console.log(`[login] profile 已登入(遠通驗證通過),略過登入流程(via=profile,loginId=${loginId})`);
        lastFlowResult = 'success';
        await context.close().catch(() => {});
        return { cookies: existingCookies, via: 'profile', loginId };
      }
      console.log(`[login] profile 有 FETC_P 但遠通驗證失敗(session 已死),清除 fetc cookie 走真人登入(loginId=${loginId})`);
      await context.clearCookies({ domain: /fetc\.net\.tw/i }).catch((e) => console.warn('[login] 清除 fetc cookie 失敗(續走真人流程):', e && e.message));
      // 重載未登入版首頁:openLoginForm 是在當前頁面上開登入彈窗,舊(染色)首頁可能沒有登入入口。
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await openLoginForm(page, account, password);
    await ensureCaptchaLoaded(page);
    activePage = page; // 此後 noVNC 用戶端接上會觸發 refreshCaptcha()

    // 通知 Vercel:老闆要點連結進 noVNC 才能完成登入。
    if (onNotify) {
      await Promise.resolve(
        onNotify({ mode: 'manual', loginId, vncUrl, ttlMin: Math.round(ttlMs / 60000) })
      ).catch((e) => console.warn('[login] onNotify(manual) 失敗:', e && e.message));
    }

    // 輪詢 FETC_P cookie,等真人在 noVNC 裡完成登入,最多 ttlMs。
    const manualStart = Date.now();
    while (Date.now() - manualStart < ttlMs) {
      try {
        const cookies = await context.cookies();
        if (cookies.some((c) => c.name === 'FETC_P' && c.value)) {
          console.log(`[login] 真人登入成功(loginId=${loginId})`);
          lastFlowResult = 'success'; // 先標結果再收 activePage——submitCode() 輪詢靠這個順序判斷
          activePage = null;
          await context.close().catch(() => {});
          return { cookies, via: 'manual', loginId };
        }
      } catch (e) { /* 輪詢中讀 cookie 短暫失敗,續輪詢 */ }
      await page.waitForTimeout(2000);
    }

    console.warn(`[login] 真人(noVNC)登入逾時未完成(loginId=${loginId})`);
    if (onNotify) {
      await Promise.resolve(onNotify({ mode: 'manual-timeout', loginId })).catch((e) =>
        console.warn('[login] onNotify(manual-timeout) 失敗:', e && e.message)
      );
    }
    // 逾時視同這次登入流程失敗——不在此自行 close,交給下面唯一的 catch 統一關閉並
    // rethrow,讓「所有路徑都會 context.close()」只有一個出口,不必在每個失敗分支各自重複。
    throw new Error('manual-login-timeout');
  } catch (e) {
    if (lastFlowResult !== 'success') lastFlowResult = 'failed';
    activePage = null;
    await context.close().catch(() => {});
    throw e;
  }
}

// keep-alive:定期 ping 會員頁偵測 session 是否仍有效(借用 getAntiForgeryToken 的
// 登入頁重導向偵測)。
// Round G1b(2026-07-27 實測 session 17 分鐘就失效,溯源):**收 getJar 函式而不是 jar
// 物件**——登入成功後 server.js 是整個重新指派 `jar = new CookieJar(...)`(換掉整個變數
// 綁定,不是原地變更內容),若這裡在啟動時就把當下的 jar 物件捕進 closure,計時器手上
// 永遠是啟動時那個舊的(通常是空的)jar,每次 ping 都在用未登入的 session,真正登入後的
// session 從未被保溫,遠通 ASP.NET ~20 分閒置逾時照收不誤。改成每次 tick 呼叫 getJar()
// 現抓「當下」的 jar,才能吃到登入成功後換上的新 jar。
// intervalMs 預設由 15 分改 10 分:遠通逾時約 20 分,15 分只要漏一次 ping 就死;10 分留
// 單次失敗的餘裕,成本只是一個便宜的 GET。
// onAlive():ping 成功(拿到 token)時呼叫,讓呼叫端把 lastKeepAlive/續期 cookie 存檔
// (遠通 ping 可能帶 Set-Cookie 續期,不存回等於白 ping)。
function startKeepAlive({ getJar, intervalMs = 10 * 60 * 1000, onExpired, onAlive }) {
  const { getAntiForgeryToken } = require('./fetc-client');
  const timer = setInterval(async () => {
    try {
      const token = await getAntiForgeryToken(getJar());
      if (token) {
        if (onAlive) onAlive();
      } else if (onExpired) {
        onExpired();
      }
    } catch (e) {
      if (onExpired) onExpired(e);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

// 進行中流程的狀態(0.4.0):登入頁 /state 用——ageSec 太大代表這張驗證碼與 v3 情境都放太久,
// 頁面會自動重啟流程而不是讓使用者對著舊頁面輸碼。
function flowState() {
  return {
    inFlight: !!activePage,
    ageSec: activePage && flowStartedAt ? Math.round((Date.now() - flowStartedAt) / 1000) : null,
    attempts: webAttempts,
    cap: lastCapMeta,
  };
}

// 中止進行中的流程(0.4.0):供「過期自動重啟」與「被遠通拒絕後換全新流程」用——
// 關掉頁面即可,startLogin 的主流程輪詢會看到 activePage 被收走而以 flow-ended 結束。
async function abortLogin() {
  const page = activePage;
  if (!page) return false;
  activePage = null;
  lastFlowResult = 'aborted';
  try {
    const ctx = page.context();
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  } catch (e) { /* 已關閉 */ }
  console.log('[login] 中止進行中的登入流程(過期或要求換新流程)');
  return true;
}

module.exports = {
  startLogin,
  startKeepAlive,
  refreshCaptcha,
  captchaShot,
  capMeta,
  submitCode,
  flowState,
  abortLogin,
};
