'use strict';
// b4p:分頁內 fetch 被 Cloudflare 擋時,擴充功能自己讓 Chrome 整頁過驗證再重跑(＋b4s L1～L3)。
// 假 chrome＋假遠通站台模型;全部合成資料。
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../agent-core');
const { build, AGENT } = require('./helpers/fake-chrome');

const GETPDF = core.GETPDF_PATH;
const SEARCH = '/UX0505Traffic/UX050506TrafficAdvancedSearch';
const MEMBER = 'https://www.fetc.net.tw/Member';
const apJob = (id) => ({ id, type: 'attach-print', payload: { recordId: 'R1', rowId: 'W1', startDate: '2026/07/20', endDate: '2026/07/21', plates: [{ plateRaw: 'TEST-001', times: ['2026/07/20 12:30:45'], filename: 'f.pdf' }] } });
const okPrint = { ok: true, data: { pdfs: [{ plateRaw: 'TEST-001', ok: true, pdfBase64: 'JVBERi0=', printTotal: 30 }] }, cinCache: { 'TEST-001': 'CIN1' } };
const pollOf = (jobs) => () => ({ status: 200, json: { ok: true, mode: 'browser', jobs, pollAfterSec: 300 } });
const resultOk = () => ({ status: 200, json: { ok: true, next: [] } });
const results = (t) => t.site.log.filter((l) => l.action === 'etag-agent-result').map((l) => l.body);
const pathOf = (u) => new URL(u).pathname;
const CLICK_MSG = '請到遠通分頁點一下驗證';
const SOFT_MSG = '遠通驗證沒能自動通過,下一輪會再試(分頁上若有驗證請點一下)';

// 假遠通站台:
//   getChallenge   整頁 GET 被擋路徑時出現挑戰
//   postChallenge  整頁 POST GetPDF 時出現挑戰
//   passAfter      挑戰頁被看幾次後自動通過(Infinity＝要人點)
//   stuckAfterPass POST 挑戰通過後 Chrome 下載 PDF、分頁仍停在挑戰頁(真 CF 的行為之一)
//   blocked(job)   這筆工作在分頁內 fetch 是否被擋(預設:未取得通行狀態就擋)
//   cfPath         被擋的路徑
function makeFetc(cfg) {
  const m = { cleared: false, pages: new Map(), dlId: 10, t: null, cfg, clearanceVer: 0 };
  const page = (url, kind, extra) => ({ url, kind, ...(extra || {}) });
  m.addDownload = (url) => {
    m.t.state.downloads.push({ id: m.dlId++, url, finalUrl: url, startTime: new Date(m.t.clock()).toISOString(), state: 'complete' });
  };
  m.probe = (tab, tabId) => {
    let pg = m.pages.get(tabId);
    if (!pg) pg = page(tab ? tab.url : MEMBER, 'ok');
    if (pg.kind === 'challenge' && !pg.passed) {
      if (pg.left <= 0) {
        pg.passed = true;
        m.cleared = true;
        m.clearanceVer++; // 通過＝CF 換發 cf_clearance
        if (pg.onPass) pg.onPass();
        if (!pg.stuck) pg.kind = 'ok';
      } else pg.left--;
    }
    const ch = pg.kind === 'challenge';
    return { url: pg.url, title: ch ? 'Just a moment...' : '會員專區', text: ch ? 'Checking' : 'ok', hasLoginForm: false };
  };
  m.onNavigate = (tabId, url) => {
    const p = pathOf(url);
    if (p !== '/Member' && cfg.getChallenge && !m.cleared) m.pages.set(tabId, page(url, 'challenge', { left: cfg.passAfter }));
    else m.pages.set(tabId, page(url, 'ok'));
  };
  m.onSubmitForm = (action, state, tabId) => {
    if (cfg.onSubmit) cfg.onSubmit(m);
    if (cfg.postChallenge && !m.cleared) {
      m.pages.set(tabId, page(action, 'challenge', { left: cfg.passAfter, stuck: !!cfg.stuckAfterPass, onPass: () => m.addDownload(action) }));
    } else {
      m.addDownload(action); // 整頁 POST 直接到原站:下載,分頁不換頁
    }
  };
  m.runJob = async (job) => {
    const blocked = cfg.blocked ? cfg.blocked(job, m) : !m.cleared;
    if (blocked) {
      const step = (cfg.cfPath || GETPDF) === SEARCH ? 'search' : 'getpdf';
      return { ok: false, reason: 'cf-challenge', message: `cf-challenge step=${step} status=403 <b>Just a moment</b>`, cfPath: cfg.cfPath || GETPDF };
    }
    return okPrint;
  };
  return m;
}

