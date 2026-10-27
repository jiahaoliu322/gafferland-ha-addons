// ── 擴充功能 2.1.0 執行面核心(可注入依賴,不直接碰全域 chrome)────────────────────
// background.js 只負責把真的 chrome.* 接進來;這裡的邏輯用假 chrome／假 fetch 在 node 測試。
//
// 平常不連遠通、不問站台;只有員工按 popup「執行」(或憑證待補時偵測到員工在遠通下載了憑證)才跑一次 run:
//   未配對 → 結束;遠通 cookie(FETC_P)判斷登入(未登入＝只心跳、不開分頁)→ POST etag-agent-poll →
//   有工作才開遠通分頁 →(驗證頁／登入頁判斷)→ 逐工作把 fetc-parse.js＋fetc-chain.js 注入該分頁(MAIN world)執行 →
//   POST etag-agent-result(回應的 next 接著做)→ 佇列空了再問一次站台,直到站台回空 → 關自己開的分頁。
// 鐵則:
//   - 遠通請求一律由遠通分頁內的 fetch 發出;這支檔案(背景頁)只 fetch 自家站台。
//   - 不做任何自動導頁／表單送出;遠通要人驗證＝由人在遠通分頁上自己做。
//   - 呼叫自家站台不帶 cookie(credentials:'omit'),只帶 X-Gfl-Agent-Token。
//   - token 只存 chrome.storage.local,不進 log、不進錯誤訊息。
(function (root) {
  'use strict';

  const DEFAULT_BASE_URL = 'https://admin.gafferland.com';
  // 1.0.x 存過的舊網域(vercel.app 已停用、manifest 也不再允許)視同未設定,退回預設。
  const LEGACY_BASE_URL_RE = /^https?:\/\/(gafferland\.vercel\.app|(www\.)?gafferland\.net)(\/|$)/i;
  const FETC_MEMBER_URL = 'https://www.fetc.net.tw/Member';
  const FETC_COOKIE_DOMAIN = 'fetc.net.tw';
  const FETC_LOGIN_COOKIE = 'FETC_P';

  const RUN_LOCK_MS = 5 * 60 * 1000;
  const JOB_TIMEOUT_MS = 4 * 60 * 1000;
  const CF_WAIT_MS = 45 * 1000;
  const CF_STEP_MS = 3 * 1000;
  const TAB_LOAD_TIMEOUT_MS = 30 * 1000;
  const TAB_POLL_MS = 500;
  // 分頁導航一直沒 commit(遠通卡住)時 executeScript 會永遠不回(真 Chromium 實測),探頁要有自己的上限
  const PROBE_TIMEOUT_MS = 5 * 1000;
  const MAX_JOBS_PER_RUN = 30;
  const MAX_POLLS_PER_RUN = 10;
  const RESULT_LIMIT_BYTES = 4 * 1024 * 1024; // Vercel 請求上限 4.5MB
  const POLL_MAX_JOBS = 10;
  const SESSION_REASONS = ['login-required', 'cf-interactive', 'cf-challenge'];
  const PAGE_FILES = ['fetc-parse.js', 'fetc-chain.js'];
  const PRINT_TYPES = ['settle-print', 'attach-print'];
  const QUERY_TYPES = ['settle-query', 'scan'];
  const TRIGGERS = ['popup', 'download'];
  // 頁面回傳可信度:reason 只收 10-common 列的值;cinCache 限 key/value 長度與筆數
  const ALLOWED_REASONS = ['login-required', 'cf-interactive', 'cf-challenge', 'no-rows', 'cin-not-found', 'pdf-failed', 'error'];
  const CIN_MAX_ENTRIES = 200;
  const CIN_MAX_KEY = 20;
  const CIN_MAX_VALUE = 40;
  const MESSAGE_MAX = 200;
  // 只有這幾種才算「真正的錯誤」寫進 pendingError／popup 最後錯誤;cin-not-found／no-rows 是正常業務結果
  const REAL_ERROR_REASONS = ['cf-challenge', 'login-required', 'pdf-failed', 'error'];
  const MSG_NOT_LOGGED_IN = '遠通尚未登入,請先登入遠通會員區再按「執行」';
  const MSG_RELOGIN = '遠通需要重新登入,請登入遠通會員區後再按「執行」';
  const MSG_CF_TAB = '遠通分頁出現驗證,請在那個分頁完成後再按一次「執行」';
  const msgPdfBlocked = (done, n) =>
    `完成 ${done} 筆;憑證待補 ${n} 份:請在遠通任一筆按一次「列印」,下載完成後會自動補跑(或再按「執行」)`;

  // ── 純函式 ──────────────────────────────────────────────────────────────────

  function resolveBaseUrl(stored) {
    const v = String(stored || '').trim().replace(/\/+$/, '');
    return v && !LEGACY_BASE_URL_RE.test(v) ? v : DEFAULT_BASE_URL;
  }

  // 網址是否落在 manifest host_permissions 內(只認 https;'https://*.x.y/*' 與 'https://x.y/*')
  function isHostPermitted(url, patterns) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    for (const p of patterns || []) {
      const m = /^https:\/\/([^/]+)\/\*$/.exec(String(p));
      if (!m) continue;
      const h = m[1].toLowerCase();
      if (h.startsWith('*.')) {
        const suffix = h.slice(1); // '.fetc.net.tw'
        if (u.hostname.toLowerCase().endsWith(suffix) || u.hostname.toLowerCase() === h.slice(2)) return true;
      } else if (u.hostname.toLowerCase() === h) {
        return true;
      }
    }
    return false;
  }

  // 網址是否為遠通網域(https;www.fetc.net.tw 或 *.fetc.net.tw)
  function isFetcUrl(url) {
    let u;
    try {
      u = new URL(String(url || ''));
    } catch (e) {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'fetc.net.tw' || h.endsWith('.fetc.net.tw');
  }

  // 診斷訊息:只收字串、去 HTML 標籤、壓空白、≤200 字
  function sanitizeMessage(m) {
    if (typeof m !== 'string') return '';
    return m
      .replace(/<[^>]*>?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MESSAGE_MAX);
  }

  // 這筆工作的結果算不算真正的錯誤:失敗看 reason;成功但有車失敗(message 以 reason 開頭)也看 reason
  function isRealError(ex) {
    if (!ex || !ex.message) return false;
    if (ex.out && ex.out.ok === false) return REAL_ERROR_REASONS.includes(ex.out.reason);
    return REAL_ERROR_REASONS.some((r) => ex.message === r || ex.message.startsWith(r + ' '));
  }

  function sanitizeReason(reason) {
    return typeof reason === 'string' && ALLOWED_REASONS.includes(reason) ? reason : 'error';
  }

  // 頁面回傳的 cinCache 只收 string→string、key ≤20、value ≤40、最多 200 筆(保留最後的)
  function sanitizeCinCache(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && k.length > 0 && k.length <= CIN_MAX_KEY && v.length <= CIN_MAX_VALUE) out[k] = v;
    }
    const keys = Object.keys(out);
    if (keys.length > CIN_MAX_ENTRIES) {
      const keep = {};
      for (const k of keys.slice(-CIN_MAX_ENTRIES)) keep[k] = out[k];
      return keep;
    }
    return out;
  }

  // 遠通頁面診斷 → 'challenge' | 'login' | 'ok'。p＝gflProbePage 的回傳
  function classifyPage(p) {
    const info = p || {};
    const title = String(info.title || '');
    const text = String(info.text || '');
    const url = String(info.url || '');
    if (/Just a moment|Checking your browser|請稍候|執行安全驗證/i.test(title) || /Just a moment/i.test(text) || /[?&]__cf_chl/i.test(url)) {
      return 'challenge';
    }
    if (/UX0301UserLogin/i.test(url) || info.hasLoginForm) return 'login';
    return 'ok';
  }

  const byteLength = (s) => new TextEncoder().encode(s).length;

  // 結果 body 超過上限時,從最大的 PDF 開始改成 pdf-failed,直到 ≤ limit。回 {json, dropped}
  function shrinkResultBody(body, limit) {
    const cap = limit || RESULT_LIMIT_BYTES;
    let json = JSON.stringify(body);
    if (byteLength(json) <= cap) return { json, dropped: [] };
    const data = body && body.data;
    if (!data || !Array.isArray(data.pdfs)) return { json, dropped: [] };
    const next = { ...body, data: { ...data, pdfs: data.pdfs.map((p) => ({ ...p })) } };
    const order = next.data.pdfs
      .map((p, i) => ({ i, size: p.pdfBase64 ? p.pdfBase64.length : 0 }))
      .filter((x) => x.size > 0)
      .sort((a, b) => b.size - a.size);
    const dropped = [];
    for (const { i } of order) {
      const plateRaw = next.data.pdfs[i].plateRaw;
      next.data.pdfs[i] = { plateRaw, ok: false, reason: 'pdf-failed' };
      dropped.push(plateRaw);
      json = JSON.stringify(next);
      if (byteLength(json) <= cap) break;
    }
    return { json, dropped };
  }

  // 站台 queue 統計(poll 回應)→ {query, print}:查詢＝settle-query＋scan、憑證＝settle-print＋attach-print。
  // 沒有 byType(舊站台)或值不是非負數一律當 0
  function queueCounts(queue) {
    const bt = queue && typeof queue === 'object' && queue.byType && typeof queue.byType === 'object' ? queue.byType : {};
    const num = (k) => {
      const v = Number(bt[k]);
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    };
    const sum = (ks) => ks.reduce((n, k) => n + num(k), 0);
    return { query: sum(QUERY_TYPES), print: sum(PRINT_TYPES) };
  }

  // 工作結果(上傳用的 {ok,reason?,data?})是否帶登入／驗證類原因。回 'login-required' | 'cf-interactive' | null
  function sessionStopOf(r) {
    if (!r) return null;
    const norm = (reason) =>
      reason === 'login-required' ? 'login-required' : SESSION_REASONS.includes(reason) ? 'cf-interactive' : null;
    if (r.ok === false) return norm(r.reason);
    const d = r.data || {};
    const entries = []
      .concat(d.perPlate ? Object.values(d.perPlate) : [])
      .concat(Array.isArray(d.pdfs) ? d.pdfs : []);
    let found = null;
    for (const e of entries) {
      if (e && e.ok === false) {
        const s = norm(e.reason);
        if (s === 'login-required') return s;
        if (s) found = s;
      }
    }
    return found;
  }

  function lastRunText(lr) {
    if (!lr) return '尚未執行過';
    return lr.message || '—';
  }

  // ── 在遠通分頁內執行的函式(會被序列化注入,必須自足,只能用分頁的全域)────────────
  function gflProbePage() {
    return {
      url: location.href,
      title: document.title || '',
      text: ((document.body && document.body.innerText) || '').slice(0, 1500),
      hasLoginForm: !!(
        document.querySelector('#smartAccount, [name="smartAccount"]') &&
        document.querySelector('#smartPassword, [name="smartPassword"]')
      ),
    };
  }

  async function gflPageRunner(job, cinCache) {
    try {
      const G = globalThis.GflFetcChain;
      if (!G) return { ok: false, reason: 'error', message: 'chain-missing' };
      const cache = Object.assign({}, cinCache || {});
      const chain = G.createFetcChain({ fetchImpl: (u, i) => fetch(u, i), cinCache: cache });
      const payload = (job && job.payload) || {};
      let data;
      if (job.type === 'settle-query') data = await chain.runQueryJob(payload);
      else if (job.type === 'scan') data = await chain.runScanJob(payload);
      else if (job.type === 'settle-print' || job.type === 'attach-print') data = await chain.runPrintJob(payload);
      else return { ok: false, reason: 'error', message: 'unknown-type' };
      // 分頁內任何 fetch 被 CF 擋(fetch 層挑戰瀏覽器不會自解)→ 整筆回 cf-challenge(背景頁不導頁、不重跑)
      const cf = typeof chain.lastChallenge === 'function' ? chain.lastChallenge() : null;
      if (cf) {
        return {
          ok: false,
          reason: 'cf-challenge',
          message: ('cf-challenge step=' + cf.step + ' status=' + cf.status).slice(0, 200),
        };
      }
      const out = { ok: true, data, cinCache: cache };
      const lf = typeof chain.lastFailure === 'function' ? chain.lastFailure() : null;
      if (lf) out.message = (lf.reason + ' step=' + lf.step + ' status=' + lf.status + ' ' + lf.detail).slice(0, 200);
      return out;
    } catch (e) {
      return { ok: false, reason: 'error', message: ('runner ' + String((e && e.message) || e)).slice(0, 200) };
    }
  }

  // ── 核心 ────────────────────────────────────────────────────────────────────

  function createAgentCore(deps) {
    const d = deps || {};
    const chrome = d.chrome;
    const fetchImpl = d.fetch;
    const now = d.now || (() => Date.now());
    const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const timer = d.timer || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h),
    };
    const version = d.version || '0.0.0';
    const keepAlive = d.keepAlive || { start() {}, stop() {} };
    // 探頁逾時用的計時器(與工作逾時的 timer 分開注入)
    const probeTimer = d.probeTimer || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h),
    };
    const log = d.log || (() => {});
    const hosts = d.hostPatterns || [];
    const local = chrome.storage.local;
    const session = chrome.storage.session;

    let running = false;
    let trigger; // 本輪觸發來源(run 設定,recordRun 帶進 lastRun)

    async function getLocal(key) {
      const o = await local.get(key);
      return o ? o[key] : undefined;
    }

    // 呼叫自家站台(不帶 cookie,只帶 agent token)
    async function callSite(agent, action, body) {
      const resp = await fetchImpl(`${agent.baseUrl}/api/collect?action=${action}`, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error', // 站台不應轉址;轉址＝失敗,不帶 header 跟過去
        headers: { 'Content-Type': 'application/json', 'X-Gfl-Agent-Token': agent.token },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      let data = null;
      try {
        data = await resp.json();
      } catch (e) {
        data = null;
      }
      return { status: resp.status, data };
    }

    // 解除配對／被移除:連同這台的待補旗標、peek 統計、CIN 快取一起清(b78f F-3)
    async function clearPairing() {
      await local.remove(['agent', 'pdfPending', 'lastPeek', 'cinCache']);
    }

    async function recordRun(info) {
      const rec = { at: now(), count: 0, state: 'ok', message: '', ...info };
      if (trigger !== undefined) rec.trigger = trigger;
      await local.set({ lastRun: rec, fetcState: { state: rec.state, at: rec.at } });
      return rec;
    }

    // 分頁還在且網域仍是遠通才算「自己的」(tabId／windowId 在瀏覽器重啟後會被別的分頁重用)
    async function fetcTabOrNull(tabId) {
      try {
        const t = await chrome.tabs.get(tabId);
        // 載入中的分頁 url 是 ''、目的地在 pendingUrl(b4s L2)
        return t && isFetcUrl(t.url || t.pendingUrl) ? t : null;
      } catch (e) {
        return null;
      }
    }

    // 等分頁載完;最多 30 秒,且不超過呼叫端給的 deadline(b4s L3)
    async function waitTabComplete(tabId, deadline) {
      const t0 = now();
      const until = Math.min(t0 + TAB_LOAD_TIMEOUT_MS, Number.isFinite(deadline) ? deadline : Infinity);
      for (;;) {
        let t = null;
        try {
          t = await chrome.tabs.get(tabId);
        } catch (e) {
          return false;
        }
        if (t && t.status === 'complete') return true;
        if (now() >= until) return false;
        await sleep(TAB_POLL_MS);
      }
    }

    // 回 {cls:'challenge'|'login'|'ok'|'unknown', url}
    async function probeInfo(tabId) {
      try {
        const res = await new Promise((resolve, reject) => {
          const h = probeTimer.set(() => reject(new Error('probe-timeout')), PROBE_TIMEOUT_MS);
          chrome.scripting.executeScript({ target: { tabId }, func: gflProbePage }).then(
            (v) => {
              probeTimer.clear(h);
              resolve(v);
            },
            (e) => {
              probeTimer.clear(h);
              reject(e);
            }
          );
        });
        const p = res && res[0] && res[0].result;
        return { cls: classifyPage(p), url: String((p && p.url) || '') };
      } catch (e) {
        return { cls: 'unknown', url: '' }; // 頁面正在跳轉等:當作還沒好
      }
    }

    async function probePage(tabId) {
      return (await probeInfo(tabId)).cls;
    }

    async function openTab() {
      let wins = [];
      try {
        wins = (await chrome.windows.getAll()) || [];
      } catch (e) {
        wins = [];
      }
      if (!wins.length) {
        const w = await chrome.windows.create({ url: FETC_MEMBER_URL, focused: false, state: 'minimized' });
        const tab = w.tabs && w.tabs[0];
        return { tabId: tab.id, windowId: w.id };
      }
      const tab = await chrome.tabs.create({ url: FETC_MEMBER_URL, active: false });
      return { tabId: tab.id, windowId: null };
    }

    // 只關「本輪自己建立且網域仍是遠通」的分頁;windows.remove 只用在本輪 windows.create 建出的視窗
    // (own.windowId 只有 openTab 建視窗時才會有;沿用的舊分頁一律 windowId＝null)。
    async function closeOwned(own) {
      if (!own) return;
      try {
        const t = await fetcTabOrNull(own.tabId);
        if (!t) return; // 已被關掉,或 id 現在是別的網域的分頁:不碰
        let wholeWindow = false;
        if (own.windowId != null && (t.windowId == null || t.windowId === own.windowId)) {
          // b4s L1:視窗裡只剩自己的分頁才關整個視窗;使用者把分頁開進(拖進)這個視窗＝只關自己的分頁
          try {
            const w = await chrome.windows.get(own.windowId, { populate: true });
            const tabs = (w && Array.isArray(w.tabs) && w.tabs) || [];
            wholeWindow = tabs.length > 0 && tabs.every((x) => x.id === own.tabId);
          } catch (e) {
            wholeWindow = false;
          }
        }
        if (wholeWindow) await chrome.windows.remove(own.windowId);
        else await chrome.tabs.remove(own.tabId);
      } catch (e) {
        /* 已被使用者關掉 */
      }
    }

    // 等挑戰頁自動通過:每 3 秒看一次,最多 45 秒(含等分頁載入的時間,b4s L3)。回 'ok' | 'login' | 'challenge'
    async function settlePage(tabId) {
      const deadline = now() + CF_WAIT_MS;
      for (;;) {
        const loaded = await waitTabComplete(tabId, deadline);
        if (!loaded && now() >= deadline) return 'challenge'; // 等滿還沒載完:不再探頁(探頁本身也可能卡 5 秒)
        const c = await probePage(tabId);
        if (c === 'ok' || c === 'login') return c;
        if (now() >= deadline) return 'challenge'; // unknown 久了也當卡住
        await sleep(CF_STEP_MS);
      }
    }

    async function postResult(agent, body) {
      let { json, dropped } = shrinkResultBody(body);
      if (dropped.length) log('result-shrunk', dropped.length);
      if (byteLength(json) > RESULT_LIMIT_BYTES) {
        // 縮 PDF 後還是太大(例如非 PDF 的 data 灌水):整筆改回報 error,不送大 body
        json = JSON.stringify({ id: body && body.id, ok: false, reason: 'error' });
        log('result-oversize');
      }
      let last = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await callSite(agent, 'etag-agent-result', json);
          if (r.status === 401) return { revoked: true, next: [] };
          if (r.status === 200 && r.data && r.data.ok) return { next: Array.isArray(r.data.next) ? r.data.next : [] };
          if (r.status === 409) return { next: [], failed: 'not-claimed' }; // 不是我領的(逾時被別台領走):丟掉
          last = `HTTP ${r.status}`;
        } catch (e) {
          last = 'network';
        }
        await sleep(2000);
      }
      return { next: [], failed: last };
    }

    function withTimeout(promise, ms) {
      return new Promise((resolve) => {
        const h = timer.set(() => resolve({ timedOut: true }), ms);
        promise.then(
          (v) => {
            timer.clear(h);
            resolve({ value: v });
          },
          (e) => {
            timer.clear(h);
            resolve({ error: e });
          }
        );
      });
    }

    // 在分頁內跑一個工作 → 上傳用的 {ok,reason?,data?};順便回 cinCache
    async function execJob(tabId, job, cinCache) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: PAGE_FILES });
      } catch (e) {
        return { out: { ok: false, reason: 'error' }, message: 'inject-failed' };
      }
      const r = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: gflPageRunner, args: [job, cinCache] }),
        JOB_TIMEOUT_MS
      );
      if (r.timedOut) return { out: { ok: false, reason: 'error' }, message: 'job-timeout' };
      if (r.error) return { out: { ok: false, reason: 'error' }, message: sanitizeMessage('execute ' + String((r.error && r.error.message) || r.error)) };
      const res = r.value && r.value[0] && r.value[0].result;
      if (!res) return { out: { ok: false, reason: 'error' }, message: 'no-result' };
      if (!res.ok) {
        const reason = sanitizeReason(res.reason);
        // 失敗一律帶 message(步驟＋status;頁面沒給就用 reason 本身)
        return { out: { ok: false, reason }, message: sanitizeMessage(res.message) || reason };
      }
      const ret = { out: { ok: true, data: res.data }, cinCache: sanitizeCinCache(res.cinCache) };
      const msg = sanitizeMessage(res.message);
      if (msg) ret.message = msg;
      return ret;
    }

    async function fetcLoggedIn() {
      let cookies = [];
      try {
        cookies = (await chrome.cookies.getAll({ domain: FETC_COOKIE_DOMAIN })) || [];
      } catch (e) {
        cookies = [];
      }
      return cookies.some((c) => c.name === FETC_LOGIN_COOKIE);
    }

    // exclude:要站台這次不發的工作型別(b78f F-1:憑證被擋後帶兩種 print)
    async function pollSite(agent, fetcState, max, exclude) {
      const lastError = await getLocal('pendingError');
      const body = { version, fetcState, max };
      if (Array.isArray(exclude) && exclude.length) body.exclude = exclude.slice();
      if (lastError) body.lastError = String(lastError).slice(0, 200);
      const r = await callSite(agent, 'etag-agent-poll', body);
      if (r.status === 401) return { revoked: true, status: 401 };
      return r;
    }

    // 一輪的第一次 poll:失敗就記錄並結束這輪(回 {exit}),成功回 {data}
    async function firstPoll(agent, fetcState, max) {
      let poll;
      try {
        poll = await pollSite(agent, fetcState, max);
      } catch (e) {
        await local.set({ pendingError: 'poll-network' });
        return { exit: await recordRun({ ok: false, state: 'error', message: '連不到站台,請稍後再按一次「執行」' }) };
      }
      if (poll.revoked) return { exit: await revokedExit() };
      if (poll.status !== 200 || !poll.data || !poll.data.ok) {
        await local.set({ pendingError: `poll-http-${poll.status}` });
        return { exit: await recordRun({ ok: false, state: 'error', message: `站台回應異常(HTTP ${poll.status})` }) };
      }
      await local.remove('pendingError');
      return { data: poll.data };
    }

    async function runInner() {
      const agent = await getLocal('agent');
      if (!agent || !agent.token || !agent.baseUrl) return { skipped: 'unpaired' };
      if (!isHostPermitted(agent.baseUrl, hosts)) {
        return recordRun({ ok: false, state: 'error', message: '站台網址不在擴充功能允許的網域內,請到設定頁檢查' });
      }

      if (!(await fetcLoggedIn())) {
        // 未登入:只心跳＋取統計(max:0 不領工作),不開分頁
        const p = await firstPoll(agent, 'login-required', 0);
        if (p.exit) return p.exit;
        return recordRun({ state: 'login-required', message: MSG_NOT_LOGGED_IN });
      }

      const first = await firstPoll(agent, 'ok', POLL_MAX_JOBS);
      if (first.exit) return first.exit;
      let lastQueue = first.data.queue;
      // 站台有回 queue 統計(b7 起一律有)才「佇列空了再問一次」;舊站台只做這一批
      const canRepoll = !!(lastQueue && typeof lastQueue === 'object');

      const queue = [];
      const known = new Set(); // 本輪已收下(已做或已回報)的工作 id
      // 站台再發回本輪已處理過的 id:不執行、不再回報、不算新工作(b78f F-2;重報會燒 attempts)
      function admit(jobs) {
        let fresh = 0;
        for (const j of Array.isArray(jobs) ? jobs : []) {
          if (!j || known.has(j.id)) continue;
          known.add(j.id);
          queue.push(j);
          fresh++;
        }
        return fresh;
      }
      admit(first.data.jobs);

      const finish = async (pdfBlocked) => {
        await local.set({ pdfPending: !!pdfBlocked || queueCounts(lastQueue).print > 0 });
      };

      if (!queue.length) {
        await finish(false);
        return recordRun({ state: 'ok', message: '沒有待處理工作' });
      }

      // 有工作:每輪開新的遠通分頁(不沿用上一輪留下的分頁)
      const own = await openTab();

      let stop = null; // 'login-required' | 'cf-interactive'
      let done = 0;
      let lastErr = null;
      let leaveTab = false;
      let pdfBlocked = false; // 憑證被 CF 擋:本輪其餘憑證工作不做,查詢照做
      const blocked = new Set();
      let processed = 0;
      let polls = 1;
      try {
        const page = await settlePage(own.tabId);
        if (page === 'login') stop = 'login-required';
        else if (page === 'challenge') {
          stop = 'cf-interactive';
          leaveTab = true; // 分頁留給人處理;不記下來,下一輪開新分頁
        }

        let cinCache = sanitizeCinCache(await getLocal('cinCache'));
        for (;;) {
          while (queue.length && processed < MAX_JOBS_PER_RUN) {
            const job = queue.shift();
            processed++;
            const isPrint = PRINT_TYPES.includes(job.type);
            if (stop || (isPrint && pdfBlocked)) {
              const body = { id: job.id, ok: false, reason: stop || 'cf-challenge' };
              if (!stop) blocked.add(job.id);
              const rr = await postResult(agent, body);
              if (rr.revoked) return revokedExit();
              continue;
            }
            const ex = await execJob(own.tabId, job, cinCache);
            if (ex.cinCache) {
              cinCache = sanitizeCinCache({ ...cinCache, ...ex.cinCache });
              await local.set({ cinCache });
            }
            if (ex.message && isRealError(ex)) lastErr = ex.message; // 偏離 6 降噪:cin-not-found／no-rows 這類正常業務結果不算錯誤
            const body = ex.out.ok ? { id: job.id, ok: true, data: ex.out.data } : { id: job.id, ok: false, reason: ex.out.reason };
            let s = sessionStopOf(ex.out);
            if (isPrint && s === 'cf-interactive') {
              // 憑證被擋只擋憑證:照回報(站台釋放並退還次數),本輪之後的憑證工作不做
              pdfBlocked = true;
              blocked.add(job.id);
              s = null;
            }
            const rr = await postResult(agent, body);
            if (rr.revoked) return revokedExit();
            if (!rr.failed && !blocked.has(job.id)) done++;
            if (s) {
              stop = s;
              leaveTab = s === 'cf-interactive';
            }
            if (rr.next.length) admit(rr.next);
          }
          // 超過單輪上限留下的:放回(不回報,claim 過期自會重領)
          if (stop || queue.length || processed >= MAX_JOBS_PER_RUN || !canRepoll || polls >= MAX_POLLS_PER_RUN) break;
          let p;
          try {
            // 憑證已被擋:之後的 poll 請站台別再發憑證工作,名額留給查詢(b78f F-1)
            p = await pollSite(agent, 'ok', Math.min(POLL_MAX_JOBS, MAX_JOBS_PER_RUN - processed), pdfBlocked ? PRINT_TYPES : undefined);
          } catch (e) {
            await local.set({ pendingError: 'poll-network' });
            break;
          }
          polls++;
          if (p.revoked) return revokedExit();
          if (p.status !== 200 || !p.data || !p.data.ok) {
            await local.set({ pendingError: `poll-http-${p.status}` });
            break;
          }
          lastQueue = p.data.queue;
          const fresh = admit(p.data.jobs);
          if (!fresh) break; // 站台回空(或只剩本輪已處理過的)
        }
      } finally {
        if (!leaveTab) await closeOwned(own);
      }

      await finish(pdfBlocked);
      if (lastErr) {
        const msg = sanitizeMessage(String(lastErr)) || 'error';
        await local.set({ pendingError: msg, lastError: { at: now(), message: msg } });
      }
      if (stop === 'login-required') return recordRun({ count: done, state: 'login-required', message: MSG_RELOGIN });
      if (stop === 'cf-interactive') return recordRun({ count: done, state: 'cf-interactive', message: MSG_CF_TAB });
      if (pdfBlocked) {
        // 待補數＝最後一次 poll 回應的站台憑證數;回應沒有 queue(舊站台)才退回本輪被擋數(b78f F-1)
        const n = lastQueue && typeof lastQueue === 'object' ? queueCounts(lastQueue).print : blocked.size;
        return recordRun({ count: done, state: 'cf-interactive', message: msgPdfBlocked(done, n) });
      }
      return recordRun({ count: done, state: 'ok', message: `完成 ${done} 筆工作` });
    }

    async function revokedExit() {
      await clearPairing();
      return recordRun({ ok: false, state: 'revoked', message: '這台已被移除,請重新配對' });
    }

    // 對外:run。同時只跑一個(記憶體旗標擋同一個 SW 內的並行;storage.session 鎖擋 SW 重啟後的殘留,5 分鐘過期)
    // opts.trigger:'popup'(按「執行」)｜'download'(員工在遠通下載了憑證)｜undefined,記進 lastRun.trigger
    async function run(opts) {
      if (running) return { skipped: 'busy' };
      running = true;
      try {
        const lock = session ? (await session.get('runLock')).runLock : null;
        if (lock && now() - lock.at < RUN_LOCK_MS) return { skipped: 'busy' };
        if (session) await session.set({ runLock: { at: now() } });
        const tr = opts && opts.trigger;
        trigger = TRIGGERS.includes(tr) ? tr : undefined;
        keepAlive.start();
        try {
          return await runInner();
        } catch (e) {
          log('run-failed', String((e && e.message) || e).slice(0, 100));
          await local.set({ pendingError: String((e && e.message) || e).slice(0, 200) });
          return recordRun({ ok: false, state: 'error', message: '執行失敗,請稍後再按一次「執行」' });
        } finally {
          keepAlive.stop();
          if (session) await session.remove('runLock');
          trigger = undefined;
        }
      } finally {
        running = false;
      }
    }

    // 對外:peek(popup 開啟時用)。poll max:0＝只心跳＋取統計;不開分頁、不執行工作
    async function peek() {
      const agent = await getLocal('agent');
      const loggedIn = await fetcLoggedIn();
      const none = { queue: null, mode: null };
      if (!agent || !agent.token || !agent.baseUrl) return { paired: false, loggedIn, ...none };
      if (!isHostPermitted(agent.baseUrl, hosts)) return { paired: true, loggedIn, ...none, error: 'host-not-permitted' };
      let r;
      try {
        r = await pollSite(agent, loggedIn ? 'ok' : 'login-required', 0);
      } catch (e) {
        return { paired: true, loggedIn, ...none, error: 'network' };
      }
      if (r.revoked) {
        await revokedExit();
        return { paired: false, loggedIn, ...none, revoked: true };
      }
      if (r.status !== 200 || !r.data || !r.data.ok) return { paired: true, loggedIn, ...none, error: `http-${r.status}` };
      const queue = r.data.queue && typeof r.data.queue === 'object' && !Array.isArray(r.data.queue) ? r.data.queue : null;
      await local.set({ lastPeek: { at: now(), queue } });
      return { paired: true, loggedIn, queue, mode: typeof r.data.mode === 'string' ? r.data.mode : null };
    }

    return { run, peek, clearPairing };
  }

  // ── 配對(設定頁用)──────────────────────────────────────────────────────────
  // 成功 → 存 {agentId,token,name,baseUrl} 到 chrome.storage.local。token 不回傳給呼叫端。
  async function pairAgent(opts) {
    const o = opts || {};
    const baseUrl = resolveBaseUrl(o.baseUrl);
    if (!isHostPermitted(baseUrl, o.hostPatterns)) return { ok: false, reason: 'host-not-permitted' };
    const code = String(o.code || '').trim().toUpperCase();
    if (!code) return { ok: false, reason: 'bad-code' };
    let resp;
    try {
      resp = await o.fetch(`${baseUrl}/api/collect?action=etag-agent-pair`, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, version: o.version || '' }),
      });
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      data = null;
    }
    if (resp.status === 200 && data && data.ok && data.agentId && data.token) {
      await o.storage.set({
        agent: { agentId: data.agentId, token: data.token, name: String(data.name || ''), baseUrl },
      });
      return { ok: true, name: String(data.name || '') };
    }
    if (resp.status === 429) return { ok: false, reason: 'throttled' };
    if (resp.status === 400) return { ok: false, reason: 'bad-code' };
    return { ok: false, reason: `http-${resp.status}` };
  }

  const api = {
    DEFAULT_BASE_URL,
    LEGACY_BASE_URL_RE,
    FETC_MEMBER_URL,
    FETC_COOKIE_DOMAIN,
    FETC_LOGIN_COOKIE,
    RUN_LOCK_MS,
    JOB_TIMEOUT_MS,
    CF_WAIT_MS,
    CF_STEP_MS,
    PROBE_TIMEOUT_MS,
    MAX_JOBS_PER_RUN,
    MAX_POLLS_PER_RUN,
    POLL_MAX_JOBS,
    RESULT_LIMIT_BYTES,
    PAGE_FILES,
    PRINT_TYPES,
    ALLOWED_REASONS,
    MSG_NOT_LOGGED_IN,
    MSG_CF_TAB,
    msgPdfBlocked,
    resolveBaseUrl,
    isHostPermitted,
    isFetcUrl,
    sanitizeReason,
    sanitizeCinCache,
    sanitizeMessage,
    classifyPage,
    shrinkResultBody,
    sessionStopOf,
    queueCounts,
    lastRunText,
    gflProbePage,
    gflPageRunner,
    createAgentCore,
    pairAgent,
  };

  root.GflAgentCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
