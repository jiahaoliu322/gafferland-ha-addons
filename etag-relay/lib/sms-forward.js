// ── lib/sms-forward.js(0.7.0)────────────────────────────────────────────
// SMS 中繼(每日簡訊 Every8d 台灣 IP 出口):every8d 只給境外固定 IP 白名單,Vercel
// serverless 沒有固定 IP;家中 HA 是台灣住宅 IP,不需要跟 every8d 申請任何東西。
// 帳密(uid/pwd)由呼叫端(Vercel /sms 請求 body)每次帶入,中繼**不存帳密**,單一
// 事實來源仍在 Vercel(SMS_USER/SMS_PASS)。
//
// 純函式,可離線測(見 test-sms.js)。fetchImpl 可注入(照 lib/siteip-heartbeat.js
// 範式)。**pwd／msg(含 OTP 驗證碼)絕不落 log**——本模組只回傳 { status, body },
// 呼叫端(server.js)自行決定要 log 什麼(僅遮罩後的 dest 與 HTTP status)。
'use strict';

const E8D_URL = 'https://api.e8d.tw/API21/HTTP/sendSMS.ashx';

// forwardSms({uid,pwd,sb,msg,dest}, {fetchImpl,timeoutMs}) → { status, body }。
// 純轉發:不判讀 e8d 回應內容(CSV 格式/負數錯誤碼判斷交給呼叫端,與直連分支共用同一套
// 判斷邏輯,見 gafferland-main lib/sms.js)。逾時/網路錯誤直接 throw,呼叫端(server.js)
// 負責轉譯成 { ok:false, reason:'e8d-unreachable' } 回應。
async function forwardSms({ uid, pwd, sb, msg, dest } = {}, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const params = new URLSearchParams({
    UID: uid || '',
    PWD: pwd || '',
    SB: sb || '',
    MSG: msg || '',
    DEST: dest || '',
  });
  const resp = await fetchImpl(`${E8D_URL}?${params}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await resp.text();
  return { status: resp.status, body };
}

module.exports = { forwardSms };
