'use strict';
// b8③:background.js 在 vm 裡用假 chrome 跑——gfl-peek／gfl-run-now、舊鍵清理。
// b10(2.2.0):下載觸發整組刪除(擴充功能不再碰憑證);改成「background 原始碼無 downloads」＋onStartup 清三鍵。
// 全部合成資料。agent-core 用替身(記錄 run／peek 呼叫);最後一案接真的 agent-core。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realCore = require('../agent-core');
const { makeFakeChrome, makeFakeSite, AGENT } = require('./helpers/fake-chrome');

const BG_SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function loadBackground(fakeOpts, opts) {
  const fake = makeFakeChrome(fakeOpts);
  const runs = [];
  const peeks = [];
  // vm 裡建的物件 prototype 不同:一律 JSON 來回再記,deepStrictEqual 才比得了
  const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const stub = {
    run: async (o) => { runs.push(plain(o)); return { state: 'ok' }; },
    peek: async () => { peeks.push(1); return { paired: true, loggedIn: true, queue: null, mode: 'browser' }; },
    clearPairing: async () => {},
  };
  const site = opts && opts.site;
  const ctx = {
    chrome: fake.chrome,
    console: { log() {} },
    URL,
    setInterval,
    clearInterval,
    fetch: site ? site.fetch : async () => { throw new Error('background 不該 fetch'); },
    importScripts(f) {
      assert.equal(f, 'agent-core.js');
      ctx.GflAgentCore = opts && opts.real ? realCore : { ...realCore, createAgentCore: () => stub };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(BG_SRC, ctx);
  return { ...fake, runs, peeks };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
test('③popup 訊息:gfl-peek → core.peek;gfl-run-now → run(trigger popup);別的擴充功能送的不理', async () => {
  const b = loadBackground({ agent: AGENT });
  const id = b.chrome.runtime.id;
  const got = [];
  const ret = b.chrome.runtime.onMessage.fire({ type: 'gfl-peek' }, { id }, (r) => got.push(JSON.parse(JSON.stringify(r))));
  assert.deepEqual(ret, [true]);
  await flush();
  assert.equal(b.peeks.length, 1);
  assert.equal(b.runs.length, 0);
  assert.deepEqual(got, [{ ok: true, result: { paired: true, loggedIn: true, queue: null, mode: 'browser' } }]);
  b.chrome.runtime.onMessage.fire({ type: 'gfl-run-now' }, { id }, () => {});
  await flush();
  assert.deepEqual(b.runs, [{ trigger: 'popup' }]);
  assert.deepEqual(b.chrome.runtime.onMessage.fire({ type: 'gfl-run-now' }, { id: 'other-ext' }, () => {}), [false]);
  assert.deepEqual(b.chrome.runtime.onMessage.fire({ type: 'other' }, { id }, () => {}), [false]);
  await flush();
  assert.equal(b.runs.length, 1);
  assert.equal(b.peeks.length, 1);
});

test('b10:onInstalled／onStartup:清舊鍵 cfTab＋lastClearance＋pdfPending,其他鍵不動;載入時不自己跑', async () => {
  for (const ev of ['onInstalled', 'onStartup']) {
    const b = loadBackground({ agent: AGENT });
    await b.local.set({ cfTab: { tabId: 1, windowId: null }, lastClearance: { at: 1 }, lastRun: { at: 1 }, pdfPending: true });
    b.chrome.runtime[ev].fire({});
    await flush();
    for (const k of ['cfTab', 'lastClearance', 'pdfPending']) assert.equal(b.local.m.has(k), false, `${ev}:${k}`);
    assert.ok(b.local.m.has('agent') && b.local.m.has('lastRun'), ev);
    assert.deepEqual(b.runs, [], ev);
    assert.deepEqual(b.peeks, [], ev);
  }
});

test('b10f F2:onInstalled 升級(reason=update)再清 lastError／pendingError;全新安裝不動它們;onStartup 不清這兩鍵', async () => {
  const keep = { lastError: { at: 1, message: 'cf-challenge step=getpdf status=403' }, pendingError: 'cf-challenge step=getpdf status=403', lastRun: { at: 1 } };
  {
    const b = loadBackground({ agent: AGENT });
    await b.local.set({ ...keep, cfTab: { tabId: 1, windowId: null }, pdfPending: true });
    b.chrome.runtime.onInstalled.fire({ reason: 'update', previousVersion: '2.1.0' });
    await flush();
    for (const k of ['lastError', 'pendingError', 'cfTab', 'pdfPending']) assert.equal(b.local.m.has(k), false, `update:${k}`);
    assert.ok(b.local.m.has('lastRun') && b.local.m.has('agent'), 'update:其他鍵不動');
  }
  for (const [label, fire] of [['install', (b) => b.chrome.runtime.onInstalled.fire({ reason: 'install' })], ['onStartup', (b) => b.chrome.runtime.onStartup.fire({})], ['onInstalled 無 details', (b) => b.chrome.runtime.onInstalled.fire()]]) {
    const b = loadBackground({ agent: AGENT });
    await b.local.set(keep);
    fire(b);
    await flush();
    for (const k of ['lastError', 'pendingError', 'lastRun']) assert.equal(b.local.m.has(k), true, `${label}:${k} 不該被清`);
  }
});

test('b10④:background 原始碼無 downloads 字面;假 chrome 沒有 downloads 也照常載入(只掛 onInstalled／onStartup／onMessage)', () => {
  assert.ok(!/downloads/.test(BG_SRC), 'background.js 出現 downloads');
  assert.ok(!/getpdf/i.test(BG_SRC), 'background.js 出現 GetPDF 路徑');
  const b = loadBackground({ agent: AGENT });
  assert.equal('downloads' in b.chrome, false, '假 chrome 已無 downloads(誤用會直接丟錯)');
  assert.equal(b.chrome.runtime.onInstalled.listeners.length, 1);
  assert.equal(b.chrome.runtime.onStartup.listeners.length, 1);
  assert.equal(b.chrome.runtime.onMessage.listeners.length, 1);
});

test('b10:接真的 agent-core:popup「執行」跑一輪查詢、lastRun.trigger=popup、不寫 pdfPending', async () => {
  let n = 0;
  const site = makeFakeSite({
    poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: n++ ? [] : [{ id: 'sq:1', type: 'settle-query', payload: {} }], queue: { byType: { 'attach-print': 2 } } } }),
    result: () => ({ status: 200, json: { ok: true, next: [] } }),
  });
  const b = loadBackground(
    { agent: AGENT, runJob: async () => ({ ok: true, data: { perPlate: { 'TEST-001': { ok: true, transactions: [] } } } }) },
    { real: true, site }
  );
  b.chrome.runtime.onMessage.fire({ type: 'gfl-run-now' }, { id: b.chrome.runtime.id }, () => {});
  for (let i = 0; i < 200 && !b.local.m.has('lastRun'); i++) await new Promise((r) => setTimeout(r, 5));
  const lr = b.local.m.get('lastRun');
  assert.equal(lr.trigger, 'popup');
  assert.equal(lr.state, 'ok');
  assert.equal(b.local.m.has('pdfPending'), false);
  assert.equal(site.log.filter((l) => l.action === 'etag-agent-result').length, 1);
  assert.deepEqual(b.calls.tabsUpdated, []);
});
