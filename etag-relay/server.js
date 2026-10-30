// ── Gafferland Relay(原 etag-relay)HA add-on 主服務 ─────────────────────────
// Node 內建 http server(不用 express,add-on 體積/攻擊面最小化)。
// 0.8.0 起只剩簡訊中繼與店內 IP 心跳——遠通 eTag 改由員工電腦的瀏覽器擴充功能代查、收款憑證
// 由員工在網站匯入遠通原生 PDF,中繼的 /query、/print、/session、keep-alive 與 session 存檔
// 全部拆除(lib/fetc-client.js、lib/parse.js、fixtures/ 一併刪除)。
// 路由:
//   GET  /health  (驗 X-Relay-Secret)  存活 + 店內 IP 心跳狀態 siteIpHeartbeat
//   POST /sms     (驗 X-Relay-Secret)  0.7.0:SMS 中繼(every8d 台灣 IP 出口)——收
//                                       {uid,pwd,sb,msg,dest} 純轉發 lib/sms-forward.js,
//                                       帳密由 Vercel 每次請求帶入,中繼不存帳密
//   其餘路徑(含已拆的 /query /print /session)一律 404 not-found。
// 背景:店內 IP 心跳(lib/siteip-heartbeat.js,每 5 分鐘 POST Vercel)。
//
// 帳密/RELAY_SECRET 絕不寫入任何 log 或回應(沿用 gafferland-main sanitize 鐵則)。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { startSiteIpHeartbeat } = require('./lib/siteip-heartbeat');
const { forwardSms } = require('./lib/sms-forward');

// ── 設定(HA add-on options 由 supervisor 注入 /data/options.json,本機開發
// 則走環境變數 fallback,方便未部署前先 `node server.js` 對語法/路由 smoke test)──
// 0.8.0:FETC_ACCOUNT/FETC_PASSWORD 不再讀取(schema 仍保留為選填,見 config.yaml)。
// 0.8.0:data 目錄可用環境變數 RELAY_DATA_DIR 覆寫(只給 test-server.js 用臨時目錄;
// HA 容器內不設,維持 /data)。options.json 與啟動時要刪的舊 session.json 都在這個目錄。
const DATA_DIR = process.env.RELAY_DATA_DIR || '/data';
let options = {};
try {
  options = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
} catch (e) {
  // 非 HA 容器環境(本機開發/CI):options.json 不存在,走環境變數
  options = {
    RELAY_SECRET: process.env.RELAY_SECRET || '',
    VERCEL_CAPTCHA_URL: process.env.VERCEL_CAPTCHA_URL || '',
    VERCEL_CALLBACK_SECRET: process.env.VERCEL_CALLBACK_SECRET || '',
    PUNCH_SITEIP_URL: process.env.PUNCH_SITEIP_URL || '',
  };
}

const PORT = 8099;

// 店內 IP 心跳(0.6.0):啟動前 /health 尚未跑過 startSiteIpHeartbeat,先給一個回傳空狀態
// 的 getter 佔位,避免 handleHealth 在啟動極早期(理論上不會發生,但保守起見)拿到 undefined。
let siteIpHeartbeat = { getStatus: () => ({ lastOkAt: null, lastIp: null }) };

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

// SMS 中繼(0.7.0)log 用遮罩:手機號碼保留前 4 碼＋後 3 碼,不足 7 碼視為不可辨識全遮
// (與 gafferland-main lib/mask.js maskPhone 同一遮法,獨立實作——兩個 repo 不跨 require)。
function maskDest(dest) {
  const s = String(dest || '').replace(/\D/g, '');
  return s.length >= 7 ? s.slice(0, 4) + '***' + s.slice(-3) : '***';
}

function requireSecret(req, res, expected) {
  const got = req.headers['x-relay-secret'];
  if (!expected || !safeEqual(got, expected)) {
    sendJson(res, 401, { ok: false, reason: 'unauthorized' });
    return false;
  }
  return true;
}

// ── 路由處理 ──────────────────────────────────────────────────────────────

// 0.8.0:session 相關欄位(sessionValid/sessionReason/lastKeepAlive)隨 eTag 路由拆除。
async function handleHealth(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  return sendJson(res, 200, {
    ok: true,
    siteIpHeartbeat: siteIpHeartbeat.getStatus(),
  });
}

// POST /sms(0.7.0):SMS 中繼(every8d 台灣 IP 出口)。帳密由 Vercel 每次請求帶入
// {uid,pwd,sb,msg,dest},中繼純轉發 lib/sms-forward.js 不存帳密。回應契約:
//   成功 200 {ok:true, status, body}(body=e8d 原始回應文字,CSV 格式判讀交回呼叫端
//   gafferland-main lib/sms.js,與直連分支共用同一套判斷邏輯)
//   e8d 連不上/逾時 200 {ok:false, reason:'e8d-unreachable'}
// log 只印遮罩後的 dest 與 HTTP status——pwd/msg(含 OTP 驗證碼)絕不落 log。
async function handleSms(req, res) {
  if (!requireSecret(req, res, options.RELAY_SECRET)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-request' });
  }
  const { uid, pwd, sb, msg, dest } = body;
  if (!uid || !pwd || !msg || !dest) {
    return sendJson(res, 400, { ok: false, reason: 'missing-params' });
  }

  try {
    const { status, body: text } = await forwardSms({ uid, pwd, sb, msg, dest });
    console.log(`[etag-relay] /sms dest=${maskDest(dest)} status=${status}`);
    return sendJson(res, 200, { ok: true, status, body: text });
  } catch (e) {
    console.error('[etag-relay] /sms error:', e && e.message); // 訊息本身不含帳密/OTP
    return sendJson(res, 200, { ok: false, reason: 'e8d-unreachable' });
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  Promise.resolve()
    .then(() => {
      if (req.method === 'GET' && url.pathname === '/health') return handleHealth(req, res);
      if (req.method === 'POST' && url.pathname === '/sms') return handleSms(req, res);

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

// 0.8.0:舊版(≤0.7.1)存在 data 目錄的遠通 session 檔(session.json,含遠通 cookie)已無程式
// 讀取,啟動時順手刪掉,不留在使用者的 HA 裡。不存在就略過(force);刪不掉(唯讀等)只 warn
// 一行,不影響啟動。
function removeLegacySessionFile() {
  try {
    fs.rmSync(path.join(DATA_DIR, 'session.json'), { force: true });
  } catch (e) {
    console.warn(`[etag-relay] 舊 session.json 刪除失敗(不影響啟動):${(e && e.code) || (e && e.message)}`);
  }
}

if (require.main === module) {
  removeLegacySessionFile();
  server.listen(PORT, () => {
    console.log(`[etag-relay] listening on :${PORT}`);
    // 店內 IP 心跳(0.6.0):每 5 分鐘 POST Vercel 一次,讓打卡 Wi-Fi 判定知道目前店內
    // 對外 IP。零新密鑰:沿用既有 VERCEL_CAPTCHA_URL(取 origin)與 VERCEL_CALLBACK_SECRET。
    // 未設定時 sendSiteIpHeartbeat 內部回 not-configured,不影響其餘功能。
    siteIpHeartbeat = startSiteIpHeartbeat(options);
  });
}

module.exports = { server, options };
