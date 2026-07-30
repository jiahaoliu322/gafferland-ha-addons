// ── noVNC 遠端畫面(Round F 真人遠端登入)─────────────────────────────────
// 用途:reCAPTCHA v3 擋死自動登入,改由老闆本人透過瀏覽器看中繼容器裡那顆 Chrome 的畫面、
// 親手完成遠通登入——真人操作 v3 才給分(Round G1 起這是唯一登入路徑,見 lib/login.js)。
//
// 為什麼不用 apt 的 novnc/websockify(0.2.x 走過的路):那兩個套件讓 HA 上的 docker build
// 反覆失敗,而 HA 不吐 build 輸出、無從診斷。這裡改成:
//   ①noVNC 走 npm 的 @novnc/novnc(**只有 core/ 函式庫,沒有現成 vnc.html**)
//   ②登入頁自己寫(下方 PAGE_HTML,順便做成手機友善:自動連線＋自動縮放)
//   ③WebSocket→VNC(x11vnc :5900)轉發用 Node 的 ws 自己接,不需要 python/websockify
// 好處是 Dockerfile 只多裝一個 x11vnc,幾乎等同能正常 build 的 0.1.6。
//
// 安全(Round G1 改版):noVNC 入口(8098)拿掉 Cloudflare Access——改成兩層:①連結本身
// 內建長亂數 token(loadVncToken 產生,見下,不對就連頁面都進不去);②x11vnc 的 VNC 密碼
// (-rfbauth),由使用者在瀏覽器輸入,**中繼不持有、不記錄、不回傳**(run.sh 建密碼檔時
// 也不入 log)。之所以拿掉 Access:唯一登入路徑就是要老闆本人點連結進來操作,Access 的
// email OTP 反而多一道與「登入遠通」本身無關的門;token 放進連結裡,體驗上等同一次性
// 邀請連結。
'use strict';

const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const VNC_HTTP_PORT = 8098;   // Cloudflare Tunnel 指向這個埠(etag-vnc.gafferland.net)
const VNC_TCP_PORT = 5900;    // run.sh 起的 x11vnc(-localhost,只收容器內連線)
// ⚠ 掛的是**整個套件根目錄**而非 core/:rfb.js 會 import `../vendor/pako/…`,
// 只掛 core/ 那些相對路徑會解不開。入口檔名各版不同(1.5 是 core/rfb.js,舊版 lib/rfb.js),
// 啟動時偵測一次,再寫進頁面的 import 路徑,不要寫死。
const NOVNC_ROOT = path.join(__dirname, '..', 'node_modules', '@novnc', 'novnc');

function detectRfbEntry() {
  for (const rel of ['core/rfb.js', 'lib/rfb.js']) {
    if (fs.existsSync(path.join(NOVNC_ROOT, rel))) return rel;
  }
  return null;
}

