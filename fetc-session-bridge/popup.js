// Gafferland eTag Session — popup.js
// 純原生 JS,無外部依賴。cookie 值不得寫入 console.log。

const DEFAULT_BASE_URL = "https://gafferland.vercel.app";
const FETC_COOKIE_DOMAIN = "fetc.net.tw";
const FETC_LOGIN_COOKIE = "FETC_P";

const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const primaryBtn = document.getElementById("primaryBtn");
const messageEl = document.getElementById("message");
const copyBtn = document.getElementById("copyBtn");
const optionsLink = document.getElementById("optionsLink");

let mode = null; // 'login' | 'update'

init();

async function init() {
  optionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  copyBtn.addEventListener("click", onCopyCookies);

  try {
    const cookies = await chrome.cookies.getAll({ domain: FETC_COOKIE_DOMAIN });
    const loggedIn = cookies.some((c) => c.name === FETC_LOGIN_COOKIE);
    renderLoginState(loggedIn);
  } catch (err) {
    statusEl.textContent = `無法讀取遠通 cookies:${err.message}`;
    statusEl.className = "";
  }
}

function renderLoginState(loggedIn) {
  if (!loggedIn) {
    mode = "login";
    statusEl.textContent = "尚未登入遠通";
    statusEl.className = "no";
    hintEl.textContent = "登入完成後再回來點本擴充功能";
    hintEl.style.display = "block";

    primaryBtn.textContent = "開啟遠通會員區";
    primaryBtn.style.display = "block";
    primaryBtn.onclick = () => {
      chrome.tabs.create({ url: "https://www.fetc.net.tw/" });
    };
  } else {
    mode = "update";
    statusEl.textContent = "遠通已登入 ✓";
    statusEl.className = "ok";
    hintEl.style.display = "none";

    primaryBtn.textContent = "更新 Gafferland session";
    primaryBtn.style.display = "block";
    primaryBtn.onclick = onUpdateSession;
  }
}

async function getFlattenedCookies() {
  const cookies = await chrome.cookies.getAll({ domain: FETC_COOKIE_DOMAIN });
  const obj = {};
  // 同名 cookie 取後者
  for (const c of cookies) {
    obj[c.name] = c.value;
  }
  return obj;
}

async function getBaseUrl() {
  const stored = await chrome.storage.local.get("baseUrl");
  return (stored.baseUrl && stored.baseUrl.trim()) || DEFAULT_BASE_URL;
}

async function onUpdateSession() {
  hideMessage();
  primaryBtn.disabled = true;
  const originalText = primaryBtn.textContent;
  primaryBtn.textContent = "送出中…";

  try {
    const baseUrl = await getBaseUrl();
    const cookieObj = await getFlattenedCookies();

    let res;
    try {
      res = await fetch(`${baseUrl}/api/collect?action=relay-session`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies: cookieObj }),
      });
    } catch (networkErr) {
      showMessage(
        "error",
        `送出失敗:${networkErr.message}。可改用下方「複製 Cookie 字串」手動補救。`
      );
      return;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      data = null;
    }

    if (res.status === 200 && data && data.ok) {
      showMessage(
        "success",
        "✅ session 已更新!若已過當日 06:50,系統正在自動補跑結算,結果會推 LINE。"
      );
    } else if (res.status === 403 || res.status === 401) {
      // 伺服器有明確 error 文案（如 CSRF 守門）就照實顯示，別一律誤導成「未登入」
      showMessage(
        "error",
        (data && data.error)
          ? `後台拒絕（HTTP ${res.status}）：${data.error}`
          : "請先在這個 Chrome 登入 Gafferland 後台,再回來重試。",
        { text: "開啟後台", url: `${baseUrl}/collect` }
      );
    } else if (res.status === 400 || (data && data.reason === "session-invalid")) {
      showMessage(
        "error",
        "遠通 session 無效——請重新登入遠通會員區後再試一次。"
      );
    } else {
      showMessage(
        "error",
        `送出失敗:HTTP ${res.status}。可改用下方「複製 Cookie 字串」手動補救。`
      );
    }
  } finally {
    primaryBtn.disabled = false;
    primaryBtn.textContent = originalText;
  }
}

async function onCopyCookies() {
  try {
    const cookieObj = await getFlattenedCookies();
    const str = Object.entries(cookieObj)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    await navigator.clipboard.writeText(str);
    showMessage(
      "success",
      "已複製,可貼到 /collect 的「貼 Cookie 補救」"
    );
  } catch (err) {
    showMessage("error", `複製失敗:${err.message}`);
  }
}

function showMessage(type, text, link) {
  messageEl.innerHTML = "";
  messageEl.className = `show ${type}`;

  const p = document.createElement("div");
  p.textContent = text;
  messageEl.appendChild(p);

  if (link) {
    const a = document.createElement("a");
    a.href = link.url;
    a.textContent = link.text;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: link.url });
    });
    messageEl.appendChild(a);
  }
}

function hideMessage() {
  messageEl.className = "";
  messageEl.innerHTML = "";
}
