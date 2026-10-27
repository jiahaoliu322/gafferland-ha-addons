'use strict';
// b8③:background.js 在 vm 裡用假 chrome 跑——下載觸發、gfl-peek／gfl-run-now、舊鍵清理。
// 全部合成資料。agent-core 用替身(記錄 run／peek 呼叫);最後一案接真的 agent-core。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realCore = require('../agent-core');
const { makeFakeChrome, makeFakeSite, AGENT } = require('./helpers/fake-chrome');

const BG_SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const GETPDF_URL = 'https://www.fetc.net.tw/UX0000Common/UX000006GetPDF?&r=1700000000000';

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
  return { ...fake, runs, peeks, fire: fake.chrome.downloads.onChanged.fire };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const complete = (id) => ({ id, state: { previous: 'in_progress', current: 'complete' } });

async function downloadCase({ url, pdfPending = true, delta, unset }) {
  const b = loadBackground({ agent: AGENT });
  b.state.downloads.push({ id: 7, url, finalUrl: url, state: 'complete', startTime: '2026-10-28T00:00:00.000Z' });
  if (!unset) await b.local.set({ pdfPending });
  b.fire(delta || complete(7));
  await flush();
  return b;
}

test('③下載觸發:pdfPending=true＋遠通憑證下載 complete → run 一次(trigger download)', async () => {
  const b = await downloadCase({ url: GETPDF_URL });
  assert.deepEqual(b.runs, [{ trigger: 'download' }]);
  assert.deepEqual(b.calls.downloads, []);
  // 路徑比對不分大小寫
  const b2 = await downloadCase({ url: 'https://www.fetc.net.tw/ux0000common/UX000006GETPDF?&r=1' });
  assert.deepEqual(b2.runs, [{ trigger: 'download' }]);
});

// T-1:每個反例一個獨立 test(),案名帶條件,失敗時一眼看出是哪一條
const NEGATIVE_CASES = [
  ['非遠通網域', { url: 'https://evil.example/UX0000Common/UX000006GetPDF' }],
  ['網域只是前綴像遠通(fetc.net.tw.evil.example)', { url: 'https://www.fetc.net.tw.evil.example/UX0000Common/UX000006GetPDF' }],
  ['少了 www 的 fetc.net.tw', { url: 'https://fetc.net.tw/UX0000Common/UX000006GetPDF' }],
  ['http 不是 https', { url: 'http://www.fetc.net.tw/UX0000Common/UX000006GetPDF' }],
  ['路徑多一段(/GetPDF/x)', { url: 'https://www.fetc.net.tw/UX0000Common/UX000006GetPDF/x' }],
  ['遠通別的路徑(/Member)', { url: 'https://www.fetc.net.tw/Member' }],
  ['遠通網址只出現在 query', { url: 'https://evil.example/?u=https://www.fetc.net.tw/UX0000Common/UX000006GetPDF' }],
  ['網址無法解析', { url: 'not a url' }],
  ['pdfPending=false', { url: GETPDF_URL, pdfPending: false }],
  ['pdfPending 未設', { url: GETPDF_URL, unset: true }],
  ["pdfPending 是字串 'true'", { url: GETPDF_URL, pdfPending: 'true' }],
  ['state complete→in_progress', { url: GETPDF_URL, delta: { id: 7, state: { previous: 'complete', current: 'in_progress' } } }],
  ['state interrupted', { url: GETPDF_URL, delta: { id: 7, state: { current: 'interrupted' } } }],
  ['delta 沒有 state(只改檔名)', { url: GETPDF_URL, delta: { id: 7, filename: { current: 'x.pdf' } } }],
  ['查不到這筆下載(id 不符)', { url: GETPDF_URL, delta: complete(8) }],
];
for (const [label, c] of NEGATIVE_CASES) {
  test(`③下載觸發反例:${label} → 不跑、不碰下載`, async () => {
    const b = await downloadCase(c);
    assert.deepEqual(b.runs, []);
    assert.deepEqual(b.calls.downloads, []);
  });
}

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

test('③onInstalled／onStartup:清舊鍵 cfTab＋lastClearance,其他鍵不動;載入時不自己跑', async () => {
  for (const ev of ['onInstalled', 'onStartup']) {
    const b = loadBackground({ agent: AGENT });
    await b.local.set({ cfTab: { tabId: 1, windowId: null }, lastClearance: { at: 1 }, lastRun: { at: 1 }, pdfPending: true });
    b.chrome.runtime[ev].fire({});
    await flush();
    assert.equal(b.local.m.has('cfTab'), false, ev);
    assert.equal(b.local.m.has('lastClearance'), false, ev);
    assert.ok(b.local.m.has('agent') && b.local.m.has('lastRun') && b.local.m.has('pdfPending'), ev);
    assert.deepEqual(b.runs, [], ev);
    assert.deepEqual(b.peeks, [], ev);
  }
});

test('③接真的 agent-core:員工下載憑證 → 補跑一輪、lastRun.trigger=download、pdfPending 清掉、不碰下載', async () => {
  let n = 0;
  const site = makeFakeSite({
    poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: n++ ? [] : [{ id: 'sp:1', type: 'settle-print', payload: {} }], queue: { byType: {} } } }),
    result: () => ({ status: 200, json: { ok: true, next: [] } }),
  });
  const b = loadBackground(
    { agent: AGENT, runJob: async () => ({ ok: true, data: { pdfs: [{ plateRaw: 'TEST-001', ok: true, pdfBase64: 'JVBERi0=', printTotal: 1 }] } }) },
    { real: true, site }
  );
  b.state.downloads.push({ id: 3, url: GETPDF_URL, state: 'complete' });
  await b.local.set({ pdfPending: true });
  b.fire(complete(3));
  for (let i = 0; i < 200 && !b.local.m.has('lastRun'); i++) await new Promise((r) => setTimeout(r, 5));
  const lr = b.local.m.get('lastRun');
  assert.equal(lr.trigger, 'download');
  assert.equal(lr.state, 'ok');
  assert.equal(b.local.m.get('pdfPending'), false);
  assert.equal(site.log.filter((l) => l.action === 'etag-agent-result').length, 1);
  assert.deepEqual(b.calls.downloads, []);
  assert.deepEqual(b.calls.tabsUpdated, []);
});
