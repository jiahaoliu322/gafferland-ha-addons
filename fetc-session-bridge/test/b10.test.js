'use strict';
// b10:擴充功能 2.2.0——拆掉憑證相關;popup 顯示待補憑證與匯入指引。
// popup.js／options.js 在 vm 裡用 linkedom＋假 chrome 真的跑;agent-core 用假站台。全部合成資料(零真實車牌／帳號)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const core = require('../agent-core');
const { makeFakeChrome, build, AGENT } = require('./helpers/fake-chrome');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

// 合成站台網址:故意跟預設網址、storage 的 baseUrl 都不同,才分得出「用的是已配對站台」
const PAIRED_BASE = 'https://paired-site.example.test';
const OTHER_BASE = 'https://options-baseurl.example.test';
const PAIRED = { agentId: 'ag1', token: 'TESTTOKEN-synthetic', name: '測試電腦', baseUrl: PAIRED_BASE };
const qOf = (byType) => ({ open: 0, claimed: 0, oldestAt: null, byType: { 'settle-query': 0, scan: 0, 'settle-print': 0, 'attach-print': 0, ...(byType || {}) } });
const HINT = (m) => `憑證 ${m} 份待補：到遠通下載該車的通行費紀錄 PDF，再到網站「eTag 待補憑證」匯入（擴充功能不會自動抓憑證）。`;

// peekResult:gfl-peek 的回應 result;null＝背景頁回應失敗
async function renderPopup({ stored, peekResult, cookies }) {
  const { document } = parseHTML(read('popup.html'));
  const fake = makeFakeChrome({ cookies });
  await fake.local.set(stored || {});
  fake.chrome.runtime.sendMessage = async (msg) =>
    msg.type === 'gfl-peek' ? (peekResult ? { ok: true, result: peekResult } : { ok: false }) : { ok: true };
  fake.chrome.runtime.openOptionsPage = () => {};
  const ctx = { document, chrome: fake.chrome, GflAgentCore: core, console: { log() {}, error() {} } };
  vm.createContext(ctx);
  vm.runInContext(read('popup.js'), ctx);
  await flush();
  return { doc: document, fake };
}
const peekOf = (paired, byType) => ({ paired, loggedIn: true, queue: qOf(byType), mode: 'browser' });

// ── ①憑證指引＋「開啟匯入頁」 ────────────────────────────────────────────────────

test('b10①:已配對＋M＞0 → 顯示憑證指引(M＝settle-print＋attach-print);點「開啟匯入頁」開 {baseUrl}/collect#etag-receipts', async () => {
  const { doc, fake } = await renderPopup({
    stored: { agent: PAIRED, baseUrl: OTHER_BASE },
    peekResult: peekOf(true, { 'settle-query': 1, 'settle-print': 2, 'attach-print': 1 }),
  });
  assert.equal(doc.getElementById('receiptHint').style.display, 'block');
  assert.equal(doc.getElementById('receiptHintText').textContent, HINT(3));
  assert.equal(doc.getElementById('openReceiptsBtn').textContent, '開啟匯入頁');
  assert.equal(doc.getElementById('queueVal').textContent, '查詢 1 筆・憑證 3 份', '待處理列沿用 peek');
  const before = fake.calls.tabsCreated.length;
  doc.getElementById('openReceiptsBtn').onclick();
  // vm 裡建的物件 prototype 不同:JSON 來回再比
  assert.deepEqual(JSON.parse(JSON.stringify(fake.calls.tabsCreated.slice(before))), [{ url: `${PAIRED_BASE}/collect#etag-receipts` }]);
});

