'use strict';
// b8:2.1.0「你要才執行」——一鍵跑完佇列、憑證被擋只擋憑證、peek、未登入、驗證頁、trigger。
// 假 chrome＋假站台;全部合成資料(零真實車牌／帳號)。
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../agent-core');
const { build, AGENT } = require('./helpers/fake-chrome');

const MEMBER = 'https://www.fetc.net.tw/Member';
const payload = { plates: ['TEST-001'], startDate: '2026/07/20', endDate: '2026/07/21' };
const sq = (id) => ({ id, type: 'settle-query', payload });
const sc = (id) => ({ id, type: 'scan', payload });
const sp = (id) => ({ id, type: 'settle-print', payload: { ...payload, plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'] }] } });
const ap = (id) => ({ id, type: 'attach-print', payload: { ...payload, recordId: 'R1', rowId: 'W1', plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'], filename: 'f.pdf' }] } });
const okQuery = { ok: true, data: { perPlate: { 'TEST-001': { ok: true, transactions: [] } } }, cinCache: { 'TEST-001': 'CIN1' } };
const okPrint = { ok: true, data: { pdfs: [{ plateRaw: 'TEST-001', ok: true, pdfBase64: 'JVBERi0=', printTotal: 30 }] } };
const cfPage = () => ({ ok: false, reason: 'cf-challenge', message: 'cf-challenge step=getpdf status=403' });
const resultOk = () => ({ status: 200, json: { ok: true, next: [] } });
const qOf = (byType) => ({ open: 0, claimed: 0, oldestAt: null, byType: { 'settle-query': 0, scan: 0, 'settle-print': 0, 'attach-print': 0, ...(byType || {}) } });
const lastRun = (t) => t.local.m.get('lastRun');
const polls = (t) => t.site.log.filter((l) => l.action === 'etag-agent-poll');
const results = (t) => t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
const ran = (t) => t.calls.injected.filter((x) => x.job).map((x) => x.job);
const assertOnlyMemberNav = (t) => {
  for (const c of [...t.calls.tabsCreated, ...t.calls.windowsCreated, ...t.calls.tabsUpdated]) assert.equal(c.url, MEMBER);
};

// 依序回應的假站台 poll:batches[i] 是第 i 次 poll 回的工作(超過就回空),每次都帶 queue 統計
const seqPoll = (batches, queueOf) => {
  let i = 0;
  return () => {
    const jobs = batches[i] || [];
    const q = queueOf ? queueOf(i) : qOf();
    i++;
    return { status: 200, json: { ok: true, mode: 'browser', jobs, pollAfterSec: 300, queue: q } };
  };
};

// 比較真實的假站台:佇列＋claim;cf-challenge／cf-interactive／login-required 回報＝釋放回佇列(退還次數),其餘＝完成刪除
// poll body.exclude(陣列)內的型別不發(b78f F-1,同站台 pollFor 契約)
function queueSite(initial) {
  const open = new Map(initial.map((j) => [j.id, j]));
  const claimed = new Set();
  const byType = () => {
    const bt = { 'settle-query': 0, scan: 0, 'settle-print': 0, 'attach-print': 0 };
    for (const j of open.values()) bt[j.type]++;
    return bt;
  };
  return {
    open,
    poll: (body) => {
      const jobs = [];
      for (const j of open.values()) {
        if (jobs.length >= (body.max || 0)) break;
        if (body.fetcState !== 'ok' || claimed.has(j.id)) continue;
        if (Array.isArray(body.exclude) && body.exclude.includes(j.type)) continue;
        claimed.add(j.id);
        jobs.push(j);
      }
      return { status: 200, json: { ok: true, mode: 'browser', jobs, pollAfterSec: 300, queue: { open: open.size, claimed: claimed.size, oldestAt: null, byType: byType() } } };
    },
    result: (body) => {
      if (!claimed.has(body.id)) return { status: 409, json: { ok: false, reason: 'not-claimed' } };
      claimed.delete(body.id);
      if (!(body.ok === false && ['cf-challenge', 'cf-interactive', 'login-required'].includes(body.reason))) open.delete(body.id);
      return { status: 200, json: { ok: true, next: [] } };
    },
  };
}

test('①一鍵跑完:站台 poll 連回 3＋2＋0 筆 → 三次 poll、5 筆全做、分頁關閉', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => okQuery },
    { poll: seqPoll([[sq('a1'), sq('a2'), sc('a3')], [sq('b1'), sq('b2')], []]), result: resultOk }
  );
  const r = await t.core.run({ trigger: 'popup' });
  assert.equal(polls(t).length, 3);
  assert.deepEqual(polls(t).map((l) => l.body.max), [10, 10, 10]);
  assert.ok(polls(t).every((l) => l.body.fetcState === 'ok'));
  assert.deepEqual(ran(t), ['a1', 'a2', 'a3', 'b1', 'b2']);
  assert.equal(results(t).length, 5);
  assert.equal(t.calls.tabsCreated.length, 1);
  assert.equal(t.calls.tabsRemoved.length, 1);
  assert.equal(r.state, 'ok');
  assert.equal(r.message, '完成 5 筆工作');
  assert.equal(r.trigger, 'popup');
  assert.equal(t.local.m.get('pdfPending'), false);
  assertOnlyMemberNav(t);
});

test('①b 再 poll 上限:站台每次都給新工作 → 最多 10 次 poll(MAX_POLLS_PER_RUN)', async () => {
  let n = 0;
  const t = build(
    { agent: AGENT, runJob: async () => okQuery },
    { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [sq(`j${n++}`)], queue: qOf({ 'settle-query': 1 }) } }), result: resultOk }
  );
  await t.core.run();
  assert.equal(core.MAX_POLLS_PER_RUN, 10);
  assert.equal(polls(t).length, 10);
  assert.equal(ran(t).length, 10);
});

