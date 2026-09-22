// ── etag-relay HA add-on 主服務 ─────────────────────────────────────────
// Node 內建 http server(不用 express,add-on 體積/攻擊面最小化)。
// 路由(0.5.0 起,登入/VNC/Chrome 全套拆除:session 改由使用者電腦的 Chrome 擴充功能
// 把 cookies POST 進 /session,真驗證通過才生效並回呼 Vercel 觸發補跑結算):
//   POST /query   (驗 X-Relay-Secret)  三步查詢鏈 → 回 transactions/total/printHtml
//                                       (body.skipPrint:true 省最後 print 步驟,見下)
//   POST /print   (驗 X-Relay-Secret)  Round H1(0.3.8 終局):純 HTTP 復刻站方「下載PDF
//                                       文件」打包,POST 遠通 UX000006GetPDF 由**遠通伺服器**
//                                       生成原生 PDF(鐵則:PDF 是收款憑證,必須是遠通自己
//                                       生成的檔案)→ 回 pdfBase64(via:'fetc-native')
//   GET  /health  (驗 X-Relay-Secret)  存活 + session 有效性
//   POST /session (驗 X-Relay-Secret)  瀏覽器擴充功能餵入新 cookies:先用
//                                       getAntiForgeryToken 真驗證(與 keep-alive 同一把尺)
//                                       通過才換 jar/存檔,回應送出後 fire-and-forget 回呼
//                                       Vercel(mode:'success')觸發補跑結算
//
// 帳密/cookie/RELAY_SECRET 絕不寫入任何 log 或回應(沿用 gafferland-main sanitize 鐵則)。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { CookieJar, resolveCin, queryAll, buildDateTimeMapForTimes, print, generateNativePdf } = require('./lib/fetc-client');
const { startSiteIpHeartbeat } = require('./lib/siteip-heartbeat');

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
    PUNCH_SITEIP_URL: process.env.PUNCH_SITEIP_URL || '',
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

// 店內 IP 心跳(0.6.0):啟動前 /health 尚未跑過 startSiteIpHeartbeat,先給一個回傳空狀態
// 的 getter 佔位,避免 handleHealth 在啟動極早期(理論上不會發生,但保守起見)拿到 undefined。
let siteIpHeartbeat = { getStatus: () => ({ lastOkAt: null, lastIp: null }) };

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    jar = new CookieJar(raw.cookies || {});
    sessionMeta = {
      lastKeepAlive: raw.lastKeepAlive || null,
      plateCinCache: raw.plateCinCache || {},
    };
  } catch (e) {
    // 無存檔(首次啟動)或壞檔 → 空 session,等擴充功能透過 /session 餵入
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

// 通知 Vercel:POST VERCEL_CAPTCHA_URL {...payload, secret}。
// secret 用 VERCEL_CALLBACK_SECRET(呼應「Vercel→relay 用既有 ETAG_RELAY_SECRET、
// relay→Vercel 用 ETAG_RELAY_CALLBACK_SECRET」的契約——中繼這端只認得自己 config.yaml
// 裡的 VERCEL_CALLBACK_SECRET 選項名稱,對外呼叫時帶的欄位值即 Vercel 端的
// ETAG_RELAY_CALLBACK_SECRET)。
// 0.5.0 起唯一呼叫點=handleSession 驗證通過後的 mode:'success' 回呼(觸發 Vercel 端補跑
// 結算)。通知失敗只印警告、不可 throw——不能讓 /session 的回應因為通知失敗而卡住或出錯。
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
  } catch (e) {
    console.warn(`[etag-relay] 通知 Vercel 例外(mode=${payload && payload.mode}):`, e && e.message);
  }
}

// session 失效時的通知(0.5.0 起純 log,不再推 LINE)。query/print 撞失效、keep-alive
// 偵測失效、啟動即驗都會呼叫這裡——登入/VNC 全套已拆除,自動重新取得 session 已不可能,
// 唯一補救管道是使用者從瀏覽器擴充功能重新餵一次 cookies 進 /session。是否要在 Vercel 端
// 提醒使用者,交給 Vercel「有單才提醒」的邏輯,不在這裡推播。
function noteSessionDead(reason) {
  console.log('[etag-relay] session 失效(' + reason + '),等待使用者從擴充功能餵入新 session');
  return Promise.resolve();
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
      noteSessionDead('query-session-expired'); // 純 log(本次查詢仍回失效,下次 cron 補;冪等)
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
      noteSessionDead('print-session-expired'); // 同 handleQuery,純 log
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
    siteIpHeartbeat: siteIpHeartbeat.getStatus(),
  });
}

