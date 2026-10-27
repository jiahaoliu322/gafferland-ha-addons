'use strict';
// agent-core.js:用假 chrome.* 與假站台驗 run 流程(b4)。
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../agent-core');
const { build, AGENT, HOSTS } = require('./helpers/fake-chrome');

const job = (id, type = 'settle-query') => ({ id, type, payload: { plates: ['TEST-001'], startDate: '2026/07/20', endDate: '2026/07/21' } });
const okQuery = { ok: true, data: { perPlate: { 'TEST-001': { ok: true, transactions: [] } } }, cinCache: { 'TEST-001': 'CIN1' } };
const pollOf = (jobs) => () => ({ status: 200, json: { ok: true, mode: 'browser', jobs, pollAfterSec: 300 } });
const resultOk = () => ({ status: 200, json: { ok: true, next: [] } });
const lastRun = (t) => t.local.m.get('lastRun');

test('未配對:不打網站、不開分頁', async () => {
  const t = build({}, { poll: pollOf([]), result: resultOk });
  const r = await t.core.run();
  assert.deepEqual(r, { skipped: 'unpaired' });
  assert.equal(t.site.log.length, 0);
  assert.equal(t.calls.tabsCreated.length + t.calls.windowsCreated.length, 0);
});

test('無 FETC_P:poll 回報 login-required,不開分頁', async () => {
  const t = build({ agent: AGENT, cookies: [{ name: 'other', value: '1' }] }, { poll: pollOf([]), result: resultOk });
  await t.core.run();
  assert.equal(t.site.log.length, 1);
  assert.equal(t.site.log[0].action, 'etag-agent-poll');
  assert.equal(t.site.log[0].body.fetcState, 'login-required');
  assert.equal(t.site.log[0].body.version, '2.0.0');
  assert.equal(t.calls.tabsCreated.length + t.calls.windowsCreated.length, 0);
  assert.equal(lastRun(t).state, 'login-required');
});

test('有工作:開背景分頁→注入兩檔→在分頁內執行→回報→接 next→關自己開的分頁', async () => {
  const ran = [];
  let n = 0;
  const t = build(
    { agent: AGENT, runJob: async (j) => { ran.push(j.id); return okQuery; } },
    {
      poll: pollOf([job('sq:1')]),
      result: (body) => (++n === 1 ? { status: 200, json: { ok: true, next: [job('sp:1', 'settle-print')] } } : resultOk()),
    }
  );
  await t.core.run();
  assert.deepEqual(ran, ['sq:1', 'sp:1']);
  assert.equal(t.calls.tabsCreated.length, 1);
  assert.equal(t.calls.tabsCreated[0].active, false);
  assert.match(t.calls.tabsCreated[0].url, /^https:\/\/www\.fetc\.net\.tw\/Member$/);
  // 每個工作前都注入 fetc-parse.js＋fetc-chain.js,在 MAIN world
  const files = t.calls.injected.filter((x) => x.files);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].files, ['fetc-parse.js', 'fetc-chain.js']);
  assert.equal(files[0].world, 'MAIN');
  assert.ok(t.calls.injected.filter((x) => x.job).every((x) => x.world === 'MAIN'), '工作函式也要在 MAIN world');
  // 結果回報
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].body, { id: 'sq:1', ok: true, data: okQuery.data });
  // 站台呼叫:只帶 agent token、不帶 cookie
  for (const l of t.site.log) {
    assert.equal(l.headers['X-Gfl-Agent-Token'], AGENT.token);
    assert.equal(l.credentials, 'omit');
    assert.ok(l.url.startsWith('https://admin.gafferland.com/api/collect?action=etag-agent-'));
  }
  // 結束關掉自己開的分頁;cin 快取存下
  assert.equal(t.calls.tabsRemoved.length, 1);
  assert.deepEqual(t.local.m.get('cinCache'), { 'TEST-001': 'CIN1' });
  assert.equal(lastRun(t).count, 2);
  assert.equal(lastRun(t).state, 'ok');
});

