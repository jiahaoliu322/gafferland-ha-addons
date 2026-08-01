// Gafferland eTag Session — options.js
// 純原生 JS,無外部依賴。

const DEFAULT_BASE_URL = "https://gafferland.vercel.app";

const baseUrlInput = document.getElementById("baseUrl");
const saveBtn = document.getElementById("saveBtn");
const savedEl = document.getElementById("saved");

init();

async function init() {
  const stored = await chrome.storage.local.get("baseUrl");
  baseUrlInput.value = stored.baseUrl || DEFAULT_BASE_URL;

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
