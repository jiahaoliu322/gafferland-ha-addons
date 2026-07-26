// ── etag-relay HA add-on 主服務 ─────────────────────────────────────────
// Node 內建 http server(不用 express,add-on 體積/攻擊面最小化)。
// 路由見計劃 Round E「HA 中繼服務 etag-relay」節、Round F「雙軌登入」節:
//   POST /query   (驗 X-Relay-Secret)  三步查詢鏈 → 回 transactions/total/printHtml
//   GET  /health  (驗 X-Relay-Secret)  存活 + session 有效性
//   POST /login   (驗 X-Relay-Secret)  手動觸發登入流程(不必等 cron/keep-alive 撞失效)
//   POST /session (內部用)             登入流程寫回 session cookie(貼 cookie 終極備援)
//   POST /captcha (驗 callback secret) Vercel line-webhook 轉發老闆回的 4 碼(軌道 A 用)
//   GET  /cap/{token}.png (不驗 secret,Access 例外) 供 LINE 抓 pending 登入的驗證碼圖
//
// 帳密/cookie 絕不寫入任何 log 或回應(沿用 gafferland-main sanitize 鐵則)。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { CookieJar, resolveCin, queryAll } = require('./lib/fetc-client');

// ── 設定(HA add-on options 由 supervisor 注入 /data/options.json,本機開發
// 則走環境變數 fallback,方便未部署前先 `node server.js` 對語法/路由 smoke test)──
let options = {};
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (e) {
  // 非 HA 容器環境(本機開發/CI):options.json 不存在,走環境變數
  options = {
    FETC_ACCOUNT: process.env.FETC_ACCOUNT || '',
    FETC_PASSWORD: process.env.FETC_PASSWORD || '',
    RELAY_SECRET: process.env.RELAY_SECRET || '',
    VERCEL_CAPTCHA_URL: process.env.VERCEL_CAPTCHA_URL || '',
    VERCEL_CALLBACK_SECRET: process.env.VERCEL_CALLBACK_SECRET || '',
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
    VNC_PASSWORD: process.env.VNC_PASSWORD || '',
    VNC_PUBLIC_URL: process.env.VNC_PUBLIC_URL || '',
    MANUAL_LOGIN_TTL_MIN: process.env.MANUAL_LOGIN_TTL_MIN || 15,
  };
}

const PORT = 8099;
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '.devdata');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── session 持久化(跨重啟)───────────────────────────────────────────────
// 存的只有 cookie 名稱/值(session token 本身),不含帳密。
let jar = new CookieJar();
let sessionMeta = { lastKeepAlive: null, plateCinCache: {} };

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    jar = new CookieJar(raw.cookies || {});
    sessionMeta = {
      lastKeepAlive: raw.lastKeepAlive || null,
      plateCinCache: raw.plateCinCache || {},
    };
  } catch (e) {
    // 無存檔(首次啟動)或壞檔 → 空 session,等登入流程寫入
  }
}

function saveSession() {
  const payload = {
    cookies: jar.toObject(),
    lastKeepAlive: sessionMeta.lastKeepAlive,
    plateCinCache: sessionMeta.plateCinCache,
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(payload), { mode: 0o600 });
}

loadSession();