// 瀏覽器擴充功能餵入新 session(0.5.0:取代整套登入/VNC 流程,唯一的 session 更新路徑)。
// 收 {cookies}(陣列 [{name,value}] 或物件 {name:value} 都吃)。真驗證通過才生效:
// 1. 先組候選 jar(不動全域 jar/sessionMeta),用與 keep-alive 同一把尺(getAntiForgeryToken)
//    驗證這組 cookies 真的能打會員頁——驗不過(token 為 null 或例外)一律視為失敗,回 400,
//    不蓋全域 jar、不 saveSession、不動 lastKeepAlive。
// 2. 驗證通過才換上全域 jar、記 lastKeepAlive、落檔。
// 3. 回應送出後才 fire-and-forget 回呼 Vercel(mode:'success')——Vercel 端收到會同步跑
//    補跑結算,可能耗時數分鐘,絕不能 await 卡住本請求的回應。
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

  const candidateJar = new CookieJar(asObj);
  let token = null;
  try {
    const { getAntiForgeryToken } = require('./lib/fetc-client');
    token = await getAntiForgeryToken(candidateJar);
  } catch (e) {
    token = null;
  }
  if (!token) {
    console.log('[etag-relay] /session 收到新 session,驗證失敗(session-invalid)');
    return sendJson(res, 400, { ok: false, reason: 'session-invalid' });
  }

  jar = candidateJar;
  sessionMeta.lastKeepAlive = Date.now();
  saveSession();
  console.log('[etag-relay] /session 收到新 session,驗證通過,已存檔並回呼 Vercel');
  sendJson(res, 200, { ok: true, verified: true });

  // fire-and-forget:見上方檔頭說明,不可 await。
  notifyVercel({ mode: 'success', loginId: 'session-push', via: 'extension' })
    .catch((e) => console.warn('[etag-relay] /session 回呼 Vercel 例外:', e && e.message));
}

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  Promise.resolve()
    .then(() => {
      if (req.method === 'POST' && url.pathname === '/query') return handleQuery(req, res);
      if (req.method === 'POST' && url.pathname === '/print') return handlePrint(req, res);
      if (req.method === 'GET' && url.pathname === '/health') return handleHealth(req, res);
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
// 實際 ping 目標/判定條件沿用 lib/fetc-client.js getAntiForgeryToken(TOKEN_SOURCE_PATH)。
// getJar: () => jar(而非直接傳 jar 物件)確保每次 tick 都讀「現在」的 jar——/session
// 換上新 cookies 時是整個重新指派 `jar = candidateJar`,若這裡捕的是啟動時的 jar 物件,
// 計時器永遠 ping 不到換上的新 session(Round G1b 曾因此踩過同款 bug,教訓沿用)。
// onAlive:ping 成功才更新 lastKeepAlive 並 saveSession()——遠通續期可能帶 Set-Cookie,
// 不存回等於白 ping。
function scheduleKeepAlive() {
  const { startKeepAlive } = require('./lib/fetc-client');
  startKeepAlive({
    getJar: () => jar,
    onAlive: () => {
      sessionMeta.lastKeepAlive = Date.now();
      saveSession();
    },
    onExpired: () => {
      console.warn('[etag-relay] keep-alive 偵測到 session 失效');
      noteSessionDead('keep-alive-expired');
    },
  });
  sessionMeta.lastKeepAlive = Date.now();
  saveSession();
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[etag-relay] listening on :${PORT}`);
    // 0.5.0 起 keep-alive 無條件跑:保溫只依賴 jar,與 FETC 帳密無關(登入已拆除,帳密
    // 已無功能用途)——舊版以 options.FETC_ACCOUNT 當閘門,哪天使用者清掉帳密設定會讓
    // 保溫無聲停擺,故移除。
    scheduleKeepAlive();
    // 店內 IP 心跳(0.6.0):每 5 分鐘 POST Vercel 一次,讓打卡 Wi-Fi 判定知道目前店內
    // 對外 IP。零新密鑰:沿用既有 VERCEL_CAPTCHA_URL(取 origin)與 VERCEL_CALLBACK_SECRET。
    // 未設定時 sendSiteIpHeartbeat 內部回 not-configured,不影響其餘功能。
    siteIpHeartbeat = startSiteIpHeartbeat(options);
    // 啟動即驗一次 session——keep-alive 是 setInterval,第一次檢查在啟動後 10 分鐘;
    // 重啟後的失效盲區(session 已死卻要空等 10 分鐘才發現)靠這裡補。與 keep-alive
    // 同一把尺(getAntiForgeryToken);空 jar 天然驗不過。失效只走 noteSessionDead
    // (0.5.0 起純 log,見上方註解——不再有自動觸發登入這回事)。
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
        console.warn('[etag-relay] 啟動 session 檢查:失效');
      } catch (e) {
        console.warn('[etag-relay] 啟動 session 檢查異常(視為失效):', e && e.message);
      }
      noteSessionDead('startup-session-invalid');
    })();
  });
}

module.exports = { server, jar, options };
