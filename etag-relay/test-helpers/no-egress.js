// ── test-helpers/no-egress.js(0.8.0,只給測試用;Dockerfile 不 COPY)──────────────
// 用法:node --require ./test-helpers/no-egress.js server.js
// 擋下所有「不是 127.0.0.1」的對外連線,讓測試永遠不可能真的打到 every8d、Vercel 或任何外站
// (b3 實作時曾因 /sms 守門被突變拿掉而對 api.e8d.tw 真的發出一次請求,這支就是為了不再重演)。
//
// 擋四層(任一層擋到都會先寫一行 `[no-egress] BLOCKED <目標>` 到 stderr,再丟錯):
//   1. globalThis.fetch:在呼叫原生 fetch 之前先看 URL 主機(連 DNS 都不查)。
//   2. http.request/get、https.request/get:同上,在建立連線前先看主機。
//   3. net.connect/createConnection、tls.connect:直接呼叫 socket 層的入口。
//   4. net.Socket.prototype.connect:所有 TCP/TLS 連線(含 undici 內部)最後都走這裡,兜底。
// 測試端(test-server.js)讀子行程 stderr,只要出現 BLOCKED 就判失敗(＝零攔截才算綠)。
// 只准 127.0.0.1(含 IPv4-mapped ::ffff:127.0.0.1);'localhost' 也擋——測試一律寫死 IP。
// Unix domain socket / named pipe(options.path)不經網路,放行。
'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const ALLOWED = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

function report(target) {
  try {
    fs.writeSync(2, `[no-egress] BLOCKED ${target}\n`);
  } catch (_) {
    /* stderr 關掉時仍要丟錯 */
  }
  const err = new Error(`no-egress: 禁止對外連線 ${target}`);
  err.code = 'NO_EGRESS';
  return err;
}

function stripBrackets(h) {
  const s = String(h);
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

function checkHost(host, port) {
  const h = stripBrackets(host == null || host === '' ? 'localhost' : host);
  if (!ALLOWED.has(h)) throw report(`${h}:${port == null ? '' : port}`);
}

// net/tls 參數正規化:(options[, cb]) | (port[, host][, cb]) | (path[, cb]) | 內部已正規化的陣列
function hostFromConnectArgs(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (a && typeof a === 'object') {
    if (a.path != null && a.port == null) return null; // IPC,不經網路
    return { host: a.host != null ? a.host : a.hostname, port: a.port };
  }
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: a };
  }
  if (typeof a === 'string') return null; // path 形式(IPC)
  return { host: 'localhost', port: undefined };
}

function guardConnectArgs(args) {
  const t = hostFromConnectArgs(args);
  if (t) checkHost(t.host, t.port);
}

// 4. 兜底:socket 層
const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  guardConnectArgs(args);
  return origSocketConnect.apply(this, args);
};

// 3. net/tls 入口
for (const [mod, name] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
  const orig = mod[name];
  mod[name] = function guardedConnect(...args) {
    guardConnectArgs(args);
    return orig.apply(this, args);
  };
}

// 2. http/https
function hostFromRequestArgs(args, defaultPort) {
  let u = args[0];
  let opts = null;
  if (typeof u === 'string' || u instanceof URL) {
    const url = new URL(String(u));
    opts = typeof args[1] === 'object' && args[1] ? args[1] : {};
    return {
      host: opts.hostname || opts.host || url.hostname,
      port: opts.port || url.port || defaultPort,
    };
  }
  opts = u || {};
  if (opts.socketPath) return null;
  const rawHost = opts.hostname || opts.host || 'localhost';
  return { host: String(rawHost).replace(/:\d+$/, ''), port: opts.port || defaultPort };
}

for (const [mod, port] of [[http, 80], [https, 443]]) {
  for (const name of ['request', 'get']) {
    const orig = mod[name];
    mod[name] = function guardedRequest(...args) {
      const t = hostFromRequestArgs(args, port);
      if (t) checkHost(t.host, t.port);
      return orig.apply(this, args);
    };
  }
}

// 1. fetch
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let href;
    try {
      href = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
      const url = new URL(href);
      checkHost(url.hostname, url.port);
    } catch (e) {
      return Promise.reject(e);
    }
    return origFetch.call(this, input, init);
  };
}