test('①c 單輪 30 筆上限也擋再 poll:每次回 10 筆 → 3 次 poll、30 筆,不做第 4 次', async () => {
  let n = 0;
  const t = build(
    { agent: AGENT, runJob: async () => okQuery },
    {
      poll: (body) => ({ status: 200, json: { ok: true, mode: 'browser', jobs: Array.from({ length: body.max }, () => sq(`j${n++}`)), queue: qOf() } }),
      result: resultOk,
    }
  );
  const r = await t.core.run();
  assert.equal(polls(t).length, 3);
  assert.equal(ran(t).length, 30);
  assert.equal(r.count, 30);
});

test('①d 舊站台(poll 回應沒有 queue 統計):只做第一批,不再 poll', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => okQuery },
    { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [sq('a')], pollAfterSec: 300 } }), result: resultOk }
  );
  await t.core.run();
  assert.equal(polls(t).length, 1);
  assert.deepEqual(ran(t), ['a']);
});

test('②憑證被擋:sp 回 cf-challenge → 照回報、後面的 ap 不執行直接回報 cf-challenge、同輪 sq 照做、pdfPending=true', async () => {
  const site = queueSite([sp('sp:1'), ap('ap:1'), sq('sq:1')]);
  const t = build(
    { agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? cfPage() : j.type === 'attach-print' ? okPrint : okQuery) },
    { poll: site.poll, result: site.result }
  );
  const r = await t.core.run();
  assert.deepEqual(ran(t), ['sp:1', 'sq:1'], '只有 sp 與 sq 在分頁內執行');
  const rs = results(t);
  assert.deepEqual(rs.slice(0, 3), [
    { id: 'sp:1', ok: false, reason: 'cf-challenge' },
    { id: 'ap:1', ok: false, reason: 'cf-challenge' },
    { id: 'sq:1', ok: true, data: okQuery.data },
  ]);
  // b78f:被擋後的 poll 帶 exclude,站台不再發憑證 → 不會有重報
  assert.equal(rs.length, 3);
  assert.equal(polls(t).length, 2);
  assert.equal('exclude' in polls(t)[0].body, false, '被擋之前的 poll 不帶 exclude');
  assert.deepEqual(polls(t)[1].body.exclude, ['settle-print', 'attach-print']);
  assert.deepEqual([...site.open.keys()].sort(), ['ap:1', 'sp:1'], '兩筆憑證仍在站台佇列(未被 claim 卡住)');
  assert.equal(t.local.m.get('pdfPending'), true);
  assert.equal(r.state, 'cf-interactive');
  assert.equal(r.message, '完成 1 筆;憑證待補 2 份:請在遠通任一筆按一次「列印」,下載完成後會自動補跑(或再按「執行」)');
  assert.equal(t.calls.tabsRemoved.length, 1, '分頁照關');
  assert.equal(t.local.m.has('cfTab'), false);
  assertOnlyMemberNav(t);
});

