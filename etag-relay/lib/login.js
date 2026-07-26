// ── 遠通(FETC)登入流程骨架(playwright)──────────────────────────────────
// 本輪(E1-a)只寫、不執行:無法在本機模擬 HA 容器內起 chromium 對遠通真登入
// (會消耗一次真實登入嘗試、有鎖帳號風險),依計劃裁示留到活 session/實機驗證。
//
// 職責分離(2026-07-27 裁定機制③):HA 只持 FETC_ACCOUNT/FETC_PASSWORD(add-on
// secret);老闆的 LINE 金鑰只在 Vercel 端。此模組只管「開瀏覽器登入、截圖驗證碼、
// 等外部把 4 碼餵回來、拿到 session cookie」,不知道 LINE 是什麼。
//
// 非同步流程(跨 Vercel 請求,見計劃 Round E §session 更新機制):
//   1. keep-alive 或查詢偵測 session 失效 → server.js 呼叫 startLogin()
//   2. chromium 開登入頁 → 填帳密 → reCAPTCHA v3 真瀏覽器自動過(E0 已證實)
//   3. 截 validateCode 4 碼圖 → 存進 pendingLogins(記憶體,短 TTL)→ 產生不可猜 token
//   4. server.js 對外曝光 GET /cap/{token}.png(唯一不驗 X-Relay-Secret 的端點,
//      Cloudflare Access 例外放行)→ 呼叫 VERCEL_CAPTCHA_URL 通知「圖好了」
//   5. Vercel 端 LINE 推老闆圖 → 老闆回 4 碼 → line-webhook → POST 中繼 /captcha
//      {loginId, code} → server.js 呼叫 submitCaptcha(loginId, code)
//   6. submitCaptcha 把 code 填回同一個 page 提交 → 擷取新 session cookie → resolve
//      pending 的 Promise → 關瀏覽器
//
// TODO(待活 session 驗證,非架構阻斷,列於 E0 findings「待補小項③」):
//   - 登入頁實際 DOM 選擇器(帳號/密碼欄位 name、validateCode <img> 的 src/selector、
//     提交按鈕)——E0 probe 只 dump 過欄位名稱(smartAccount/smartPassword/
//     validateCode/recaptchaToken),未截圖驗證真實 DOM 結構。
//   - reCAPTCHA v3 token 從何處讀出(隱藏 input?攔截 XHR?)——E0 只證實「有
//     grecaptcha.execute 且真瀏覽器會自動過」,未逐行走過擷取程式碼。
//   - 驗證碼提交失敗(4 碼錯誤)的重試/放棄邏輯與逾時策略。
//   - keep-alive ping 的目標端點與判定「仍有效」的回應特徵。
'use strict';

const crypto = require('crypto');

const LOGIN_URL = 'https://www.fetc.net.tw/UX0301UserLogin/UX030101SmartIDLogin';
// TODO:實際登入頁(GET,顯示表單)路徑待確認,以下為推測值
const LOGIN_PAGE_URL = 'https://www.fetc.net.tw/UX0301UserLogin';

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // pending 登入的驗證碼圖短 TTL(5 分鐘未回碼即視為逾時)

// pending 登入 = token(不可猜、供 /cap/{token}.png 用)→ { imageBuffer, createdAt, resolve, reject, loginId }
// 全部存記憶體(無持久卷需求——登入是短暫、非同步、跨請求但不跨重啟的流程;
// add-on 重啟中途剛好卡在登入態的機率極低,重啟後重新觸發即可)。
const pending = new Map();

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// 供 server.js GET /cap/{token}.png 用:回目前 pending 登入的驗證碼截圖。
// 不驗 secret(Cloudflare Access 例外放行),故 token 本身就是唯一的存取控制——
// 32 bytes random base64url、5 分鐘 TTL、命中一次後不失效(老闆可能重新整理頁面)。
function getCaptchaImage(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CAPTCHA_TTL_MS) {
    pending.delete(token);
    return null;
  }
  return entry.imageBuffer;
}

