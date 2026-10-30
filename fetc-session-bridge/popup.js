// Gafferland eTag Session — popup.js
// 純原生 JS,無外部依賴。cookie 值不得寫入 console.log。
// 2.3.0:拿掉「舊中繼(備援)」摺疊區(轉送遠通 session 給舊中繼、拷貝 cookie 兩個鈕)——
// 中繼 0.8.0 已拆 eTag 路由,popup 只剩這台電腦的狀態與「執行」。

const FETC_COOKIE_DOMAIN = "fetc.net.tw";
const FETC_LOGIN_COOKIE = "FETC_P";

const optionsLink = document.getElementById("optionsLink");

// ── 這台電腦(瀏覽器版 eTag 代查)狀態與「執行」(平常不自動跑,員工按「執行」才跑;2.2.0 起只做查詢與金額,憑證到網站匯入)──
const agentVal = document.getElementById("agentVal");
const fetcVal = document.getElementById("fetcVal");
const queueVal = document.getElementById("queueVal");
const lastRunVal = document.getElementById("lastRunVal");
const lastErrRow = document.getElementById("lastErrRow");
const lastErrVal = document.getElementById("lastErrVal");
const receiptHint = document.getElementById("receiptHint");
const receiptHintText = document.getElementById("receiptHintText");
const openReceiptsBtn = document.getElementById("openReceiptsBtn");
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
  const stored = await chrome.storage.local.get(["agent", "lastRun", "fetcState", "lastError"]);
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

  // 憑證指引:已配對且站台憑證待補 M＞0 才顯示;「開啟匯入頁」開已配對站台的 /collect#etag-receipts
  // (M 直接取 peek 統計;配對與否另外把關,不靠上面「站台待處理」列的分支)
  const peekCounts = peek && !peek.failed && peek.queue ? GflAgentCore.queueCounts(peek.queue) : null;
  const receiptsPending = agent && peekCounts ? peekCounts.print : 0;
  if (receiptsPending > 0) {
    receiptHintText.textContent = `憑證 ${receiptsPending} 份待補：到遠通下載該車的通行費紀錄 PDF，再到網站「eTag 待補憑證」匯入（擴充功能不會自動抓憑證）。`;
    const receiptsUrl = `${GflAgentCore.resolveBaseUrl(agent.baseUrl)}/collect#etag-receipts`;
    openReceiptsBtn.onclick = () => chrome.tabs.create({ url: receiptsUrl });
    receiptHint.style.display = "block";
  } else {
    receiptHintText.textContent = "";
    openReceiptsBtn.onclick = null;
    receiptHint.style.display = "none";
  }

  if (!agent) {
    runBtn.disabled = true;
    runNote.textContent = "請先到設定頁輸入配對碼。";
  } else if (!loggedIn) {
    runBtn.disabled = true;
    runNote.textContent = "請先登入遠通會員區，再回來按「執行」。";
  } else {
    runBtn.disabled = false;
    if (counts && counts.query === 0 && counts.print > 0) {
      runNote.textContent = "目前沒有要查詢的；憑證請到網站匯入。";
    } else if (counts && counts.query === 0) {
      runNote.textContent = "目前沒有待處理工作。";
    } else {
      runNote.textContent = "按「執行」會在背景開遠通分頁查詢並計算金額，做完自動關閉。";
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

function init() {
  optionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}