test('②b 憑證被擋寫在 per-plate(ok:true 的 pdfs 帶 cf-challenge)也只擋憑證;查詢 cf-challenge 才整輪停', async () => {
  const t = build(
    {
      agent: AGENT,
      runJob: async (j) =>
        j.type === 'attach-print' ? { ok: true, data: { pdfs: [{ plateRaw: 'TEST-001', ok: false, reason: 'cf-challenge' }] } } : j.id === 'q2' ? cfPage() : okQuery,
    },
    { poll: seqPoll([[ap('a'), sq('q1'), sp('s'), sq('q2'), sq('q3')]]), result: resultOk }
  );
  const r = await t.core.run();
  assert.deepEqual(ran(t), ['a', 'q1', 'q2']);
  assert.deepEqual(results(t).slice(1), [
    { id: 'q1', ok: true, data: okQuery.data },
    { id: 's', ok: false, reason: 'cf-challenge' },
    { id: 'q2', ok: false, reason: 'cf-challenge' },
    { id: 'q3', ok: false, reason: 'cf-interactive' },
  ]);
  assert.equal(polls(t).length, 1, '整輪停就不再 poll');
  assert.equal(r.state, 'cf-interactive');
  assert.equal(t.local.m.get('pdfPending'), true);
  assert.equal(t.local.m.has('cfTab'), false);
});

test('②c 沒被擋但站台還有憑證(最後一次 poll 的 byType)→ pdfPending=true;都沒有 → false', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: seqPoll([[sq('a')], []], (i) => qOf(i === 1 ? { 'attach-print': 2 } : {})), result: resultOk });
  const r = await t.core.run();
  assert.equal(r.state, 'ok');
  assert.equal(t.local.m.get('pdfPending'), true);
  const t2 = build({ agent: AGENT }, { poll: seqPoll([[]], () => qOf({ 'settle-query': 3 })), result: resultOk });
  await t2.local.set({ pdfPending: true });
  const r2 = await t2.core.run();
  assert.equal(r2.message, '沒有待處理工作');
  assert.equal(t2.local.m.get('pdfPending'), false);
  assert.equal(t2.calls.tabsCreated.length + t2.calls.windowsCreated.length, 0);
});

// ── b78f F-1:被擋後 poll 帶 exclude、待補數取自站台 queue ─────────────────────────

test('b78f F-1:被擋之前的 poll 不帶 exclude;被擋之後每次 poll 都帶兩種 print', async () => {
  const t = build(
    { agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? cfPage() : okQuery) },
    { poll: seqPoll([[sq('a')], [sp('s')], [sq('b')], []], () => qOf({ 'settle-print': 1 })), result: resultOk }
  );
  const r = await t.core.run();
  assert.deepEqual(ran(t), ['a', 's', 'b']);
  const bodies = polls(t).map((l) => l.body);
  assert.equal(bodies.length, 4);
  assert.equal('exclude' in bodies[0], false, '第 1 次(未被擋)');
  assert.equal('exclude' in bodies[1], false, '第 2 次(未被擋)');
  assert.deepEqual(bodies[2].exclude, ['settle-print', 'attach-print'], '第 3 次(被擋後)');
  assert.deepEqual(bodies[3].exclude, ['settle-print', 'attach-print'], '第 4 次(被擋後)');
  assert.equal(r.state, 'cf-interactive');
});

