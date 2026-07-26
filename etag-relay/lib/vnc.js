// ── noVNC 遠端畫面(Round F 真人遠端登入)─────────────────────────────────
// 用途:reCAPTCHA v3 擋死自動登入(4 碼驗證碼本身早就過得了),改由老闆本人透過瀏覽器
// 看中繼容器裡那顆 Chrome 的畫面、親手完成遠通登入——真人操作 v3 才給分。
//
// 為什麼不用 apt 的 novnc/websockify(0.2.x 走過的路):那兩個套件讓 HA 上的 docker build
// 反覆失敗,而 HA 不吐 build 輸出、無從診斷。這裡改成:
//   ①noVNC 走 npm 的 @novnc/novnc(**只有 core/ 函式庫,沒有現成 vnc.html**)
//   ②登入頁自己寫(下方 PAGE_HTML,順便做成手機友善:自動連線＋自動縮放)
//   ③WebSocket→VNC(x11vnc :5900)轉發用 Node 的 ws 自己接,不需要 python/websockify
// 好處是 Dockerfile 只多裝一個 x11vnc,幾乎等同能正常 build 的 0.1.6。
//
// 安全:本服務只綁 8098,對外一律走 Cloudflare Tunnel＋Access(email OTP 限老闆本人);
// x11vnc 另有 VNC 密碼(-rfbauth)＝第二道。VNC 密碼由使用者在瀏覽器輸入,**中繼不持有、
// 不記錄、不回傳**(run.sh 建密碼檔時也不入 log)。
'use strict';

const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');

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

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// 極簡 VNC 頁面。noVNC 的 lib/rfb.js 是 ES module,瀏覽器可直接 import——
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
  gap:16px;padding:24px;background:#0a0a0a;z-index:10;text-align:center}
.gate h1{font-size:17px;font-weight:500;margin:0;letter-spacing:.5px}
.gate p{font-size:13px;color:rgba(245,240,232,.5);margin:0;line-height:1.7;max-width:320px}
.gate input{width:min(280px,80vw);padding:12px 14px;font-size:16px;border-radius:8px;
  border:1px solid rgba(255,255,255,.18);background:#1a1a1a;color:#f5f0e8}
.gate button{padding:12px 28px;font-size:15px;border:none;border-radius:8px;
  background:#c9a96e;color:#0a0a0a;font-weight:500}
.msg{font-size:13px;color:#c9a96e;min-height:18px}
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
  <h1>eTag 遠端登入</h1>
  <p>連上中繼主機的瀏覽器畫面,完成遠通登入(帳號密碼已預先填好,通常只需輸入畫面上的 4 碼驗證碼)。</p>
  <input type="password" id="pw" placeholder="VNC 密碼" autocomplete="current-password">
  <button id="go">連線</button>
  <div class="msg" id="msg"></div>
</div>
<input id="kb" style="position:fixed;opacity:0;pointer-events:none;top:-100px" autocapitalize="off" autocorrect="off">
<script type="module">
import RFB from './novnc/${rfbEntry}';

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
let rfb = null;

function connect(password) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  msg('連線中…');
  try {
    rfb = new RFB($('screen'), proto + '://' + location.host + '/websockify',
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
  rfb.addEventListener('disconnect', (e) => {
    $('gate').classList.remove('hide');
    $('bar').classList.add('hide');
    msg(e.detail && e.detail.clean ? '連線已結束' : '連線中斷,請重試');
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

// 啟動 noVNC 網頁 + WebSocket→x11vnc 轉發。vncEnabled=false(未設 VNC_PASSWORD)則不啟動,
// 讓「沒設密碼＝完全不對外開」這件事在程式層也成立(run.sh 那邊也不會起 x11vnc)。
function startVncServer({ enabled }) {
  if (!enabled) {
    console.warn('[etag-relay] VNC_PASSWORD 未設定,不啟動 noVNC 網頁服務');
    return null;
  }

  const rfbEntry = detectRfbEntry();
  if (!rfbEntry) {
    // 沒有 @novnc/novnc(依賴沒裝成)就別假裝服務存在——寧可明確報錯,也不要讓老闆
    // 點開連結看到空白頁卻不知道為什麼。
    console.error('[etag-relay] 找不到 @novnc/novnc 的 rfb.js,noVNC 網頁服務不啟動');
    return null;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${VNC_HTTP_PORT}`);
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/vnc.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(pageHtml(rfbEntry));
    }
    if (url.pathname.startsWith('/novnc/')) {
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = net.connect(VNC_TCP_PORT, '127.0.0.1');
      const closeBoth = () => {
        try { ws.close(); } catch (e) { /* 已關 */ }
        try { tcp.destroy(); } catch (e) { /* 已關 */ }
      };
      tcp.on('connect', () => console.log('[etag-relay] noVNC 用戶端已接上 x11vnc'));
      tcp.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
      tcp.on('error', (e) => { console.warn('[etag-relay] VNC TCP 錯誤:', e.message); closeBoth(); });
      tcp.on('close', closeBoth);
      ws.on('message', (d) => tcp.write(d));
      ws.on('error', () => closeBoth());
      ws.on('close', closeBoth);
    });
  });

  server.listen(VNC_HTTP_PORT, () => {
    console.log(`[etag-relay] noVNC 網頁服務 on :${VNC_HTTP_PORT}(/websockify → 127.0.0.1:${VNC_TCP_PORT})`);
  });
  return server;
}

module.exports = { startVncServer, VNC_HTTP_PORT };