test('沒有任何視窗:建最小化視窗,結束時關視窗', async () => {
  const t = build({ agent: AGENT, windows: 0, runJob: async () => okQuery }, { poll: pollOf([job('sq:1')]), result: resultOk });
  await t.core.run();
  assert.equal(t.calls.windowsCreated.length, 1);
  assert.equal(t.calls.windowsCreated[0].state, 'minimized');
  assert.equal(t.calls.windowsCreated[0].focused, false);
  assert.deepEqual(t.calls.windowsRemoved, [900]);
});

test('poll 回 401:清本機配對、不開分頁', async () => {
  const t = build({ agent: AGENT }, { poll: () => ({ status: 401, json: { ok: false, reason: 'bad-token' } }), result: resultOk });
  await t.core.run();
  assert.equal(t.local.m.has('agent'), false);
  assert.equal(lastRun(t).state, 'revoked');
  assert.match(lastRun(t).message, /已被移除/);
  assert.equal(t.calls.tabsCreated.length, 0);
  // 之後的 run 視同未配對
  assert.deepEqual(await t.core.run(), { skipped: 'unpaired' });
});

test('result 回 401:清配對並停止', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([job('a'), job('b')]), result: () => ({ status: 401, json: { ok: false } }) });
  await t.core.run();
  assert.equal(t.local.m.has('agent'), false);
  assert.equal(t.site.log.filter((l) => l.action === 'etag-agent-result').length, 1);
  assert.equal(t.calls.tabsRemoved.length, 1);
});

test('挑戰頁:等 45 秒(每 3 秒看一次)後 cf-interactive,不關分頁,剩下工作回報 cf-interactive', async () => {
  const t = build(
    { agent: AGENT, probe: () => ({ url: 'https://www.fetc.net.tw/Member', title: 'Just a moment...', text: '', hasLoginForm: false }), runJob: async () => { throw new Error('不該執行'); } },
    { poll: pollOf([job('a'), job('b')]), result: resultOk }
  );
  await t.core.run();
  const total = t.sleeps.filter((ms) => ms === 3000).length * 3000;
  assert.ok(total >= 45000, `等待 ${total}ms`);
  assert.equal(t.calls.tabsRemoved.length, 0);
  assert.equal(t.calls.windowsRemoved.length, 0);
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
  assert.deepEqual(results, [{ id: 'a', ok: false, reason: 'cf-interactive' }, { id: 'b', ok: false, reason: 'cf-interactive' }]);
  assert.equal(lastRun(t).state, 'cf-interactive');
  assert.ok(t.local.m.get('cfTab'));
  assert.equal(t.calls.injected.filter((x) => x.files).length, 0);
});

test('上次留下的挑戰分頁仍未通過:poll 帶 cf-interactive、不領工作、不開新分頁', async () => {
  const t = build(
    { agent: AGENT, probe: () => ({ url: 'https://www.fetc.net.tw/Member', title: 'Just a moment...', text: '', hasLoginForm: false }) },
    { poll: pollOf([job('a')]), result: resultOk }
  );
  t.state.tabs.set(55, { id: 55, status: 'complete', url: 'https://www.fetc.net.tw/Member' });
  await t.local.set({ cfTab: { tabId: 55, windowId: null } });
  await t.core.run();
  assert.equal(t.site.log.length, 1);
  assert.equal(t.site.log[0].body.fetcState, 'cf-interactive');
  assert.equal(t.calls.tabsCreated.length, 0);
  assert.equal(t.calls.tabsRemoved.length, 0);
});

test('上次留下的分頁已通過驗證:沿用它做事,結束後關掉', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([job('a')]), result: resultOk });
  t.state.tabs.set(55, { id: 55, status: 'complete', url: 'https://www.fetc.net.tw/Member' });
  await t.local.set({ cfTab: { tabId: 55, windowId: null } });
  await t.core.run();
  assert.equal(t.calls.tabsCreated.length, 0);
  assert.deepEqual(t.calls.tabsRemoved, [55]);
  assert.equal(t.local.m.has('cfTab'), false);
});

