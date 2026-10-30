// ── test-helpers/fake-e8d.js(0.8.0,只給測試用;Dockerfile 不 COPY)───────────────
// 用法:node --require ./test-helpers/no-egress.js --require ./test-helpers/fake-e8d.js server.js
// 把 globalThis.fetch 對 api.e8d.tw 的請求改送到本機假 every8d(環境變數 FAKE_E8D_URL,
// 必須是 http://127.0.0.1:<port>/...),path 與 query 原封帶過去;其他網址照原樣交給下一層
// fetch(即 no-egress 包過的那個,非 127.0.0.1 一律被擋)。
// 「成功」「不通」由本機假伺服器(test-server.js)切換:成功＝回 200 文字,不通＝直接斷線。
// lib/sms-forward.js 的預設 fetchImpl＝呼叫當下的全域 fetch,所以換掉 globalThis.fetch 就生效。
// 本檔不 log 任何請求內容(簡訊 pwd／msg 不得落 log)。
'use strict';

const target = process.env.FAKE_E8D_URL || '';
let base;
try {
  base = new URL(target);
} catch (_) {
  base = null;
}
if (!base || base.hostname !== '127.0.0.1') {
  throw new Error('fake-e8d: FAKE_E8D_URL 必須是 http://127.0.0.1:<port>/...');
}

const E8D_HOST = 'api.e8d.tw';
const nextFetch = globalThis.fetch;

globalThis.fetch = function fakeE8dFetch(input, init) {
  const href = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
  let url;
  try {
    url = new URL(href);
  } catch (_) {
    return nextFetch.call(this, input, init);
  }
  if (url.hostname !== E8D_HOST) return nextFetch.call(this, input, init);
  const redirected = new URL(base.href);
  redirected.pathname = base.pathname.replace(/\/$/, '') + url.pathname;
  redirected.search = url.search;
  return nextFetch.call(this, redirected.href, init);
};