function setup(cfg, jobs, extraOpts) {
  const m = makeFetc(cfg);
  const cookies = () => [{ name: 'FETC_P', value: 'x' }].concat(m.clearanceVer ? [{ name: 'cf_clearance', domain: '.fetc.net.tw', value: 'v' + m.clearanceVer, expirationDate: 1 }] : []);
  const t = build(
    { agent: AGENT, cookies, probe: m.probe, onNavigate: m.onNavigate, onSubmitForm: m.onSubmitForm, runJob: (j) => m.runJob(j), ...(extraOpts || {}) },
    { poll: pollOf(jobs), result: resultOk }
  );
  m.t = t;
  return { t, m };
}

const navs = (t, path) => t.calls.tabsUpdated.filter((u) => u.url && pathOf(u.url) === path);

test('b4p:GetPDF 被擋 → GET 整頁出現挑戰→變正常 → 回 Member 重跑成功(via get)', async () => {
  const { t } = setup({ getChallenge: true, passAfter: 2 }, [apJob('ap:1')]);
  await t.core.run();
  assert.deepEqual(results(t), [{ id: 'ap:1', ok: true, data: okPrint.data }]);
  const lr = t.local.m.get('lastRun');
  assert.equal(lr.state, 'ok');
  assert.equal(lr.count, 1);
  const lc = t.local.m.get('lastClearance');
  assert.equal(lc.via, 'get');
  assert.equal(lc.ok, true);
  assert.ok(Number.isFinite(lc.at));
  // 先整頁 GET 被擋路徑(帶 ?&r=),通過後回 Member
  assert.match(t.calls.tabsUpdated[0].url, /^https:\/\/www\.fetc\.net\.tw\/UX0000Common\/UX000006GetPDF\?&r=\d+$/);
  assert.equal(t.calls.tabsUpdated[1].url, MEMBER);
  assert.equal(t.calls.formSubmits.length, 0, 'GET 就過了,不走 POST');
  assert.equal(t.calls.injected.filter((x) => x.job).length, 2, '同一筆重跑一次');
  assert.equal(t.calls.tabsRemoved.length, 1, '做完照常關分頁');
  assert.equal(t.local.m.has('cfTab'), false);
});

test('b4p:挑戰一閃即過(第一眼就已是正常頁)但 cf_clearance 換發 → 也算 GET 通過', async () => {
  const { t } = setup({ getChallenge: true, passAfter: 0 }, [apJob('ap:1')]);
  await t.core.run();
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.equal(t.local.m.get('lastClearance').via, 'get');
  assert.equal(t.calls.formSubmits.length, 0);
});