test('b10 守門:「開啟匯入頁」網址一律以已配對 baseUrl 開頭(舊網域經 resolveBaseUrl 退回預設)', async () => {
  for (const [base, want] of [
    [PAIRED_BASE, PAIRED_BASE],
    [`${PAIRED_BASE}/`, PAIRED_BASE],
    ['https://gafferland.vercel.app', core.DEFAULT_BASE_URL],
  ]) {
    const { doc, fake } = await renderPopup({
      stored: { agent: { ...PAIRED, baseUrl: base }, baseUrl: OTHER_BASE },
      peekResult: peekOf(true, { 'attach-print': 1 }),
    });
    const before = fake.calls.tabsCreated.length;
    doc.getElementById('openReceiptsBtn').onclick();
    const created = fake.calls.tabsCreated.slice(before);
    assert.equal(created.length, 1, base);
    assert.ok(created[0].url.startsWith(`${want}/`), `${base} → ${created[0].url}`);
    assert.equal(created[0].url, `${want}/collect#etag-receipts`, base);
  }
});

for (const [label, opts] of [
  ['未配對(peek 仍回 M＞0)', { stored: {}, peekResult: peekOf(false, { 'attach-print': 2 }) }],
  ['未配對＋2.1.x 殘留 pdfPending', { stored: { pdfPending: true }, peekResult: peekOf(false, { 'settle-print': 1 }) }],
  ['已配對＋M＝0', { stored: { agent: PAIRED }, peekResult: peekOf(true, { 'settle-query': 3 }) }],
  ['已配對＋M＝0＋2.1.x 殘留 pdfPending', { stored: { agent: PAIRED, pdfPending: true }, peekResult: peekOf(true, {}) }],
  ['已配對＋peek 失敗', { stored: { agent: PAIRED }, peekResult: null }],
]) {
  test(`b10①:${label} → 不顯示憑證指引`, async () => {
    const { doc, fake } = await renderPopup(opts);
    assert.equal(doc.getElementById('receiptHint').style.display, 'none');
    assert.equal(doc.getElementById('receiptHintText').textContent, '');
    assert.equal(doc.getElementById('openReceiptsBtn').onclick, null);
    assert.equal(doc.getElementById('agentVal').textContent, opts.stored.agent ? `已配對:${PAIRED.name}` : '未配對', '確認 popup 真的跑完 renderAgent');
    assert.equal(fake.calls.tabsCreated.length, 0);
  });
}

test('b10 T1:已配對＋未登入(沒有遠通登入 cookie)＋M＞0 → 憑證指引仍顯示、「開啟匯入頁」可點(匯入頁是 Gafferland 網站,不需遠通登入)', async () => {
  const { doc, fake } = await renderPopup({
    stored: { agent: PAIRED },
    peekResult: peekOf(true, { 'attach-print': 2 }),
    cookies: [],
  });
  assert.equal(doc.getElementById('runNote').textContent, '請先登入遠通會員區，再回來按「執行」。', '確認真的是未登入分支');
  assert.equal(doc.getElementById('receiptHint').style.display, 'block');
  assert.equal(doc.getElementById('receiptHintText').textContent, HINT(2));
  assert.equal(typeof doc.getElementById('openReceiptsBtn').onclick, 'function');
  const before = fake.calls.tabsCreated.length;
  doc.getElementById('openReceiptsBtn').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(fake.calls.tabsCreated.slice(before))), [{ url: `${PAIRED_BASE}/collect#etag-receipts` }]);
});

// ── ②runNote 字面 ─────────────────────────────────────────────────────────────

for (const [label, opts, want] of [
  ['N＞0', { stored: { agent: PAIRED }, peekResult: peekOf(true, { scan: 1, 'attach-print': 2 }) }, '按「執行」會在背景開遠通分頁查詢並計算金額，做完自動關閉。'],
  ['N＝0 且 M＞0', { stored: { agent: PAIRED }, peekResult: peekOf(true, { 'attach-print': 2 }) }, '目前沒有要查詢的；憑證請到網站匯入。'],
  ['都 0', { stored: { agent: PAIRED }, peekResult: peekOf(true, {}) }, '目前沒有待處理工作。'],
  ['未配對(維持)', { stored: {}, peekResult: peekOf(false, { 'settle-query': 1 }) }, '請先到設定頁輸入配對碼。'],
  ['未登入(維持)', { stored: { agent: PAIRED }, peekResult: peekOf(true, { 'settle-query': 1 }), cookies: [] }, '請先登入遠通會員區，再回來按「執行」。'],
]) {
  test(`b10②:runNote ${label}`, async () => {
    const { doc } = await renderPopup(opts);
    assert.equal(doc.getElementById('runNote').textContent, want);
  });
}