test('b78f F-1 重現:一批 10 筆全是憑證、第一筆被擋 → 再 poll 帶 exclude 領到後面的查詢並做完(不被憑證餓死)', async () => {
  const prints = Array.from({ length: 12 }, (_, i) => sp(`sp:${i}`));
  const site = queueSite([...prints, sq('sq:late')]);
  const t = build({ agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? cfPage() : okQuery) }, { poll: site.poll, result: site.result });
  const r = await t.core.run();
  assert.deepEqual(ran(t), ['sp:0', 'sq:late'], '只有第一筆憑證真的跑;查詢有被領到並執行');
  assert.equal(results(t).length, 11, '10 筆憑證各回報一次＋1 筆查詢,不重報');
  assert.equal(site.open.has('sq:late'), false, '查詢已完成');
  assert.equal(site.open.size, 12, '12 筆憑證都還在站台佇列');
  assert.equal(r.message, '完成 1 筆;憑證待補 12 份:請在遠通任一筆按一次「列印」,下載完成後會自動補跑(或再按「執行」)');
});

test('b78f F-1:憑證待補數＝最後一次 poll 回應 queue.byType 的 settle-print＋attach-print(不是本輪被擋數)', async () => {
  const t = build(
    { agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? cfPage() : okQuery) },
    { poll: seqPoll([[sp('s'), sq('q')], []], (i) => qOf(i === 0 ? { 'settle-print': 1, 'settle-query': 1 } : { 'settle-print': 4, 'attach-print': 3, 'settle-query': 9 })), result: resultOk }
  );
  const r = await t.core.run();
  assert.equal(r.message, core.msgPdfBlocked(1, 7));
  assert.equal(r.message, '完成 1 筆;憑證待補 7 份:請在遠通任一筆按一次「列印」,下載完成後會自動補跑(或再按「執行」)');
});

test('b78f F-1:poll 回應沒有 queue(舊站台)才退回本輪被擋數', async () => {
  const t = build(
    { agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? cfPage() : okQuery) },
    { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [sp('s1'), ap('a1'), sq('q')], pollAfterSec: 300 } }), result: resultOk }
  );
  const r = await t.core.run();
  assert.equal(polls(t).length, 1);
  assert.equal(r.message, core.msgPdfBlocked(1, 2));
});

// ── b78f F-2:同一輪站台再發回已回報過的 id → 不執行、不重報、不算新工作 ───────────────

test('b78f F-2 重現:站台把已回報失敗的 id 再發回(poll)→ postResult 次數不增、不重做、該輪結束', async () => {
  const t = build(
    { agent: AGENT, runJob: async () => ({ ok: false, reason: 'error', message: 'synthetic' }) },
    { poll: seqPoll([[sq('a')], [sq('a')], [sq('never')]], () => qOf({ 'settle-query': 1 })), result: resultOk }
  );
  const r = await t.core.run();
  assert.deepEqual(ran(t), ['a']);
  assert.deepEqual(results(t), [{ id: 'a', ok: false, reason: 'error' }]);
  assert.equal(polls(t).length, 2, '第二次 poll 只回本輪已處理過的 id → 不算新工作,該輪結束');
  assert.equal(r.state, 'ok');
});

test('b78f F-2:站台在 next 裡發回已回報過的 id(含被擋憑證)→ 也不重報', async () => {
  let n = 0;
  const t = build(
    { agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? cfPage() : okQuery) },
    {
      poll: seqPoll([[sp('s'), sq('q')], []], () => qOf({ 'settle-print': 1 })),
      result: () => ({ status: 200, json: { ok: true, next: n++ === 1 ? [sp('s'), sq('q')] : [] } }),
    }
  );
  await t.core.run();
  assert.deepEqual(ran(t), ['s', 'q']);
  assert.deepEqual(results(t).map((b) => b.id), ['s', 'q']);
});

// ── b78f F-3:被移除時一併清殘留 ────────────────────────────────────────────────

const RESIDUE = { pdfPending: true, lastPeek: { at: 1, queue: null }, cinCache: { 'TEST-001': 'CIN1' } };
const assertNoResidue = (t, label) => {
  for (const k of ['agent', 'pdfPending', 'lastPeek', 'cinCache']) assert.equal(t.local.m.has(k), false, `${label}:${k}`);
};