// ── 共用 helper ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// timing-safe 比對,避免密鑰時序攻擊(即使內網 Cloudflare Access 已擋一層,
// 二層 secret 仍值得做到位)
function safeEqual(a, b) {
  const crypto = require('crypto');
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireSecret(req, res, expected) {
  const got = req.headers['x-relay-secret'];
  if (!expected || !safeEqual(got, expected)) {
    sendJson(res, 401, { ok: false, reason: 'unauthorized' });
    return false;
  }
  return true;
}

// /captcha 專用:接受 X-Relay-Secret 等於 RELAY_SECRET(=Vercel 端 ETAG_RELAY_SECRET,
// 與 /query 同一把、Vercel→relay 的一般認證)**或** VERCEL_CALLBACK_SECRET(=Vercel 端
// ETAG_RELAY_CALLBACK_SECRET)——兩把密鑰職責不同(見計劃 Round E「契約」:relay→Vercel
// 用 CALLBACK_SECRET 當 body.secret 字段、Vercel→relay 用 RELAY_SECRET 當 header),但
// line-webhook 轉發 /captcha 時是 Vercel→relay 方向,理應也接受任一把已設定的密鑰,對未來
// 密鑰輪替/職責調整留彈性,不因命名巧合而卡死。
function requireEitherSecret(req, res, expectedList) {
  const got = req.headers['x-relay-secret'];
  const ok = (expectedList || []).some((expected) => expected && safeEqual(got, expected));
  if (!ok) {
    sendJson(res, 401, { ok: false, reason: 'unauthorized' });
    return false;
  }
  return true;
}

// ── 登入流程觸發(A2,2026-07-27)────────────────────────────────────────────
// keep-alive 偵測失效、查詢撞失效、或首次啟動無 session 時都呼叫這裡。同一時間只跑
// 一個登入流程(loginInFlight 互斥)——遠通登入失敗有鎖帳號風險,「只試一次、失敗不重
// 試」是 lib/login.js 內部(captcha 提交)的鐵則,這裡的互斥只是避免多個觸發點(keep-alive
// timer 與查詢請求可能同時偵測到失效)重複開瀏覽器,不是重試邏輯。
let loginInFlight = null;

// 通知 Vercel 登入進度:POST VERCEL_CAPTCHA_URL {...payload, secret}。
// secret 用 VERCEL_CALLBACK_SECRET(與 handleCaptcha 驗證同一把,呼應計劃「Vercel→relay 用既有
// ETAG_RELAY_SECRET、relay→Vercel 用 ETAG_RELAY_CALLBACK_SECRET」的契約——中繼這端只認得自己
// config.yaml 裡的 VERCEL_CALLBACK_SECRET 選項名稱,對外呼叫時帶的欄位值即 Vercel 端的
// ETAG_RELAY_CALLBACK_SECRET)。
// payload.mode 為 'auto'(附 token,由這裡組 imageUrl)|'manual'|'manual-timeout'|'success'——
// 只有 auto 才組 imageUrl,其餘 mode 不把 token 帶出去(token 只對「4 碼圖」這件事有意義)。
// 通知失敗只印警告、不可 throw——軌道 B(真人遠端登入)特別重要:Vercel 通知不到,老闆還是要
// 能靠其他管道(如直接看 noVNC)登入,不能讓登入流程因為通知失敗而 reject。
async function notifyVercel(payload) {
  if (!options.VERCEL_CAPTCHA_URL) {
    console.warn(`[etag-relay] VERCEL_CAPTCHA_URL 未設定,無法通知 Vercel(mode=${payload && payload.mode})`);
    return;
  }
  const body = { ...payload, secret: options.VERCEL_CALLBACK_SECRET };
  if (body.mode === 'auto' && body.token) {
    body.imageUrl = `${options.PUBLIC_BASE_URL || ''}/cap/${body.token}.png`;
    delete body.token; // 只留 imageUrl,token 本身不必洩給 Vercel
  }
  try {
    const resp = await fetch(options.VERCEL_CAPTCHA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn(`[etag-relay] 通知 Vercel 失敗(mode=${payload && payload.mode}):HTTP ${resp.status}`);
    }
  } catch (e) {
    console.warn(`[etag-relay] 通知 Vercel 例外(mode=${payload && payload.mode}):`, e && e.message);
  }
}

// 觸發一次登入流程(不 await 完成——呼叫端 fire-and-forget,結果透過 saveSession 落地、
// 下次查詢自然吃到新 session)。reason 只供 log 分類,絕不含帳密。
// mode:'auto'(預設)＝先試自動登入一次,失敗轉真人;'manual'＝直接進真人遠端登入
// (使用者從 /collect 主動按「重新登入遠通」時用,不必白等軌道 A 的 4 碼視窗)。
function triggerLogin(reason, mode) {
  if (loginInFlight) {
    console.log(`[etag-relay] 登入流程已在進行中,略過重複觸發(reason=${reason})`);
    return loginInFlight;
  }
  if (!options.FETC_ACCOUNT || !options.FETC_PASSWORD) {
    console.warn(`[etag-relay] 無 FETC_ACCOUNT/FETC_PASSWORD,無法自動登入(reason=${reason})`);
    return Promise.resolve();
  }

  console.log(`[etag-relay] 觸發登入流程(reason=${reason},mode=${mode || 'auto'})`);
  const { startLogin } = require('./lib/login');
  loginInFlight = startLogin({
    account: options.FETC_ACCOUNT,
    password: options.FETC_PASSWORD,
    profileDir: path.join(DATA_DIR, 'chrome-profile'),
    vncUrl: options.VNC_PUBLIC_URL,
    manualTtlMs: (Number(options.MANUAL_LOGIN_TTL_MIN) || 15) * 60 * 1000,
    onNotify: notifyVercel,
    mode: mode === 'manual' ? 'manual' : 'auto',
  })
    .then(({ cookies, via, loginId }) => {
      const asObj = Object.fromEntries((cookies || []).map((c) => [c.name, c.value]));
      jar = new CookieJar(asObj);
      sessionMeta.lastKeepAlive = Date.now();
      saveSession();
      console.log(`[etag-relay] 登入流程成功,session 已存檔(via=${via})`);
      notifyVercel({ mode: 'success', loginId, via });
    })
    .catch((e) => {
      // e.message 只可能含 URL/HTTP status/逾時等網路層資訊(lib/login.js 沿用 sanitize 鐵則),
      // 不含帳密/cookie。
      console.error('[etag-relay] 登入流程失敗:', e && e.message);
    })
    .finally(() => {
      loginInFlight = null;
    });
  return loginInFlight;
}

async function resolvePlateCin(plate) {
  if (sessionMeta.plateCinCache[plate]) return sessionMeta.plateCinCache[plate];
  // TODO(待活 session 驗證,見 lib/fetc-client.js resolveCin 註解):端點/解析結構未經
  // E0 實測,本輪只接線、不驗真值。
  const cin = await resolveCin(jar, plate);
  if (cin) {
    sessionMeta.plateCinCache[plate] = cin;
    saveSession();
  }
  return cin;
}

// ── 路由處理 ──────────────────────────────────────────────────────────────

async function handleQuery(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-request' });
  }
  const { plate, startDate, endDate } = body;
  if (!plate || !startDate || !endDate) {
    return sendJson(res, 400, { ok: false, reason: 'missing-params' });
  }

  try {
    const cin = await resolvePlateCin(plate);
    if (!cin) {
      return sendJson(res, 200, { ok: false, reason: 'cin-not-found' });
    }

    const result = await queryAll(jar, { plate, cin, startDate, endDate });
    saveSession(); // queryAll 過程可能更新 cookie(Set-Cookie 續期),存回

    const transactions = result.transactions.map((t) => ({
      timeTs: t.timeTs,
      timeStr: t.timeStr,
      route: t.route,
      gantry: t.gantry,
      amount: t.amount,
    }));

    return sendJson(res, 200, {
      ok: true,
      transactions,
      total: result.total,
      printHtml: result.printHtml,
    });
  } catch (e) {
    if (e && e.code === 'SESSION_EXPIRED') {
      triggerLogin('query-session-expired'); // fire-and-forget:本次查詢仍回失效,下次 cron 補(冪等)
      return sendJson(res, 200, { ok: false, reason: 'session-expired' });
    }
    console.error('[etag-relay] /query error:', e && e.message); // 訊息本身不含帳密/cookie
    return sendJson(res, 500, { ok: false, reason: 'internal-error' });
  }
}

