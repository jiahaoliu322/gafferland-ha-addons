// ── test-server.js(0.8.0)────────────────────────────────────────────────
// 本機真的起 `node server.js`(子行程),從 HTTP 層驗 /health、/sms 守門與回應契約、店內 IP 心跳
// 送達、已拆的 eTag 路由 404、啟動時刪除舊 session.json。
//
// **零對外連線**:子行程一律 `--require test-helpers/no-egress.js`(非 127.0.0.1 連線全擋,擋到就
// 在 stderr 留 BLOCKED,本測試判失敗)＋`--require test-helpers/fake-e8d.js`(把 api.e8d.tw 改送
// 到本測試開在 127.0.0.1 的假 every8d)。開跑前先自檢 no-egress 真的擋得住(對 TEST-NET
// 192.0.2.1 與 .invalid 網域——就算守門壞了也連不到任何真實主機)。
// 心跳目的地(PUNCH_SITEIP_URL)也指向同一台本機假伺服器。
//
// server.js 埠號寫死 8099:跑測試時本機 8099 不能被占用。data 目錄用 RELAY_DATA_DIR 指到臨時目錄。
// 只用 Node 20 就有的 API(CI 在 Node 20 跑)。
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const NO_EGRESS = path.join(DIR, 'test-helpers', 'no-egress.js');
const FAKE_E8D = path.join(DIR, 'test-helpers', 'fake-e8d.js');
const SERVER = path.join(DIR, 'server.js');
const RELAY_PORT = 8099; // server.js 寫死
const HEARTBEAT_WAIT_MS = 30000; // server 首發心跳在啟動後 15 秒(lib/siteip-heartbeat.js 預設)

const ENV_SECRET = 'test-relay-secret-env-1111';
const FILE_SECRET = 'test-relay-secret-file-2222';
const CB_SECRET = 'test-callback-secret-3333';
const LEGACY_FETC_PASSWORD = 'legacy-fetc-pass-5555';
const LEGACY_VNC_PASSWORD = 'legacy-vnc-pass-6666';
const SMS = {
  uid: 'test-uid-acct',
  pwd: 'test-sms-pwd-4444',
  sb: 'GAFFERLAND',
  msg: '你的驗證碼是 987654',
  dest: '0911222333',
};
const E8D_OK_BODY = '28,1,1,0,fake-batch-id';
const HB_IP = '203.0.113.7';

// log 裡絕不能出現的字串(密鑰、簡訊帳密與內容、未遮罩手機號碼)
const FORBIDDEN_IN_LOG = [
  ENV_SECRET, FILE_SECRET, CB_SECRET, LEGACY_FETC_PASSWORD, LEGACY_VNC_PASSWORD,
  SMS.uid, SMS.pwd, SMS.msg, '987654', SMS.dest,
];

const children = new Set();
let lastRelayLog = null; // 失敗時印出最後一個 relay 子行程的 stderr(只含測試用假值)
const tmpDirs = [];
process.on('exit', () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch (_) { /* 已結束 */ }
  }
  for (const d of tmpDirs) {
    try { fs.chmodSync(d, 0o755); } catch (_) { /* 已刪 */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 盡力 */ }
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`等待逾時:${what}`);
}

function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `relay-test-${tag}-`));
  tmpDirs.push(d);
  return d;
}

// ── 本機假伺服器:假 every8d(/e8d/...)＋心跳收件(/hb)──────────────────────
function startFake() {
  const state = { e8dMode: 'ok', e8dRequests: [], heartbeats: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/e8d/')) {
        state.e8dRequests.push({ method: req.method, pathname: url.pathname, params: url.searchParams });
        if (state.e8dMode === 'down') {
          req.socket.destroy(); // 不通:直接斷線
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(E8D_OK_BODY);
        return;
      }
      if (url.pathname === '/hb') {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { /* 非 JSON */ }
        state.heartbeats.push({ method: req.method, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ip: HB_IP }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port }));
  });
}