// 讀寫 noVNC 入口的長亂數 token。沒有 Cloudflare Access 之後,這是擋「隨便掃到 8098
// 硬闖」的第一道門——沒有這個 token,連頁面都進不去(見下方驗 key 邏輯),VNC 密碼是第二層。
// token 落地 dataDir(HA add-on 的 /data,持久卷),跨重啟/重建容器維持不變(不然每次都要
// 重新發連結給老闆)。讀寫失敗(如卷不可寫)一律回 null,呼叫端(startVncServer)必須
// fail-closed——寧可不開 noVNC,也不要開一個沒有 token 保護的入口。
function loadVncToken(dataDir) {
  const tokenPath = path.join(dataDir, 'vnc-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (e) { /* 檔案不存在(首次啟動)或讀取失敗,往下產生新的 */ }
  try {
    const token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
  } catch (e) {
    console.error('[etag-relay] VNC token 讀寫失敗,noVNC 入口將不啟動:', e && e.message);
    return null;
  }
}

// timing-safe 比對 URL 上的 key 與 token(呼應 server.js safeEqual 同一鐵則:即使多一層
// VNC 密碼,key 本身的比對也不該用 === 留時序側漏洞)。長度不同直接回 false。
function safeEqualKey(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// 極簡登入頁。0.3.5 使用者裁示改版:**驗證碼直接顯示在這頁、頁面輸碼=主要路徑**
// (由中繼瀏覽器代填代送——先前被 v3 擋時跑的是 bundled chromium,0.3.4 起有真 Chrome+
// 持久 profile,實測看能不能過);noVNC 遠端畫面收進「進階」摺疊區當同頁備援(v3 連代送
// 都擋時,真人親手操作必過)。noVNC 的 rfb.js 是 ES module,瀏覽器可直接 import——
// 底下把整個套件根目錄掛在 /novnc/ 之下,相對 import(./util/logging.js、../vendor/pako 等)才解得開。
const pageHtml = (rfbEntry) => `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>eTag 遠端登入</title>
<style>
html,body{margin:0;height:100%;background:#0a0a0a;color:#f5f0e8;
  font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif;overscroll-behavior:none}
#screen{width:100vw;height:100vh}
#screen canvas{display:block}
.gate{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;padding:24px;background:#0a0a0a;z-index:10;text-align:center;overflow-y:auto}
.gate h1{font-size:17px;font-weight:500;margin:0;letter-spacing:.5px}
.gate p{font-size:13px;color:rgba(245,240,232,.5);margin:0;line-height:1.7;max-width:320px}
.gate input{width:min(280px,80vw);padding:12px 14px;font-size:16px;border-radius:8px;
  border:1px solid rgba(255,255,255,.18);background:#1a1a1a;color:#f5f0e8;text-align:center}
.gate button{padding:12px 28px;font-size:15px;border:none;border-radius:8px;
  background:#c9a96e;color:#0a0a0a;font-weight:500}
.gate button.sub{background:transparent;border:1px solid rgba(255,255,255,.18);color:rgba(245,240,232,.7);
  font-size:13px;padding:8px 16px}
.msg{font-size:13px;color:#c9a96e;min-height:18px;max-width:320px;line-height:1.6}
#capImg{width:min(280px,80vw);min-height:64px;border-radius:8px;background:#fff}
#code{font-size:20px;letter-spacing:6px;text-align:center}
.hint{font-size:12px;line-height:1.5;color:#9a9a9a;max-width:320px;text-align:center}
details{max-width:min(320px,84vw)}
details summary{font-size:13px;color:rgba(245,240,232,.45);cursor:pointer;padding:6px 0}
details > div{display:flex;flex-direction:column;gap:12px;align-items:center;padding-top:10px}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;justify-content:center;
  padding:8px calc(env(safe-area-inset-right) + 8px) calc(env(safe-area-inset-bottom) + 8px)
        calc(env(safe-area-inset-left) + 8px);
  background:rgba(10,10,10,.82);z-index:5}
.bar button{padding:8px 16px;font-size:13px;border:1px solid rgba(255,255,255,.18);
  border-radius:6px;background:transparent;color:rgba(245,240,232,.7)}
.hide{display:none!important}
</style></head><body>
<div id="screen"></div>
<div class="bar hide" id="bar">
  <button id="btnFit">切換縮放</button>
  <button id="btnKb">鍵盤</button>
</div>
<div class="gate" id="gate">
  <div id="cardLoad">
    <h1>遠通電收登入</h1>
    <p>檢查登入狀態…</p>
  </div>
  <div id="cardStart" class="hide" style="display:flex;flex-direction:column;gap:16px;align-items:center">
    <h1>遠通電收登入</h1>
    <p>目前沒有進行中的登入流程。按下方按鈕啟動(約需 10 秒開啟瀏覽器)。</p>
    <button id="btnStart">開始登入</button>
    <div class="msg" id="smsg"></div>
  </div>
  <div id="cardCode" class="hide" style="display:flex;flex-direction:column;gap:14px;align-items:center">
    <h1>遠通電收登入</h1>
    <p>帳號密碼已填好,輸入下圖 4 碼驗證碼即可完成登入。</p>
    <img id="capImg" alt="驗證碼">
    <input id="code" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="4 碼驗證碼" autocomplete="one-time-code" autofocus>
    <button id="btnSend">送出登入</button>
    <button id="btnNewCap" class="sub">換一張</button>
    <div class="hint">驗證碼有效時間很短,請在 1 分鐘內送出;圖看起來不像驗證碼就按「換一張」。</div>
    <div class="msg" id="cmsg"></div>
    <details id="advBox">
      <summary>進階:遠端畫面登入(上面送出被擋時用)</summary>
      <div>
        <p>連上中繼主機的瀏覽器畫面,親手輸碼、按登入——真人操作不會被 Google 驗證擋。</p>
        <input type="password" id="pw" placeholder="VNC 密碼" autocomplete="current-password">
        <button id="go">連線</button>
        <button id="btnSendKeys" class="sub">把上面的 4 碼打進遠端瀏覽器</button>
        <div class="hint">手機鍵盤在遠端畫面常打不出數字:先在遠端畫面點一下遠通的驗證碼欄位,再按這個鈕把上面輸入框的 4 碼送進去,然後親手按遠端的「登入」。</div>
        <div class="msg" id="msg"></div>
      </div>
    </details>
  </div>
  <div id="cardDone" class="hide" style="display:flex;flex-direction:column;gap:16px;align-items:center">
    <h1>✅ 登入完成</h1>
    <p>遠通 session 已更新,這個頁面可以關閉了。</p>
  </div>
</div>
<input id="kb" style="position:fixed;opacity:0;pointer-events:none;top:-100px" autocapitalize="off" autocorrect="off">
<script type="module">
import RFB from './novnc/${rfbEntry}';

// URL 內建的長亂數 token——連進這個頁面本身就是靠這個 key(見 lib/vnc.js 驗 key 邏輯),
// 所有 API 請求與 /websockify 連線都要重新帶上(每個都是獨立的 HTTP 請求,各自驗)。
const KEY = new URLSearchParams(location.search).get('key') || '';
const withKey = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY);

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
const cmsg = (t) => { $('cmsg').textContent = t || ''; };
const showCard = (id) => {
  for (const c of ['cardLoad', 'cardStart', 'cardCode', 'cardDone']) $(c).classList.toggle('hide', c !== id);
};

// ── 主要路徑:驗證碼顯示在頁面上、頁面輸碼 ─────────────────────────────
async function loadCaptcha(refresh) {
  const r = await fetch(withKey('/captcha.png' + (refresh ? '?refresh=1' : '')), { cache: 'no-store' });
  if (r.status !== 200) return false;
  $('capImg').src = URL.createObjectURL(await r.blob());
  return true;
}

// 0.4.0:先問 /state。有流程但已放太久(>180 秒)= 驗證碼與 Google 驗證情境都過期,送出必被
// 擋——直接自動重啟一個新流程,不讓使用者對著舊頁面白費工(2026-07-30 使用者實測的主症狀)。
const STALE_SEC = 180;
async function startFlow(force) {
  showCard('cardStart');
  $('smsg').textContent = force ? '重新啟動登入流程中…' : '啟動瀏覽器中…';
  $('btnStart').disabled = true;
  try { await fetch(withKey('/trigger' + (force ? '?force=1' : '')), { method: 'POST' }); } catch (e) {}
  // 輪詢等瀏覽器開好、驗證碼圖就緒(冷啟 ~10 秒,最多等 2 分鐘)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      if (await loadCaptcha(false)) { showCard('cardCode'); $('code').focus(); $('btnStart').disabled = false; return true; }
    } catch (e) { /* 續等 */ }
  }
  $('smsg').textContent = '啟動逾時,請重新整理頁面再試';
  $('btnStart').disabled = false;
  return false;
}

async function init() {
  let st = null;
  try { st = await (await fetch(withKey('/state'), { cache: 'no-store' })).json(); } catch (e) {}
  if (st && st.inFlight && typeof st.ageSec === 'number' && st.ageSec > STALE_SEC) {
    return void startFlow(true);   // 舊流程過期 → 換全新的
  }
  try {
    if (await loadCaptcha(false)) { showCard('cardCode'); $('code').focus(); return; }
  } catch (e) { /* 網路失敗當作無流程 */ }
  showCard('cardStart');
}
init();

$('btnStart').addEventListener('click', () => { startFlow(false); });

$('btnNewCap').addEventListener('click', async () => {
  cmsg('更新驗證碼…');
  cmsg((await loadCaptcha(true)) ? '' : '更新失敗,流程可能已結束,請重新整理頁面');
});

$('btnSend').addEventListener('click', async () => {
  const code = $('code').value.trim();
  if (!/^\\d{4}$/.test(code)) return cmsg('請輸入 4 碼數字');
  $('btnSend').disabled = true;
  cmsg('送出中(Google 驗證+遠通回應約需數秒)…');
  let r = null;
  try {
    r = await (await fetch(withKey('/code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json();
  } catch (e) {
    r = { ok: false, reason: 'network' };
  }
  $('btnSend').disabled = false;
  if (r.ok) return showCard('cardDone');
  const reasonText = {
    'fetc-rejected': '遠通拒絕:' + (r.message || '登入失敗') + '——若持續發生,代表仍被 Google 驗證擋,請改用下方「遠端畫面登入」親手操作。',
    'too-many-attempts': '已嘗試 3 次,為避免帳號被鎖請改用下方「遠端畫面登入」。',
    'bad-code': '請輸入 4 碼數字',
    'no-login-in-flight': '登入流程已結束,請重新整理頁面',
    'flow-ended': '登入流程已結束,請重新整理頁面',
    'timeout': '等不到遠通回應,請按「換一張」再試,或改用下方遠端畫面登入',
    'submit-error': '送出失敗,請再試一次',
    'network': '連線失敗,請再試一次',
  }[r.reason] || '登入失敗(' + (r.reason || '未知') + ')';
  cmsg(reasonText);
  if (r.reason === 'too-many-attempts') $('advBox').open = true;
  $('code').value = '';
  // 0.4.0:被遠通拒/逾時 → 不在同一個(可能已被 v3 記點、或驗證碼已過期的)頁面上重試,
  // 直接換一個全新流程與全新驗證碼;達 3 次上限則不再自動重啟,引導走遠端畫面。
  if (r.reason === 'fetc-rejected' || r.reason === 'timeout') {
    cmsg(reasonText + ' 正在換一組全新驗證碼…');
    startFlow(true);
  }
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSend').click(); });
// 輸滿 4 碼就把焦點移到送出鈕(手機收起鍵盤、一按即送)
$('code').addEventListener('input', () => { if (/^\d{4}$/.test($('code').value.trim())) $('btnSend').focus(); });

// ── 備援:noVNC 遠端畫面(真人親手操作)────────────────────────────────
let rfb = null;

// 0.4.0:把上面輸入框的 4 碼「打」進遠端瀏覽器——手機 IME 透過 VNC 常常送不出數字
// (2026-07-30 使用者實測),改由 noVNC 直接合成按鍵事件(keysym 0x30+digit)。
// 使用者先在遠端畫面點一下遠通的驗證碼欄位(讓遠端焦點在該欄),再按此鈕,最後**親手**
// 按遠端的「登入」——真人點擊是這條備援路線的價值所在,不代按。
function wireSendKeys() {
  const btn = document.getElementById('btnSendKeys');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const code = $('code').value.trim();
    if (!/^\d{4}$/.test(code)) return msg('請先在上面的輸入框填 4 碼數字');
    if (!rfb) return msg('請先按「連線」連上遠端畫面');
    try {
      for (const ch of code) {
        const keysym = 0x30 + Number(ch);   // '0'..'9'
        rfb.sendKey(keysym, 'Digit' + ch, true);
        rfb.sendKey(keysym, 'Digit' + ch, false);
      }
      msg('已把 ' + code.length + ' 碼送進遠端畫面,請確認欄位內容後親手按遠端的「登入」');
    } catch (e) {
      msg('送鍵失敗:' + e.message);
    }
  });
}
wireSendKeys();
// securityfailure 訊息(VNC 密碼錯誤/連線被拒)比緊接著觸發的 disconnect 更有診斷價值,
// 不該被 disconnect 的通用訊息蓋掉——用這個旗標記「這輪已經顯示過原因了」,下次按連線
// 重新嘗試時重置。
let lastFailureMsg = false;

function connect(password) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  msg('連線中…');
  lastFailureMsg = false; // 新一輪嘗試,重置旗標
  try {
    rfb = new RFB($('screen'), proto + '://' + location.host + '/websockify?key=' + encodeURIComponent(KEY),
      { credentials: { password: password } });
  } catch (e) {
    msg('連線失敗:' + e.message);
    return;
  }
  // 手機友善:整個桌面縮放進畫面(不改遠端解析度,免得動到自動化用的視窗尺寸)
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.addEventListener('connect', () => {
    $('gate').classList.add('hide');
    $('bar').classList.remove('hide');
  });
  // 診斷:VNC 密碼錯誤或(理論上)key 被拒絕時 noVNC 會先發這個,再發 disconnect——
  // 沒有這個 handler,老闆只會看到「連線中斷,請重試」,完全不知道是密碼打錯還是網路問題。
  rfb.addEventListener('securityfailure', (e) => {
    lastFailureMsg = true;
    msg('VNC 密碼錯誤/連線被拒:' + ((e.detail && e.detail.reason) || '未知原因'));
  });
  rfb.addEventListener('disconnect', (e) => {
    $('gate').classList.remove('hide');
    $('bar').classList.add('hide');
    if (!lastFailureMsg) {
      msg(e.detail && e.detail.clean ? '連線已結束' : '連線中斷,請重試');
    }
    rfb = null;
  });
  rfb.addEventListener('credentialsrequired', () => {
    $('gate').classList.remove('hide');
    msg('VNC 密碼錯誤');
  });
}

$('go').addEventListener('click', () => {
  const pw = $('pw').value;
  if (!pw) return msg('請輸入 VNC 密碼');
  connect(pw);
});
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });

// 縮放切換:縮到整頁 ↔ 原尺寸(手機上想看清小字時用)
$('btnFit').addEventListener('click', () => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  rfb.clipViewport = !rfb.scaleViewport;
});
// 手機沒有實體鍵盤:用隱藏 input 叫出系統鍵盤,輸入直接轉給遠端
$('btnKb').addEventListener('click', () => { $('kb').focus(); });
$('kb').addEventListener('input', (e) => {
  if (!rfb) return;
  for (const ch of e.target.value) rfb.sendKey(ch.charCodeAt(0), null, true);
  e.target.value = '';
});
$('kb').addEventListener('keydown', (e) => {
  if (!rfb) return;
  if (e.key === 'Backspace') { e.preventDefault(); rfb.sendKey(0xff08); }
  if (e.key === 'Enter') { e.preventDefault(); rfb.sendKey(0xff0d); }
});
</script></body></html>`;

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store', // 檔案量小,不值得為快取多一層失效問題
    });
    res.end(buf);
  });
}