for (const stuck of [false, true]) {
  test(`b4p:GET 不出現挑戰 → POST 表單 → 挑戰→通過${stuck ? '(分頁停在挑戰頁、只見下載)' : ''} → 重跑成功;只清本步驟的 GetPDF 下載`, async () => {
    const { t, m } = setup(
      {
        getChallenge: false,
        postChallenge: true,
        passAfter: 1,
        stuckAfterPass: stuck,
        // 送出表單的同時,使用者自己下載了別的檔案(不能碰)
        onSubmit: (mm) => mm.t.state.downloads.push({ id: 2, url: 'https://example.com/user-file.zip', finalUrl: 'https://example.com/user-file.zip', startTime: new Date(mm.t.clock() + 1).toISOString(), state: 'in_progress' }),
      },
      [apJob('ap:1')]
    );
    // 一份時間在前的遠通 GetPDF 下載(使用者稍早自己按列印的,不能碰)
    t.state.downloads.push({ id: 1, url: `https://www.fetc.net.tw${GETPDF}?&r=1`, finalUrl: `https://www.fetc.net.tw${GETPDF}?&r=1`, startTime: new Date(t.clock() - 60000).toISOString(), state: 'complete' });
    await t.core.run();
    assert.deepEqual(results(t), [{ id: 'ap:1', ok: true, data: okPrint.data }]);
    assert.equal(t.local.m.get('lastRun').state, 'ok');
    assert.deepEqual({ ...t.local.m.get('lastClearance'), at: 0 }, { at: 0, via: 'post', ok: true });
    // GET 被擋路徑 → 回 Member → 頁內(MAIN)整頁 POST 到 GetPDF
    assert.equal(navs(t, GETPDF).length, 1);
    assert.equal(t.calls.formSubmits.length, 1);
    assert.equal(t.calls.formSubmits[0].world, 'MAIN');
    assert.match(t.calls.formSubmits[0].action, /^https:\/\/www\.fetc\.net\.tw\/UX0000Common\/UX000006GetPDF\?&r=\d+$/);
    // 只清掉本步驟產生的那份(id 10):cancel＋removeFile＋erase;使用者的兩份都不碰
    const touched = [...new Set(t.calls.downloads.map((d) => d[1]))];
    assert.deepEqual(touched, [10]);
    assert.deepEqual(t.calls.downloads.map((d) => d[0]).sort(), ['cancel', 'erase', 'removeFile']);
    assert.deepEqual(t.state.downloads.map((d) => d.id).sort(), [1, 2]);
    assert.equal(m.cleared, true);
    assert.equal(t.calls.tabsRemoved.length, 1);
  });
}

test('b4p:挑戰不消失(要人點)→ 分頁停在挑戰頁本身、記 cfTab、cf-interactive;下輪仍挑戰＝不開新分頁;變正常＝照常跑', async () => {
  const { t, m } = setup({ getChallenge: true, passAfter: Infinity }, [apJob('ap:1'), apJob('ap:2')]);
  await t.core.run();
  assert.deepEqual(results(t), [
    { id: 'ap:1', ok: false, reason: 'cf-challenge' },
    { id: 'ap:2', ok: false, reason: 'cf-interactive' },
  ]);
  const lr = t.local.m.get('lastRun');
  assert.equal(lr.state, 'cf-interactive');
  assert.equal(lr.message, CLICK_MSG, 'F3:真的停在挑戰頁＝請人點');
  const tabId = t.calls.tabsCreated.length ? 100 : null;
  assert.deepEqual(t.local.m.get('cfTab'), { tabId, windowId: null });
  assert.equal(t.calls.tabsRemoved.length, 0);
  // 最後一次導航就是挑戰頁(被擋路徑),沒有導回 Member
  const last = t.calls.tabsUpdated[t.calls.tabsUpdated.length - 1];
  assert.equal(pathOf(last.url), GETPDF);
  assert.equal(m.pages.get(tabId).kind, 'challenge');
  assert.deepEqual({ ...t.local.m.get('lastClearance'), at: 0 }, { at: 0, via: null, ok: false });
  // 診斷:pendingError 帶步驟與 status、去掉 HTML
  assert.equal(t.local.m.get('pendingError'), 'cf-challenge step=getpdf status=403 Just a moment');
  assert.equal(t.local.m.get('lastError').message, 'cf-challenge step=getpdf status=403 Just a moment');

  // 下一輪:挑戰仍在 → poll 帶 cf-interactive、不開新分頁、不執行
  const injected = t.calls.injected.length;
  await t.core.run();
  const polls = t.site.log.filter((l) => l.action === 'etag-agent-poll');
  assert.equal(polls[polls.length - 1].body.fetcState, 'cf-interactive');
  assert.equal(polls[polls.length - 1].body.lastError, 'cf-challenge step=getpdf status=403 Just a moment');
  assert.equal(t.calls.tabsCreated.length, 1);
  assert.equal(t.calls.injected.length, injected);

  // 人點過了 → 下一輪沿用該分頁照常跑,做完關掉
  m.pages.get(tabId).kind = 'ok';
  m.cleared = true;
  await t.core.run();
  assert.equal(t.calls.tabsCreated.length, 1);
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.deepEqual(t.calls.tabsRemoved, [tabId]);
  assert.equal(t.local.m.has('cfTab'), false);
});

