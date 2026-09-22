// ── test-heartbeat.js(0.6.0)──────────────────────────────────────────────
// lib/siteip-heartbeat.js 驗證。零網路:stub fetchImpl、可注入 timer,不打任何真實
// 端點。涵蓋計劃 ①~⑦。
'use strict';

const assert = require('assert');
const {
  resolveHeartbeatUrl,
  sendSiteIpHeartbeat,
  startSiteIpHeartbeat,
} = require('./lib/siteip-heartbeat');

// stub log:記錄呼叫而不印到 stdout,並讓斷言能檢查訊息內容不含密鑰。
function makeStubLog() {
  const infoCalls = [];
  const warnCalls = [];
  return {
    infoCalls,
    warnCalls,
    info: (msg) => infoCalls.push(msg),
    warn: (msg) => warnCalls.push(msg),
  };
}

// 可注入的假 timer:不真的排程,呼叫端手動觸發 fireTimeout()/fireInterval() 模擬時間經過。
function makeFakeTimers() {
  let timeoutCb = null;
  let intervalCb = null;
  let timeoutDelay = null;
  let intervalDelay = null;
  let timeoutCleared = false;
  let intervalCleared = false;
  return {
    get timeoutDelay() { return timeoutDelay; },
    get intervalDelay() { return intervalDelay; },
    get timeoutCleared() { return timeoutCleared; },
    get intervalCleared() { return intervalCleared; },
    setTimeoutImpl: (cb, ms) => {
      timeoutCb = cb;
      timeoutDelay = ms;
      return { kind: 'fake-timeout' }; // 無 unref,驗證 startSiteIpHeartbeat 不因此炸掉
    },
    clearTimeoutImpl: () => { timeoutCleared = true; },
    setIntervalImpl: (cb, ms) => {
      intervalCb = cb;
      intervalDelay = ms;
      return { kind: 'fake-interval' };
    },
    clearIntervalImpl: () => { intervalCleared = true; },
    fireTimeout: async () => { assert.ok(timeoutCb, 'setTimeoutImpl 應已被呼叫'); await timeoutCb(); },
    fireInterval: async () => { assert.ok(intervalCb, 'setIntervalImpl 應已被呼叫'); await intervalCb(); },
  };
}

async function testResolveHeartbeatUrl() {
  // ① URL 推導:VERCEL_CAPTCHA_URL 帶路徑與 query 時只取 origin
  assert.strictEqual(
    resolveHeartbeatUrl({ VERCEL_CAPTCHA_URL: 'https://gafferland.com/api/collect?x=1' }),
    'https://gafferland.com/api/punch?action=site-ip',
    '應取 origin,不保留原路徑/query'
  );
  // VERCEL_CAPTCHA_URL 空 → 空字串
  assert.strictEqual(resolveHeartbeatUrl({ VERCEL_CAPTCHA_URL: '' }), '', '空 VERCEL_CAPTCHA_URL 應回空字串');
  assert.strictEqual(resolveHeartbeatUrl({}), '', '未帶任何選項應回空字串');
  // VERCEL_CAPTCHA_URL 不是合法 URL → 空字串
  assert.strictEqual(
    resolveHeartbeatUrl({ VERCEL_CAPTCHA_URL: 'not-a-url' }),
    '',
    '不合法 URL 應回空字串,不 throw'
  );

  // ② 覆寫選項優先
  assert.strictEqual(
    resolveHeartbeatUrl({
      PUNCH_SITEIP_URL: 'https://override.example/hook',
      VERCEL_CAPTCHA_URL: 'https://gafferland.com/api/collect',
    }),
    'https://override.example/hook',
    'PUNCH_SITEIP_URL 非空時應優先於 VERCEL_CAPTCHA_URL 推導'
  );

  console.log('[test-heartbeat] ①②URL 推導/覆寫優先 PASS');
}

async function testNotConfigured() {
  // ③ 未設定(URL 空 或 secret 空)→ 不呼叫 fetch
  let fetchCalled = false;
  const stubFetch = async () => { fetchCalled = true; };

  const r1 = await sendSiteIpHeartbeat(
    { VERCEL_CAPTCHA_URL: '', VERCEL_CALLBACK_SECRET: 'sekret' },
    { fetchImpl: stubFetch }
  );
  assert.deepStrictEqual(r1, { ok: false, reason: 'not-configured' });
  assert.strictEqual(fetchCalled, false, 'URL 為空不應呼叫 fetch');

  const r2 = await sendSiteIpHeartbeat(
    { VERCEL_CAPTCHA_URL: 'https://gafferland.com', VERCEL_CALLBACK_SECRET: '' },
    { fetchImpl: stubFetch }
  );
  assert.deepStrictEqual(r2, { ok: false, reason: 'not-configured' });
  assert.strictEqual(fetchCalled, false, 'secret 為空不應呼叫 fetch');

  console.log('[test-heartbeat] ③未設定不呼叫 fetch PASS');
}

