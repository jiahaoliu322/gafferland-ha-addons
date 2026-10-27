// Gafferland eTag Session — options.js
// 純原生 JS。預設網址／舊網域判斷／網域白名單檢查／配對邏輯都在 agent-core.js。token 不顯示、不 log。

const core = GflAgentCore;
const manifest = chrome.runtime.getManifest();
const HOSTS = manifest.host_permissions || [];

const baseUrlInput = document.getElementById("baseUrl");
const saveBtn = document.getElementById("saveBtn");
const savedEl = document.getElementById("saved");
const urlMsg = document.getElementById("urlMsg");
const unpairedBox = document.getElementById("unpairedBox");
const pairedBox = document.getElementById("pairedBox");
const pairedName = document.getElementById("pairedName");
const pairCode = document.getElementById("pairCode");
const pairBtn = document.getElementById("pairBtn");
const unpairBtn = document.getElementById("unpairBtn");
const pairMsg = document.getElementById("pairMsg");

init();

async function init() {
  const stored = await chrome.storage.local.get("baseUrl");
  baseUrlInput.value = core.resolveBaseUrl(stored.baseUrl);

  saveBtn.addEventListener("click", onSave);
  pairBtn.addEventListener("click", onPair);
  unpairBtn.addEventListener("click", onUnpair);
  await renderPairState();
}

function showMsg(el, type, text) {
  el.textContent = text;
  el.className = `msg show ${type}`;
}

function hideMsg(el) {
  el.textContent = "";
  el.className = "msg";
}

// 回傳通過檢查的網址;不在 host_permissions 內 → 顯示提示並回 null
function readBaseUrl() {
  const value = (baseUrlInput.value || "").trim().replace(/\/+$/, "");
  const baseUrl = value || core.DEFAULT_BASE_URL;
  if (!core.isHostPermitted(baseUrl, HOSTS)) {
    showMsg(
      urlMsg,
      "error",
      "這個網址不在擴充功能允許的網域內(目前只允許 admin.gafferland.com),請改回預設網址。"
    );
    return null;
  }
  hideMsg(urlMsg);
  return baseUrl;
}

async function onSave() {
  const baseUrl = readBaseUrl();
  if (!baseUrl) return;

  await chrome.storage.local.set({ baseUrl });
  baseUrlInput.value = baseUrl;

  savedEl.style.display = "inline";
  setTimeout(() => {
    savedEl.style.display = "none";
  }, 2000);
}

async function renderPairState() {
  const { agent } = await chrome.storage.local.get("agent");
  if (agent && agent.token) {
    unpairedBox.style.display = "none";
    pairedBox.style.display = "block";
    pairedName.textContent = `已配對:${agent.name || agent.agentId}`;
  } else {
    unpairedBox.style.display = "block";
    pairedBox.style.display = "none";
  }
}

async function onPair() {
  hideMsg(pairMsg);
  const baseUrl = readBaseUrl();
  if (!baseUrl) return;
  pairBtn.disabled = true;
  try {
    const r = await core.pairAgent({
      fetch: (url, init) => fetch(url, init),
      storage: chrome.storage.local,
      baseUrl,
      code: pairCode.value,
      version: manifest.version,
      hostPatterns: HOSTS,
    });
    if (r.ok) {
      await chrome.storage.local.set({ baseUrl });
      pairCode.value = "";
      await renderPairState();
      showMsg(pairMsg, "ok", `已配對:${r.name}`);
      return;
    }
    const text =
      r.reason === "bad-code"
        ? "配對碼錯誤或已過期,請在 /collect 重新產生"
        : r.reason === "throttled"
        ? "嘗試太多次,請稍後再試"
        : r.reason === "network"
        ? "連不到站台,請檢查網路與站台網址"
        : r.reason === "host-not-permitted"
        ? "站台網址不在允許的網域內"
        : `配對失敗(${r.reason})`;
    showMsg(pairMsg, "error", text);
  } finally {
    pairBtn.disabled = false;
  }
}

async function onUnpair() {
  await chrome.storage.local.remove(["agent", "cfTab", "lastRun", "fetcState", "pendingError"]);
  await renderPairState();
  showMsg(pairMsg, "ok", "已解除本機配對;請同時到 /collect 把這台電腦移除。");
}
