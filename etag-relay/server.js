// ── etag-relay HA add-on 主服務 ─────────────────────────────────────────
// Node 內建 http server(不用 express,add-on 體積/攻擊面最小化)。
// 路由(Round G1 起,軌道 A/LINE 4 碼流程整條移除,唯一登入路徑=真人 noVNC):
//   POST /query   (驗 X-Relay-Secret)  三步查詢鏈 → 回 transactions/total/printHtml
//   GET  /health  (驗 X-Relay-Secret)  存活 + session 有效性 + noVNC 連結(vncUrl)
//   POST /login   (驗 X-Relay-Secret)  手動觸發登入流程(不必等 cron/keep-alive 撞失效)
//   POST /session (內部用)             登入流程寫回 session cookie(貼 cookie 終極備援)
//
// 帳密/cookie/VNC 密碼/VNC token 絕不寫入任何 log 或回應(沿用 gafferland-main sanitize 鐵則)。
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

// noVNC 入口的 URL token(見 lib/vnc.js loadVncToken)。由下方 require.main 啟動段填入;
// 未跑到那段(如未來 require 這個模組來測試)則維持 null,buildVncUrl() 因此回 null——
// 不是錯誤,只是沒有可用的 noVNC 連結。
let vncToken = null;

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

// ── 登入流程觸發(A2,2026-07-27)────────────────────────────────────────────
// keep-alive 偵測失效、查詢撞失效、或首次啟動無 session 時都呼叫這裡。同一時間只跑
// 一個登入流程(loginInFlight 互斥)——這裡的互斥只是避免多個觸發點(keep-alive timer 與
// 查詢請求可能同時偵測到失效)重複開瀏覽器,不是重試邏輯;「登入失敗不重試送出」鐵則現在
// 由 lib/login.js 天然成立(整條流程沒有自動送出這一步,唯一送出動作是真人在 noVNC 裡
// 自己按的)。
let loginInFlight = null;
let lastManualNotifyAt = 0; // 上次成功送出 mode:'manual' 通知的時間(module-level;初始 0
// 代表「還沒通知過」,配合下方 triggerLogin() 的冷卻判斷——Date.now() - 0 天然是個很大的
// 數字,不會誤判成冷卻中)。

// 組出帶 token 的 noVNC 完整連結,供通知 Vercel(老闆從 LINE 點連結進 noVNC)與 /health
// (Vercel staff API 用)回應——沒有 Cloudflare Access 保護 8098 這層之後,這個 URL 本身
// 就是進 noVNC 頁面的門檻之一(見 lib/vnc.js 驗 key 邏輯)。VNC_PUBLIC_URL 或 vncToken
// 任一缺就回 null,不給半個連結。
function buildVncUrl() {
  if (!options.VNC_PUBLIC_URL || !vncToken) return null;
  return `${options.VNC_PUBLIC_URL.replace(/\/+$/, '')}/?key=${vncToken}`;
}

