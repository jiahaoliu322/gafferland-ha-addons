// Gafferland eTag Session — popup.js
// 純原生 JS,無外部依賴。cookie 值不得寫入 console.log。

const DEFAULT_BASE_URL = "https://admin.gafferland.com";
// 1.0.x 存過的舊網域(vercel.app 已停用、manifest 也不再允許)視同未設定,退回預設。
const LEGACY_BASE_URL_RE = /^https?:\/\/(gafferland\.vercel\.app|(www\.)?gafferland\.net)(\/|$)/i;
const FETC_COOKIE_DOMAIN = "fetc.net.tw";
const FETC_LOGIN_COOKIE = "FETC_P";

const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const primaryBtn = document.getElementById("primaryBtn");
const messageEl = document.getElementById("message");
const copyBtn = document.getElementById("copyBtn");
const optionsLink = document.getElementById("optionsLink");

let mode = null; // 'login' | 'update'

// ── 這台電腦(瀏覽器版 eTag 代查)狀態與「執行」(2.1.0:平常不自動跑,員工按「執行」才跑)──
const agentVal = document.getElementById("agentVal");
const fetcVal = document.getElementById("fetcVal");
const queueVal = document.getElementById("queueVal");
const lastRunVal = document.getElementById("lastRunVal");
const lastErrRow = document.getElementById("lastErrRow");
const lastErrVal = document.getElementById("lastErrVal");
const cfHint = document.getElementById("cfHint");
const runBtn = document.getElementById("runBtn");
const runNote = document.getElementById("runNote");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const openFetcBtn = document.getElementById("openFetcBtn");

function setVal(el, text, cls) {
  el.textContent = text;
  el.className = cls ? `v ${cls}` : "v";
}

async function initAgent() {
  openSettingsBtn.onclick = () => chrome.runtime.openOptionsPage();
  openFetcBtn.onclick = () => chrome.tabs.create({ url: "https://www.fetc.net.tw/Member" });
  runBtn.onclick = onRunNow;
  await renderAgent(null);
  await refreshPeek();
}

// 問背景頁 peek(poll max:0＝只心跳＋取站台統計;不開分頁、不執行工作)
async function refreshPeek() {
  let peek = { failed: true };
  try {
    const r = await chrome.runtime.sendMessage({ type: "gfl-peek" });
    if (r && r.ok && r.result && !r.result.error) peek = r.result;
  } catch (err) {
    peek = { failed: true };
  }
  await renderAgent(peek);
}

// peek＝null:還在讀;{failed:true}:讀取失敗;否則 {paired,loggedIn,queue,mode}
async function renderAgent(peek) {
  const stored = await chrome.storage.local.get(["agent", "lastRun", "fetcState", "lastError", "pdfPending"]);
  const agent = stored.agent && stored.agent.token ? stored.agent : null;
  let loggedIn = false;
  try {
    const cookies = await chrome.cookies.getAll({ domain: FETC_COOKIE_DOMAIN });
    loggedIn = cookies.some((c) => c.name === FETC_LOGIN_COOKIE);
  } catch (err) {
    loggedIn = false;
  }

  if (agent) {
    setVal(agentVal, `已配對:${agent.name || agent.agentId}`, "ok");
    openSettingsBtn.style.display = "none";
  } else {
    setVal(agentVal, "未配對", "no");
    openSettingsBtn.style.display = "block";
  }

  if (loggedIn) {
    setVal(fetcVal, "已登入", "ok");
    openFetcBtn.style.display = "none";
  } else {
    setVal(fetcVal, "未登入", "no");
    openFetcBtn.style.display = "block";
  }

  const lr = stored.lastRun;
  if (lr) {
    const t = new Date(lr.at).toLocaleString("zh-TW", { hour12: false });
    setVal(lastRunVal, `${t} ${GflAgentCore.lastRunText(lr)}`, lr.ok === false ? "bad" : "");
  } else {
    setVal(lastRunVal, "尚未執行過", "");
  }

  // 最後錯誤(步驟＋status,agent-core 已去 HTML、≤200 字)
  const le = stored.lastError;
  if (le && le.message) {
    const t = new Date(le.at).toLocaleString("zh-TW", { hour12: false });
    setVal(lastErrVal, `${t} ${le.message}`, "bad");
    lastErrRow.style.display = "";
  } else {
    lastErrRow.style.display = "none";
  }

  // 站台待處理:查詢 N 筆・憑證 M 份(peek 失敗＝讀取失敗)
  let counts = null;
  if (!agent) {
    setVal(queueVal, "—", "");
  } else if (!peek) {
    setVal(queueVal, "讀取中…", "");
  } else if (peek.failed || !peek.queue) {
    setVal(queueVal, "讀取失敗", "bad");
  } else {
    counts = GflAgentCore.queueCounts(peek.queue);
    setVal(queueVal, `查詢 ${counts.query} 筆・憑證 ${counts.print} 份`, "");
  }

  // 憑證待補提示只在「已配對 且 pdfPending===true」時顯示(b78f F-3:解除配對後的殘留旗標不顯示)
  const pdfPending = !!agent && stored.pdfPending === true;
  cfHint.style.display = pdfPending ? "block" : "none";

  if (!agent) {
    runBtn.disabled = true;
    runNote.textContent = "請先到設定頁輸入配對碼。";
  } else if (!loggedIn) {
    runBtn.disabled = true;
    runNote.textContent = "請先登入遠通會員區，再回來按「執行」。";
  } else {
    runBtn.disabled = false;
    if (counts && counts.print > 0) {
      runNote.textContent = "建議先在遠通任一筆按「列印」，再按「執行」，憑證會一次補完。";
    } else if (counts && counts.query === 0) {
      runNote.textContent = "目前沒有待處理工作。";
    } else {
      runNote.textContent = "按「執行」會在背景開遠通分頁處理，做完自動關閉。";
    }
  }
}

async function onRunNow() {
  runBtn.disabled = true;
  runBtn.textContent = "執行中…";
  try {
    await chrome.runtime.sendMessage({ type: "gfl-run-now" });
  } catch (err) {
    /* 背景頁回應被中斷不影響執行 */
  }
  runBtn.textContent = "執行";
  await refreshPeek();
}

initAgent();
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
  const v = (stored.baseUrl || "").trim();
  return v && !LEGACY_BASE_URL_RE.test(v) ? v : DEFAULT_BASE_URL;
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
      let msg;
      if (data && data.reason === "cf-challenge") {
        msg = "遠通官網啟用 Cloudflare 防護,中繼無法通過驗證（不是 cookie 的問題,重新登入遠通也沒用）——請通知管理者。";
      } else if (!data || !data.error || data.reason === "session-invalid") {
        msg = "遠通 session 無效——請重新登入遠通會員區後再試一次。";
      } else {
        msg = data.error;
      }
      showMessage("error", msg);
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