test('分頁是登入頁:login-required、關分頁、剩下工作回報 login-required', async () => {
  const t = build(
    { agent: AGENT, probe: () => ({ url: 'https://www.fetc.net.tw/UX0301UserLogin?x=1', title: '登入', text: '', hasLoginForm: true }) },
    { poll: pollOf([job('a')]), result: resultOk }
  );
  await t.core.run();
  assert.equal(t.calls.tabsRemoved.length, 1);
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
  assert.deepEqual(results, [{ id: 'a', ok: false, reason: 'login-required' }]);
  assert.equal(lastRun(t).state, 'login-required');
});

test('工作結果帶 login-required:照樣回報、剩下工作不再執行(以 login-required 釋放)', async () => {
  const ran = [];
  const t = build(
    { agent: AGENT, runJob: async (j) => { ran.push(j.id); return { ok: true, data: { perPlate: { 'TEST-001': { ok: false, reason: 'login-required' } } } }; } },
    { poll: pollOf([job('a'), job('b')]), result: resultOk }
  );
  await t.core.run();
  assert.deepEqual(ran, ['a']);
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[1], { id: 'b', ok: false, reason: 'login-required' });
  assert.equal(t.calls.tabsRemoved.length, 1);
});

test('工作內 cf-challenge:停止本輪、留著分頁', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => ({ ok: true, data: { pdfs: [{ plateRaw: 'TEST-001', ok: false, reason: 'cf-challenge' }] } }) },
    { poll: pollOf([job('a', 'settle-print'), job('b')]), result: resultOk }
  );
  await t.core.run();
  assert.equal(t.calls.tabsRemoved.length, 0);
  assert.ok(t.local.m.get('cfTab'));
  assert.equal(lastRun(t).state, 'cf-interactive');
});

test('單筆逾時(4 分鐘):回報 error,不卡住', async () => {
  const t = build(
    { agent: AGENT, runJob: () => new Promise(() => {}) },
    { poll: pollOf([job('a')]), result: resultOk }
  );
  const p = t.core.run();
  // 等到逾時計時器被登記後觸發它
  for (let i = 0; i < 50 && !t.timerFires.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.timerFires[0].ms, 4 * 60 * 1000);
  t.timerFires[0].fn();
  await p;
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
  assert.deepEqual(results, [{ id: 'a', ok: false, reason: 'error' }]);
  assert.equal(t.calls.tabsRemoved.length, 1);
});

test('頁面內丟例外 → 回報 error', async () => {
  const t = build({ agent: AGENT, runJob: async () => ({ ok: false, reason: 'error', message: 'boom' }) }, { poll: pollOf([job('a')]), result: resultOk });
  await t.core.run();
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
  assert.deepEqual(results, [{ id: 'a', ok: false, reason: 'error' }]);
});

test('同時兩次 run 只跑一次', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = build({ agent: AGENT, runJob: async () => { await gate; return okQuery; } }, { poll: pollOf([job('a')]), result: resultOk });
  const p1 = t.core.run();
  const p2 = t.core.run();
  assert.deepEqual(await p2, { skipped: 'busy' });
  release();
  const r1 = await p1;
  assert.equal(r1.state, 'ok');
  assert.equal(t.site.log.filter((l) => l.action === 'etag-agent-poll').length, 1);
  // 跑完鎖釋放,可再跑
  assert.equal((await t.core.run()).state, 'ok');
});

test('storage.session 殘留的新鮮鎖(SW 重啟後)擋住;過期鎖不擋', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([]), result: resultOk });
  await t.session.set({ runLock: { at: 1700000000000 - 1000 } });
  assert.deepEqual(await t.core.run(), { skipped: 'busy' });
  await t.session.set({ runLock: { at: 1700000000000 - 6 * 60 * 1000 } });
  assert.equal((await t.core.run()).state, 'ok');
});

test('result 409(不是我領的):丟掉繼續', async () => {
  let n = 0;
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([job('a'), job('b')]), result: () => (++n === 1 ? { status: 409, json: { ok: false } } : { status: 200, json: { ok: true, next: [] } }) });
  await t.core.run();
  assert.equal(t.site.log.filter((l) => l.action === 'etag-agent-result').length, 2);
  assert.equal(lastRun(t).count, 1);
});