// 通知 Vercel 登入進度:POST VERCEL_CAPTCHA_URL {...payload, secret}。
// secret 用 VERCEL_CALLBACK_SECRET(呼應計劃「Vercel→relay 用既有 ETAG_RELAY_SECRET、
// relay→Vercel 用 ETAG_RELAY_CALLBACK_SECRET」的契約——中繼這端只認得自己 config.yaml
// 裡的 VERCEL_CALLBACK_SECRET 選項名稱,對外呼叫時帶的欄位值即 Vercel 端的
// ETAG_RELAY_CALLBACK_SECRET)。
// payload.mode 為 'manual'|'manual-timeout'|'success'。
// 通知失敗只印警告、不可 throw——真人遠端登入特別重要:Vercel 通知不到,老闆還是要能靠
// 其他管道(如直接看 noVNC)登入,不能讓登入流程因為通知失敗而 reject。
async function notifyVercel(payload) {
  if (!options.VERCEL_CAPTCHA_URL) {
    console.warn(`[etag-relay] VERCEL_CAPTCHA_URL 未設定,無法通知 Vercel(mode=${payload && payload.mode})`);
    return;
  }
  const body = { ...payload, secret: options.VERCEL_CALLBACK_SECRET };
  try {
    const resp = await fetch(options.VERCEL_CAPTCHA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.warn(`[etag-relay] 通知 Vercel 失敗(mode=${payload && payload.mode}):HTTP ${resp.status}`);
      return;
    }
    // 只有成功送出 mode:'manual' 才記時間——冷卻窗口的起點是「老闆已經被通知過一次」,
    // 失敗的通知等於沒通知到,不該因此讓下一次自動觸發也被冷卻吃掉。
    if (payload && payload.mode === 'manual') {
      lastManualNotifyAt = Date.now();
    }
  } catch (e) {
    console.warn(`[etag-relay] 通知 Vercel 例外(mode=${payload && payload.mode}):`, e && e.message);
  }
}

// 觸發一次登入流程(不 await 完成——呼叫端 fire-and-forget,結果透過 saveSession 落地、
// 下次查詢自然吃到新 session)。reason 只供 log 分類,絕不含帳密。
// 唯一登入路徑=真人 noVNC(Round G1 起不再有 mode 參數)。
function triggerLogin(reason) {
  if (loginInFlight) {
    console.log(`[etag-relay] 登入流程已在進行中,略過重複觸發(reason=${reason})`);
    return loginInFlight;
  }
  if (!options.FETC_ACCOUNT || !options.FETC_PASSWORD) {
    console.warn(`[etag-relay] 無 FETC_ACCOUNT/FETC_PASSWORD,無法自動登入(reason=${reason})`);
    return Promise.resolve();
  }

  // 冷卻(Round G1):無 session 時 keep-alive 每 10 分觸發一次,若不冷卻,瀏覽器會一路
  // 開著等到 manualTtlMs 逾時才關(CPU/RAM 常駐 ~5%),LINE 也會被同一件事洗版。
  // 'manual-request' 是 /collect 的手動按鈕,老闆主動要求不受冷卻限制。
  const cooldownMs = 60 * 60 * 1000;
  if (reason !== 'manual-request' && Date.now() - lastManualNotifyAt < cooldownMs) {
    const minutesAgo = Math.round((Date.now() - lastManualNotifyAt) / 60000);
    console.log(`[etag-relay] 冷卻中(上次通知 ${minutesAgo} 分鐘前),略過自動觸發(reason=${reason})`);
    return Promise.resolve();
  }

  console.log(`[etag-relay] 觸發登入流程(reason=${reason})`);
  const { startLogin } = require('./lib/login');
  loginInFlight = startLogin({
    account: options.FETC_ACCOUNT,
    password: options.FETC_PASSWORD,
    profileDir: path.join(DATA_DIR, 'chrome-profile'),
    vncUrl: buildVncUrl(),
    manualTtlMs: (Number(options.MANUAL_LOGIN_TTL_MIN) || 15) * 60 * 1000,
    onNotify: notifyVercel,
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
    // 帶 token 的完整 noVNC 連結——這個端點本身已有 X-Relay-Secret 守門,只有 Vercel
    // staff API(老闆本人透過網站後台按鈕)能拿到,不算把 token 公開;VNC_PUBLIC_URL 或
    // token 缺一個就回 null,前端自行判斷要不要顯示「開啟遠端登入」按鈕。
    vncUrl: buildVncUrl(),
  });
}