test('b10②:popup 原始碼無「列印後／下載完成後會自動補跑」文案、無 pdfPending', () => {
  const src = read('popup.js') + read('popup.html');
  assert.ok(!/自動補跑，或再按|列印後會自動補跑|下載完成後會自動補跑|任一筆按一次「列印」/.test(src));
  assert.ok(!/pdfPending/.test(src));
});

// ── ③被移除／解除配對清 lastError、pendingError ──────────────────────────────────

const ERR_RESIDUE = { lastError: { at: 1, message: 'cf-challenge step=x status=403' }, pendingError: 'job-timeout', lastPeek: { at: 1, queue: null }, cinCache: { 'TEST-001': 'CIN1' } };
const assertCleared = (local, label) => {
  for (const k of ['agent', 'lastError', 'pendingError', 'lastPeek', 'cinCache']) assert.equal(local.m.has(k), false, `${label}:${k}`);
};

test('b10③:run 的 poll 回 401 → lastError／pendingError 一併清掉', async () => {
  const t = build({ agent: AGENT }, { poll: () => ({ status: 401, json: { ok: false } }), result: () => ({ status: 200, json: { ok: true } }) });
  await t.local.set(ERR_RESIDUE);
  assert.equal((await t.core.run()).state, 'revoked');
  assertCleared(t.local, 'poll 401');
});

test('b10③:run 中 result 回 401(這輪剛有錯誤)→ lastError／pendingError 也不留', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => ({ ok: false, reason: 'error', message: 'synthetic' }) },
    {
      poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [{ id: 'a', type: 'settle-query', payload: {} }], queue: qOf() } }),
      result: () => ({ status: 401, json: { ok: false } }),
    }
  );
  await t.local.set(ERR_RESIDUE);
  assert.equal((await t.core.run()).state, 'revoked');
  assertCleared(t.local, 'result 401');
});

test('b10③:peek 回 401 與 clearPairing 本身都清 lastError／pendingError,不清 lastRun', async () => {
  const t = build({ agent: AGENT }, { poll: () => ({ status: 401, json: { ok: false } }), result: () => ({ status: 200, json: { ok: true } }) });
  await t.local.set(ERR_RESIDUE);
  assert.equal((await t.core.peek()).revoked, true);
  assertCleared(t.local, 'peek 401');
  const t2 = build({ agent: AGENT }, { poll: () => ({ status: 200, json: { ok: true, jobs: [] } }), result: () => ({ status: 200, json: { ok: true } }) });
  await t2.local.set({ ...ERR_RESIDUE, lastRun: { at: 1 } });
  await t2.core.clearPairing();
  assertCleared(t2.local, 'clearPairing');
  assert.ok(t2.local.m.has('lastRun'));
});

