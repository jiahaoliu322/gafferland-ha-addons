'use strict';
// manifest／頁面檔守門(b4):版本、權限、background、host_permissions、舊中繼摺疊區、公開 repo 零密鑰。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('manifest:version 2.3.0、權限清單(無 alarms、無 downloads、2.3.0 起無 clipboardWrite)、background service worker', () => {
  assert.equal(manifest.version, '2.3.0');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['cookies', 'scripting', 'storage', 'tabs']);
  assert.ok(!manifest.permissions.includes('clipboardWrite'), 'clipboardWrite 只為舊中繼「複製 Cookie 字串」存在');
  assert.ok(!manifest.permissions.includes('alarms'));
  assert.ok(!manifest.permissions.includes('downloads'));
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

test('background.js 引入 agent-core.js、無 alarms、無 downloads(b10)、接 gfl-peek', () => {
  const bg = read('background.js');
  assert.match(bg, /importScripts\('agent-core\.js'\)/);
  assert.ok(!/alarms/.test(bg), 'background 不得用 alarms');
  assert.ok(!/downloads/.test(bg), 'background 不得用 downloads(b10)');
  assert.match(bg, /'gfl-peek'/);
  assert.equal(require('../agent-core').ALARM_NAME, undefined);
  assert.equal(require('../agent-core').ALARM_PERIOD_MIN, undefined);
});