test('b4p:POST 挑戰要人點 → 分頁停在 POST 挑戰頁(送出表單後不再導航);人點過後下一輪看到本步驟(r＝rB)的 GetPDF 下載＝視為通過並清掉,使用者自己的 GetPDF 下載不碰', async () => {
  const { t, m } = setup({ getChallenge: false, postChallenge: true, passAfter: Infinity, stuckAfterPass: true }, [apJob('ap:1')]);
  await t.core.run();
  assert.equal(t.local.m.get('lastRun').state, 'cf-interactive');
  assert.equal(t.calls.formSubmits.length, 1);
  const lastUpd = t.calls.tabsUpdated[t.calls.tabsUpdated.length - 1];
  assert.equal(lastUpd.url, MEMBER, '最後一次導航是送表單前回 Member;送出後沒有再導航');
  const cfTab = t.local.m.get('cfTab');
  assert.equal(cfTab.tabId, 100);
  assert.ok(Number.isFinite(cfTab.pdfSince));
  assert.ok(Number.isFinite(cfTab.pdfR), 'F2:cfTab 一併存 rB');
  // 人在分頁點驗證 → CF 重送 POST → Chrome 下載 GetPDF,分頁仍停在挑戰頁
  const pg = m.pages.get(100);
  pg.left = 0;
  m.probe(t.state.tabs.get(100), 100);
  assert.equal(t.state.downloads.length, 1);
  const ownId = t.state.downloads[0].id;
  // 這段期間使用者自己在遠通按列印 → 另一份 GetPDF 下載(r 不同,時間在窗口內)
  const userUrl = `https://www.fetc.net.tw${GETPDF}?&r=${cfTab.pdfR + 12345}`;
  t.state.downloads.push({ id: 50, url: userUrl, finalUrl: userUrl, startTime: new Date(t.clock() + 5).toISOString(), state: 'complete' });
  await t.core.run();
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.deepEqual(results(t).slice(-1), [{ id: 'ap:1', ok: true, data: okPrint.data }]);
  // F2:第二輪後下載資料夾沒有空白 PDF(本步驟那份被 cancel＋removeFile＋erase);F1:使用者那份不受影響
  assert.deepEqual([...new Set(t.calls.downloads.map((d) => d[1]))], [ownId]);
  assert.deepEqual(t.calls.downloads.map((d) => d[0]).sort(), ['cancel', 'erase', 'removeFile']);
  assert.deepEqual(t.state.downloads.map((d) => d.id), [50]);
  assert.equal(t.calls.tabsCreated.length, 1);
});

test('b4q F2:POST 挑戰要人點、人還沒點 → 下一輪不刪任何下載(沒有 r＝rB 的下載就不動),使用者的 GetPDF 下載照舊', async () => {
  const { t } = setup({ getChallenge: false, postChallenge: true, passAfter: Infinity, stuckAfterPass: true }, [apJob('ap:1')]);
  await t.core.run();
  const cfTab = t.local.m.get('cfTab');
  const userUrl = `https://www.fetc.net.tw${GETPDF}?&r=${cfTab.pdfR + 1}`;
  t.state.downloads.push({ id: 51, url: userUrl, finalUrl: userUrl, startTime: new Date(t.clock() + 5).toISOString(), state: 'complete' });
  await t.core.run();
  assert.equal(t.local.m.get('lastRun').state, 'cf-interactive');
  assert.equal(t.calls.downloads.length, 0);
  assert.deepEqual(t.state.downloads.map((d) => d.id), [51]);
});

test('b4q F1:POST 過驗證後重跑期間,使用者自己按列印產生的 GetPDF 下載(另一個 r)不被 cancel／removeFile／erase', async () => {
  let runs = 0;
  const { t, m } = setup({ getChallenge: false, postChallenge: true, passAfter: 1 }, [apJob('ap:1')], {
    runJob: async (job) => {
      runs++;
      if (runs === 1) return m.runJob(job); // 第一次被擋 → 走過驗證
      const u = `https://www.fetc.net.tw${GETPDF}?&r=999`;
      t.state.downloads.push({ id: 77, url: u, finalUrl: u, startTime: new Date(t.clock() + 5).toISOString(), state: 'complete' });
      return okPrint;
    },
  });
  await t.core.run();
  assert.equal(t.local.m.get('lastClearance').via, 'post');
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.ok(!t.calls.downloads.some((d) => d[1] === 77), '使用者的下載不能碰');
  assert.ok(t.state.downloads.some((d) => d.id === 77));
  assert.ok(t.calls.downloads.some((d) => d[0] === 'cancel' && d[1] === 10), '本步驟那份照清');
});