// 讓 /collect 有「重新登入遠通」按鈕,不必等 cron/keep-alive 撞失效才觸發。
// fire-and-forget(同 triggerLogin 既有語意):回應只回「有沒有啟動」,不等登入流程跑完。
async function handleLogin(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  // body.mode 已不再有意義(唯一路徑=真人 noVNC)——照收不報錯,只是不再拿來分岔邏輯,
  // 相容 Vercel 端既有呼叫(過去會帶 mode:'manual'/'auto')。
  try { await readBody(req); } catch (e) { /* 壞 JSON 不擋觸發 */ }
  const p = triggerLogin('manual-request');
  return sendJson(res, 200, { ok: true, started: !!p, inFlight: !!loginInFlight, mode: 'manual' });
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

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  Promise.resolve()
    .then(() => {
      if (req.method === 'POST' && url.pathname === '/query') return handleQuery(req, res);
      if (req.method === 'GET' && url.pathname === '/health') return handleHealth(req, res);
      if (req.method === 'POST' && url.pathname === '/login') return handleLogin(req, res);
      if (req.method === 'POST' && url.pathname === '/session') return handleSession(req, res);

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

// ── keep-alive(每 ~10 分鐘保溫 session)──────────────────────────────────
// 失效 → triggerLogin('keep-alive-expired')(A2,2026-07-27 接線)。實際 ping 目標/判定
// 條件沿用 lib/fetc-client.js getAntiForgeryToken(TOKEN_SOURCE_PATH)。
// Round G1b(2026-07-27 實測 session 17 分鐘就失效,根因):傳 getJar 函式而非 jar 物件本身
// ——登入成功後 jar 會被整個重新指派(見 triggerLogin().then() 內 `jar = new CookieJar(...)`),
// 若這裡傳物件,lib/login.js 的計時器 closure 抱住的是啟動時那個舊 jar(通常是空的),永遠
// ping 不到真正登入後的 session。getJar: () => jar 確保每次 tick 都讀「現在」的 jar。
// onAlive:ping 成功才更新 lastKeepAlive 並 saveSession()——遠通續期可能帶 Set-Cookie,
// 不存回等於白 ping;之前版本完全沒有這一步,也是保溫從未生效的一部分。
function scheduleKeepAlive() {
  const { startKeepAlive } = require('./lib/login');
  startKeepAlive({
    getJar: () => jar,
    onAlive: () => {
      sessionMeta.lastKeepAlive = Date.now();
      saveSession();
    },
    onExpired: () => {
      console.warn('[etag-relay] keep-alive 偵測到 session 失效');
      triggerLogin('keep-alive-expired');
    },
  });
  sessionMeta.lastKeepAlive = Date.now();
  saveSession();
}

if (require.main === module) {
  // noVNC 遠端畫面(真人遠端登入,唯一登入路徑):獨立 http server on :8098,
  // 只有設了 VNC_PASSWORD 才啟動(未設＝功能停用,見 lib/vnc.js)。
  // Round G1:noVNC 入口拿掉 Cloudflare Access,改「連結內建長亂數 token + VNC 密碼」
  // 兩層——token 由 loadVncToken() 落地 /data(持久卷),只有設了 VNC_PASSWORD 才需要。
  try {
    const { startVncServer, loadVncToken } = require('./lib/vnc');
    vncToken = options.VNC_PASSWORD ? loadVncToken(DATA_DIR) : null;
    startVncServer({ enabled: !!options.VNC_PASSWORD, token: vncToken });
  } catch (e) {
    // noVNC 起不來不可拖垮中繼本體(查詢/結算是主功能,遠端登入只是 session 更新手段)
    console.error('[etag-relay] noVNC 服務啟動失敗(不影響查詢功能):', e && e.message);
  }

  server.listen(PORT, () => {
    console.log(`[etag-relay] listening on :${PORT}`);
    if (options.FETC_ACCOUNT) {
      scheduleKeepAlive(); // 有帳密才有意義跑 keep-alive
      // 首次啟動若無 session(空 jar,首次部署或存檔遺失)也觸發一次登入,不必等 10 分 keep-alive
      if (Object.keys(jar.toObject()).length === 0) {
        triggerLogin('startup-no-session');
      }
    }
  });
}

module.exports = { server, jar, options };