test('poll 攜帶上次錯誤(lastError),poll 成功後清掉', async () => {
  const t = build({ agent: AGENT }, { poll: pollOf([]), result: resultOk });
  await t.local.set({ pendingError: 'job-timeout' });
  await t.core.run();
  assert.equal(t.site.log[0].body.lastError, 'job-timeout');
  assert.equal(t.local.m.has('pendingError'), false);
});

test('站台網址不在 host_permissions:不打網站', async () => {
  const t = build({ agent: { ...AGENT, baseUrl: 'https://evil.example.com' } }, { poll: pollOf([]), result: resultOk });
  await t.core.run();
  assert.equal(t.site.log.length, 0);
  assert.equal(lastRun(t).state, 'error');
});

test('結果超過 4MB:從最大的 PDF 起改成 pdf-failed', async () => {
  const big = (n) => 'A'.repeat(n);
  const pdfs = [
    { plateRaw: 'P1', ok: true, pdfBase64: big(1.5e6), printTotal: 1 },
    { plateRaw: 'P2', ok: true, pdfBase64: big(2.5e6), printTotal: 2 },
    { plateRaw: 'P3', ok: true, pdfBase64: big(1.8e6), printTotal: 3 },
  ];
  const t = build({ agent: AGENT, runJob: async () => ({ ok: true, data: { pdfs } }) }, { poll: pollOf([job('a', 'settle-print')]), result: resultOk });
  await t.core.run();
  const body = t.site.log.find((l) => l.action === 'etag-agent-result');
  assert.ok(body.bodyBytes <= 4 * 1024 * 1024, `body ${body.bodyBytes}`);
  const got = body.body.data.pdfs;
  assert.deepEqual(got[1], { plateRaw: 'P2', ok: false, reason: 'pdf-failed' });
  assert.equal(got[0].ok, true);
  assert.equal(got[2].ok, true); // 共 5.8MB,砍掉最大的 P2 後 3.3MB 已 ≤4MB,其餘保留
  assert.equal(got[0].ok, true);
});

// ── shrinkResultBody ────────────────────────────────────────────────────────
test('shrinkResultBody:未超限原樣;超限由大到小砍到剛好放得下', () => {
  const mk = (sizes) => ({ id: 'x', ok: true, data: { pdfs: sizes.map((s, i) => ({ plateRaw: 'P' + i, ok: true, pdfBase64: 'A'.repeat(s), printTotal: 1 })) } });
  const small = mk([100, 200]);
  assert.equal(core.shrinkResultBody(small, 10000).dropped.length, 0);
  const b = mk([4000, 6000, 3000]);
  const r = core.shrinkResultBody(b, 8000);
  assert.deepEqual(r.dropped, ['P1']);
  assert.ok(new TextEncoder().encode(r.json).length <= 8000);
  assert.equal(JSON.parse(r.json).data.pdfs[0].ok, true);
  const all = core.shrinkResultBody(mk([9000, 9000]), 100);
  assert.deepEqual(all.dropped.sort(), ['P0', 'P1']);
  // 非 pdfs 型(查詢)不動
  const q = { id: 'q', ok: true, data: { perPlate: {} } };
  assert.deepEqual(core.shrinkResultBody(q, 1).dropped, []);
});

test('sessionStopOf:各結果形狀', () => {
  assert.equal(core.sessionStopOf({ ok: false, reason: 'login-required' }), 'login-required');
  assert.equal(core.sessionStopOf({ ok: false, reason: 'cf-challenge' }), 'cf-interactive');
  assert.equal(core.sessionStopOf({ ok: false, reason: 'error' }), null);
  assert.equal(core.sessionStopOf({ ok: true, data: { perPlate: { A: { ok: true }, B: { ok: false, reason: 'cf-challenge' } } } }), 'cf-interactive');
  assert.equal(core.sessionStopOf({ ok: true, data: { pdfs: [{ ok: false, reason: 'pdf-failed' }] } }), null);
});

