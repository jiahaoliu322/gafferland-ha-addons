// Gafferland eTag Session — options.js
// 純原生 JS,無外部依賴。

const DEFAULT_BASE_URL = "https://admin.gafferland.com";
// 同 popup.js:1.0.x 存過的舊網域視同未設定。
const LEGACY_BASE_URL_RE = /^https?:\/\/(gafferland\.vercel\.app|(www\.)?gafferland\.net)(\/|$)/i;

const baseUrlInput = document.getElementById("baseUrl");
const saveBtn = document.getElementById("saveBtn");
const savedEl = document.getElementById("saved");

init();

async function init() {
  const stored = await chrome.storage.local.get("baseUrl");
  const v = (stored.baseUrl || "").trim();
  baseUrlInput.value = v && !LEGACY_BASE_URL_RE.test(v) ? v : DEFAULT_BASE_URL;

  saveBtn.addEventListener("click", onSave);
}

async function onSave() {
  const value = (baseUrlInput.value || "").trim().replace(/\/+$/, "");
  const baseUrl = value || DEFAULT_BASE_URL;

  await chrome.storage.local.set({ baseUrl });
  baseUrlInput.value = baseUrl;

  savedEl.style.display = "inline";
  setTimeout(() => {
    savedEl.style.display = "none";
  }, 2000);
}