// ── 起 relay 子行程 ─────────────────────────────────────────────────────────
function startRelay({ dataDir, env, fakePort }) {
  const childEnv = {
    PATH: process.env.PATH || '',
    RELAY_DATA_DIR: dataDir,
    FAKE_E8D_URL: `http://127.0.0.1:${fakePort}/e8d`,
    ...env,
  };
  const child = spawn(process.execPath, ['--require', NO_EGRESS, '--require', FAKE_E8D, SERVER], {
    cwd: DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const log = { out: '', err: '' };
  lastRelayLog = log;
  child.stdout.on('data', (c) => { log.out += c.toString('utf8'); });
  child.stderr.on('data', (c) => { log.err += c.toString('utf8'); });
  let exited = null;
  const exitP = new Promise((r) => child.on('exit', (code, signal) => { exited = { code, signal }; children.delete(child); r(); }));

  async function ready() {
    await waitUntil(
      () => {
        if (exited) throw new Error(`relay 啟動即結束 ${JSON.stringify(exited)}(8099 被占用?)\n${log.out}\n${log.err}`);
        return log.out.includes(`listening on :${RELAY_PORT}`);
      },
      10000,
      'relay listening'
    );
  }
  async function stop() {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exitP, sleep(5000)]);
      if (!exited) { child.kill('SIGKILL'); await exitP; }
    }
  }
  return { child, log, ready, stop, isAlive: () => !exited };
}