test('classifyPage', () => {
  assert.equal(core.classifyPage({ title: 'Just a moment...', url: 'https://www.fetc.net.tw/' }), 'challenge');
  assert.equal(core.classifyPage({ title: '請稍候…', url: 'https://www.fetc.net.tw/' }), 'challenge');
  assert.equal(core.classifyPage({ title: 'x', url: 'https://www.fetc.net.tw/?__cf_chl_tk=1' }), 'challenge');
  assert.equal(core.classifyPage({ title: 'x', url: 'https://www.fetc.net.tw/UX0301UserLogin' }), 'login');
  assert.equal(core.classifyPage({ title: 'x', url: 'https://www.fetc.net.tw/Member', hasLoginForm: true }), 'login');
  assert.equal(core.classifyPage({ title: '會員', url: 'https://www.fetc.net.tw/Member' }), 'ok');
});

test('isHostPermitted / resolveBaseUrl', () => {
  assert.equal(core.isHostPermitted('https://admin.gafferland.com', HOSTS), true);
  assert.equal(core.isHostPermitted('https://admin.gafferland.com/collect', HOSTS), true);
  assert.equal(core.isHostPermitted('https://www.fetc.net.tw', HOSTS), true);
  assert.equal(core.isHostPermitted('http://admin.gafferland.com', HOSTS), false);
  assert.equal(core.isHostPermitted('https://gafferland.vercel.app', HOSTS), false);
  assert.equal(core.isHostPermitted('https://evil.admin.gafferland.com', HOSTS), false);
  assert.equal(core.isHostPermitted('not a url', HOSTS), false);
  assert.equal(core.resolveBaseUrl(''), 'https://admin.gafferland.com');
  assert.equal(core.resolveBaseUrl('https://gafferland.vercel.app/'), 'https://admin.gafferland.com');
  assert.equal(core.resolveBaseUrl('https://admin.gafferland.com/'), 'https://admin.gafferland.com');
});

// ── 配對 ────────────────────────────────────────────────────────────────────
function pairEnv(resp) {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    opts: {
      fetch: async (url, init) => { calls.push({ url, init }); return { status: resp.status, json: async () => resp.json }; },
      storage: { async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); } },
      baseUrl: 'https://admin.gafferland.com',
      code: ' k7m2q9xa ',
      version: '2.0.0',
      hostPatterns: HOSTS,
    },
  };
}

test('pairAgent 成功:存 {agentId,token,name,baseUrl},碼轉大寫去空白,不帶 cookie', async () => {
  const e = pairEnv({ status: 200, json: { ok: true, agentId: 'ag9', token: 'TOK-synthetic', name: '店裡電腦' } });
  const r = await core.pairAgent(e.opts);
  assert.deepEqual(r, { ok: true, name: '店裡電腦' });
  assert.deepEqual(e.store.get('agent'), { agentId: 'ag9', token: 'TOK-synthetic', name: '店裡電腦', baseUrl: 'https://admin.gafferland.com' });
  assert.equal(e.calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(e.calls[0].init.body), { code: 'K7M2Q9XA', version: '2.0.0' });
  assert.ok(!JSON.stringify(r).includes('TOK'));
});

test('pairAgent 錯碼／限流／網域不允許', async () => {
  assert.deepEqual(await core.pairAgent(pairEnv({ status: 400, json: { ok: false, reason: 'bad-code' } }).opts), { ok: false, reason: 'bad-code' });
  assert.deepEqual(await core.pairAgent(pairEnv({ status: 429, json: {} }).opts), { ok: false, reason: 'throttled' });
  const bad = pairEnv({ status: 200, json: {} });
  bad.opts.baseUrl = 'https://evil.example.com';
  assert.deepEqual(await core.pairAgent(bad.opts), { ok: false, reason: 'host-not-permitted' });
  assert.equal(bad.calls.length, 0);
  const e = pairEnv({ status: 200, json: {} });
  e.opts.code = '  ';
  assert.deepEqual(await core.pairAgent(e.opts), { ok: false, reason: 'bad-code' });
  const net = pairEnv({ status: 200, json: {} });
  net.opts.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await core.pairAgent(net.opts), { ok: false, reason: 'network' });
  assert.equal(e.store.has('agent'), false);
});