test('b78f F-3:run 的 poll 回 401 → agent／pdfPending／lastPeek／cinCache 都不存在', async () => {
  const t = build({ agent: AGENT }, { poll: () => ({ status: 401, json: { ok: false } }), result: resultOk });
  await t.local.set(RESIDUE);
  const r = await t.core.run();
  assert.equal(r.state, 'revoked');
  assertNoResidue(t, 'poll 401');
});

test('b78f F-3:run 中 result 回 401 → 殘留鍵都清掉', async () => {
  const t = build({ agent: AGENT, runJob: async () => okQuery }, { poll: seqPoll([[sq('a')]]), result: () => ({ status: 401, json: { ok: false } }) });
  await t.local.set(RESIDUE);
  const r = await t.core.run();
  assert.equal(r.state, 'revoked');
  assertNoResidue(t, 'result 401');
});

test('b78f F-3:peek 回 401 → 殘留鍵都清掉;clearPairing 本身也清', async () => {
  const t = build({ agent: AGENT }, { poll: () => ({ status: 401, json: { ok: false } }), result: resultOk });
  await t.local.set(RESIDUE);
  assert.equal((await t.core.peek()).revoked, true);
  assertNoResidue(t, 'peek 401');
  const t2 = build({ agent: AGENT }, { poll: seqPoll([[]]), result: resultOk });
  await t2.local.set({ ...RESIDUE, lastRun: { at: 1 } });
  await t2.core.clearPairing();
  assertNoResidue(t2, 'clearPairing');
  assert.ok(t2.local.m.has('lastRun'), 'clearPairing 只清這四鍵');
});

test('④peek:poll max:0(含心跳)、不開分頁、不執行、存 lastPeek', async () => {
  const q = qOf({ 'settle-query': 2, 'settle-print': 1 });
  const t = build({ agent: AGENT, runJob: async () => { throw new Error('不該執行'); } }, { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [sq('x')], queue: q } }), result: resultOk });
  const r = await t.core.peek();
  assert.deepEqual(r, { paired: true, loggedIn: true, queue: q, mode: 'browser' });
  assert.equal(t.site.log.length, 1);
  assert.equal(t.site.log[0].action, 'etag-agent-poll');
  assert.equal(t.site.log[0].body.max, 0);
  assert.equal(t.site.log[0].body.fetcState, 'ok');
  assert.equal(t.site.log[0].body.version, '2.0.0');
  assert.equal(t.calls.tabsCreated.length + t.calls.windowsCreated.length, 0);
  assert.equal(t.calls.scriptWire.length, 0);
  assert.deepEqual(t.local.m.get('lastPeek'), { at: t.clock(), queue: q });
  assert.equal(t.local.m.has('lastRun'), false, 'peek 不記 lastRun');
  assert.deepEqual(core.queueCounts(q), { query: 2, print: 1 });
});

test('④b peek:未配對不打網站;未登入 fetcState=login-required;401 清配對;站台錯誤回 error', async () => {
  const t0 = build({}, { poll: () => { throw new Error('不該打'); }, result: resultOk });
  assert.deepEqual(await t0.core.peek(), { paired: false, loggedIn: true, queue: null, mode: null });
  assert.equal(t0.site.log.length, 0);
  const t1 = build({ agent: AGENT, cookies: [] }, { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [], queue: qOf() } }), result: resultOk });
  const r1 = await t1.core.peek();
  assert.equal(r1.loggedIn, false);
  assert.equal(t1.site.log[0].body.fetcState, 'login-required');
  assert.equal(t1.site.log[0].body.max, 0);
  const t2 = build({ agent: AGENT }, { poll: () => ({ status: 401, json: { ok: false } }), result: resultOk });
  assert.equal((await t2.core.peek()).paired, false);
  assert.equal(t2.local.m.has('agent'), false);
  const t3 = build({ agent: AGENT }, { poll: () => ({ status: 500, json: null }), result: resultOk });
  assert.equal((await t3.core.peek()).error, 'http-500');
  assert.equal(t3.local.m.has('lastPeek'), false);
});