async function handleHealth(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  let sessionValid = false;
  try {
    const { getAntiForgeryToken } = require('./lib/fetc-client');
    const token = await getAntiForgeryToken(jar);
    sessionValid = !!token;
  } catch (e) {
    sessionValid = false;
  }
  return sendJson(res, 200, {
    ok: true,
    sessionValid,
    lastKeepAlive: sessionMeta.lastKeepAlive,
    loginInFlight: !!loginInFlight,
    vncEnabled: !!options.VNC_PASSWORD, // 只回有無設定,密碼值絕不外流
    hasProfile: fs.existsSync(path.join(DATA_DIR, 'chrome-profile')),
  });
}

// 讓 /collect 有「重新登入遠通」按鈕,不必等 cron/keep-alive 撞失效才觸發。
// fire-and-forget(同 triggerLogin 既有語意):回應只回「有沒有啟動」,不等登入流程跑完。
async function handleLogin(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  // body 可有可無(空 body 視同 mode:'auto');壞 JSON 不擋觸發,當作沒帶參數。
  let body = {};
  try { body = await readBody(req); } catch (e) { body = {}; }
  const mode = body && body.mode === 'manual' ? 'manual' : 'auto';
  const p = triggerLogin('manual-request', mode);
  return sendJson(res, 200, { ok: true, started: !!p, inFlight: !!loginInFlight, mode });
}

