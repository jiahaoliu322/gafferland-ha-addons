// Gafferland eTag 瀏覽器版 — 背景 service worker(只接 chrome.*;邏輯在 agent-core.js)
// 平常不連遠通、不問站台:只有 popup「執行」會跑一輪(只做查詢與金額;收款憑證由員工到網站匯入遠通 PDF)。
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

// 一次性清理舊鍵:2.0.x 的 cfTab(留給人點驗證的分頁)、lastClearance(上次自動過驗證紀錄);2.1.x 的 pdfPending(憑證待補旗標)
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.remove(['cfTab', 'lastClearance', 'pdfPending']);
  // 升級時再清舊版殘留:錯誤字樣(舊版憑證被擋的錯誤訊息)與上次執行(舊版字樣的 lastRun,2.3.0 起);全新安裝本來就沒有
  if (details && details.reason === 'update') chrome.storage.local.remove(['lastError', 'pendingError', 'lastRun']);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(['cfTab', 'lastClearance', 'pdfPending']);
});

// popup:「執行」與開啟時的 peek(只心跳＋取統計)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'gfl-run-now' && msg.type !== 'gfl-peek')) return false;
  if (sender && sender.id !== chrome.runtime.id) return false;
  const p = msg.type === 'gfl-peek' ? core.peek() : core.run({ trigger: 'popup' });
  p.then(
    (r) => sendResponse({ ok: true, result: r }),
    () => sendResponse({ ok: false })
  );
  return true;
});
