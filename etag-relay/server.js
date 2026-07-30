// ── etag-relay HA add-on 主服務 ─────────────────────────────────────────
// Node 內建 http server(不用 express,add-on 體積/攻擊面最小化)。
// 路由(Round G1 起,軌道 A/LINE 4 碼流程整條移除,唯一登入路徑=真人 noVNC):
//   POST /query   (驗 X-Relay-Secret)  三步查詢鏈 → 回 transactions/total/printHtml
//                                       (body.skipPrint:true 省最後 print 步驟,見下)
//   POST /print   (驗 X-Relay-Secret)  Round H1(0.3.8 終局):純 HTTP 復刻站方「下載PDF
//                                       文件」打包,POST 遠通 UX000006GetPDF 由**遠通伺服器**
//                                       生成原生 PDF(鐵則:PDF 是收款憑證,必須是遠通自己
//                                       生成的檔案)→ 回 pdfBase64(via:'fetc-native')
//   GET  /health  (驗 X-Relay-Secret)  存活 + session 有效性 + noVNC 連結(vncUrl)
//   POST /login   (驗 X-Relay-Secret)  手動觸發登入流程(不必等 cron/keep-alive 撞失效)
//   POST /session (內部用)             登入流程寫回 session cookie(貼 cookie 終極備援)
//
// 帳密/cookie/VNC 密碼/VNC token 絕不寫入任何 log 或回應(沿用 gafferland-main sanitize 鐵則)。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { CookieJar, resolveCin, queryAll, buildDateTimeMapForTimes, print, generateNativePdf } = require('./lib/fetc-client');

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
    MANUAL_LOGIN_TTL_MIN: process.env.MANUAL_LOGIN_TTL_MIN || 8,
  };
}

const PORT = 8099;
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '.devdata');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── session 持久化(跨重啟)───────────────────────────────────────────────
// 存的只有 cookie 名稱/值(session token 本身),不含帳密。
let jar = new CookieJar();
let sessionMeta = { lastKeepAlive: null, plateCinCache: {}, lastNotifyDate: null };

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
      // 0.4.0:最後一次推播登入連結的台北日期——落檔才能做到「重啟也不重推同一天」。
      lastNotifyDate: raw.lastNotifyDate || null,
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
    lastNotifyDate: sessionMeta.lastNotifyDate,
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

// 台北日期字串(yyyy-mm-dd)——每日一則通知的判斷基準(0.4.0 使用者裁示)。台灣無日光節約,
// 直接 UTC+8 再取 ISO 前 10 碼即可,不用本地時區解析(沿用全站牆鐘慣例)。
function taipeiDateStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

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
    // 只有成功送出 mode:'manual' 才記日期——「每日一則」的起點是「老闆今天已經被通知過」,
    // 失敗的通知等於沒通知到,不該因此吃掉今天唯一的額度。**日期落檔 session.json**:
    // add-on 重啟不會重推同一天(0.3.x 用 in-memory 時間戳,重啟即歸零 → 重推)。
    if (payload && payload.mode === 'manual') {
      sessionMeta.lastNotifyDate = taipeiDateStr();
      saveSession();
    }
  } catch (e) {
    console.warn(`[etag-relay] 通知 Vercel 例外(mode=${payload && payload.mode}):`, e && e.message);
  }
}