// 內部用:登入流程(lib/login.js)取得新 session 後寫回。不對外(Cloudflare
// Access 保護 + X-Relay-Secret),故沿用同一把 RELAY_SECRET。
async function handleSession(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-request' });
  }
  const { cookies } = body; // [{name, value}, ...] 或 {name: value}
  if (!cookies) return sendJson(res, 400, { ok: false, reason: 'missing-cookies' });

  const asObj = Array.isArray(cookies)
    ? Object.fromEntries(cookies.map((c) => [c.name, c.value]))
    : cookies;
  jar = new CookieJar(asObj);
  sessionMeta.lastKeepAlive = Date.now();
  saveSession();
  return sendJson(res, 200, { ok: true });
}

async function handleCaptcha(req, res) {
  if (!requireEitherSecret(req, res, [options.RELAY_SECRET, options.VERCEL_CALLBACK_SECRET])) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-request' });
  }
  const { loginId, code } = body;
  if (!loginId || !code) return sendJson(res, 400, { ok: false, reason: 'missing-params' });

  try {
    const { submitCaptcha } = require('./lib/login');
    await submitCaptcha(loginId, code);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    console.error('[etag-relay] /captcha error:', e && e.message);
    return sendJson(res, 500, { ok: false, reason: 'captcha-submit-failed' });
  }
}

// 唯一不驗 X-Relay-Secret 的端點——Cloudflare Access 設 bypass 讓 LINE
// (老闆手機瀏覽器)能直接開圖。安全性完全靠 token 不可猜(login.js 32 bytes
// random base64url)+ 短 TTL,不做額外驗證。
function handleCapImage(req, res, token) {
  const { getCaptchaImage } = require('./lib/login');
  const image = getCaptchaImage(token);
  if (!image) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length });
  res.end(image);
}

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const capMatch = url.pathname.match(/^\/cap\/([A-Za-z0-9_-]+)\.png$/);

  Promise.resolve()
    .then(() => {
      if (req.method === 'POST' && url.pathname === '/query') return handleQuery(req, res);
      if (req.method === 'GET' && url.pathname === '/health') return handleHealth(req, res);
      if (req.method === 'POST' && url.pathname === '/login') return handleLogin(req, res);
      if (req.method === 'POST' && url.pathname === '/session') return handleSession(req, res);
      if (req.method === 'POST' && url.pathname === '/captcha') return handleCaptcha(req, res);
      if (req.method === 'GET' && capMatch) return handleCapImage(req, res, capMatch[1]);

      sendJson(res, 404, { ok: false, reason: 'not-found' });
    })
    .catch((e) => {
      console.error('[etag-relay] unhandled error:', e && e.message);
      try {
        sendJson(res, 500, { ok: false, reason: 'internal-error' });
      } catch (_) {
        /* response 可能已送出 */
      }
    });
});

// ── keep-alive(每 ~15 分鐘保溫 session)──────────────────────────────────
// 失效 → triggerLogin('keep-alive-expired')(A2,2026-07-27 接線)。實際 ping 目標/判定
// 條件沿用 lib/fetc-client.js getAntiForgeryToken(TOKEN_SOURCE_PATH),待活 session 驗證收斂。
function scheduleKeepAlive() {
  const { startKeepAlive } = require('./lib/login');
  startKeepAlive({
    jar,
    onExpired: () => {
      console.warn('[etag-relay] keep-alive 偵測到 session 失效');
      triggerLogin('keep-alive-expired');
    },
  });
  sessionMeta.lastKeepAlive = Date.now();
  saveSession();
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[etag-relay] listening on :${PORT}`);
    if (options.FETC_ACCOUNT) {
      scheduleKeepAlive(); // 有帳密才有意義跑 keep-alive
      // 首次啟動若無 session(空 jar,首次部署或存檔遺失)也觸發一次登入,不必等 15 分 keep-alive
      if (Object.keys(jar.toObject()).length === 0) {
        triggerLogin('startup-no-session');
      }
    }
  });
}

module.exports = { server, jar, options };
