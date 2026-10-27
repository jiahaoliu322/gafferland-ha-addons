// Gafferland eTag 瀏覽器版 — 背景 service worker(只接 chrome.*;邏輯在 agent-core.js)
// token 只存 chrome.storage.local,這裡不 log 任何憑證。
importScripts('agent-core.js');

const manifest = chrome.runtime.getManifest();
const core = GflAgentCore.createAgentCore({
  chrome,
  fetch: (url, init) => fetch(url, init),
  version: manifest.version,
  hostPatterns: manifest.host_permissions || [],
  // 單筆工作最長 4 分鐘:跑的期間定時呼叫一個便宜的 API,避免 service worker 閒置被收掉
  keepAlive: (() => {
    let h = null;
    return {
      start() {
        if (h === null) h = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
      },
      stop() {
        if (h !== null) {
          clearInterval(h);
          h = null;
        }
      },
    };
  })(),
  log: (...a) => console.log('[gfl-etag]', ...a),
});

function ensureAlarm() {
  chrome.alarms.get(GflAgentCore.ALARM_NAME, (a) => {
    if (!a) chrome.alarms.create(GflAgentCore.ALARM_NAME, { periodInMinutes: GflAgentCore.ALARM_PERIOD_MIN });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  core.clearStaleTab(); // 重啟後舊 cfTab 的 tabId 不可信
});
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GflAgentCore.ALARM_NAME) core.run();
});

// popup「立即執行」
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'gfl-run-now') return false;
  if (sender && sender.id !== chrome.runtime.id) return false;
  core.run().then(
    (r) => sendResponse({ ok: true, result: r }),
    () => sendResponse({ ok: false })
  );
  return true;
});