// 觸發一次登入流程(不 await 完成——呼叫端 fire-and-forget,結果透過 saveSession 落地、
// 下次查詢自然吃到新 session)。reason 只供 log 分類,絕不含帳密。
// 唯一登入路徑=真人 noVNC(Round G1 起不再有 mode 參數)。
// 0.4.0 架構反轉:**自動偵測到 session 失效不再開瀏覽器**,只推一則通知(每日一則)。
// 原因(2026-07-30 使用者實測):凌晨 4 點偵測到失效就開瀏覽器填好帳密等真人,中午才點連結
// 的人看到的是放了 8 小時的頁面與驗證碼(v3 情境早過期,送出必被擋),而瀏覽器整晚常駐把
// Xvfb/x11vnc 拖到很卡。改成「人到了才開」:通知 → 使用者點登入頁 → POST /trigger 起流程 →
// 驗證碼從產生到送出壓在幾十秒內。
function noteSessionDead(reason) {
  const today = taipeiDateStr();
  if (sessionMeta.lastNotifyDate === today) {
    console.log(`[etag-relay] session 失效(reason=${reason});今日已通知過,不重複推播`);
    return Promise.resolve();
  }
  const vncUrl = buildVncUrl();
  if (!vncUrl) {
    console.warn(`[etag-relay] session 失效(reason=${reason})但 VNC_PUBLIC_URL/token 未就緒,無法給登入連結`);
    return Promise.resolve();
  }
  console.log(`[etag-relay] session 失效(reason=${reason}),推播今日登入連結(不開瀏覽器,等使用者開頁面)`);
  return notifyVercel({
    mode: 'manual',
    loginId: 'on-demand',
    vncUrl,
    ttlMin: Number(options.MANUAL_LOGIN_TTL_MIN) || 8,
  });
}

// 觸發登入流程(0.4.0 起只由「人在登入頁按開始登入」或 /collect 手動按鈕呼叫;自動偵測走
// noteSessionDead)。opts.force=先中止進行中的舊流程再起新的(頁面偵測到 ageSec 過大、或
// 上一次送出被遠通拒 → 換一個全新頁面/全新 v3 情境重來)。
function triggerLogin(reason, opts = {}) {
  if (loginInFlight && !opts.force) {
    console.log(`[etag-relay] 登入流程已在進行中,略過重複觸發(reason=${reason})`);
    return loginInFlight;
  }
  if (!options.FETC_ACCOUNT || !options.FETC_PASSWORD) {
    console.warn(`[etag-relay] 無 FETC_ACCOUNT/FETC_PASSWORD,無法自動登入(reason=${reason})`);
    return Promise.resolve();
  }

  console.log(`[etag-relay] 觸發登入流程(reason=${reason}${opts.force ? ',force' : ''})`);
  const { startLogin, abortLogin } = require('./lib/login');
  const prev = opts.force && loginInFlight ? loginInFlight : null;
  let mine;
  mine = (async () => {
    if (opts.force) {
      await abortLogin().catch(() => {});
      if (prev) await prev.catch(() => {});   // 等舊流程收乾淨(它會以 flow-ended 結束)
    }
    return startLogin({
      account: options.FETC_ACCOUNT,
      password: options.FETC_PASSWORD,
      profileDir: path.join(DATA_DIR, 'chrome-profile'),
      vncUrl: buildVncUrl(),
      manualTtlMs: (Number(options.MANUAL_LOGIN_TTL_MIN) || 8) * 60 * 1000,
      onNotify: notifyVercel,
    });
  })()
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
      // 0.4.1:把原因交給 /state,讓登入頁直接顯示「為什麼開不起來」——0.4.0 時使用者只看到
      // 永遠轉圈的「啟動瀏覽器中…」,原因只存在 add-on 日誌裡。
      try { require('./lib/login').noteLoginError(e); } catch (e2) { /* 診斷用途,失敗不影響 */ }
    })
    .finally(() => {
      // 只有「自己還是當前流程」才清空——force 重啟時舊流程的 finally 會晚於新流程的指派,
      // 無條件清空會把新流程的 in-flight 狀態抹掉(第二次 /trigger 就會再開一個瀏覽器)。
      if (loginInFlight === mine) loginInFlight = null;
    });
  loginInFlight = mine;
  return mine;
}