// ── b4r:遺留 cfTab 撞號(F1)───────────────────────────────────────────────────

const probeOk = () => ({ url: 'https://www.fetc.net.tw/Member', title: '會員專區', text: 'ok', hasLoginForm: false });

test('F1:遺留 cfTab 的 id 現在是別的網域的分頁(有 windowId):不導航、不關、cfTab 被清', async () => {
  const t = build({ agent: AGENT, probe: probeOk }, { poll: pollOf([]), result: resultOk });
  await t.local.set({ cfTab: { tabId: 7, windowId: 5 } });
  t.state.tabs.set(7, { id: 7, status: 'complete', url: 'https://bank.example/account', windowId: 5 });
  await t.core.run();
  assert.deepEqual(t.calls.tabsUpdated, []);
  assert.deepEqual(t.calls.windowsRemoved, []);
  assert.deepEqual(t.calls.tabsRemoved, []);
  assert.equal(t.local.m.has('cfTab'), false);
  assert.ok(t.state.tabs.has(7));
});

test('F1:遺留 cfTab 撞到別的網域的分頁、這輪有工作:另開新分頁做事,不碰那個分頁', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([job('a')]), result: resultOk });
  await t.local.set({ cfTab: { tabId: 7, windowId: null } });
  t.state.tabs.set(7, { id: 7, status: 'complete', url: 'https://bank.example/account' });
  await t.core.run();
  assert.deepEqual(t.calls.tabsUpdated, []);
  assert.equal(t.calls.tabsCreated.length, 1);
  assert.ok(!t.calls.injected.some((x) => x.tabId === 7), '不得對別人的分頁注入');
  assert.ok(!t.calls.tabsRemoved.includes(7));
  assert.ok(t.state.tabs.has(7));
  assert.equal(lastRun(t).state, 'ok');
});

test('F1:網域只是長得像(fetc.net.tw.evil.example／http)也不沿用', async () => {
  for (const url of ['https://www.fetc.net.tw.evil.example/Member', 'http://www.fetc.net.tw/Member', 'about:blank', undefined]) {
    const t = build({ agent: AGENT, probe: probeOk }, { poll: pollOf([]), result: resultOk });
    await t.local.set({ cfTab: { tabId: 7, windowId: null } });
    t.state.tabs.set(7, { id: 7, status: 'complete', url });
    await t.core.run();
    assert.equal(t.local.m.has('cfTab'), false, String(url));
    assert.deepEqual(t.calls.tabsRemoved, [], String(url));
  }
});

test('F1:沿用遠通子網域的舊分頁:結束只用 tabs.remove,絕不 windows.remove(即使 cfTab 記著 windowId)', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([job('a')]), result: resultOk });
  await t.local.set({ cfTab: { tabId: 55, windowId: 5 } });
  t.state.tabs.set(55, { id: 55, status: 'complete', url: 'https://www.fetc.net.tw/Member', windowId: 5 });
  await t.core.run();
  assert.deepEqual(t.calls.windowsRemoved, []);
  assert.deepEqual(t.calls.tabsRemoved, [55]);
});

test('F1:本輪自己開的分頁,結束前被使用者導去別的網域:不關它', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => { for (const tab of t.state.tabs.values()) tab.url = 'https://bank.example/'; return okQuery; } },
    { poll: pollOf([job('a')]), result: resultOk }
  );
  await t.core.run();
  assert.deepEqual(t.calls.tabsRemoved, []);
  assert.deepEqual(t.calls.windowsRemoved, []);
});

test('F1:本輪 windows.create 建的視窗,結束仍是遠通 → windows.remove 該視窗', async () => {
  const t = build({ agent: AGENT, windows: 0, runJob: async () => okQuery }, { poll: pollOf([job('a')]), result: resultOk });
  await t.core.run();
  assert.deepEqual(t.calls.windowsRemoved, [900]);
});