function relayReq(method, pathname, { secret, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (secret != null) headers['X-Relay-Secret'] = secret;
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port: RELAY_PORT, method, path: pathname, headers, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('relay request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assertCleanLog(log, label) {
  const all = log.out + log.err;
  assert.ok(!all.includes('[no-egress] BLOCKED'), `${label}:no-egress 攔到對外連線\n${log.err}`);
  for (const s of FORBIDDEN_IN_LOG) {
    assert.ok(!all.includes(s), `${label}:log 不得含「${s}」`);
  }
}

// ── 0. 自檢:no-egress 真的擋得住(目標皆不可能是真實主機)──────────────────────
async function selfCheckNoEgress() {
  const script = `
    const net = require('net'), http = require('http');
    const out = [];
    const one = (name, p) => p.then(() => out.push(name + ':open'), (e) => out.push(name + ':' + (e.code || (e.cause && e.cause.code) || e.message)));
    (async () => {
      await one('fetch', fetch('http://192.0.2.1/', { signal: AbortSignal.timeout(3000) }));
      await one('http', new Promise((ok, no) => { try { const q = http.get({ host: '192.0.2.1', port: 80, timeout: 3000 }, ok); q.on('error', no); } catch (e) { no(e); } }));
      await one('net', new Promise((ok, no) => { try { const s = net.connect(443, 'example.invalid'); s.on('error', no); s.on('connect', ok); } catch (e) { no(e); } }));
      process.stdout.write(JSON.stringify(out));
    })();`;
  const child = spawn(process.execPath, ['--require', NO_EGRESS, '-e', script], {
    env: { PATH: process.env.PATH || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  await new Promise((r) => child.on('exit', () => { children.delete(child); r(); }));
  assert.deepStrictEqual(JSON.parse(out), ['fetch:NO_EGRESS', 'http:NO_EGRESS', 'net:NO_EGRESS'], `no-egress 自檢失敗:${out}\n${err}`);
  assert.strictEqual((err.match(/\[no-egress\] BLOCKED/g) || []).length, 3, `no-egress 應留 3 行 BLOCKED:${err}`);
  console.log('[test-server] ⓪no-egress 自檢:fetch/http/net 對外連線皆被擋 PASS');
}

// ── 1. 環境變數設定(無 options.json)──────────────────────────────────────
async function roundEnv(fake) {
  const dataDir = mkTmp('env');
  const relay = startRelay({
    dataDir,
    fakePort: fake.port,
    env: {
      RELAY_SECRET: ENV_SECRET,
      VERCEL_CALLBACK_SECRET: CB_SECRET,
      PUNCH_SITEIP_URL: `http://127.0.0.1:${fake.port}/hb`,
    },
  });
  try {
    await relay.ready();

    // /health
    let r = await relayReq('GET', '/health', { secret: ENV_SECRET });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['ok', 'siteIpHeartbeat'], '/health 只能有 ok、siteIpHeartbeat');
    assert.strictEqual(r.json.ok, true);
    for (const secret of [undefined, 'wrong-secret']) {
      r = await relayReq('GET', '/health', { secret });
      assert.strictEqual(r.status, 401, `/health secret=${secret} 應 401`);
      assert.deepStrictEqual(r.json, { ok: false, reason: 'unauthorized' });
    }
    console.log('[test-server] ①/health 200 只有 ok+siteIpHeartbeat;無/錯 secret 401 PASS');

    // /sms 守門:刻意少帶 pwd——就算守門被拿掉也不會走到轉送
    const noPwd = { uid: SMS.uid, sb: SMS.sb, msg: SMS.msg, dest: SMS.dest };
    for (const secret of [undefined, 'wrong-secret']) {
      r = await relayReq('POST', '/sms', { secret, body: noPwd });
      assert.strictEqual(r.status, 401, `/sms secret=${secret} 應 401(收到 ${r.status})`);
      assert.deepStrictEqual(r.json, { ok: false, reason: 'unauthorized' });
    }
    // 缺欄位 400
    for (const body of [noPwd, {}, { uid: SMS.uid, pwd: SMS.pwd, msg: SMS.msg }]) {
      r = await relayReq('POST', '/sms', { secret: ENV_SECRET, body });
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(r.json, { ok: false, reason: 'missing-params' });
    }
    assert.strictEqual(fake.state.e8dRequests.length, 0, '守門／缺欄位不得轉送 e8d');
    console.log('[test-server] ②/sms 無/錯 secret 401、缺欄位 400,皆未轉送 PASS');

    // 成功路徑
    fake.state.e8dMode = 'ok';
    r = await relayReq('POST', '/sms', { secret: ENV_SECRET, body: SMS });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, status: 200, body: E8D_OK_BODY });
    assert.strictEqual(fake.state.e8dRequests.length, 1);
    const sent = fake.state.e8dRequests[0];
    assert.strictEqual(sent.pathname, '/e8d/API21/HTTP/sendSMS.ashx');
    assert.strictEqual(sent.params.get('UID'), SMS.uid);
    assert.strictEqual(sent.params.get('PWD'), SMS.pwd);
    assert.strictEqual(sent.params.get('SB'), SMS.sb);
    assert.strictEqual(sent.params.get('MSG'), SMS.msg);
    assert.strictEqual(sent.params.get('DEST'), SMS.dest);
    console.log('[test-server] ③/sms 成功 200 {ok:true,status,body},參數原樣轉送 PASS');

    // e8d 不通
    fake.state.e8dMode = 'down';
    r = await relayReq('POST', '/sms', { secret: ENV_SECRET, body: SMS });
    assert.strictEqual(r.status, 200, `e8d 不通應 200(收到 ${r.status})`);
    assert.deepStrictEqual(r.json, { ok: false, reason: 'e8d-unreachable' });
    assert.strictEqual(fake.state.e8dRequests.length, 2);
    fake.state.e8dMode = 'ok';
    console.log('[test-server] ④/sms e8d 不通 200 {ok:false,reason:e8d-unreachable} PASS');

    // 已拆 eTag 路由
    for (const [method, p] of [['GET', '/query'], ['POST', '/query'], ['GET', '/print'], ['POST', '/print'], ['GET', '/session'], ['POST', '/session']]) {
      r = await relayReq(method, p, { secret: ENV_SECRET, body: method === 'POST' ? {} : undefined });
      assert.strictEqual(r.status, 404, `${method} ${p} 應 404(收到 ${r.status})`);
      assert.deepStrictEqual(r.json, { ok: false, reason: 'not-found' });
    }
    console.log('[test-server] ⑤/query /print /session 一律 404 PASS');

    // 心跳送達(首發在啟動後 15 秒)
    await waitUntil(() => fake.state.heartbeats.length > 0, HEARTBEAT_WAIT_MS, '心跳送達本機假伺服器');
    const hb = fake.state.heartbeats[0];
    assert.strictEqual(hb.method, 'POST');
    assert.deepStrictEqual(hb.body, { secret: CB_SECRET, source: 'etag-relay' });
    await waitUntil(async () => {
      const h = await relayReq('GET', '/health', { secret: ENV_SECRET });
      return h.json && h.json.siteIpHeartbeat && h.json.siteIpHeartbeat.lastIp === HB_IP;
    }, 5000, '/health siteIpHeartbeat.lastIp 更新');
    console.log('[test-server] ⑥心跳 POST 送達且帶 secret,/health 反映 lastIp PASS');

    assert.ok(relay.isAlive(), 'relay 不應 crash');
  } finally {
    await relay.stop();
  }
  assertCleanLog(relay.log, '環境變數輪');
  assert.ok(relay.log.out.includes('dest=0911***333'), 'log 應只有遮罩後的 dest');
  console.log('[test-server] ⑦log 不含 secret／簡訊帳密與內容;no-egress 零攔截 PASS');
}

function legacyOptions() {
  return {
    RELAY_SECRET: FILE_SECRET,
    VERCEL_CAPTCHA_URL: '',
    VERCEL_CALLBACK_SECRET: '',
    PUNCH_SITEIP_URL: '',
    // ≤0.7.1 舊鍵:使用者既有設定還留著,server 必須照常起得來
    FETC_ACCOUNT: 'legacy-fetc-acct',
    FETC_PASSWORD: LEGACY_FETC_PASSWORD,
    VNC_PASSWORD: LEGACY_VNC_PASSWORD,
    VNC_RESOLUTION: '1280x800',
  };
}

function writeDataDir(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify(legacyOptions()));
  fs.writeFileSync(path.join(dataDir, 'session.json'), JSON.stringify({ cookies: 'fake-old-session', savedAt: 0 }));
}

// ── 2. 假 /data/options.json(帶 FETC_*／VNC_* 舊鍵)＋舊 session.json ───────────
async function roundOptionsFile(fake) {
  const dataDir = mkTmp('opts');
  writeDataDir(dataDir);
  const relay = startRelay({ dataDir, fakePort: fake.port, env: { RELAY_SECRET: ENV_SECRET } });
  try {
    await relay.ready();
    assert.ok(!fs.existsSync(path.join(dataDir, 'session.json')), '啟動後舊 session.json 應被刪除');
    assert.ok(fs.existsSync(path.join(dataDir, 'options.json')), 'options.json 不得被動到');

    let r = await relayReq('GET', '/health', { secret: FILE_SECRET });
    assert.strictEqual(r.status, 200, 'options.json 的 RELAY_SECRET 應生效');
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['ok', 'siteIpHeartbeat']);
    r = await relayReq('GET', '/health', { secret: ENV_SECRET });
    assert.strictEqual(r.status, 401, '有 options.json 時不得改讀環境變數');

    const before = fake.state.e8dRequests.length;
    fake.state.e8dMode = 'ok';
    r = await relayReq('POST', '/sms', { secret: FILE_SECRET, body: SMS });
    assert.deepStrictEqual(r.json, { ok: true, status: 200, body: E8D_OK_BODY });
    assert.strictEqual(fake.state.e8dRequests.length, before + 1);
    assert.ok(relay.isAlive(), 'relay 不應 crash');
  } finally {
    await relay.stop();
  }
  assert.ok(!/session\.json/.test(relay.log.err), `刪除成功不應 warn:${relay.log.err}`);
  assertCleanLog(relay.log, 'options.json 輪');
  console.log('[test-server] ⑧options.json 帶 FETC_*／VNC_* 舊鍵照常啟動、讀檔內 secret;舊 session.json 啟動即刪 PASS');
}