async function resolvePlateCin(plate) {
  if (sessionMeta.plateCinCache[plate]) return sessionMeta.plateCinCache[plate];
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
  const { plate, startDate, endDate, skipPrint } = body;
  if (!plate || !startDate || !endDate) {
    return sendJson(res, 400, { ok: false, reason: 'missing-params' });
  }

  try {
    const cin = await resolvePlateCin(plate);
    if (!cin) {
      return sendJson(res, 200, { ok: false, reason: 'cin-not-found' });
    }

    const result = await queryAll(jar, { plate, cin, startDate, endDate }, { skipPrint: !!skipPrint });
    saveSession(); // queryAll 過程可能更新 cookie(Set-Cookie 續期),存回

    const transactions = result.transactions.map((t) => ({
      timeTs: t.timeTs,
      timeStr: t.timeStr,
      route: t.route,
      gantry: t.gantry,
      amount: t.amount,
    }));

    const responseBody = { ok: true, transactions, total: result.total };
    // skipPrint=true:回應完全不含這欄(不是給 null)——省下的正是呼叫端不想要的
    // 那 2MB inline 資產字串,帶著 null 一樣要佔頻寬。
    if (!skipPrint) responseBody.printHtml = result.printHtml;
    return sendJson(res, 200, responseBody);
  } catch (e) {
    if (e && e.code === 'SESSION_EXPIRED') {
      noteSessionDead('query-session-expired'); // 0.4.0:只推每日一則通知,不開瀏覽器(本次查詢仍回失效,下次 cron 補;冪等)
      return sendJson(res, 200, { ok: false, reason: 'session-expired' });
    }
    console.error('[etag-relay] /query error:', e && e.message); // 訊息本身不含帳密/cookie
    return sendJson(res, 500, { ok: false, reason: 'internal-error' });
  }
}

