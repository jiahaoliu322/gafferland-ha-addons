'use strict';
// 測試共用:linkedom 的 parseHtml、relay 路徑、fixture 讀取、stub 遠通站台。
// 全部合成資料(零真實車牌／帳號)。
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('linkedom');

const BRIDGE_DIR = path.join(__dirname, '..', '..');
const RELAY_DIR = path.join(BRIDGE_DIR, '..', 'etag-relay');
const FIXTURE_DIR = path.join(RELAY_DIR, 'fixtures');
const GOLDEN_DIR = path.join(__dirname, '..', 'golden');

function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

const BASE = 'https://www.fetc.net.tw';
const TEST_PLATE = 'TEST-001';
const TEST_CIN = 'CIN-SYNTH-001';
const TEST_TOKEN = 'tok-synth-abc';

const MEMBER_HTML =
  '<html><body><div class="swiper-slide" data-cin="' + TEST_CIN + '" data-cln="' + TEST_PLATE + '"></div>' +
  '<div class="swiper-slide" data-cin="CIN-SYNTH-002" data-plate="TEST-002"></div></body></html>';
const SETTING_HTML =
  '<html><body><form><input type="hidden" name="__RequestVerificationToken" value="' + TEST_TOKEN + '"></form></body></html>';
const LOGIN_HTML =
  '<html><body><input id="smartAccount"><input id="smartPassword"></body></html>';
const CF_HTML = '<html><head><title>Just a moment...</title></head><body></body></html>';
// 帶 script／pre／head href／head src／body 單斜線 src／body 雙斜線 src／中文的合成列印頁,
// 用來鎖 buildPdfContentFromPrintHtml 的每條取代規則
const RICH_PRINT_HTML =
  '<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>合成列印頁</title>' +
  '<link rel="stylesheet" href="/Content/print.css"><script src="/Scripts/a.js"></script>' +
  '<script>var x = "不該留下";</script></head>' +
  '<body class="p"><div class="logo"><img src="/Content/images/logo.png"><img src="//cdn.example.test/x.png">' +
  '<img src="https://other.example.test/y.png"></div><pre>debug 不該留下</pre>' +
  '<table id="tblFeeList"><tr class="detail-row"><td>04:01:47</td><td>五股-高公局</td><td>1.4</td><td>1.6元</td></tr>' +
  '<tr><td class="date total">總計</td><td></td><td>1.4</td><td>1.6元</td></tr></table>' +
  '<SCRIPT>alert("大寫也要移除")</SCRIPT></body></html>';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%synthetic\n');

// 預設站台;overrides 以路徑尾段覆寫:{ member, setting, search, detail, print, pdf }
// 每個 override 可為字串／{status,body,url,headers}／function(req)
function makeSite(overrides = {}) {
  return async function site(req) {
    const p = req.u.pathname;
    let key;
    if (p === '/Member') key = 'member';
    else if (p === '/Member/Setting') key = 'setting';
    else if (p.endsWith('UX050506TrafficAdvancedSearch')) key = 'search';
    else if (p.endsWith('UX050507AdvancedSearchDetail')) key = 'detail';
    else if (p.endsWith('UX050508TrafficAdvancedSearchPrint')) key = 'print';
    else if (p.endsWith('UX000006GetPDF')) key = 'pdf';
    else return { status: 404, body: 'not found' };
    let o = overrides[key];
    if (typeof o === 'function') o = await o(req);
    if (o !== undefined) return typeof o === 'string' ? { body: o } : o;
    switch (key) {
      case 'member': return { body: MEMBER_HTML };
      case 'setting': return { body: SETTING_HTML };
      case 'search': return { body: fixture('search.html') };
      case 'detail': return { body: fixture('detail.html') };
      case 'print': return { body: fixture('print.html') };
      case 'pdf': return { body: PDF_BYTES, headers: { 'content-type': 'application/pdf' } };
    }
  };
}

// 包成 fetch;log 收原始請求(含 UA/Cookie/Referer 等,供比對與守門)
function makeStubFetch(site, log) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    log.push({ method: init.method || 'GET', url, pathQuery: u.pathname + u.search, body: init.body, headers, credentials: init.credentials, redirect: init.redirect });
    const r = await site({ method: init.method || 'GET', u, body: init.body, headers });
    const resp = new Response(r.body, { status: r.status || 200, headers: r.headers || {} });
    Object.defineProperty(resp, 'url', { value: r.url || url });
    return resp;
  };
}

// 正規化:扣掉瀏覽器自帶的 UA/Cookie/Referer、r= 時間鹽;body 轉成有序鍵值對
function normalize(entry) {
  const headers = {};
  for (const [k, v] of Object.entries(entry.headers)) {
    if (k === 'user-agent' || k === 'cookie' || k === 'referer') continue;
    headers[k] = v;
  }
  return {
    method: entry.method,
    path: entry.pathQuery.replace(/r=\d+/, 'r=N'),
    headers,
    body: entry.body == null ? null : Array.from(new URLSearchParams(entry.body).entries()),
  };
}

module.exports = {
  BASE, TEST_PLATE, TEST_CIN, TEST_TOKEN, MEMBER_HTML, SETTING_HTML, LOGIN_HTML, CF_HTML, PDF_BYTES, RICH_PRINT_HTML,
  RELAY_DIR, FIXTURE_DIR, GOLDEN_DIR, parseHtml, fixture, makeSite, makeStubFetch, normalize,
};