test('F1:cf-interactive 留著的分頁不記 windowId(下輪只會 tabs.remove)', async () => {
  const t = build(
    { agent: AGENT, windows: 0, probe: () => ({ url: 'https://www.fetc.net.tw/Member', title: 'Just a moment...', text: '', hasLoginForm: false }) },
    { poll: pollOf([job('a')]), result: resultOk }
  );
  await t.core.run();
  assert.equal(t.local.m.get('cfTab').windowId, null);
});

test('F1:clearStaleTab(onStartup 用)清掉 cfTab', async () => {
  const t = build({ agent: AGENT }, { poll: pollOf([]), result: resultOk });
  await t.local.set({ cfTab: { tabId: 7, windowId: null } });
  await t.core.clearStaleTab();
  assert.equal(t.local.m.has('cfTab'), false);
});

// ── F3:沿用 cfTab 分支也要處理 401 ─────────────────────────────────────────────

test('F3:沿用 cfTab 的 poll 回 401:清配對、popup 顯示已被移除', async () => {
  const t = build(
    { agent: AGENT, probe: () => ({ url: 'https://www.fetc.net.tw/Member?__cf_chl_tk=x', title: 'Just a moment...', text: '', hasLoginForm: false }) },
    { poll: () => ({ status: 401, json: { ok: false, reason: 'bad-token' } }), result: resultOk }
  );
  await t.local.set({ cfTab: { tabId: 100, windowId: null } });
  t.state.tabs.set(100, { id: 100, status: 'complete', url: 'https://www.fetc.net.tw/Member' });
  await t.core.run();
  assert.equal(t.local.m.has('agent'), false);
  assert.equal(lastRun(t).state, 'revoked');
  assert.match(lastRun(t).message, /已被移除/);
});

// ── F2:頁面回傳不可信 ───────────────────────────────────────────────────────────

test('F2:sanitizeCinCache 只收 string→string、key≤20、value≤40、最多 200 筆', () => {
  const big = {};
  for (let i = 0; i < 300; i++) big[`P${i}`] = `C${i}`;
  const r = core.sanitizeCinCache(big);
  assert.equal(Object.keys(r).length, 200);
  assert.ok(r.P299 && !r.P0, '超量時保留較新的');
  const mixed = core.sanitizeCinCache({ ok: 'v', num: 5, obj: { a: 1 }, nul: null, arr: ['x'], ['k'.repeat(21)]: 'v', longv: 'v'.repeat(41), edge: 'v'.repeat(40), ['k'.repeat(20)]: 'v' });
  assert.deepEqual(Object.keys(mixed).sort(), ['k'.repeat(20), 'edge', 'ok'].sort());
  for (const bad of [null, undefined, 'str', 5, ['a']]) assert.deepEqual(core.sanitizeCinCache(bad), {});
});

test('F2:頁面回傳的 cinCache 先過濾才存進 storage', async () => {
  const dirty = { 'TEST-001': 'CIN1', evil: { x: 1 }, ['k'.repeat(50)]: 'v', longv: 'z'.repeat(500) };
  const t = build({ agent: AGENT, runJob: async () => ({ ok: true, data: { perPlate: {} }, cinCache: dirty }) }, { poll: pollOf([job('a')]), result: resultOk });
  await t.core.run();
  assert.deepEqual(t.local.m.get('cinCache'), { 'TEST-001': 'CIN1' });
});

test('F2:頁面回傳的 reason 不在清單內一律改成 error(也不照原樣送上傳)', async () => {
  for (const [given, want] of [['pdf-failed', 'pdf-failed'], ['no-rows', 'no-rows'], ['<script>alert(1)</script>', 'error'], [{ a: 1 }, 'error'], [undefined, 'error'], ['x'.repeat(5000), 'error']]) {
    const t = build({ agent: AGENT, runJob: async () => ({ ok: false, reason: given, message: 'm' }) }, { poll: pollOf([job('a')]), result: resultOk });
    await t.core.run();
    const res = t.site.log.find((l) => l.action === 'etag-agent-result');
    assert.deepEqual(res.body, { id: 'a', ok: false, reason: want });
  }
  assert.equal(core.sanitizeReason('login-required'), 'login-required');
  assert.equal(core.sanitizeReason('weird'), 'error');
});

