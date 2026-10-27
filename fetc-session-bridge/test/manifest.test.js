'use strict';
// manifest／頁面檔守門(b4):版本、權限、background、host_permissions、舊中繼摺疊區、公開 repo 零密鑰。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('manifest:version 2.0.0、權限清單、background service worker', () => {
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'clipboardWrite', 'cookies', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
});

test('manifest:host_permissions 保留遠通與站台網域,不含 vercel.app', () => {
  assert.deepEqual(manifest.host_permissions, ['https://*.fetc.net.tw/*', 'https://admin.gafferland.com/*']);
});

test('預設站台網址在 host_permissions 內', () => {
  const core = require('../agent-core');
  assert.equal(core.isHostPermitted(core.DEFAULT_BASE_URL, manifest.host_permissions), true);
});

test('background.js 引入 agent-core.js 並建 5 分鐘 alarm', () => {
  const bg = read('background.js');
  assert.match(bg, /importScripts\('agent-core\.js'\)/);
  assert.match(bg, /chrome\.alarms\.create\(GflAgentCore\.ALARM_NAME/);
  assert.equal(require('../agent-core').ALARM_PERIOD_MIN, 5);
  assert.equal(require('../agent-core').ALARM_NAME, 'gfl-etag-poll');
});

test('popup.html:舊中繼兩個鈕在「舊中繼(備援)」摺疊區內,文案不變', () => {
  const html = read('popup.html');
  const m = /<details class="legacy">([\s\S]*?)<\/details>/.exec(html);
  assert.ok(m, '找不到摺疊區');
  assert.match(m[1], /<summary>舊中繼\(備援\)<\/summary>/);
  assert.match(m[1], /id="primaryBtn"/);
  assert.match(m[1], /<button id="copyBtn">複製 Cookie 字串<\/button>/);
  const js = read('popup.js');
  assert.match(js, /"更新 Gafferland session"/);
  assert.match(js, /action=relay-session/);
  assert.match(js, /已複製,可貼到 \/collect 的「貼 Cookie 補救」/);
});

test('popup.html／options.html 零 inline script,且載入 agent-core.js', () => {
  for (const f of ['popup.html', 'options.html']) {
    const html = read(f);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f} 有 inline script`);
    assert.match(html, /<script src="agent-core\.js"><\/script>/);
  }
});


// 取出所有 log(...)／console.xxx(...) 呼叫的完整引數文字:從 "(" 起做括號平衡,字串字面值內的括號不計,但字串內容保留在回傳文字中
function logCallArgs(src) {
  const out = [];
  const re = /(?<![\w$])(?:log|console\.\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    const start = i;
    let depth = 1;
    let q = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"' || c === '`') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

test('C2:agent-core／background 不直接 fetch 遠通;token 不進 log', () => {
  for (const f of ['agent-core.js', 'background.js']) {
    const src = read(f);
    for (const m of src.matchAll(/\bfetch\s*\(([^)]*)\)/g)) {
      assert.ok(!/fetc/i.test(m[1]), `${f} 直接 fetch 遠通: ${m[0]}`);
    }
    // log／console 呼叫的完整引數文字(括號平衡掃描,不靠 [^)]*)不得含 token,也不得把整個 agent 物件丟進去
    const calls = logCallArgs(src);
    assert.ok(calls.length > 0, `${f} 掃不到任何 log 呼叫(掃描器壞了?)`);
    for (const a of calls) {
      assert.ok(!/\.token\b|\btoken\b/i.test(a), `${f} 把 token 放進 log/console: ${a}`);
      assert.ok(!/(^|[^.\w'"])agent\b(?!Id)/.test(a), `${f} 把 agent 物件放進 log/console: ${a}`);
    }
  }
  const core = read('agent-core.js');
  // 呼叫自家站台一律不帶 cookie
  assert.match(core, /credentials: 'omit'/);
  assert.ok(!/credentials: 'include'/.test(core));
});

test('公開 repo:擴充功能目錄零密鑰樣式', () => {
  for (const f of ['agent-core.js', 'background.js', 'options.js', 'popup.js', 'manifest.json']) {
    const src = read(f);
    assert.ok(!/(sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|FETC_P=[A-Za-z0-9]{8,})/.test(src), `${f} 疑似密鑰`);
  }
});

test('T2:logCallArgs 掃描器自測:巢狀括號／字串內括號／換行都抓得到引數尾端的 token', () => {
  const hit = (src) => logCallArgs(src).some((a) => /\.token\b/.test(a));
  assert.ok(hit("log('x', foo(bar(1)), agent.token)"));
  assert.ok(hit("log('a (b', fn(')'), agent.token)"));
  assert.ok(hit("console.log(\n  'x',\n  `${agent.token}`\n)"));
  assert.ok(hit("log('x', JSON.stringify({ t: agent.token }))"));
  assert.ok(!hit("log('x', agent.agentId); const t = agent.token;"));
});

test('b4r:onStartup 會清遺留 cfTab', () => {
  const bg = read('background.js');
  const m = /onStartup\.addListener\(([\s\S]*?)\n\}\);/.exec(bg);
  assert.ok(m, '找不到 onStartup listener');
  assert.match(m[1], /clearStaleTab\(\)/);
});
