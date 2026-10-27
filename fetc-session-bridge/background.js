// Gafferland eTag 瀏覽器版 — 背景 service worker(只接 chrome.*;邏輯在 agent-core.js)
// 平常不連遠通、不問站台:只有 popup「執行」與「憑證待補時員工在遠通下載了憑證」會跑一輪。
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

// 一次性清理:2.0.x 留下的舊鍵(留給人點驗證的分頁、上次自動過驗證紀錄)
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['cfTab', 'lastClearance']);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(['cfTab', 'lastClearance']);
});

// 員工在遠通按「列印」下載憑證完成 → 憑證待補(pdfPending)時自動補跑一輪。
// downloads 權限唯一用途＝偵測這件事:只看網址,不讀檔、不刪檔、不開檔、不取消。
const FETC_PDF_HOST = 'www.fetc.net.tw';
const FETC_PDF_PATH_LC = '/ux0000common/ux000006getpdf'; // 比對不分大小寫(存小寫)
function isFetcPdfDownloadUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (e) {
    return false;
  }
  return u.protocol === 'https:' && u.host === FETC_PDF_HOST && u.pathname.toLowerCase() === FETC_PDF_PATH_LC;
}

async function onDownloadComplete(id) {
  let items = [];
  try {
    items = (await chrome.downloads.search({ id })) || [];
  } catch (e) {
    return;
  }
  const item = items[0];
  if (!item || !isFetcPdfDownloadUrl(item.url)) return;
  const o = await chrome.storage.local.get('pdfPending');
  if (!o || o.pdfPending !== true) return;
  await core.run({ trigger: 'download' });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state || delta.state.current !== 'complete') return;
  onDownloadComplete(delta.id).catch(() => {});
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