test('b4q M4:POST 分支挑戰一閃即過(探頁沒看到挑戰頁)但 cf_clearance 換發 → 也算通過(via post)', async () => {
  const { t } = setup({ getChallenge: false, postChallenge: true, passAfter: 0 }, [apJob('ap:1')]);
  await t.core.run();
  assert.equal(t.calls.formSubmits.length, 1);
  assert.equal(t.local.m.get('lastClearance').via, 'post');
  assert.equal(t.local.m.get('lastClearance').ok, true);
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.deepEqual(results(t), [{ id: 'ap:1', ok: true, data: okPrint.data }]);
});

test('b4q M5:重跑期間才「慢到」的本步驟 GetPDF 下載(r＝rB)也要清掉,不留空白 PDF', async () => {
  let runs = 0;
  let ref;
  const { t, m } = setup({ getChallenge: false, postChallenge: true, passAfter: 1 }, [apJob('ap:1')], {
    runJob: async (job) => {
      runs++;
      if (runs === 1) return ref.runJob(job);
      ref.addDownload(ref.t.calls.formSubmits[0].action); // 慢到的下載:過驗證的觀察期已結束
      return okPrint;
    },
  });
  ref = m;
  await t.core.run();
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.deepEqual(t.state.downloads, [], '兩份本步驟下載(觀察期內＋慢到的)都清掉');
  assert.ok(t.calls.downloads.some((d) => d[0] === 'erase' && d[1] === 11), '慢到的那份(id 11)被清');
});

test('b4q M7:GET 過驗證那一步導到登入頁 → 停在 login-required,不繼續走 POST 分支', async () => {
  let ref;
  const wrap = (pr) => (new URL(pr.url).pathname !== '/Member' ? { ...pr, title: '登入', text: 'login', hasLoginForm: true } : pr);
  const { t, m } = setup({ getChallenge: false, postChallenge: true, passAfter: 0 }, [apJob('ap:1')], {
    probe: (tab, id) => wrap(ref.probe(tab, id)),
  });
  ref = m;
  await t.core.run();
  assert.equal(t.calls.formSubmits.length, 0, '登入頁不該再送 POST 表單');
  assert.equal(t.local.m.get('lastRun').state, 'login-required');
  assert.deepEqual(results(t), [{ id: 'ap:1', ok: false, reason: 'login-required' }]);
});

test('b4p:一輪只過驗證一次 — 通過後重跑仍被擋 → 停下(d),第二筆不執行', async () => {
  const { t } = setup({ getChallenge: true, passAfter: 1, blocked: () => true }, [apJob('ap:1'), apJob('ap:2')]);
  await t.core.run();
  assert.equal(navs(t, GETPDF).length, 1, '只過一次');
  assert.equal(t.calls.formSubmits.length, 0);
  assert.equal(t.calls.injected.filter((x) => x.job).length, 2, '第一筆＋重跑;第二筆不跑');
  assert.deepEqual(results(t), [
    { id: 'ap:1', ok: false, reason: 'cf-challenge' },
    { id: 'ap:2', ok: false, reason: 'cf-interactive' },
  ]);
  assert.equal(t.local.m.get('lastRun').state, 'cf-interactive');
  assert.ok(t.local.m.get('cfTab'));
  assert.equal(t.calls.tabsRemoved.length, 0);
  // F3:通過後重跑仍被擋＝沒有可點的驗證 → 不叫人點,說「沒能自動通過、下一輪會再試」
  assert.equal(t.local.m.get('lastRun').message, SOFT_MSG);
});