test('⑤未登入:poll max:0 心跳、不開分頁、不執行(站台就算回工作也不做)、message 字面', async () => {
  const t = build(
    { agent: AGENT, cookies: [{ name: 'other', value: '1' }], runJob: async () => { throw new Error('不該執行'); } },
    { poll: () => ({ status: 200, json: { ok: true, mode: 'browser', jobs: [sq('x')], queue: qOf({ 'settle-query': 1 }) } }), result: resultOk }
  );
  const r = await t.core.run({ trigger: 'popup' });
  assert.equal(polls(t).length, 1);
  assert.equal(polls(t)[0].body.max, 0);
  assert.equal(polls(t)[0].body.fetcState, 'login-required');
  assert.equal(results(t).length, 0);
  assert.equal(t.calls.tabsCreated.length + t.calls.windowsCreated.length, 0);
  assert.equal(r.state, 'login-required');
  assert.equal(r.message, '遠通尚未登入,請先登入遠通會員區再按「執行」');
  assert.equal(core.MSG_NOT_LOGGED_IN, r.message);
});

test('⑥Member 是驗證頁:留分頁、cfTab 鍵不存在、下一輪開新分頁(不沿用、不碰舊分頁)', async () => {
  let challenge = true;
  const t = build(
    { agent: AGENT, probe: () => (challenge ? { url: MEMBER, title: 'Just a moment...', text: '', hasLoginForm: false } : { url: MEMBER, title: '會員專區', text: 'ok', hasLoginForm: false }), runJob: async () => okQuery },
    { poll: seqPoll([[sq('a')], [sq('b')], []]), result: resultOk }
  );
  const r1 = await t.core.run();
  assert.equal(r1.state, 'cf-interactive');
  assert.equal(r1.message, core.MSG_CF_TAB);
  assert.equal(t.calls.tabsCreated.length, 1);
  const firstTab = 100;
  assert.ok(t.state.tabs.has(firstTab));
  assert.deepEqual(t.calls.tabsRemoved, []);
  assert.equal(t.local.m.has('cfTab'), false);
  assert.equal(polls(t).length, 1, '停下就不再 poll');
  challenge = false;
  const r2 = await t.core.run();
  assert.equal(r2.state, 'ok');
  assert.equal(t.calls.tabsCreated.length, 2, '第二輪開新分頁');
  assert.ok(!t.calls.injected.some((x) => x.tabId === firstTab), '不對留下的分頁注入');
  assert.ok(!t.calls.tabsRemoved.includes(firstTab), '不關留下的分頁');
  assert.equal(t.local.m.has('cfTab'), false);
  assertOnlyMemberNav(t);
});

test('trigger:run({trigger}) 記進 lastRun.trigger;不在清單內／未給＝沒有 trigger', async () => {
  for (const [given, want] of [['download', 'download'], ['popup', 'popup'], ['evil', undefined], [undefined, undefined]]) {
    const t = build({ agent: AGENT }, { poll: seqPoll([[]]), result: resultOk });
    await t.core.run(given === undefined ? undefined : { trigger: given });
    assert.equal(lastRun(t).trigger, want, String(given));
    assert.equal('trigger' in lastRun(t), want !== undefined, String(given));
  }
});

test('④c/⑧ 下載觸發的 run 也照 T1:executeScript 不帶 token;calls.downloads 永遠空', async () => {
  const site = queueSite([sp('sp:1'), sq('sq:1')]);
  const t = build({ agent: AGENT, runJob: async (j) => (j.type === 'settle-print' ? okPrint : okQuery) }, { poll: site.poll, result: site.result });
  await t.local.set({ pdfPending: true });
  const r = await t.core.run({ trigger: 'download' });
  assert.equal(r.state, 'ok');
  assert.equal(r.trigger, 'download');
  assert.equal(t.local.m.get('pdfPending'), false);
  assert.equal(site.open.size, 0);
  for (const w of t.calls.scriptWire) assert.ok(!w.includes(AGENT.token));
  assert.deepEqual(t.calls.downloads, []);
});