// ── 3. data 目錄不可寫:刪不掉 session.json 也照常啟動,只 warn 一行 ────────────
async function roundUnwritable(fake) {
  const dataDir = mkTmp('ro');
  writeDataDir(dataDir);
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    // root 無視目錄權限:改用「session.json 是非空目錄」讓 rmSync(force、非 recursive)一樣刪不掉
    fs.rmSync(path.join(dataDir, 'session.json'));
    fs.mkdirSync(path.join(dataDir, 'session.json'));
    fs.writeFileSync(path.join(dataDir, 'session.json', 'x'), 'x');
  } else {
    fs.chmodSync(dataDir, 0o555);
  }
  const relay = startRelay({ dataDir, fakePort: fake.port, env: {} });
  try {
    await relay.ready();
    const r = await relayReq('GET', '/health', { secret: FILE_SECRET });
    assert.strictEqual(r.status, 200);
    assert.ok(fs.existsSync(path.join(dataDir, 'session.json')), '前提:session.json 刪不掉');
    assert.ok(relay.isAlive(), 'relay 不應 crash');
  } finally {
    await relay.stop();
    fs.chmodSync(dataDir, 0o755);
  }
  const warnLines = relay.log.err.split('\n').filter((l) => /session\.json/.test(l));
  assert.strictEqual(warnLines.length, 1, `應只 warn 一行:${relay.log.err}`);
  assertCleanLog(relay.log, '不可寫輪');
  console.log(`[test-server] ⑨data 目錄不可寫(${isRoot ? 'root:session.json 為目錄' : 'chmod 555'})仍正常啟動,只 warn 一行 PASS`);
}

(async () => {
  const guard = setTimeout(() => {
    console.error('[test-server] 整體逾時 FAIL');
    process.exit(1);
  }, 120000);
  guard.unref();

  let fake;
  try {
    await selfCheckNoEgress();
    fake = await startFake();
    await roundEnv(fake);
    await roundOptionsFile(fake);
    await roundUnwritable(fake);
    console.log('[test-server] 全部 PASS');
  } catch (e) {
    console.error('[test-server] FAIL:', e && e.stack ? e.stack : e);
    if (lastRelayLog && lastRelayLog.err) console.error('[test-server] relay stderr:\n' + lastRelayLog.err.trim());
    process.exitCode = 1;
  } finally {
    if (fake) fake.srv.close();
    if (fake) fake.srv.closeAllConnections && fake.srv.closeAllConnections();
  }
})();