test('b4p:一輪只過驗證一次 — 第一筆過驗證成功,第二筆又被擋 → 不再過第二次,直接停', async () => {
  const { t } = setup({ getChallenge: true, passAfter: 1, blocked: (job, m) => job.id === 'ap:2' || !m.cleared }, [apJob('ap:1'), apJob('ap:2')]);
  await t.core.run();
  assert.equal(navs(t, GETPDF).length, 1);
  assert.deepEqual(results(t), [
    { id: 'ap:1', ok: true, data: okPrint.data },
    { id: 'ap:2', ok: false, reason: 'cf-challenge' },
  ]);
  assert.equal(t.local.m.get('lastRun').state, 'cf-interactive');
  assert.equal(t.local.m.get('lastRun').count, 2);
  assert.equal(t.local.m.get('lastRun').message, SOFT_MSG, 'F3:第二筆又被擋(沒看到挑戰頁)＝軟訊息');
});

test('b4p:search 被擋走同一路徑(整頁 GET search 路徑);卡住時 pendingError 帶 step=search', async () => {
  const { t } = setup({ getChallenge: true, passAfter: 1, cfPath: SEARCH }, [apJob('ap:1')]);
  await t.core.run();
  assert.equal(navs(t, SEARCH).length, 1);
  assert.equal(t.local.m.get('lastRun').state, 'ok');
  assert.equal(t.local.m.get('lastClearance').via, 'get');

  const s2 = setup({ getChallenge: true, passAfter: Infinity, cfPath: SEARCH }, [apJob('ap:1')]);
  await s2.t.core.run();
  assert.equal(pathOf(s2.t.calls.tabsUpdated[s2.t.calls.tabsUpdated.length - 1].url), SEARCH);
  assert.match(s2.t.local.m.get('pendingError'), /^cf-challenge step=search status=403/);
});

test('b4p:頁面回報的 cfPath 不在白名單 → 不導航、照舊停下', async () => {
  for (const bad of ['https://evil.example/x', '/Evil', '//evil.example/Member', 42]) {
    const t = build(
      { agent: AGENT, runJob: async () => ({ ok: false, reason: 'cf-challenge', message: 'x', cfPath: bad }) },
      { poll: pollOf([apJob('ap:1')]), result: resultOk }
    );
    await t.core.run();
    assert.equal(t.calls.tabsUpdated.length, 0, String(bad));
    assert.equal(t.calls.formSubmits.length, 0);
    assert.equal(t.local.m.get('lastRun').state, 'cf-interactive');
    assert.equal(t.local.m.get('lastRun').message, SOFT_MSG, 'F3:沒導航＝沒有可點的驗證');
    assert.equal(t.local.m.has('lastClearance'), false);
  }
});

test('b4p:失敗一律帶 message(頁面沒給就用 reason)→ pendingError;站台回報仍只送 reason', async () => {
  const t = build({ agent: AGENT, runJob: async () => ({ ok: false, reason: 'error' }) }, { poll: pollOf([apJob('ap:1')]), result: resultOk });
  await t.core.run();
  assert.equal(t.local.m.get('pendingError'), 'error');
  assert.deepEqual(results(t), [{ id: 'ap:1', ok: false, reason: 'error' }]);
  const long = build({ agent: AGENT, runJob: async () => ({ ok: false, reason: 'pdf-failed', message: '<html><body>' + 'x'.repeat(500) + '</body></html>' }) }, { poll: pollOf([apJob('ap:1')]), result: resultOk });
  await long.core.run();
  const pe = long.local.m.get('pendingError');
  assert.ok(pe.length <= 200 && !/[<>]/.test(pe), pe.slice(0, 40));
});

test('b4q F4:cin-not-found／no-rows 這類正常業務結果不寫進 pendingError／最後錯誤;真正的錯誤才寫', async () => {
  for (const [res, expectErr] of [
    [{ ok: true, data: { pdfs: [] }, message: 'cin-not-found step=cin status=200 查無' }, false],
    [{ ok: true, data: { pdfs: [] }, message: 'no-rows step=search status=200' }, false],
    [{ ok: false, reason: 'no-rows', message: 'no-rows' }, false],
    [{ ok: false, reason: 'cin-not-found', message: 'cin-not-found' }, false],
    [{ ok: true, data: { pdfs: [] }, message: 'pdf-failed step=getpdf status=500 boom' }, true],
    [{ ok: false, reason: 'error', message: 'runner x' }, true],
    [{ ok: false, reason: 'login-required', message: 'login-required' }, true],
  ]) {
    const t = build({ agent: AGENT, runJob: async () => res }, { poll: pollOf([apJob('ap:1')]), result: resultOk });
    await t.core.run();
    assert.equal(t.local.m.has('pendingError'), expectErr, JSON.stringify(res));
    assert.equal(t.local.m.has('lastError'), expectErr, JSON.stringify(res));
  }
});

