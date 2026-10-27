// ── test-cf.js(0.7.1)────────────────────────────────────────────────────
// 遠通 Cloudflare 挑戰頁分辨驗證。零網路:stub globalThis.fetch,只攔 fetc.net.tw,
// 其他 URL 一律 throw(證明沒打外網)。fixture 全為合成 HTML,零真實資料。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SECRET = 'test-secret-not-real';
process.env.RELAY_SECRET = SECRET;

const devdata = path.join(__dirname, '.devdata');
const devdataExisted = fs.existsSync(devdata);

const fetcClient = require('./lib/fetc-client');
const { isCfChallenge, getAntiForgeryToken, startKeepAlive, CookieJar } = fetcClient;

const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body>challenge</body></html>';
const MEMBER_HTML = '<html><body><form><input name="__RequestVerificationToken" value="t"></form></body></html>';
const LOGIN_HTML = '<html><body><input name="smartAccount"><input name="smartPassword"></body></html>';
const PLAIN_HTML = '<html><body>nothing here</body></html>';

const realFetch = globalThis.fetch;
let scenario = 'challenge'; // 'challenge' | 'no-token'
const fetchedUrls = [];

function stubFetch(url, init) {
  const u = String(url);
  if (!/fetc\.net\.tw/.test(u)) throw new Error('unexpected-external-fetch');
  fetchedUrls.push(u);
  if (scenario === 'challenge') {
    return Promise.resolve(new Response(CHALLENGE_HTML, { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }));
  }
  if (scenario === 'member') return Promise.resolve(new Response(MEMBER_HTML, { status: 200 }));
  if (scenario === 'login') return Promise.resolve(new Response(LOGIN_HTML, { status: 200 }));
  return Promise.resolve(new Response(PLAIN_HTML, { status: 200 }));
}

function h(map) { return new Headers(map || {}); }

function testIsCfChallenge() {
  assert.strictEqual(isCfChallenge(403, h({ 'cf-mitigated': 'challenge' }), ''), true);
  assert.strictEqual(isCfChallenge(403, h(), CHALLENGE_HTML), true);
  assert.strictEqual(isCfChallenge(503, h({ 'cf-mitigated': 'Challenge' }), ''), true);
  assert.strictEqual(isCfChallenge(200, h(), CHALLENGE_HTML), false);
  assert.strictEqual(isCfChallenge(403, h(), PLAIN_HTML), false);
  assert.strictEqual(isCfChallenge(200, h(), MEMBER_HTML), false);
  console.log('[test-cf] ①isCfChallenge 六種組合 PASS');
}

async function testGetAntiForgeryToken() {
  globalThis.fetch = stubFetch;
  const jar = new CookieJar({ ASPSESSION: 'secret-cookie-value-xyz' });

  scenario = 'challenge';
  let err = null;
  try { await getAntiForgeryToken(jar); } catch (e) { err = e; }
  assert.ok(err, '挑戰頁應 reject');
  assert.strictEqual(err.code, 'CF_CHALLENGE');
  assert.ok(!/secret-cookie-value-xyz/.test(err.message), 'message 不得含 cookie 值');
  assert.ok(!/Just a moment/.test(err.message), 'message 不得含 body 原文');

  scenario = 'member';
  assert.strictEqual(await getAntiForgeryToken(jar), 't');

  scenario = 'login';
  assert.strictEqual(await getAntiForgeryToken(jar), null);
  console.log('[test-cf] ②getAntiForgeryToken 挑戰頁 reject／會員頁 token／登入頁 null PASS');
}

async function testKeepAlive() {
  globalThis.fetch = stubFetch;
  scenario = 'challenge';
  // startKeepAlive 的 timer 是 unref 的,測試要自己持有一個 ref timer 才不會提前結束
  const hold = setTimeout(() => {}, 5000);
  const got = await new Promise((resolve) => {
    const timer = startKeepAlive({
      getJar: () => new CookieJar({}),
      intervalMs: 20,
      onExpired: (e) => { clearInterval(timer); resolve(e); },
      onAlive: () => { clearInterval(timer); resolve('alive'); },
    });
  });
  clearTimeout(hold);
  assert.ok(got && got.code === 'CF_CHALLENGE', 'onExpired 應收到 CF_CHALLENGE 例外');
  console.log('[test-cf] ③startKeepAlive 遇挑戰頁 onExpired 收到 CF_CHALLENGE PASS');
}

function request(port, method, urlPath, { secret = SECRET, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (secret) headers['X-Relay-Secret'] = secret;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function testServerRoutes() {
  globalThis.fetch = stubFetch;
  const { server } = require('./server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    const cookies = { a: 'b' };
    const qBody = { plate: 'TEST-0001', startDate: '2026/01/01', endDate: '2026/01/02' };
    const pBody = { ...qBody, times: ['2026/01/01 10:00:00'] };

    // 挑戰頁情境
    scenario = 'challenge';
    let r = await request(port, 'POST', '/session', { body: { cookies } });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.json, { ok: false, reason: 'cf-challenge' });
    r = await request(port, 'GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.sessionValid, false);
    assert.strictEqual(r.json.sessionReason, 'cf-challenge');
    r = await request(port, 'POST', '/query', { body: qBody });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: false, reason: 'cf-challenge' });
    r = await request(port, 'POST', '/print', { body: pBody });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: false, reason: 'cf-challenge' });

    // 無 token 的 200 頁情境(舊行為不變)
    scenario = 'plain';
    r = await request(port, 'POST', '/session', { body: { cookies } });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.json, { ok: false, reason: 'session-invalid' });
    r = await request(port, 'GET', '/health');
    assert.strictEqual(r.json.sessionValid, false);
    assert.strictEqual(r.json.sessionReason, 'session-invalid');

    // requireSecret 未受影響
    r = await request(port, 'GET', '/health', { secret: null });
    assert.strictEqual(r.status, 401);
  } finally {
    console.log = origLog; console.warn = origWarn; console.error = origErr;
    await new Promise((r) => server.close(r));
  }
  assert.ok(fetchedUrls.length > 0);
  console.log('[test-cf] ④server 路由 /session /health /query /print 分辨 cf-challenge／session-invalid／401 PASS');
}

async function main() {
  try {
    testIsCfChallenge();
    await testGetAntiForgeryToken();
    await testKeepAlive();
    await testServerRoutes();
    console.log('[test-cf] ALL PASS');
  } finally {
    globalThis.fetch = realFetch;
    if (!devdataExisted && fs.existsSync(devdata)) fs.rmSync(devdata, { recursive: true, force: true });
  }
}

let completed = false;
process.on('exit', (code) => {
  if (code === 0 && !completed) { console.error('[test-cf] FAIL 事件迴圈提前結束,測試未跑完'); process.exitCode = 1; }
});
main().then(() => { completed = true; process.exit(0); }).catch((e) => {
  console.error('[test-cf] FAIL', e);
  process.exit(1);
});