test('2.3.0:popup 已拿掉「舊中繼(備援)」摺疊區——無 details、兩個鈕、relay-session 呼叫、複製 Cookie 與相關函式', () => {
  const html = read('popup.html');
  const js = read('popup.js');
  assert.ok(!/<details\b/i.test(html), 'popup.html 還有 <details>');
  assert.ok(!/舊中繼\(備援\)|class="legacy"|details\.legacy/.test(html), 'popup.html 還有舊中繼區或其樣式');
  for (const id of ['status', 'hint', 'primaryBtn', 'message', 'copyBtn']) {
    assert.ok(!new RegExp(`id="${id}"`).test(html), `popup.html 還有 #${id}`);
    assert.ok(!new RegExp(`#${id}\\b`).test(html), `popup.html 還有 #${id} 樣式`);
  }
  assert.ok(!/relay-session/.test(js), 'popup.js 還呼叫 relay-session');
  assert.ok(!/clipboard/.test(js), 'popup.js 還用 clipboard');
  assert.ok(!/更新 Gafferland session|複製 Cookie|貼 Cookie 補救/.test(js + html), '還有舊中繼文案');
  for (const fn of ['onUpdateSession', 'onCopyCookies', 'getFlattenedCookies', 'getBaseUrl', 'renderLoginState', 'showMessage', 'hideMessage']) {
    assert.ok(!new RegExp(`\\b${fn}\\b`).test(js), `popup.js 還有 ${fn}`);
  }
  // 設定連結仍在且有接
  assert.match(html, /id="optionsLink"/);
  assert.match(js, /optionsLink\.addEventListener\("click"/);
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

test('b4r→b10:onStartup／onInstalled 一次性清舊鍵 cfTab＋lastClearance＋pdfPending', () => {
  const bg = read('background.js');
  for (const ev of ['onStartup', 'onInstalled']) {
    const m = new RegExp(ev + '\\.addListener\\(([\\s\\S]*?)\\n\\}\\);').exec(bg);
    assert.ok(m, `找不到 ${ev} listener`);
    assert.match(m[1], /chrome\.storage\.local\.remove\(\['cfTab', 'lastClearance', 'pdfPending'\]\)/, ev);
  }
});

// b8:2.1.0 拆掉自動過驗證／自動導頁／下載清除。agent-core.js＋background.js 原始碼(含註解)不得出現這些字面。
const FORBIDDEN = [
  ['alarms', /alarms/],
  ['cf_clearance', /cf_clearance/],
  ['downloads.cancel', /downloads\.cancel/],
  ['removeFile', /removeFile/],
  ['erase', /\berase\b/],
  ['.submit(', /\.submit\(/],
  ['GetPDF', /GetPDF/],
  ['downloads.onChanged', /downloads\.onChanged/],
];
function forbiddenHits(src) {
  return FORBIDDEN.filter(([, re]) => re.test(src)).map(([name]) => name);
}

test('b4q P1→b8:原始碼零 cf_clearance 字面(不再讀 cf_clearance、也沒有指紋比對)', () => {
  for (const f of ['agent-core.js', 'background.js']) {
    const src = read(f);
    assert.ok(!/cf_clearance/.test(src), `${f} 出現 cf_clearance`);
    assert.ok(!/cfCookieSig|\bsig[01]\b/.test(src), `${f} 還有 cf_clearance 指紋比對`);
  }
});

test('b8:forbiddenHits 掃描器自測(每個禁字都抓得到;乾淨原始碼為空)', () => {
  assert.deepEqual(forbiddenHits("const a = 1;\nchrome.tabs.create({ url: FETC_MEMBER_URL });"), []);
  assert.deepEqual(forbiddenHits('chrome.alarms.create("x")'), ['alarms']);
  assert.deepEqual(forbiddenHits("c.name === 'cf_clearance'"), ['cf_clearance']);
  assert.deepEqual(forbiddenHits('await chrome.downloads.cancel(1)'), ['downloads.cancel']);
  assert.deepEqual(forbiddenHits('await dl.removeFile(1)'), ['removeFile']);
  assert.deepEqual(forbiddenHits('await dl.erase({ id: 1 })'), ['erase']);
  assert.deepEqual(forbiddenHits('form.submit();'), ['.submit(']);
  assert.deepEqual(forbiddenHits("const P = '/UX0000Common/UX000006GetPDF';"), ['GetPDF']);
  assert.deepEqual(forbiddenHits('chrome.downloads.onChanged.addListener(f)'), ['downloads.onChanged']);
});

// ── b8 守門⑦:禁字、分頁網址只有 Member、agent-core 不碰 downloads ─────────────────
// 取出 re 命中的每個呼叫的完整引數文字(括號平衡,字串內括號不計)
function callArgs(src, re) {
  const out = [];
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
const TAB_NAV_RE = /(?:tabs|windows)\s*\.\s*(?:create|update)\s*\(/g;
function badTabNavs(src) {
  return callArgs(src, new RegExp(TAB_NAV_RE.source, 'g')).filter(
    (a) => !/\burl\s*:\s*(?:GflAgentCore\.)?FETC_MEMBER_URL\b/.test(a) || (a.match(/\burl\b/g) || []).length !== 1
  );
}

test('b8⑦:agent-core.js＋background.js 原始碼禁字全無', () => {
  for (const f of ['agent-core.js', 'background.js']) assert.deepEqual(forbiddenHits(read(f)), [], f);
});

test('b8⑦:所有 tabs.create／tabs.update／windows.create 的 url 只能是 FETC_MEMBER_URL', () => {
  assert.equal(require('../agent-core').FETC_MEMBER_URL, 'https://www.fetc.net.tw/Member');
  const core = read('agent-core.js');
  assert.ok(callArgs(core, new RegExp(TAB_NAV_RE.source, 'g')).length >= 2, '掃不到 openTab 的建立呼叫(掃描器壞了?)');
  for (const f of ['agent-core.js', 'background.js']) assert.deepEqual(badTabNavs(read(f)), [], f);
  // 掃描器自測
  assert.deepEqual(badTabNavs('chrome.tabs.create({ url: FETC_MEMBER_URL, active: false })'), []);
  assert.equal(badTabNavs("chrome.tabs.update(id, { url: FETC_ORIGIN + '/x' })").length, 1);
  assert.equal(badTabNavs('chrome.tabs.update(id, { url: `${FETC_MEMBER_URL}?x=1` })').length, 1);
  assert.equal(badTabNavs('chrome.tabs.update(id, {\n  url: other })').length, 1);
  assert.equal(badTabNavs('chrome.tabs.update(id, { active: true, url: FETC_MEMBER_URL, x: { url: y } })').length, 1);
});

test('b8⑦→b10④:agent-core.js／background.js 都不用 downloads、零 GetPDF 路徑(不分大小寫)', () => {
  for (const f of ['agent-core.js', 'background.js']) {
    const src = read(f);
    assert.ok(!/downloads/.test(src), `${f} 出現 downloads`);
    assert.equal((src.match(/getpdf/gi) || []).length, 0, `${f} 出現 GetPDF 路徑`);
  }
});

test('b8:popup 無輪詢文案、開啟即 gfl-peek、鈕叫「執行」', () => {
  const js = read('popup.js');
  const html = read('popup.html');
  assert.ok(!/每 5 分鐘|自動檢查/.test(js + html));
  assert.match(js, /type: "gfl-peek"/);
  assert.match(html, /<button id="runBtn" disabled>執行<\/button>/);
  // b10:憑證指引＋「開啟匯入頁」鈕;刪除所有「列印後／下載完成後會自動補跑」文案
  assert.match(html, /<div id="receiptHint"><div id="receiptHintText"><\/div><button id="openReceiptsBtn">開啟匯入頁<\/button><\/div>/);
  assert.match(js, /`憑證 \$\{receiptsPending\} 份待補：到遠通下載該車的通行費紀錄 PDF，再到網站「eTag 待補憑證」匯入（擴充功能不會自動抓憑證）。`/);
  assert.ok(!/cfHint|pdfPending/.test(js + html), 'popup 不再有 cfHint／pdfPending');
  assert.ok(!/列印後會自動補跑|下載完成後會自動補跑/.test(js + html), 'popup 還有自動補跑文案');
});

// ── b78f F-3:解除配對清殘留(b10:pdfPending 拿掉、加 lastError／pendingError;popup 執行期案移到 b10.test.js)──

test('b78f F-3→b10③:options.js 解除配對清 agent／lastPeek／cinCache／lastError／pendingError,不再列 cfTab／pdfPending', () => {
  const js = read('options.js');
  const m = js.match(/async function onUnpair\(\) \{\s*await chrome\.storage\.local\.remove\((\[[^\]]*\])\)/);
  assert.ok(m, '找得到 onUnpair 的 remove 清單');
  const keys = JSON.parse(m[1]);
  for (const k of ['agent', 'lastPeek', 'cinCache', 'lastError', 'pendingError']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('cfTab'));
  assert.ok(!keys.includes('pdfPending'));
});