test('b4p:表單 executeScript 也進 scriptWire 掃描,不含 token／header 名／agentId', async () => {
  const { t } = setup({ getChallenge: false, postChallenge: true, passAfter: 0 }, [apJob('ap:1')]);
  await t.core.run();
  const wire = t.calls.scriptWire.join('\n');
  assert.ok(wire.includes('gflSubmitPdfForm'), '表單函式有被送進分頁');
  for (const bad of [AGENT.token, 'X-Gfl-Agent-Token', AGENT.agentId, 'agentId']) assert.ok(!wire.includes(bad), bad);
});

test('b4p:isOwnPdfDownload 只認遠通 GetPDF 網址＋本步驟之後', () => {
  const since = Date.UTC(2026, 9, 27, 13, 0, 0);
  const at = (ms) => new Date(ms).toISOString();
  const u = `https://www.fetc.net.tw${GETPDF}?&r=1`;
  assert.equal(core.isOwnPdfDownload({ url: u, startTime: at(since) }, since, 1), true);
  assert.equal(core.isOwnPdfDownload({ url: u, startTime: at(since - 1) }, since, 1), false);
  assert.equal(core.isOwnPdfDownload({ url: u, startTime: at(since + 5) }, since, 2), false, 'F1:r 不同＝使用者自己的列印下載');
  assert.equal(core.isOwnPdfDownload({ url: u, startTime: at(since + 5) }, since), false, '沒給 r 一律不認');
  assert.equal(core.isOwnPdfDownload({ url: `https://www.fetc.net.tw${GETPDF}`, startTime: at(since + 5) }, since, 1), false, '網址沒有 r');
  assert.equal(core.isOwnPdfDownload({ url: 'https://www.fetc.net.tw/Member?&r=1', startTime: at(since + 5) }, since, 1), false);
  assert.equal(core.isOwnPdfDownload({ url: `https://evil.example${GETPDF}?&r=1`, startTime: at(since + 5) }, since, 1), false);
  assert.equal(core.isOwnPdfDownload({ url: `http://www.fetc.net.tw${GETPDF}?&r=1`, startTime: at(since + 5) }, since, 1), false);
  assert.equal(core.isOwnPdfDownload({ url: u }, since, 1), false);
});

// ── 分頁內 runner(真 fetc-chain＋stub 遠通)──────────────────────────────────
test('b4p:gflPageRunner — GetPDF／search 被 CF 擋 → 整筆 {ok:false,reason:cf-challenge,cfPath,message};pdf-failed 帶診斷 message', async () => {
  const H = require('./helpers/env');
  const chainMod = require('../fetc-chain');
  require('../fetc-parse');
  const saved = { fetch: globalThis.fetch, chain: globalThis.GflFetcChain, DP: globalThis.DOMParser };
  const { DOMParser } = require('linkedom');
  globalThis.DOMParser = DOMParser;
  globalThis.GflFetcChain = chainMod;
  const job = { id: 'ap:1', type: 'attach-print', payload: apJob('ap:1').payload };
  job.payload.plates[0].plateRaw = H.TEST_PLATE;
  try {
    const run = async (overrides) => {
      globalThis.fetch = H.makeStubFetch(H.makeSite(overrides), []);
      return core.gflPageRunner(job, {});
    };
    const cfPdf = await run({ pdf: { status: 403, body: 'blocked', headers: { 'cf-mitigated': 'challenge' } } });
    assert.equal(cfPdf.ok, false);
    assert.equal(cfPdf.reason, 'cf-challenge');
    assert.equal(cfPdf.cfPath, GETPDF);
    assert.equal(cfPdf.message, 'cf-challenge step=getpdf status=403');
    const cfSearch = await run({ search: { status: 403, body: 'blocked', headers: { 'cf-mitigated': 'challenge' } } });
    assert.equal(cfSearch.reason, 'cf-challenge');
    assert.equal(cfSearch.cfPath, SEARCH);
    assert.equal(cfSearch.message, 'cf-challenge step=search status=403');
    const failed = await run({ pdf: { status: 500, body: '<html>boom</html>', headers: { 'content-type': 'text/html' } } });
    assert.equal(failed.ok, true);
    assert.match(failed.message, /^pdf-failed step=getpdf status=500 /);
    // F4:查無車牌(cin-not-found)是正常結果,不帶 message
    const unknownJob = { id: 'ap:2', type: 'attach-print', payload: { ...apJob('ap:2').payload, plates: [{ plateRaw: 'NOPE-999', times: ['2026/07/20 12:30:45'], filename: 'f.pdf' }] } };
    globalThis.fetch = H.makeStubFetch(H.makeSite({}), []);
    const nf = await core.gflPageRunner(unknownJob, {});
    assert.equal(nf.ok, true);
    assert.equal(nf.data.pdfs[0].reason, 'cin-not-found');
    assert.equal(nf.message, undefined);
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.GflFetcChain = saved.chain;
    globalThis.DOMParser = saved.DP;
  }
});