test('b10③:設定頁「解除配對」(真的跑 options.js)清 lastError／pendingError 與其他本機狀態,保留站台網址', async () => {
  const { document } = parseHTML(read('options.html'));
  const fake = makeFakeChrome({});
  await fake.local.set({ ...ERR_RESIDUE, agent: PAIRED, baseUrl: PAIRED_BASE, lastRun: { at: 1 }, fetcState: { state: 'ok', at: 1 } });
  fake.chrome.runtime.getManifest = () => ({ version: '2.2.0', host_permissions: ['https://*.fetc.net.tw/*', 'https://admin.gafferland.com/*'] });
  const listeners = {};
  const unpair = document.getElementById('unpairBtn');
  const origAdd = unpair.addEventListener.bind(unpair);
  unpair.addEventListener = (ev, fn) => { listeners[ev] = fn; origAdd(ev, fn); };
  const ctx = { document, chrome: fake.chrome, GflAgentCore: core, console: { log() {}, error() {} }, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(read('options.js'), ctx);
  await flush();
  assert.equal(document.getElementById('pairedBox').style.display, 'block', '先是已配對');
  await listeners.click();
  await flush();
  for (const k of ['agent', 'lastError', 'pendingError', 'lastPeek', 'cinCache', 'lastRun', 'fetcState']) assert.equal(fake.local.m.has(k), false, k);
  assert.equal(fake.local.m.get('baseUrl'), PAIRED_BASE);
  assert.equal(document.getElementById('unpairedBox').style.display, 'block');
});

// ── ④manifest／原始碼無 downloads ─────────────────────────────────────────────

test('b10④:manifest 2.3.0、權限無 downloads、description 新字面;background／agent-core 無 downloads 字面', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.version, '2.3.0');
  assert.deepEqual(m.permissions, ['cookies', 'scripting', 'storage', 'tabs']);
  assert.match(m.description, /由員工按「執行」時在這台電腦已登入的遠通分頁內代為查詢通行明細，交回 Gafferland 站台計算金額（平常不自動連線；收款憑證請在網站匯入遠通 PDF）。$/);
  assert.ok(!/產生收款憑證/.test(m.description));
  for (const f of ['background.js', 'agent-core.js', 'manifest.json']) assert.ok(!/downloads/.test(read(f)), `${f} 出現 downloads`);
  assert.equal(core.PRINT_TYPES, undefined, 'PRINT_TYPES 已刪');
  assert.equal(core.msgPdfBlocked, undefined, '憑證待補訊息已刪');
});

// ── ⑤舊站台仍發 attach-print:一般錯誤路徑、不寫 pdfPending ─────────────────────────

test('b10⑤:舊站台發 attach-print(GetPDF 403＝cf-challenge)→ 照回報、記最後錯誤、後面的查詢照做、整輪 ok、storage 無 pdfPending', async () => {
  const jobs = [
    { id: 'ap:R1:W1', type: 'attach-print', payload: { recordId: 'R1', rowId: 'W1', plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'], filename: 'f.pdf' }] } },
    { id: 'sq:1', type: 'settle-query', payload: { plates: ['TEST-002'], startDate: '2026/07/20', endDate: '2026/07/21' } },
  ];
  let polled = 0;
  const t = build(
    {
      agent: AGENT,
      runJob: async (j) =>
        j.type === 'attach-print'
          ? { ok: false, reason: 'cf-challenge', message: 'cf-challenge step=getpdf status=403' }
          : { ok: true, data: { perPlate: { 'TEST-002': { ok: true, transactions: [] } } } },
    },
    {
      poll: (body) => {
        assert.deepEqual(body.exclude, ['settle-print', 'attach-print'], 'poll 一律帶 exclude');
        return { status: 200, json: { ok: true, mode: 'browser', jobs: polled++ ? [] : jobs, queue: qOf({ 'attach-print': 1 }) } };
      },
      result: () => ({ status: 200, json: { ok: true, next: [] } }),
    }
  );
  const r = await t.core.run({ trigger: 'popup' });
  const results = t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
  assert.deepEqual(results.map((b) => [b.id, b.ok, b.reason]), [['ap:R1:W1', false, 'cf-challenge'], ['sq:1', true, undefined]]);
  assert.deepEqual(t.calls.injected.filter((x) => x.job).map((x) => x.job), ['ap:R1:W1', 'sq:1']);
  assert.equal(r.state, 'ok');
  assert.equal(r.message, '完成 2 筆工作');
  assert.equal(t.local.m.has('pdfPending'), false);
  assert.deepEqual(t.local.m.get('lastError'), { at: t.clock(), message: 'cf-challenge step=getpdf status=403' });
  assert.equal(t.calls.tabsRemoved.length, 1);
  assert.equal(polled, 2, '佇列空了照常再問一次(沒有因憑證被擋提早停)');
});

test('b10⑤:查詢工作被 CF 擋仍整輪停(只有憑證類改走一般錯誤)', async () => {
  const sq = (id) => ({ id, type: 'settle-query', payload: { plates: ['TEST-001'], startDate: '2026/07/20', endDate: '2026/07/21' } });
  const t = build(
    { agent: AGENT, runJob: async () => ({ ok: false, reason: 'cf-challenge', message: 'cf-challenge step=query status=403' }) },
    { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [sq('a'), sq('b')], queue: qOf() } }), result: () => ({ status: 200, json: { ok: true, next: [] } }) }
  );
  const r = await t.core.run();
  assert.equal(r.state, 'cf-interactive');
  assert.deepEqual(t.calls.injected.filter((x) => x.job).map((x) => x.job), ['a']);
  assert.equal(t.local.m.has('pdfPending'), false);
});