test('F2:縮 PDF 後 data 仍超過 4MB(非 PDF 灌水):不送大 body,改回報 error', async () => {
  const huge = { perPlate: { 'TEST-001': { ok: true, transactions: [{ timeStr: 'x', route: 'r'.repeat(5 * 1024 * 1024), gantry: 'g', amount: 1 }] } } };
  const t = build({ agent: AGENT, runJob: async () => ({ ok: true, data: huge }) }, { poll: pollOf([job('a')]), result: resultOk });
  await t.core.run();
  const res = t.site.log.find((l) => l.action === 'etag-agent-result');
  assert.ok(res.bodyBytes < 1024, `bodyBytes=${res.bodyBytes}`);
  assert.deepEqual(res.body, { id: 'a', ok: false, reason: 'error' });
});

// ── U1:站台請求不跟轉址 ────────────────────────────────────────────────────────

test('U1:poll／result 呼叫自家站台都帶 redirect:error 與 credentials:omit', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: pollOf([job('a')]), result: resultOk });
  await t.core.run();
  assert.ok(t.site.log.length >= 2);
  for (const l of t.site.log) {
    assert.equal(l.redirect, 'error', l.action);
    assert.equal(l.credentials, 'omit', l.action);
  }
});

test('U1:pairAgent 也帶 redirect:error;站台轉址（fetch 丟錯）＝失敗 network', async () => {
  const e = pairEnv({ status: 200, json: { ok: true, agentId: 'ag9', token: 'TOK-synthetic', name: 'x' } });
  await core.pairAgent(e.opts);
  assert.equal(e.calls[0].init.redirect, 'error');
  const r = pairEnv({ status: 200, json: {} });
  r.opts.fetch = async (u, init) => { if (init.redirect === 'error') throw new TypeError('redirect mode is set to error'); return { status: 200, json: async () => ({}) }; };
  assert.deepEqual(await core.pairAgent(r.opts), { ok: false, reason: 'network' });
});

// ── T1:token 不得進入送進分頁的任何東西 ──────────────────────────────────────────

test('T1:所有 executeScript 的 args 與 func 原始碼都不含 token／header 名／agentId', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => okQuery },
    { poll: pollOf([job('a'), job('b', 'settle-print')]), result: resultOk }
  );
  await t.core.run();
  assert.ok(t.calls.scriptWire.length >= 4, `只有 ${t.calls.scriptWire.length} 次 executeScript`);
  for (const w of t.calls.scriptWire) {
    assert.ok(!w.includes(AGENT.token), '含 token');
    assert.ok(!/x-gfl-agent-token/i.test(w), '含 header 名');
    assert.ok(!w.includes(AGENT.agentId), '含 agentId');
  }
});

// ── T3:單輪工作數上限 ──────────────────────────────────────────────────────────

test('T3:站台一直回 next 時,單輪最多處理 30 筆', async () => {
  let n = 0;
  const t = build(
    { agent: AGENT, runJob: async () => okQuery },
    { poll: pollOf([job('j0')]), result: () => ({ status: 200, json: { ok: true, next: [job(`j${++n}`)] } }) }
  );
  const r = await t.core.run();
  assert.equal(t.site.log.filter((l) => l.action === 'etag-agent-result').length, 30);
  assert.equal(t.calls.injected.filter((x) => x.job).length, 30);
  assert.equal(r.count, 30);
});

test('F1:本輪建的視窗,結束時該分頁已被拖到別的視窗:不 windows.remove(只關分頁)', async () => {
  const t = build(
    { agent: AGENT, windows: 0, runJob: async () => { for (const tab of t.state.tabs.values()) tab.windowId = 77; return okQuery; } },
    { poll: pollOf([job('a')]), result: resultOk }
  );
  await t.core.run();
  assert.deepEqual(t.calls.windowsRemoved, []);
  assert.equal(t.calls.tabsRemoved.length, 1);
});