// ── b4s ─────────────────────────────────────────────────────────────────────
test('b4s L1(t7):使用者把分頁開進擴充功能建的視窗 → 只關自己的分頁,不關視窗', async () => {
  const t = build(
    {
      agent: AGENT,
      windows: 0,
      runJob: async () => {
        t.state.tabs.set(555, { id: 555, status: 'complete', url: 'https://other.example/my-work', windowId: 900 });
        return okPrint;
      },
    },
    { poll: pollOf([apJob('ap:1')]), result: resultOk }
  );
  await t.core.run();
  assert.equal(t.calls.windowsCreated.length, 1);
  assert.deepEqual(t.calls.windowsRemoved, []);
  assert.deepEqual(t.calls.tabsRemoved, [100]);
  assert.ok(t.state.tabs.has(555));
});

test('b4s L2(pend):遺留 cfTab 仍在載入(url 空、pendingUrl 是遠通)→ 認得是自己的分頁,照常收掉不留孤兒', async () => {
  const t = build({ agent: AGENT }, { poll: pollOf([]), result: resultOk });
  await t.local.set({ cfTab: { tabId: 7, windowId: null } });
  t.state.tabs.set(7, { id: 7, status: 'loading', url: '', pendingUrl: 'https://www.fetc.net.tw/Member' });
  await t.core.run();
  assert.deepEqual(t.calls.tabsRemoved, [7]);
  assert.equal(t.local.m.has('cfTab'), false);
});

test('b4s L3(t8):遠通卡住(分頁一直載入、探頁 executeScript 永不回)→ 一輪等待 ≤ 45 秒就收手', async () => {
  // 真 Chromium 實測:導航一直沒 commit 時 executeScript 不 reject 也不 resolve。探頁逾時計時器在這裡改成「下一個 tick 就到」
  const fired = [];
  const probeTimer = { set: (fn, ms) => { fired.push(ms); return setImmediate(fn); }, clear: (h) => clearImmediate(h) };
  const t = build({ agent: AGENT, probe: () => new Promise(() => {}), runJob: async () => okPrint }, { poll: pollOf([apJob('ap:1')]), result: resultOk }, { probeTimer });
  const create = t.chrome.tabs.create;
  t.chrome.tabs.create = async (p) => {
    const tab = await create(p);
    tab.status = 'loading';
    return tab;
  };
  const t0 = t.clock();
  await t.core.run();
  const spent = t.clock() - t0;
  assert.ok(spent <= 45000 + 3000, `一輪等了 ${spent}ms`);
  assert.ok(spent >= 45000, `至少等滿 45 秒才放棄(${spent}ms)`);
  assert.equal(t.local.m.get('lastRun').state, 'cf-interactive');
  assert.equal(t.calls.injected.filter((x) => x.job).length, 0);
  assert.ok(fired.length >= 1 && fired.every((ms) => ms === core.PROBE_TIMEOUT_MS), '探頁有自己的逾時');
});