// ── F1:poll／peek 一律帶 exclude(舊站台只認 exclude、不認 b9 的伺服器端排除) ─────────────────────

// 模擬「舊站台」:只認 body.exclude;領出去的工作 attempts+1(憑證類被領＝會被燒次數)
function makeOldSite(items) {
  const state = items.map((j) => ({ ...j, attempts: 0, done: false }));
  const claimed = [];
  return {
    state,
    claimed,
    handlers: {
      poll: (body) => {
        const ex = Array.isArray(body.exclude) ? body.exclude : [];
        const jobs = [];
        for (const j of state) {
          if (j.done || ex.includes(j.type) || jobs.length >= body.max) continue;
          j.attempts++;
          claimed.push(j.id);
          jobs.push({ id: j.id, type: j.type, payload: j.payload });
        }
        return { status: 200, json: { ok: true, mode: 'browser', jobs, queue: qOf({ 'attach-print': state.filter((j) => j.type === 'attach-print' && !j.done).length }) } };
      },
      result: (body) => {
        const j = state.find((x) => x.id === body.id);
        if (j && body.ok) j.done = true;
        return { status: 200, json: { ok: true, next: [] } };
      },
    },
  };
}

test('b10 F1:舊站台(只認 exclude)放 1 筆 attach-print＋1 筆 settle-query,連跑 6 輪 → attach-print 從未被領、attempts 不變、settle-query 正常完成', async () => {
  const site = makeOldSite([
    { id: 'ap:R1:W1', type: 'attach-print', payload: { recordId: 'R1', rowId: 'W1', plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'], filename: 'f.pdf' }] } },
    { id: 'sq:1', type: 'settle-query', payload: { plates: ['TEST-002'], startDate: '2026/07/20', endDate: '2026/07/21' } },
  ]);
  const t = build(
    { agent: AGENT, runJob: async () => ({ ok: true, data: { perPlate: { 'TEST-002': { ok: true, transactions: [] } } } }) },
    site.handlers
  );
  for (let i = 0; i < 6; i++) await t.core.run({ trigger: 'popup' });
  const ap = site.state.find((j) => j.id === 'ap:R1:W1');
  const sq = site.state.find((j) => j.id === 'sq:1');
  assert.equal(ap.attempts, 0, 'attach-print attempts 不變');
  assert.equal(ap.done, false);
  assert.ok(!site.claimed.includes('ap:R1:W1'), 'attach-print 從未被領');
  assert.equal(sq.done, true, 'settle-query 正常完成');
  assert.equal(sq.attempts, 1);
  assert.equal(t.calls.injected.filter((x) => x.job).map((x) => x.job).join(), 'sq:1');
  const polls = t.site.log.filter((l) => l.action === 'etag-agent-poll');
  assert.ok(polls.length >= 6);
  for (const l of polls) assert.deepEqual(l.body.exclude, ['settle-print', 'attach-print']);
});

test('b10 F1:peek(max:0)也帶 exclude', async () => {
  const site = makeOldSite([]);
  const t = build({ agent: AGENT }, site.handlers);
  await t.core.peek();
  const polls = t.site.log.filter((l) => l.action === 'etag-agent-poll');
  assert.equal(polls.length, 1);
  assert.equal(polls[0].body.max, 0);
  assert.deepEqual(polls[0].body.exclude, ['settle-print', 'attach-print']);
});