// 啟動 noVNC 網頁 + WebSocket→x11vnc 轉發。
// enabled=false(未設 VNC_PASSWORD)則不啟動,讓「沒設密碼＝完全不對外開」這件事在程式層
// 也成立(run.sh 那邊也不會起 x11vnc)。
// token 由呼叫端(server.js)透過 loadVncToken() 產生後傳入——沒有 token 一律 fail-closed
// 不啟動,不論 enabled 是否為 true:沒有 Cloudflare Access 之後,token 是唯一擋外部硬闖
// 的門,寧可整個服務不開,也不要開一個誰都能連的 noVNC 入口。
// onClientConnect(選配):noVNC 用戶端通過 key 驗證、WS 建立時呼叫——server.js 掛
// lib/login.js 的 refreshCaptcha(),讓老闆連上當下看到的是張新鮮的驗證碼圖。
// captcha(選配,0.3.5 頁面輸碼主路徑):{ shot({refresh})→png Buffer|null,
// submit(code)→{ok,reason?,message?}, trigger()→啟動登入流程 }——server.js 接
// lib/login.js 的 captchaShot/submitCode 與自己的 triggerLogin('manual-request')。
function startVncServer({ enabled, token, onClientConnect, captcha }) {
  if (!enabled) {
    console.warn('[etag-relay] VNC_PASSWORD 未設定,不啟動 noVNC 網頁服務');
    return null;
  }
  if (!token) {
    console.error('[etag-relay] 缺 VNC token,noVNC 網頁服務不啟動(fail-closed)');
    return null;
  }

  const rfbEntry = detectRfbEntry();
  if (!rfbEntry) {
    // 沒有 @novnc/novnc(依賴沒裝成)就別假裝服務存在——寧可明確報錯,也不要讓老闆
    // 點開連結看到空白頁卻不知道為什麼。
    console.error('[etag-relay] 找不到 @novnc/novnc 的 rfb.js,noVNC 網頁服務不啟動');
    return null;
  }

  // 小型 JSON body 讀取(只給 /code 用,4KB 上限綽綽有餘)
  const readSmallBody = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) { resolve({}); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${VNC_HTTP_PORT}`);
    const keyOk = () => safeEqualKey(url.searchParams.get('key'), token);

    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/vnc.html') {
      if (!keyOk()) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(pageHtml(rfbEntry));
    }

    // ── 頁面輸碼三端點(0.3.5 主路徑;全部驗 key)────────────────────────
    // 目前的 4 碼驗證碼圖(?refresh=1 先換一張再截)。404=沒有進行中的登入流程,
    // 頁面據此顯示「開始登入」。
    // 進行中流程狀態(0.4.0):頁面用 ageSec 判斷該顯示現有驗證碼、還是自動重啟一個新流程。
    if (req.method === 'GET' && url.pathname === '/state') {
      if (!keyOk()) { res.writeHead(403); return res.end(); }
      const st = (captcha && captcha.state && captcha.state()) || { inFlight: false, ageSec: null };
      return sendJson(res, 200, st);
    }
    if (req.method === 'GET' && url.pathname === '/captcha.png') {
      if (!keyOk()) { res.writeHead(403); return res.end(); }
      if (!captcha || !captcha.shot) { res.writeHead(404); return res.end(); }
      Promise.resolve(captcha.shot({ refresh: url.searchParams.get('refresh') === '1' }))
        .then((buf) => {
          if (!buf) { res.writeHead(404); return res.end(); }
          // 0.4.0 診斷 header(無敏感資訊):抓圖命中哪個選擇器、實際尺寸、是否走截圖 fallback
          // ——使用者若再回報「圖不對」,開瀏覽器 devtools 看 response header 即可定位。
          const m = (captcha.meta && captcha.meta()) || null;
          res.writeHead(200, {
            'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
            'X-Cap-Src': m ? String(m.sel || '') : '', 'X-Cap-Size': m && m.w ? `${m.w}x${m.h}` : '',
            'X-Cap-Fallback': m && m.fallback ? '1' : '0',
          });
          res.end(buf);
        })
        .catch(() => { res.writeHead(500); res.end(); });
      return;
    }
    // 頁面輸碼送出(由中繼瀏覽器代填代送;成敗與原因見 lib/login.js submitCode)
    if (req.method === 'POST' && url.pathname === '/code') {
      if (!keyOk()) { res.writeHead(403); return res.end(); }
      if (!captcha || !captcha.submit) return sendJson(res, 200, { ok: false, reason: 'no-login-in-flight' });
      readSmallBody(req)
        .then((body) => Promise.resolve(captcha.submit(body && body.code)))
        .then((result) => sendJson(res, 200, result || { ok: false, reason: 'submit-error' }))
        .catch(() => sendJson(res, 200, { ok: false, reason: 'submit-error' }));
      return;
    }
    // 沒有進行中的流程時,讓老闆從這頁直接啟動登入(等同 /collect 的「重新登入遠通」,
    // 但不用先繞去 /collect)。fire-and-forget,頁面自己輪詢 /captcha.png 等瀏覽器就緒。
    if (req.method === 'POST' && url.pathname === '/trigger') {
      if (!keyOk()) { res.writeHead(403); return res.end(); }
      if (captcha && captcha.trigger) {
        // force=1(0.4.0):頁面偵測到現有流程已放太久(ageSec 過大)或上一次送出被遠通拒——
        // 中止舊流程、開一個全新頁面與全新 v3 情境重來,不讓使用者對著過期的驗證碼輸碼。
        const force = url.searchParams.get('force') === '1';
        try { captcha.trigger({ force }); } catch (e) { /* 觸發失敗頁面輪詢自然逾時,不需回錯 */ }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/novnc/')) {
      // 這裡**故意不驗 key**:掛的是 @novnc/novnc 套件本身的靜態檔(rfb.js 及其相依模組),
      // 純函式庫檔案零敏感資訊;而且 rfb.js 內部用相對路徑 import(如 `../vendor/pako/…`),
      // 瀏覽器發這些相對 import 請求時不會把父頁面 URL 的 query string 帶上,驗了只會讓
      // 套件載入到一半就被 403、頁面直接壞掉。安全性由上面的頁面 gate 與下面的 /websockify
      // 兩處驗 key 就足夠。
      // 路徑穿越防護:解析後必須仍在 NOVNC_ROOT 之下
      const rel = url.pathname.slice('/novnc/'.length);
      const target = path.resolve(NOVNC_ROOT, rel);
      if (!target.startsWith(NOVNC_ROOT + path.sep)) {
        res.writeHead(403);
        return res.end();
      }
      return sendFile(res, target);
    }
    res.writeHead(404);
    res.end();
  });

  // WebSocket 轉發:noVNC 預設連 /websockify,把 frame 內容原封不動接到 x11vnc 的 TCP。
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({
    noServer: true,
    // noVNC 舊版會要求 'binary' 子協定;沒帶子協定時 ws 根本不會呼叫這裡。
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${VNC_HTTP_PORT}`);
    if (url.pathname !== '/websockify') return socket.destroy();
    if (!safeEqualKey(url.searchParams.get('key'), token)) {
      console.warn('[etag-relay] noVNC 拒絕:key 不符');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 真人接上畫面的當下換一張新驗證碼(server.js 掛 refreshCaptcha)——觸發登入到
      // 老闆真的連上中間可能隔幾分鐘,舊圖可能已過期,連上時刷新保證看到的是有效的圖。
      if (onClientConnect) {
        try { Promise.resolve(onClientConnect()).catch(() => {}); } catch (e) { /* 不致命 */ }
      }
      const tcp = net.connect(VNC_TCP_PORT, '127.0.0.1');
      // 斷線診斷(使用者反饋「VNC 連線斷線無診斷」):記下是哪一端先斷、WS close code——
      // 之後排查「連線常斷」才有東西可看,不然只知道「斷了」卻不知道是 x11vnc 端斷的還是
      // 瀏覽器端斷的。用 closedReason 只認第一個先斷的一方:closeBoth() 會主動關另一端,
      // 若不擋,另一端的 close 事件接著觸發又會再印一行,兩行會互相矛盾(各說對方先斷)。
      let closedReason = null;
      const closeBoth = () => {
        try { ws.close(); } catch (e) { /* 已關 */ }
        try { tcp.destroy(); } catch (e) { /* 已關 */ }
      };
      tcp.on('connect', () => console.log('[etag-relay] noVNC 用戶端已接上 x11vnc'));
      tcp.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
      tcp.on('error', (e) => { console.warn('[etag-relay] VNC TCP 錯誤:', e.message); closeBoth(); });
      tcp.on('close', () => {
        if (!closedReason) {
          closedReason = 'x11vnc';
          console.log('[etag-relay] VNC 橋接關閉(x11vnc 端先斷)');
        }
        closeBoth();
      });
      ws.on('message', (d) => tcp.write(d));
      ws.on('error', () => closeBoth());
      ws.on('close', (code) => {
        if (!closedReason) {
          closedReason = 'browser';
          console.log(`[etag-relay] VNC 橋接關閉(瀏覽器端先斷,code=${code})`);
        }
        closeBoth();
      });
    });
  });

  server.listen(VNC_HTTP_PORT, () => {
    console.log(`[etag-relay] noVNC 網頁服務 on :${VNC_HTTP_PORT}(/websockify → 127.0.0.1:${VNC_TCP_PORT})`);
  });
  return server;
}

module.exports = { startVncServer, loadVncToken, VNC_HTTP_PORT };