async function testRequestShape() {
  // ④ 送出 body 含 secret 且 method POST、header JSON
  let capturedUrl = null;
  let capturedInit = null;
  const stubFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ ip: '203.0.113.9' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await sendSiteIpHeartbeat(
    { VERCEL_CAPTCHA_URL: 'https://gafferland.com', VERCEL_CALLBACK_SECRET: 'topsecret' },
    { fetchImpl: stubFetch }
  );

  assert.strictEqual(capturedUrl, 'https://gafferland.com/api/punch?action=site-ip');
  assert.strictEqual(capturedInit.method, 'POST');
  assert.strictEqual(capturedInit.headers['Content-Type'], 'application/json');
  const sentBody = JSON.parse(capturedInit.body);
  assert.strictEqual(sentBody.secret, 'topsecret', 'body 應含 secret');
  assert.strictEqual(sentBody.source, 'etag-relay');
  assert.ok(capturedInit.signal, '應帶 AbortSignal(timeout)');

  assert.deepStrictEqual(result, { ok: true, ip: '203.0.113.9', status: 200 });

  console.log('[test-heartbeat] ④送出 body/method/header PASS');
}

async function testNonOkStatus() {
  // ⑤ 非 2xx 不 throw,回 status
  const stubFetch = async () => new Response('nope', { status: 503 });
  const result = await sendSiteIpHeartbeat(
    { VERCEL_CAPTCHA_URL: 'https://gafferland.com', VERCEL_CALLBACK_SECRET: 'sekret' },
    { fetchImpl: stubFetch }
  );
  assert.deepStrictEqual(result, { ok: false, status: 503 });
  console.log('[test-heartbeat] ⑤非 2xx 回 status,不 throw PASS');
}

async function testFetchThrows() {
  // ⑥ fetch throw 不 throw
  const stubFetch = async () => { throw new Error('network-down'); };
  let result;
  await assert.doesNotReject(async () => {
    result = await sendSiteIpHeartbeat(
      { VERCEL_CAPTCHA_URL: 'https://gafferland.com', VERCEL_CALLBACK_SECRET: 'sekret' },
      { fetchImpl: stubFetch }
    );
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'network-down');
  console.log('[test-heartbeat] ⑥fetch throw 不外洩,回 reason PASS');
}

async function testStartSiteIpHeartbeatTiming() {
  // ⑦ startSiteIpHeartbeat:首發(setTimeout)＋週期(setInterval)各觸發一次呼叫一次
  // fetch;成功時 ip 不變不重複 log.info,ip 改變才再 log。
  const timers = makeFakeTimers();
  const log = makeStubLog();
  let ip = '203.0.113.9';
  let fetchCallCount = 0;
  const stubFetch = async () => {
    fetchCallCount += 1;
    return new Response(JSON.stringify({ ip }), { status: 200 });
  };

  const options = { VERCEL_CAPTCHA_URL: 'https://gafferland.com', VERCEL_CALLBACK_SECRET: 'sekret' };
  const handle = startSiteIpHeartbeat(options, {
    intervalMs: 300000,
    initialDelayMs: 15000,
    fetchImpl: stubFetch,
    log,
    setTimeoutImpl: timers.setTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });

  assert.strictEqual(fetchCallCount, 0, '註冊當下不應立即呼叫 fetch');
  assert.strictEqual(timers.timeoutDelay, 15000, 'setTimeout 應帶 initialDelayMs');
  assert.strictEqual(timers.intervalDelay, 300000, 'setInterval 應帶 intervalMs');

  // 首發
  await timers.fireTimeout();
  assert.strictEqual(fetchCallCount, 1, '首發應呼叫一次 fetch');
  assert.strictEqual(log.infoCalls.length, 1, '首次成功且 ip 有值應 log.info 一次');
  assert.ok(log.infoCalls[0].includes(ip), 'log 訊息應含 ip');
  assert.ok(!log.infoCalls[0].includes('sekret'), 'log 訊息絕不可含 secret');
  assert.deepStrictEqual(handle.getStatus().lastIp, ip);
  assert.ok(handle.getStatus().lastOkAt, 'lastOkAt 應已寫入');

  // 週期,ip 不變 → 不重複 log.info
  await timers.fireInterval();
  assert.strictEqual(fetchCallCount, 2, '週期應再呼叫一次 fetch');
  assert.strictEqual(log.infoCalls.length, 1, 'ip 不變不應重複 log.info');

  // ip 改變 → 再度 log.info
  ip = '198.51.100.7';
  await timers.fireInterval();
  assert.strictEqual(fetchCallCount, 3);
  assert.strictEqual(log.infoCalls.length, 2, 'ip 改變應再 log.info 一次');
  assert.strictEqual(handle.getStatus().lastIp, ip);

  // 失敗每次都 warn
  const failFetch = async () => new Response('bad', { status: 500 });
  const handle2 = startSiteIpHeartbeat(options, {
    fetchImpl: failFetch,
    log,
    setTimeoutImpl: timers.setTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
  });
  await timers.fireTimeout();
  await timers.fireTimeout();
  assert.strictEqual(log.warnCalls.length, 2, '失敗應每次都 log.warn');
  assert.ok(log.warnCalls[0].includes('500'), 'warn 訊息應含 status');

  handle.stop();
  assert.ok(timers.timeoutCleared, 'stop() 應呼叫 clearTimeoutImpl');
  assert.ok(timers.intervalCleared, 'stop() 應呼叫 clearIntervalImpl');
  void handle2;

  console.log('[test-heartbeat] ⑦startSiteIpHeartbeat 首發/週期/不重複 log/stop PASS');
}

async function main() {
  await testResolveHeartbeatUrl();
  await testNotConfigured();
  await testRequestShape();
  await testNonOkStatus();
  await testFetchThrows();
  await testStartSiteIpHeartbeatTiming();
  console.log('[test-heartbeat] PASS(離線 stub fetch + 可注入 timer,零網路)');
}

main().catch((e) => {
  console.error('[test-heartbeat] FAIL', e);
  process.exit(1);
});
