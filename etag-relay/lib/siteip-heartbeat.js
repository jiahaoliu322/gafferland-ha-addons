// ── lib/siteip-heartbeat.js(0.6.0)───────────────────────────────────────
// 店內 IP 心跳:員工打卡的 Wi-Fi 判定＝「請求來源 IP 等於店內對外 IP」。店內 IP 浮動,
// 由本模組每 5 分鐘 POST 一次 Vercel,Vercel 記下來源 IP(KV 20 分鐘過期)。
//
// **零新密鑰、零新必填選項**:沿用 add-on 既有 VERCEL_CAPTCHA_URL(取 origin)與
// VERCEL_CALLBACK_SECRET(Vercel 端對 ETAG_RELAY_CALLBACK_SECRET)。
//
// 純函式,可離線測(見 test-heartbeat.js)。**永不 throw、永不 log 密鑰**——server.js
// 啟動段呼叫 startSiteIpHeartbeat 不需要包 try/catch,timer callback 內部已自行吸收
// 所有例外。
'use strict';

// 推導心跳要 POST 的目的地 URL:
// - options.PUNCH_SITEIP_URL 非空 → 直接用(選填覆寫,一般不需要設定)。
// - 否則用 VERCEL_CAPTCHA_URL 取 origin + '/api/punch?action=site-ip'。
// - VERCEL_CAPTCHA_URL 空、或不是合法 URL → 回空字串(代表未設定,呼叫端不送出)。
function resolveHeartbeatUrl(options) {
  const opts = options || {};
  if (opts.PUNCH_SITEIP_URL && String(opts.PUNCH_SITEIP_URL).trim()) {
    return opts.PUNCH_SITEIP_URL;
  }
  const base = opts.VERCEL_CAPTCHA_URL;
  if (!base) return '';
  try {
    return new URL(base).origin + '/api/punch?action=site-ip';
  } catch (e) {
    return ''; // VERCEL_CAPTCHA_URL 不是合法 URL
  }
}

// 送出一次心跳。回傳 { ok, ip?, status?, reason? },**永不 throw**。
async function sendSiteIpHeartbeat(options, { fetchImpl = fetch, timeoutMs = 10000, log = console } = {}) {
  try {
    const opts = options || {};
    const url = resolveHeartbeatUrl(opts);
    if (!url || !opts.VERCEL_CALLBACK_SECRET) {
      return { ok: false, reason: 'not-configured' };
    }

    let resp;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: opts.VERCEL_CALLBACK_SECRET, source: 'etag-relay' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'fetch-error' };
    }

    if (!resp.ok) {
      return { ok: false, status: resp.status };
    }

    try {
      const data = await resp.json();
      return { ok: true, ip: data && data.ip, status: resp.status };
    } catch (e) {
      return { ok: false, reason: 'invalid-response' };
    }
  } catch (e) {
    // 保底:上面已逐段 try/catch,這層只是再確保任何未預期例外也不會外洩。
    return { ok: false, reason: (e && e.message) || 'unknown-error' };
  }
}

// 啟動週期性心跳:setTimeout 首發(initialDelayMs)＋setInterval 週期(intervalMs),
// 兩者皆 unref() 避免阻止 process 自然結束。回傳 { stop(), getStatus() } 供
// server.js /health 讀 lastOkAt/lastIp。
//
// log 規則:成功時只有 ip 與上次不同才 log.info(避免每 5 分鐘洗一行一樣的訊息);
// 失敗每次都 log.warn(含 status/reason,方便診斷)。**訊息內容絕不含 secret。**
function startSiteIpHeartbeat(options, {
  intervalMs = 5 * 60 * 1000,
  initialDelayMs = 15000,
  fetchImpl = fetch,
  timeoutMs = 10000,
  log = console,
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout,
  clearIntervalImpl = clearInterval,
} = {}) {
  let lastOkAt = null;
  let lastIp = null;

  async function tick() {
    let result;
    try {
      result = await sendSiteIpHeartbeat(options, { fetchImpl, timeoutMs, log });
    } catch (e) {
      // sendSiteIpHeartbeat 本身已保證不 throw,這裡只是最後一道保險,
      // 確保 timer callback 絕不會拋出未捕捉例外。
      result = { ok: false, reason: (e && e.message) || 'unknown-error' };
    }

    if (result.ok) {
      lastOkAt = Date.now();
      if (result.ip !== lastIp) {
        log.info(`[etag-relay] site-ip 心跳 ok ip=${result.ip}`);
      }
      lastIp = result.ip;
    } else {
      log.warn(`[etag-relay] site-ip 心跳失敗 status=${result.status != null ? result.status : '-'} reason=${result.reason || '-'}`);
    }
  }

  const timeoutHandle = setTimeoutImpl(() => tick(), initialDelayMs);
  if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

  const intervalHandle = setIntervalImpl(() => tick(), intervalMs);
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();

  return {
    stop() {
      clearTimeoutImpl(timeoutHandle);
      clearIntervalImpl(intervalHandle);
    },
    getStatus() {
      return { lastOkAt, lastIp };
    },
  };
}

module.exports = {
  resolveHeartbeatUrl,
  sendSiteIpHeartbeat,
  startSiteIpHeartbeat,
};