// 啟動一次登入流程。回傳 Promise<{cookies}>,失敗(逾時/驗證碼錯誤/頁面結構變動)reject。
// onCaptchaReady(token, loginId) 由呼叫端(server.js)提供,用來通知 Vercel
// (POST VERCEL_CAPTCHA_URL {loginId, imageUrl: PUBLIC_BASE_URL + '/cap/' + token + '.png'})。
async function startLogin({ account, password, onCaptchaReady }) {
  // TODO(待活 session 驗證):playwright 由 add-on Dockerfile 的 base image
  // (mcr.microsoft.com/playwright:*-jammy)提供,本輪不在本機執行此函式
  // (無法安全測試真登入,有鎖帳號風險)。以下為流程骨架,實機驗證時逐步補上
  // 真實選擇器與例外處理。
  const { chromium } = require('playwright'); // lazy require:非登入流程不需要載入 playwright

  const loginId = crypto.randomUUID();
  const token = newToken();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'zh-TW' });
    const page = await context.newPage();

    await page.goto(LOGIN_PAGE_URL, { waitUntil: 'networkidle' });

    // TODO:選擇器待真實 DOM 校正
    await page.fill('input[name="smartAccount"]', account);
    await page.fill('input[name="smartPassword"]', password);

    // reCAPTCHA v3:E0 證實真瀏覽器 grecaptcha.execute 會自動產生 recaptchaToken
    // (隱藏欄位或由頁面 JS 於送出前塞入 hidden input),此處等待該欄位有值即可,
    // 不需要額外互動。TODO:確認欄位名稱與等待條件。
    await page.waitForFunction(() => {
      const el = document.querySelector('input[name="recaptchaToken"]');
      return el && el.value && el.value.length > 0;
    }, { timeout: 15000 }).catch(() => {
      // TODO:v3 token 逾時的處理策略待實機驗證(重試?視為頁面結構變動告警?)
    });

    // 截 validateCode 4 碼圖
    const captchaEl = await page.$('img[id*="validateCode" i], img[src*="validateCode" i]');
    const imageBuffer = captchaEl ? await captchaEl.screenshot() : null;

    return await new Promise((resolve, reject) => {
      pending.set(token, {
        imageBuffer,
        createdAt: Date.now(),
        loginId,
        resolve: async (code) => {
          try {
            // TODO:選擇器待真實 DOM 校正
            await page.fill('input[name="validateCode"]', code);
            await page.click('button[type="submit"], input[type="submit"]');
            await page.waitForLoadState('networkidle');

            // TODO:提交後判斷成功/失敗的頁面特徵待校正(成功導回會員首頁?
            // 失敗留在原頁並顯示錯誤訊息?)
            const cookies = await context.cookies();
            pending.delete(token);
            await browser.close();
            resolve({ cookies });
          } catch (e) {
            pending.delete(token);
            await browser.close().catch(() => {});
            reject(e);
          }
        },
        reject,
      });

      if (onCaptchaReady) {
        Promise.resolve(onCaptchaReady(token, loginId)).catch((e) => {
          pending.delete(token);
          browser.close().catch(() => {});
          reject(e);
        });
      }

      // TTL 逾時自動放棄
      setTimeout(() => {
        if (pending.has(token)) {
          pending.delete(token);
          browser.close().catch(() => {});
          reject(new Error('captcha-timeout'));
        }
      }, CAPTCHA_TTL_MS);
    });
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

// server.js POST /captcha {loginId, code} 呼叫:把 4 碼餵給對應的 pending 登入。
// 用 loginId(而非 token)比對——loginId 不外流(只在中繼↔Vercel 內部呼叫間傳遞),
// token 才是外流給 LINE 圖片連結用的不可猜值,兩者職責分離。
function submitCaptcha(loginId, code) {
  for (const entry of pending.values()) {
    if (entry.loginId === loginId) {
      return entry.resolve(code);
    }
  }
  throw new Error('no-pending-login-for-id');
}

// keep-alive 骨架:每 ~15 分鐘 ping 一次遠通會員頁,偵測 session 是否仍有效
// (滑動逾時 ASP.NET_SessionId 需要定期活動才不過期)。
// TODO(待活 session 驗證):ping 目標與「仍有效」判定待實機校正,目前借用
// fetc-client.getAntiForgeryToken 的登入頁重導向偵測邏輯。
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
  timer.unref(); // 不阻擋 process 正常結束(測試/開發時方便)
  return timer;
}

module.exports = {
  startLogin,
  submitCaptcha,
  getCaptchaImage,
  startKeepAlive,
};
