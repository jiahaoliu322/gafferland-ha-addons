// ── 擴充功能 2.0.0 執行面核心(可注入依賴,不直接碰全域 chrome)────────────────────
// background.js 只負責把真的 chrome.* 接進來;這裡的邏輯用假 chrome／假 fetch 在 node 測試。
//
// 流程(一次 run):
//   未配對 → 結束;遠通 cookie(FETC_P)判斷登入 → POST etag-agent-poll → 有工作才開遠通分頁 →
//   (挑戰頁／登入頁判斷)→ 逐工作把 fetc-parse.js＋fetc-chain.js 注入該分頁(MAIN world)執行 →
//   POST etag-agent-result(回應的 next 接著做)→ 關自己開的分頁。
// 鐵則:
//   - 遠通請求一律由遠通分頁內的 fetch 發出;這支檔案(背景頁)只 fetch 自家站台。
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

  const ALARM_NAME = 'gfl-etag-poll';
  const ALARM_PERIOD_MIN = 5;
  const RUN_LOCK_MS = 5 * 60 * 1000;
  const JOB_TIMEOUT_MS = 4 * 60 * 1000;
  const CF_WAIT_MS = 45 * 1000;
  const CF_STEP_MS = 3 * 1000;
  const TAB_LOAD_TIMEOUT_MS = 30 * 1000;
  const TAB_POLL_MS = 500;
  // 分頁導航一直沒 commit(遠通卡住)時 executeScript 會永遠不回(真 Chromium 實測),探頁要有自己的上限
  const PROBE_TIMEOUT_MS = 5 * 1000;
  const MAX_JOBS_PER_RUN = 30;
  const RESULT_LIMIT_BYTES = 4 * 1024 * 1024; // Vercel 請求上限 4.5MB
  const POLL_MAX_JOBS = 3;
  const SESSION_REASONS = ['login-required', 'cf-interactive', 'cf-challenge'];
  const PAGE_FILES = ['fetc-parse.js', 'fetc-chain.js'];
  // 頁面回傳可信度:reason 只收 10-common 列的值;cinCache 限 key/value 長度與筆數
  const ALLOWED_REASONS = ['login-required', 'cf-interactive', 'cf-challenge', 'no-rows', 'cin-not-found', 'pdf-failed', 'error'];
  const CIN_MAX_ENTRIES = 200;
  const CIN_MAX_KEY = 20;
  const CIN_MAX_VALUE = 40;
  // 過驗證(b4p):分頁內 fetch 被 Cloudflare 擋時,整頁導到被擋的路徑(或照原生「列印」整頁 POST)讓 Chrome 過挑戰
  const FETC_ORIGIN = 'https://www.fetc.net.tw';
  const GETPDF_PATH = '/UX0000Common/UX000006GetPDF';
  // 頁面回報的 cfPath 只收這些(＝fetc-chain.js 會打的路徑);其他一律不導航
  const CF_PATHS = [
    '/Member',
    '/Member/Setting',
    '/UX0505Traffic/UX050506TrafficAdvancedSearch',
    '/UX0505Traffic/UX050507AdvancedSearchDetail',
    '/UX0505Traffic/UX050508TrafficAdvancedSearchPrint',
    GETPDF_PATH,
  ];
  const CF_CLEARANCE_COOKIE = 'cf_clearance';
  const MESSAGE_MAX = 200;
  // 只有這幾種才算「真正的錯誤」寫進 pendingError／popup 最後錯誤;cin-not-found／no-rows 是正常業務結果
  const REAL_ERROR_REASONS = ['cf-challenge', 'login-required', 'pdf-failed', 'error'];
  const MSG_CF_CLICK = '請到遠通分頁點一下驗證';
  const MSG_CF_RETRY = '遠通驗證沒能自動通過,下一輪會再試(分頁上若有驗證請點一下)';

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

  // 頁面回報的被擋路徑:只收白名單內的值
  function sanitizeCfPath(p) {
    return typeof p === 'string' && CF_PATHS.includes(p) ? p : null;
  }

  // 網址是否就是「本步驟導去的那一頁」:遠通網域、路徑相同(不分大小寫)、r 參數相同
  function isAtTarget(url, path, r) {
    let u;
    try {
      u = new URL(String(url || ''));
    } catch (e) {
      return false;
    }
    if (u.origin !== FETC_ORIGIN) return false;
    if (u.pathname.toLowerCase() !== String(path).toLowerCase()) return false;
    return r === undefined || u.searchParams.get('r') === String(r);
  }

  // 下載是否為「過驗證這一步產生的遠通 GetPDF 下載」:網址＝https://www.fetc.net.tw + GETPDF_PATH、
  // 查詢參數 r＝本步驟表單網址的 r(使用者自己按列印的下載 r 不同,不會被碰),且開始時間 ≥ sinceMs
  function isOwnPdfDownload(item, sinceMs, r) {
    if (!item || r === undefined || r === null) return false;
    const urlOk = [item.url, item.finalUrl].some((x) => {
      try {
        const u = new URL(String(x || ''));
        return (
          u.origin === FETC_ORIGIN &&
          u.pathname.toLowerCase() === GETPDF_PATH.toLowerCase() &&
          u.searchParams.get('r') === String(r)
        );
      } catch (e) {
        return false;
      }
    });
    if (!urlOk) return false;
    const t = Date.parse(item.startTime);
    return Number.isFinite(t) && Number.isFinite(sinceMs) && t >= sinceMs;
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
      // 分頁內任何 fetch 被 CF 擋(fetch 層挑戰瀏覽器不會自解)→ 整筆回 cf-challenge＋被擋路徑,交給背景頁過驗證後重跑
      const cf = typeof chain.lastChallenge === 'function' ? chain.lastChallenge() : null;
      if (cf) {
        return {
          ok: false,
          reason: 'cf-challenge',
          message: ('cf-challenge step=' + cf.step + ' status=' + cf.status).slice(0, 200),
          cfPath: cf.path,
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

  // 過驗證 POST 分支:照遠通原生「列印」整頁送出表單(Portal.Common.SendToURL 同形),讓 Chrome 遇挑戰時走整頁驗證。
  // content＝極小 HTML 的 base64;__RequestVerificationToken＝頁面現有值。必須自足(會被序列化注入)。
  function gflSubmitPdfForm(action) {
    try {
      const tokEl = document.querySelector('input[name="__RequestVerificationToken"]');
      const f = document.createElement('form');
      f.method = 'post';
      f.action = action;
      f.style.display = 'none';
      const add = (n, v) => {
        const i = document.createElement('input');
        i.type = 'hidden';
        i.name = n;
        i.value = v;
        f.appendChild(i);
      };
      add('content', btoa('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>'));
      add('__RequestVerificationToken', tokEl ? tokEl.value : '');
      (document.body || document.documentElement).appendChild(f);
      f.submit();
      return { ok: true };
    } catch (e) {
      return { ok: false };
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

    async function clearPairing() {
      await local.remove(['agent', 'cfTab']);
    }

    async function recordRun(info) {
      const rec = { at: now(), count: 0, state: 'ok', message: '', ...info };
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

    // 過驗證用:觀察分頁到了目標頁(路徑＋r 參數)之後,有沒有出現挑戰、之後有沒有變正常。
    // 最多 45 秒(含載入)。extra() 回 true＝提早結束(POST 分支:已出現本步驟的 GetPDF 下載)。
    // 回 {result:'ok'|'login'|'challenge'|'timeout'|'extra', saw}
    async function watchPage(tabId, path, r, extra) {
      const deadline = now() + CF_WAIT_MS;
      let saw = false;
      for (;;) {
        const loaded = await waitTabComplete(tabId, deadline);
        if (!loaded && now() >= deadline) return { result: saw ? 'challenge' : 'timeout', saw };
        const p = await probeInfo(tabId);
        if (p.cls === 'login') return { result: 'login', saw };
        if (isAtTarget(p.url, path, r)) {
          if (p.cls === 'challenge') saw = true;
          else if (p.cls === 'ok') return { result: 'ok', saw };
        }
        if (extra && (await extra())) return { result: 'extra', saw };
        if (now() >= deadline) return { result: saw ? 'challenge' : 'timeout', saw };
        await sleep(CF_STEP_MS);
      }
    }

    // cf_clearance 的指紋(只在記憶體比對前後是否換發;不存、不 log)
    async function cfCookieSig() {
      try {
        const cs = (await chrome.cookies.getAll({ domain: FETC_COOKIE_DOMAIN })) || [];
        return cs
          .filter((c) => c && c.name === CF_CLEARANCE_COOKIE)
          .map((c) => `${c.domain}|${c.value}|${c.expirationDate || ''}`)
          .sort()
          .join(';');
      } catch (e) {
        return '';
      }
    }

    // 只取消／清除「sinceMs 之後建立、網址是遠通 GetPDF 且 r＝本步驟表單的 r」的下載(過驗證 POST 分支產生的);
    // 其他下載(含使用者自己按列印的 GetPDF)一律不碰。回清掉幾筆
    async function purgePdfDownloads(sinceMs, r) {
      const dl = chrome.downloads;
      if (!dl || typeof dl.search !== 'function') return 0;
      let items = [];
      try {
        items = (await dl.search({ orderBy: ['-startTime'], limit: 50 })) || [];
      } catch (e) {
        return 0;
      }
      let n = 0;
      for (const it of items) {
        if (!isOwnPdfDownload(it, sinceMs, r)) continue;
        n++;
        try {
          await dl.cancel(it.id);
        } catch (e) {
          /* 已完成的下載不能 cancel */
        }
        try {
          await dl.removeFile(it.id);
        } catch (e) {
          /* 未完成／已不存在 */
        }
        try {
          await dl.erase({ id: it.id });
        } catch (e) {
          /* 已清除 */
        }
      }
      return n;
    }

    // 過驗證(一輪最多一次)。回 {ok, via:'get'|'post'|null, login?, stuck?, pdfSince?, pdfR?}
    //   a. GET 整頁導到被擋路徑:看到挑戰且之後變正常(或 cf_clearance 換發)＝通過
    //   b. GET 沒出現挑戰:回 Member,頁內建 form 整頁 POST 到 GetPDF;同樣觀察挑戰→通過(或本步驟的 GetPDF 下載出現)
    //   挑戰等滿 45 秒仍在＝stuck(分頁就停在那個挑戰頁,讓人點)
    async function clearChallenge(tabId, cfPath) {
      const sig0 = await cfCookieSig();
      const rA = now();
      await chrome.tabs.update(tabId, { url: `${FETC_ORIGIN}${cfPath}?&r=${rA}` });
      const a = await watchPage(tabId, cfPath, rA);
      if (a.result === 'login') return { ok: false, via: null, login: true };
      const passedA = a.result === 'ok' && (a.saw || (await cfCookieSig()) !== sig0);
      if (passedA) return { ok: true, via: 'get' };
      if (a.saw) return { ok: false, via: null, stuck: true };

      // b. 該路徑只挑 POST:照原生「列印」整頁送出
      await chrome.tabs.update(tabId, { url: FETC_MEMBER_URL });
      const m = await settlePage(tabId);
      if (m === 'login') return { ok: false, via: null, login: true };
      if (m !== 'ok') return { ok: false, via: null, stuck: true };
      const since = now();
      const sig1 = await cfCookieSig();
      const rB = now();
      let dlSeen = false;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: gflSubmitPdfForm,
          args: [`${FETC_ORIGIN}${GETPDF_PATH}?&r=${rB}`],
        });
      } catch (e) {
        return { ok: false, via: null, pdfSince: since, pdfR: rB };
      }
      const b = await watchPage(tabId, GETPDF_PATH, rB, async () => {
        if ((await purgePdfDownloads(since, rB)) > 0) dlSeen = true;
        return dlSeen;
      });
      if ((await purgePdfDownloads(since, rB)) > 0) dlSeen = true;
      if (b.result === 'login') return { ok: false, via: null, login: true, pdfSince: since, pdfR: rB };
      const changed = b.saw || (await cfCookieSig()) !== sig1;
      if (changed && (b.result === 'ok' || dlSeen)) return { ok: true, via: 'post', pdfSince: since, pdfR: rB };
      return { ok: false, via: null, stuck: b.result === 'challenge', pdfSince: since, pdfR: rB };
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
        const ret = { out: { ok: false, reason }, message: sanitizeMessage(res.message) || reason };
        if (reason === 'cf-challenge') ret.cfPath = sanitizeCfPath(res.cfPath);
        return ret;
      }
      const ret = { out: { ok: true, data: res.data }, cinCache: sanitizeCinCache(res.cinCache) };
      const msg = sanitizeMessage(res.message);
      if (msg) ret.message = msg;
      return ret;
    }

    // 工作被 CF 擋(有 cfPath)時:本輪還沒過過驗證就過一次,通過後回 Member 重跑同一筆。
    // 回 {ex(最終結果), stop?, pdfSince?, pdfR?, stuck?};stop＝'cf-interactive'(分頁留著)或 'login-required';
    // stuck＝真的停在挑戰頁(有可點的驗證)
    async function clearAndRetry(own, job, ex, cinCache, ctx) {
      if (ctx.clearanceUsed) return { ex, stop: 'cf-interactive' }; // 本輪已過過一次:直接停(d)
      ctx.clearanceUsed = true;
      let cl;
      try {
        cl = await clearChallenge(own.tabId, ex.cfPath);
      } catch (e) {
        cl = { ok: false, via: null };
      }
      await local.set({ lastClearance: { at: now(), via: cl.ok ? cl.via : null, ok: !!cl.ok } });
      const pdfSince = cl.pdfSince;
      const pdfR = cl.pdfR;
      const fail = (stop) => ({ ex, stop, pdfSince, pdfR, stuck: !!cl.stuck });
      if (cl.login) return { ex: { ...ex, out: { ok: false, reason: 'login-required' } }, stop: 'login-required', pdfSince, pdfR };
      if (!cl.ok) return fail('cf-interactive'); // d:分頁停在原地(挑戰頁本身),不導回 Member
      try {
        await chrome.tabs.update(own.tabId, { url: FETC_MEMBER_URL });
      } catch (e) {
        return fail('cf-interactive');
      }
      const page = await settlePage(own.tabId);
      if (page === 'login') return { ex: { ...ex, out: { ok: false, reason: 'login-required' } }, stop: 'login-required', pdfSince, pdfR };
      if (page !== 'ok') return fail('cf-interactive');
      const ex2 = await execJob(own.tabId, job, cinCache);
      if (pdfSince !== undefined) await purgePdfDownloads(pdfSince, pdfR); // 慢到的 GetPDF 下載也清掉
      if (ex2.cfPath !== undefined) return { ex: ex2, stop: 'cf-interactive', pdfSince, pdfR }; // 重跑仍被擋(d)
      return { ex: ex2, pdfSince: undefined, pdfR: undefined };
    }

    async function runInner() {
      const agent = await getLocal('agent');
      if (!agent || !agent.token || !agent.baseUrl) return { skipped: 'unpaired' };
      if (!isHostPermitted(agent.baseUrl, hosts)) {
        return recordRun({ ok: false, state: 'error', message: '站台網址不在擴充功能允許的網域內,請到設定頁檢查' });
      }

      // 上次留下等人點驗證的分頁
      let own = null;
      const left = await getLocal('cfTab');
      if (left) {
        // 上輪停在 POST 挑戰頁:人點過後 Chrome 會下載 GetPDF(網址帶本步驟的 r)。只清 r＝rB 的那份
        // (使用者自己按列印的 GetPDF 下載 r 不同,不碰);有清到＝視為已通過(分頁可能仍停在挑戰頁)。
        let ownDl = 0;
        if (Number.isFinite(left.pdfSince) && Number.isFinite(left.pdfR)) ownDl = await purgePdfDownloads(left.pdfSince, left.pdfR);
        // 核對分頁還在且網域仍是遠通;否則清掉、當作沒有(絕不導航／關閉別人的分頁)
        if (await fetcTabOrNull(left.tabId)) {
          let cls = await probePage(left.tabId);
          if (cls === 'challenge' && ownDl > 0) cls = 'ok';
          if (cls === 'challenge') {
            const lp = await pollSite(agent, 'cf-interactive');
            if (lp.revoked) return revokedExit();
            return recordRun({ state: 'cf-interactive', message: MSG_CF_CLICK });
          }
          own = { tabId: left.tabId, windowId: null }; // 沿用的分頁:只用 tabs.remove 關
        } else {
          await local.remove('cfTab');
        }
      }

      let cookies = [];
      try {
        cookies = (await chrome.cookies.getAll({ domain: FETC_COOKIE_DOMAIN })) || [];
      } catch (e) {
        cookies = [];
      }
      const loggedIn = cookies.some((c) => c.name === FETC_LOGIN_COOKIE);
      const fetcState = loggedIn ? 'ok' : 'login-required';

      let poll;
      try {
        poll = await pollSite(agent, fetcState);
      } catch (e) {
        await local.set({ pendingError: 'poll-network' });
        await closeOwned(own);
        await local.remove('cfTab');
        return recordRun({ ok: false, state: 'error', message: '連不到站台,下次再試' });
      }
      if (poll.revoked) {
        await clearPairing();
        return recordRun({ ok: false, state: 'revoked', message: '這台已被移除,請重新配對' });
      }
      if (poll.status !== 200 || !poll.data || !poll.data.ok) {
        await local.set({ pendingError: `poll-http-${poll.status}` });
        return recordRun({ ok: false, state: 'error', message: `站台回應異常(HTTP ${poll.status})` });
      }
      await local.remove('pendingError');

      const queue = Array.isArray(poll.data.jobs) ? poll.data.jobs.slice() : [];
      if (fetcState !== 'ok') {
        await closeOwned(own);
        await local.remove('cfTab');
        return recordRun({ state: 'login-required', message: '遠通尚未登入,請先登入遠通會員區' });
      }
      if (!queue.length) {
        await closeOwned(own);
        await local.remove('cfTab');
        return recordRun({ state: 'ok', message: '沒有待處理工作' });
      }

      // 有工作:開（或沿用）遠通分頁
      if (!own) {
        own = await openTab();
      } else {
        await chrome.tabs.update(own.tabId, { url: FETC_MEMBER_URL });
      }
      await local.remove('cfTab');

      let stop = null; // 'login-required' | 'cf-interactive'
      let done = 0;
      let lastErr = null;
      let keepTab = false;
      let pdfSince; // 留下的分頁停在 POST 挑戰頁時:之後人點過產生的 GetPDF 下載(r＝pdfR),下一輪清掉
      let pdfR;
      let cfStuck = false; // 真的停在挑戰頁(有可點的驗證)→ 訊息請人點;否則用「沒能自動通過」的訊息
      try {
        const page = await settlePage(own.tabId);
        if (page === 'login') stop = 'login-required';
        else if (page === 'challenge') {
          stop = 'cf-interactive';
          keepTab = true;
          cfStuck = true;
        }

        let cinCache = sanitizeCinCache(await getLocal('cinCache'));
        const ctx = { clearanceUsed: false };
        let guard = 0;
        while (queue.length && guard++ < MAX_JOBS_PER_RUN) {
          const job = queue.shift();
          if (stop) {
            const rr = await postResult(agent, { id: job.id, ok: false, reason: stop });
            if (rr.revoked) return revokedExit();
            continue;
          }
          let ex = await execJob(own.tabId, job, cinCache);
          let cfStop = null;
          if (ex.cfPath !== undefined) {
            if (ex.cfPath === null) {
              cfStop = 'cf-interactive'; // 路徑不在白名單:不導航,照舊停下
            } else {
              const cr = await clearAndRetry(own, job, ex, cinCache, ctx);
              ex = cr.ex;
              cfStop = cr.stop || null;
              pdfSince = cr.pdfSince;
              pdfR = cr.pdfR;
              if (cr.stuck) cfStuck = true;
            }
          }
          if (ex.cinCache) {
            cinCache = sanitizeCinCache({ ...cinCache, ...ex.cinCache });
            await local.set({ cinCache });
          }
          if (ex.message && isRealError(ex)) lastErr = ex.message; // 偏離 6 降噪:cin-not-found／no-rows 這類正常業務結果不算錯誤
          const body = ex.out.ok ? { id: job.id, ok: true, data: ex.out.data } : { id: job.id, ok: false, reason: ex.out.reason };
          const s = cfStop || sessionStopOf(ex.out);
          const rr = await postResult(agent, body);
          if (rr.revoked) return revokedExit();
          if (!rr.failed) done++;
          if (s) {
            stop = s;
            keepTab = s === 'cf-interactive';
          }
          if (rr.next.length) queue.push(...rr.next);
        }
        // 超過單輪上限留下的:放回(不回報,claim 過期自會重領)
      } finally {
        if (keepTab) {
          const cfTab = { tabId: own.tabId, windowId: null };
          if (Number.isFinite(pdfSince) && Number.isFinite(pdfR)) {
            cfTab.pdfSince = pdfSince;
            cfTab.pdfR = pdfR;
          }
          await local.set({ cfTab });
        } else await closeOwned(own);
      }

      if (lastErr) {
        const msg = sanitizeMessage(String(lastErr)) || 'error';
        await local.set({ pendingError: msg, lastError: { at: now(), message: msg } });
      }
      if (stop === 'login-required') return recordRun({ count: done, state: 'login-required', message: '遠通需要重新登入' });
      if (stop === 'cf-interactive') return recordRun({ count: done, state: 'cf-interactive', message: cfStuck ? MSG_CF_CLICK : MSG_CF_RETRY });
      return recordRun({ count: done, state: 'ok', message: `完成 ${done} 筆工作` });
    }

    async function revokedExit() {
      await clearPairing();
      return recordRun({ ok: false, state: 'revoked', message: '這台已被移除,請重新配對' });
    }

    async function pollSite(agent, fetcState) {
      const lastError = await getLocal('pendingError');
      const body = { version, fetcState, max: POLL_MAX_JOBS };
      if (lastError) body.lastError = String(lastError).slice(0, 200);
      const r = await callSite(agent, 'etag-agent-poll', body);
      if (r.status === 401) return { revoked: true, status: 401 };
      return r;
    }

    // 對外:run。同時只跑一個(記憶體旗標擋同一個 SW 內的並行;storage.session 鎖擋 SW 重啟後的殘留,5 分鐘過期)
    async function run() {
      if (running) return { skipped: 'busy' };
      running = true;
      try {
        const lock = session ? (await session.get('runLock')).runLock : null;
        if (lock && now() - lock.at < RUN_LOCK_MS) return { skipped: 'busy' };
        if (session) await session.set({ runLock: { at: now() } });
        keepAlive.start();
        try {
          return await runInner();
        } catch (e) {
          log('run-failed', String((e && e.message) || e).slice(0, 100));
          await local.set({ pendingError: String((e && e.message) || e).slice(0, 200) });
          return recordRun({ ok: false, state: 'error', message: '執行失敗,下次再試' });
        } finally {
          keepAlive.stop();
          if (session) await session.remove('runLock');
        }
      } finally {
        running = false;
      }
    }

    // 瀏覽器啟動時:舊 cfTab 的 tabId 已不可信,清掉
    async function clearStaleTab() {
      await local.remove('cfTab');
    }

    return { run, clearPairing, clearStaleTab };
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
    ALARM_NAME,
    ALARM_PERIOD_MIN,
    RUN_LOCK_MS,
    JOB_TIMEOUT_MS,
    CF_WAIT_MS,
    CF_STEP_MS,
    PROBE_TIMEOUT_MS,
    RESULT_LIMIT_BYTES,
    PAGE_FILES,
    ALLOWED_REASONS,
    resolveBaseUrl,
    isHostPermitted,
    isFetcUrl,
    sanitizeReason,
    sanitizeCinCache,
    sanitizeMessage,
    sanitizeCfPath,
    isAtTarget,
    isOwnPdfDownload,
    CF_PATHS,
    GETPDF_PATH,
    classifyPage,
    shrinkResultBody,
    sessionStopOf,
    lastRunText,
    gflProbePage,
    gflPageRunner,
    gflSubmitPdfForm,
    createAgentCore,
    pairAgent,
  };

  root.GflAgentCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