// Round H1(0.3.8 終局):純 HTTP 復刻遠通「下載PDF文件」打包,由遠通伺服器端點生成
// 原生 PDF(見 lib/fetc-client.js generateNativePdf 檔頭說明)。
// 回應契約(Vercel 端按此實作,務必勿改):
//   成功 {ok:true, pdfBase64, via:'fetc-native', printTotal}
//   失敗 {ok:false, reason:'no-rows'|'session-expired'|'pdf-failed'}
// times = Vercel 配對命中、要收款的門架時間戳子集('yyyy/MM/dd HH:mm:ss',與 /query
// 回應 transactions[].timeStr 同格式)——這正是「PDF 不可混入租期外通行紀錄」鐵則在
// 請求層的落地:中繼只會把 times 允許的時間戳送進遠通列印端點,不是先印全部再裁切。
async function handlePrint(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-request' });
  }
  const { plate, startDate, endDate, times } = body;
  if (!plate || !startDate || !endDate || !Array.isArray(times) || !times.length) {
    return sendJson(res, 400, { ok: false, reason: 'missing-params' });
  }

  try {
    const cin = await resolvePlateCin(plate);
    if (!cin) {
      // 契約只開放 no-rows/session-expired/pdf-failed 三種 reason——車輛清單裡找不到
      // 這個車牌本質上也是「沒有可印的資料」,歸類 no-rows(不是例外狀況,見工單回報)。
      return sendJson(res, 200, { ok: false, reason: 'no-rows' });
    }

    const { dateTimeMap, fieldToken } = await buildDateTimeMapForTimes(jar, {
      plate,
      cin,
      startDate,
      endDate,
      times,
    });
    saveSession(); // search/detail 過程可能續期 cookie

    if (!Object.keys(dateTimeMap).length) {
      return sendJson(res, 200, { ok: false, reason: 'no-rows' });
    }

    // 0.3.8:純 HTTP 全程——print 拿原始列印 HTML → 復刻站方打包 → 遠通伺服器端點
    // 生成原生 PDF(含電子憑證章/文字層)。不再開瀏覽器,也**不做任何自家渲染 fallback**:
    // 寧可沒 PDF(Vercel 記 pdfError、列照寫,之後可還原重出),也不要把非原生件掛上
    // 客戶的收款憑證欄。
    const printHtml = await print(jar, fieldToken, { plate, cin, dateTimeMap });
    saveSession();

    // printTotal 供 Vercel 端與彙總金額對數(取不到不擋)
    let printTotal = null;
    try {
      const { parsePrintRows, parseAmount } = require('./lib/parse');
      const { total } = parsePrintRows(printHtml);
      if (total && total.toll) {
        const amt = parseAmount(total.toll);
        if (Number.isFinite(amt)) printTotal = amt;
      }
    } catch (e) { /* 對數輔助欄位,解析失敗回 null */ }

    const pdfBuffer = await generateNativePdf(jar, fieldToken, printHtml);
    return sendJson(res, 200, {
      ok: true,
      pdfBase64: pdfBuffer.toString('base64'),
      via: 'fetc-native',
      printTotal,
    });
  } catch (e) {
    if (e && e.code === 'SESSION_EXPIRED') {
      noteSessionDead('print-session-expired'); // 0.4.0:同 handleQuery,只通知不開瀏覽器
      return sendJson(res, 200, { ok: false, reason: 'session-expired' });
    }
    // 契約沒有 internal-error 這個 reason,一律歸 pdf-failed(訊息本身不含帳密/cookie)。
    console.error('[etag-relay] /print error:', e && e.message);
    return sendJson(res, 200, { ok: false, reason: 'pdf-failed' });
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
      if (req.method === 'POST' && url.pathname === '/print') return handlePrint(req, res);
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
      noteSessionDead('keep-alive-expired');   // 0.4.0:不再自動開瀏覽器(見 noteSessionDead 註解)
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
    startVncServer({
      enabled: !!options.VNC_PASSWORD,
      token: vncToken,
      // noVNC 用戶端接上畫面時換一張新驗證碼(舊圖可能已過期)
      onClientConnect: () => require('./lib/login').refreshCaptcha(),
      // 0.3.5 頁面輸碼主路徑:登入頁直接顯示驗證碼圖+輸碼送出;「開始登入」等同
      // /collect 的重新登入按鈕(manual-request,不受通知冷卻限制)
      captcha: {
        shot: (opts) => require('./lib/login').captchaShot(opts),
        meta: () => require('./lib/login').capMeta(),
        state: () => require('./lib/login').flowState(),
        submit: (code) => require('./lib/login').submitCode(code),
        trigger: (opts) => triggerLogin('manual-request', opts || {}),
      },
    });
  } catch (e) {
    // noVNC 起不來不可拖垮中繼本體(查詢/結算是主功能,遠端登入只是 session 更新手段)
    console.error('[etag-relay] noVNC 服務啟動失敗(不影響查詢功能):', e && e.message);
  }

  server.listen(PORT, () => {
    console.log(`[etag-relay] listening on :${PORT}`);
    if (options.FETC_ACCOUNT) {
      scheduleKeepAlive(); // 有帳密才有意義跑 keep-alive
      // 0.3.12(使用者裁示):啟動即驗一次 session——keep-alive 是 setInterval,第一次檢查在
      // 啟動後 10 分鐘;重啟後的失效盲區(session 已死卻要空等 10 分鐘才收到登入連結)靠這裡補。
      // 與 keep-alive 同一把尺(getAntiForgeryToken);空 jar 天然驗不過,涵蓋舊
      // 'startup-no-session'(僅驗 jar 空)情境。0.4.0:失效只走 noteSessionDead(每日一則、
      // 不開瀏覽器);通知日期已落檔 session.json,重啟不會重推同一天。
      (async () => {
        try {
          const { getAntiForgeryToken } = require('./lib/fetc-client');
          const token = await getAntiForgeryToken(jar);
          if (token) {
            sessionMeta.lastKeepAlive = Date.now();
            saveSession();
            console.log('[etag-relay] 啟動 session 檢查:有效');
            return;
          }
          console.warn('[etag-relay] 啟動 session 檢查:失效,觸發登入');
        } catch (e) {
          console.warn('[etag-relay] 啟動 session 檢查異常(視為失效,觸發登入):', e && e.message);
        }
        noteSessionDead('startup-session-invalid');   // 0.4.0:啟動驗到失效也只通知,不開瀏覽器
      })();
    }
  });
}

module.exports = { server, jar, options };
