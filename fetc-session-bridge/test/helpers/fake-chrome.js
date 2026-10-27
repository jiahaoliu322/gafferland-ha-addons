'use strict';
// agent-core 測試用的假 chrome.* 與假站台 fetch。全部合成資料,無真實憑證。
const core = require('../../agent-core');

function makeArea(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    m,
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [...m.keys()];
      const out = {};
      for (const k of list) if (m.has(k)) out[k] = JSON.parse(JSON.stringify(m.get(k)));
      return out;
    },
    async set(o) {
      for (const [k, v] of Object.entries(o)) m.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) m.delete(k);
    },
  };
}

// opts: { agent, cookies, windows(已有視窗數), probe(()=>page state), runJob(job)=>pageRunner 回傳, tabStatus }
function makeFakeChrome(opts) {
  const o = opts || {};
  const calls = { tabsCreated: [], tabsRemoved: [], windowsCreated: [], windowsRemoved: [], injected: [], tabsUpdated: [], scriptWire: [] };
  const state = { nextId: 100, tabs: new Map(), probe: o.probe || (() => ({ url: 'https://www.fetc.net.tw/Member', title: '會員專區', text: 'ok', hasLoginForm: false })) };
  const local = makeArea(o.agent ? { agent: o.agent } : {});
  const session = makeArea();
  const chrome = {
    storage: { local, session },
    cookies: { async getAll() { return o.cookies === undefined ? [{ name: 'FETC_P', value: 'x' }] : o.cookies; } },
    tabs: {
      async create(p) {
        const t = { id: state.nextId++, status: 'complete', url: p.url };
        state.tabs.set(t.id, t);
        calls.tabsCreated.push(p);
        return t;
      },
      async get(id) {
        const t = state.tabs.get(id);
        if (!t) throw new Error('No tab');
        return t;
      },
      async update(id, p) { calls.tabsUpdated.push({ id, ...p }); return state.tabs.get(id); },
      async remove(id) { calls.tabsRemoved.push(id); state.tabs.delete(id); },
    },
    windows: {
      async getAll() { return Array.from({ length: o.windows === undefined ? 1 : o.windows }, (_, i) => ({ id: i + 1 })); },
      async create(p) {
        calls.windowsCreated.push(p);
        const t = { id: state.nextId++, status: 'complete', url: p.url, windowId: 900 };
        state.tabs.set(t.id, t);
        return { id: 900, tabs: [t] };
      },
      async remove(id) { calls.windowsRemoved.push(id); },
    },
    scripting: {
      async executeScript(inj) {
        // 「送進分頁的東西」:args 與函式原始碼序列化後留底,給守門測試掃描(token 不得出現)
        calls.scriptWire.push(JSON.stringify({ files: inj.files || null, args: inj.args || null, func: inj.func ? inj.func.toString() : null }));
        if (inj.files) {
          calls.injected.push({ files: inj.files, world: inj.world, tabId: inj.target.tabId });
          return [];
        }
        if (inj.func === core.gflProbePage) return [{ result: state.probe() }];
        if (inj.func === core.gflPageRunner) {
          const job = inj.args[0];
          calls.injected.push({ job: job.id, world: inj.world, tabId: inj.target.tabId });
          return [{ result: await o.runJob(job, inj.args[1]) }];
        }
        throw new Error('unexpected executeScript');
      },
    },
  };
  return { chrome, calls, state, local, session };
}

// 假站台:handlers = { poll(body, headers)→{status,json}, result(body)→{status,json}, pair }
function makeFakeSite(handlers) {
  const log = [];
  const fetch = async (url, init = {}) => {
    const action = new URL(url).searchParams.get('action');
    const body = init.body ? JSON.parse(init.body) : null;
    log.push({ url, action, body, headers: init.headers, credentials: init.credentials, redirect: init.redirect, bodyBytes: init.body ? init.body.length : 0 });
    const key = action === 'etag-agent-poll' ? 'poll' : action === 'etag-agent-result' ? 'result' : 'pair';
    const r = await handlers[key](body, init.headers);
    return { status: r.status, json: async () => r.json };
  };
  return { fetch, log };
}

const AGENT = { agentId: 'ag1', token: 'TESTTOKEN-synthetic', name: '測試電腦', baseUrl: 'https://admin.gafferland.com' };
const HOSTS = ['https://*.fetc.net.tw/*', 'https://admin.gafferland.com/*'];

function build(opts, handlers, extra) {
  const fake = makeFakeChrome(opts);
  const site = makeFakeSite(handlers);
  const sleeps = [];
  let clock = 1700000000000;
  const timerFires = [];
  const c = core.createAgentCore({
    chrome: fake.chrome,
    fetch: site.fetch,
    version: '2.0.0',
    hostPatterns: HOSTS,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    timer: (extra && extra.timer) || { set: (fn, ms) => { timerFires.push({ fn, ms }); return timerFires.length; }, clear() {} },
  });
  return { core: c, ...fake, site, sleeps, timerFires };
}

module.exports = { makeFakeChrome, makeFakeSite, build, AGENT, HOSTS };
