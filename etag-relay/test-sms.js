// ── test-sms.js(0.7.0)───────────────────────────────────────────────────
// lib/sms-forward.js 驗證。零網路:stub fetchImpl,不打任何真實 every8d 端點。
'use strict';

const assert = require('assert');
const { forwardSms } = require('./lib/sms-forward');

async function testUrlAndParams() {
  // ① URL 與參數組裝正確(URLSearchParams)
  let capturedUrl = null;
  let capturedInit = null;
  const stubFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { status: 200, text: async () => '28,1,1,0,xxx' };
  };

  const result = await forwardSms(
    { uid: 'acct', pwd: 'sekret', sb: 'GAFFERLAND', msg: '你的驗證碼是123456', dest: '0912345678' },
    { fetchImpl: stubFetch }
  );

  assert.ok(capturedUrl.startsWith('https://api.e8d.tw/API21/HTTP/sendSMS.ashx?'), '應打 e8d sendSMS 端點');
  const params = new URL(capturedUrl).searchParams;
  assert.strictEqual(params.get('UID'), 'acct');
  assert.strictEqual(params.get('PWD'), 'sekret');
  assert.strictEqual(params.get('SB'), 'GAFFERLAND');
  assert.strictEqual(params.get('MSG'), '你的驗證碼是123456');
  assert.strictEqual(params.get('DEST'), '0912345678');
  assert.ok(capturedInit.signal, '應帶 AbortSignal(timeout)');

  assert.deepStrictEqual(result, { status: 200, body: '28,1,1,0,xxx' });

  console.log('[test-sms] ①URL/參數組裝正確 PASS');
}

async function testBodyPassthrough() {
  // ② body 原文透傳:forwardSms 本身不判讀 e8d 回應內容(CSV/負數錯誤碼判斷交呼叫端),
  //   原封不動回傳
  const stubFetch = async () => ({ status: 200, text: async () => '-100,error message here' });
  const result = await forwardSms(
    { uid: 'a', pwd: 'b', sb: 'GAFFERLAND', msg: 'x', dest: '0912345678' },
    { fetchImpl: stubFetch }
  );
  assert.deepStrictEqual(result, { status: 200, body: '-100,error message here' });
  console.log('[test-sms] ②body 原文透傳(不判讀內容) PASS');
}

async function testNon200Status() {
  // ③ 非 200 狀態也照實回傳 status/body,不 throw(HTTP 層失敗判讀交呼叫端)
  const stubFetch = async () => ({ status: 500, text: async () => 'server error' });
  const result = await forwardSms(
    { uid: 'a', pwd: 'b', sb: 'GAFFERLAND', msg: 'x', dest: '0912345678' },
    { fetchImpl: stubFetch }
  );
  assert.deepStrictEqual(result, { status: 500, body: 'server error' });
  console.log('[test-sms] ③非 200 狀態照實回傳,不 throw PASS');
}

async function testFetchThrows() {
  // ④ 逾時/網路錯誤路徑:fetchImpl throw → forwardSms 直接 throw,呼叫端(server.js
  //   handleSms)負責轉譯成 {ok:false, reason:'e8d-unreachable'}
  const stubFetch = async () => { throw new Error('The operation was aborted'); };
  await assert.rejects(
    forwardSms({ uid: 'a', pwd: 'b', sb: 'GAFFERLAND', msg: 'x', dest: '0912345678' }, { fetchImpl: stubFetch }),
    /aborted/
  );
  console.log('[test-sms] ④逾時/錯誤路徑 throw(呼叫端轉譯) PASS');
}

async function testTimeoutOverride() {
  // ⑤ timeoutMs 可覆寫(預設 15000,呼叫端可傳自訂值),signal 確實已帶入 fetch init
  let capturedInit = null;
  const stubFetch = async (url, init) => {
    capturedInit = init;
    return { status: 200, text: async () => '28,1,1,0,xxx' };
  };
  await forwardSms(
    { uid: 'a', pwd: 'b', sb: 'GAFFERLAND', msg: 'x', dest: '0912345678' },
    { fetchImpl: stubFetch, timeoutMs: 5000 }
  );
  assert.ok(capturedInit.signal, '應帶 signal');
  console.log('[test-sms] ⑤timeoutMs 可覆寫,signal 已帶入 PASS');
}

async function testNoSecretsInResult() {
  // ⑥ 回傳物件只含 status/body,不附掛 uid/pwd(避免呼叫端不慎把整包 result log 出去
  //   時外洩帳密——body 本身是 e8d 回應,不含請求端帳密)
  const stubFetch = async () => ({ status: 200, text: async () => '28,1,1,0,xxx' });
  const result = await forwardSms(
    { uid: 'acct', pwd: 'topsecret', sb: 'GAFFERLAND', msg: 'x', dest: '0912345678' },
    { fetchImpl: stubFetch }
  );
  assert.deepStrictEqual(Object.keys(result).sort(), ['body', 'status']);
  console.log('[test-sms] ⑥回傳物件只含 status/body,不回顯帳密 PASS');
}

async function main() {
  await testUrlAndParams();
  await testBodyPassthrough();
  await testNon200Status();
  await testFetchThrows();
  await testTimeoutOverride();
  await testNoSecretsInResult();
  console.log('[test-sms] PASS(離線 stub fetch,零網路)');
}

main().catch((e) => {
  console.error('[test-sms] FAIL', e);
  process.exit(1);
});
