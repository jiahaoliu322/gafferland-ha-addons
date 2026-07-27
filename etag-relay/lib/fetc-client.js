// ── 遠通(FETC)HTTP 查詢客戶端 ────────────────────────────────────────────
// E0 實測結論(見 goal19 計劃 Round E):查詢鏈全程「純 cookie POST」,不需瀏覽器。
// 認證 = session cookie(ASP.NET_SessionId/FETC_P/__RequestVerificationToken/TS0*/
// Cookie_FEW-WEB,全 HttpOnly)+ 一對 ASP.NET anti-forgery token:
// cookie 裡的 __RequestVerificationToken 與 request 的 header/body
// __RequestVerificationToken 必須是「同時產生的配對」——中繼持有的 session 只有
// cookie token,POST 前必須先 GET 一個會員頁面,從回應 HTML 的
// <input name="__RequestVerificationToken" value="..."> 取得配對的 field token
// (並吃該回應可能更新的 cookie token),再帶進 POST 的 header。
'use strict';

const cheerio = require('cheerio');
const {
  parseSearchBatches,
  parseDetailGantries,
} = require('./parse');

const BASE = 'https://www.fetc.net.tw';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 任何一個「已登入才看得到」的會員頁面,用來取新鮮 anti-forgery field token。
// (2026-07-27 活 session 實測:路徑存在,未登入導回登入頁=偵測 session 失效的依據。)
const TOKEN_SOURCE_PATH = '/Member/Setting';

// 會員主頁(車輛清單),resolveCin 用。
// 會員主頁車輛清單(2026-07-27 活 session 實測):車輛卡 .swiper-slide[data-cin][data-cln]。
const MEMBER_VEHICLES_PATH = '/Member';

// 列印端點路徑(print() 用;0.3.8 起 PDF 亦全純 HTTP,見檔尾 generateNativePdf)。
const PRINT_PATH = '/UX0505Traffic/UX050508TrafficAdvancedSearchPrint';

// ── Cookie jar ───────────────────────────────────────────────────────────
// 極簡 jar:{name: value} map。真正的 Set-Cookie 屬性(Path/HttpOnly/Expires)不需要
// 追蹤——中繼永遠原樣把整包 cookie 回貼給同一個網域,只要 name/value 對即可。
class CookieJar {
  constructor(initial) {
    this.map = new Map();
    if (initial) this.setAll(initial);
  }

  // 接受 {name:value} 物件或 "a=1; b=2" 字串
  setAll(source) {
    if (!source) return;
    if (typeof source === 'string') {
      for (const part of source.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) this.map.set(name, value);
      }
      return;
    }
    for (const [k, v] of Object.entries(source)) this.map.set(k, v);
  }

  // 吃 fetch Response 的 Set-Cookie(Node 18+ 用 headers.getSetCookie();無此 API 則
  // fallback 單行 get('set-cookie') ——多筆會被逗號併成一行,盡力而為)
  ingest(headers) {
    let setCookies = [];
    if (typeof headers.getSetCookie === 'function') {
      setCookies = headers.getSetCookie();
    } else {
      const raw = headers.get('set-cookie');
      if (raw) setCookies = [raw];
    }
    for (const line of setCookies) {
      const firstPart = line.split(';')[0];
      const idx = firstPart.indexOf('=');
      if (idx < 0) continue;
      const name = firstPart.slice(0, idx).trim();
      const value = firstPart.slice(idx + 1).trim();
      if (name) this.map.set(name, value);
    }
  }

  header() {
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  get(name) {
    return this.map.get(name);
  }

  toObject() {
    return Object.fromEntries(this.map.entries());
  }
}

// 判斷回應是否被導回登入頁(session 失效的訊號)。
// (2026-07-27 實測:失效 session 會導向 UX0301UserLogin 登入頁,兩條啟發式皆有效。)
function looksLikeLoginRedirect(finalUrl, html) {
  if (/UX0301UserLogin/i.test(finalUrl || '')) return true;
  if (html && /smartAccount/.test(html) && /smartPassword/.test(html)) return true;
  return false;
}

async function rawFetch(jar, path, { method = 'GET', body, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const resp = await fetch(url, {
    method,
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Cookie: jar.header(),
      ...headers,
    },
    body,
  });
  jar.ingest(resp.headers);
  const html = await resp.text();
  return { resp, html, finalUrl: resp.url };
}

// 從 HTML 取 <input name="__RequestVerificationToken" value="...">
function extractFieldToken(html) {
  const $ = cheerio.load(html);
  const val = $('input[name="__RequestVerificationToken"]').attr('value');
  return val || null;
}

// GET 會員頁面 → 拿與目前 cookie 配對的新鮮 field token(並吃回應可能更新的 cookie)。
// session 失效(被導回登入頁)→ 回 null。
async function getAntiForgeryToken(jar) {
  const { html, finalUrl } = await rawFetch(jar, TOKEN_SOURCE_PATH);
  if (looksLikeLoginRedirect(finalUrl, html)) return null;
  return extractFieldToken(html);
}

function formBody(fields) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      for (const item of v) usp.append(k, item);
    } else if (v !== undefined && v !== null) {
      usp.append(k, v);
    }
  }
  return usp.toString();
}

async function postForm(jar, path, fields, fieldToken) {
  const { html, finalUrl } = await rawFetch(jar, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      __RequestVerificationToken: fieldToken,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: formBody(fields),
  });
  if (looksLikeLoginRedirect(finalUrl, html)) {
    const err = new Error('session-expired');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }
  return html;
}

// yyyy/MM/dd 格式化(輸入可為 Date 或 'yyyy-mm-dd'/'yyyy/mm/dd' 字串)
function fmtDate(d) {
  if (d instanceof Date) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }
  return String(d).replace(/-/g, '/');
}

// 1. search:UX050506TrafficAdvancedSearch → 回批次列 HTML(呼叫端用 parseSearchBatches 解)
async function search(jar, fieldToken, { plate, cin, startDate, endDate }) {
  return postForm(jar, '/UX0505Traffic/UX050506TrafficAdvancedSearch', {
    __RequestVerificationToken: fieldToken,
    cln: plate,
    cin,
    rdoRatingDate: '1',
    ratingStartDate: fmtDate(startDate),
    ratingEndDate: fmtDate(endDate),
    weekend: ['-1', '0', '1', '2', '3', '4', '5', '6'],
    rdoGantryId: '0',
    gantryId: '---',
    gantryIdSearch: '',
    rdoRatingAmt: '0',
    ratingAmtMin: '',
    ratingAmtMax: '',
    paymentStatus: '0',
    'X-Requested-With': 'XMLHttpRequest',
  }, fieldToken);
}

// 2. detail:UX050507AdvancedSearchDetail → 回逐門架列 HTML(呼叫端用 parseDetailGantries 解)
async function detail(jar, fieldToken, { plate, cin, batchId }) {
  return postForm(jar, '/UX0505Traffic/UX050507AdvancedSearchDetail', {
    __RequestVerificationToken: fieldToken,
    cin,
    cln: plate,
    txBatchId: batchId,
  }, fieldToken);
}

// 3. print:UX050508TrafficAdvancedSearchPrint → 回列印 HTML(呼叫端用 parsePrintRows 解)
// dateTimeJSON = { [batchId]: ['yyyy/MM/dd HH:mm:ss', ...] }
async function print(jar, fieldToken, { plate, cin, dateTimeMap }) {
  return postForm(jar, PRINT_PATH, {
    __RequestVerificationToken: fieldToken,
    cln: plate,
    cin,
    dateTimeJSON: JSON.stringify(dateTimeMap),
  }, fieldToken);
}

// cin(加密車 id)解析:GET 會員主頁,解析車輛清單 plate→cin 對照。
// (2026-07-27 活 session 實測定案:車輛卡=.swiper-slide[data-cin][data-cln];
// cin 為帳號層級識別碼(同帳號各車相同),查詢靠 cln 車牌區分。)
async function resolveCin(jar, plate) {
  const { html, finalUrl } = await rawFetch(jar, MEMBER_VEHICLES_PATH);
  if (looksLikeLoginRedirect(finalUrl, html)) {
    const err = new Error('session-expired');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }
  const $ = cheerio.load(html);
  let cin = null;
  $('[data-cln], [data-plate]').each((_, el) => {
    const $el = $(el);
    const p = $el.attr('data-cln') || $el.attr('data-plate');
    if (p && p.trim() === plate) {
      cin = $el.attr('data-cin') || $el.attr('value') || null;
    }
  });
  return cin;
}

// ── print 資產內嵌(A1,2026-07-26)───────────────────────────────────────
// 為什麼需要:列印 HTML(<head> 內 <link rel=stylesheet href="/Content/...">、
// CSS 內 url(../images/...) 背景圖如遠通 logo)裡的資產路徑都是站內相對路徑。
// Vercel chromium 用 page.setContent() 渲染這段 HTML 時沒有 base URL、且 Vercel
// 對 fetc.net.tw 網域網路層不可達(見計劃 Round E Context)——相對路徑資產全部
// 載入失敗,PDF 會缺 CSS/logo。中繼(台灣 IP)在把 printHtml 交給 Vercel 前,
// 用同一份 session cookie 把這些資產全部抓下來、換成自包含的 <style>/data URI。
//
// 實測(fetc-print-resp.txt,2026-07-26 活 session)發現:遠通 logo 不是
// <img src="/Content/...">,而是 CSS `.logo{background-image:url(../images/logo.png)}`
// ——故除了 <link>/<img> 兩種資產,CSS 檔案內容本身的 url(...) 也要遞迴內嵌,
// 否則換成 <style> 後裡面仍殘留相對路徑、瀏覽器一樣抓不到背景圖。
// <script src="/Content/...">(jQuery 等)一律移除:純列印 HTML 不需要互動 JS,
// 留著在 Vercel 對 fetc.net.tw 不可達的網路環境下只會造成無謂的請求/逾時風險。

function guessContentType(url) {
  const ext = (String(url).split('?')[0].split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    css: 'text/css',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    ico: 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

function toAbsoluteUrl(refUrl, baseForRelative) {
  if (/^https?:\/\//i.test(refUrl)) return refUrl;
  if (refUrl.startsWith('//')) return 'https:' + refUrl;
  if (refUrl.startsWith('/')) return BASE + refUrl;
  // 純相對路徑(如 CSS 內 ../images/logo.png):以來源檔案自身的絕對 URL 為底解析
  return new URL(refUrl, baseForRelative).toString();
}

// fetch 單一資產(沿用同一 jar cookie,遠通部分靜態資產仍可能要求已登入 session)。
// 回 {buf, contentType}。失敗直接 throw,由呼叫端決定降級策略。
async function fetchAssetBuffer(jar, absUrl) {
  const resp = await fetch(absUrl, {
    headers: { 'User-Agent': UA, Cookie: jar.header() },
  });
  if (!resp.ok) throw new Error(`asset-fetch-failed:${resp.status}`);
  jar.ingest(resp.headers);
  const arrayBuf = await resp.arrayBuffer();
  const contentType = resp.headers.get('content-type') || guessContentType(absUrl);
  return { buf: Buffer.from(arrayBuf), contentType };
}

// CSS 文字內的 url(...) 參照(排除已是 data: 的)→ 逐一 fetch → 換成 data URI。
// cssAbsUrl = 這份 CSS 檔案自己的絕對 URL(供解析 CSS 內相對路徑用的底)。
async function inlineCssUrls(cssText, cssAbsUrl, jar) {
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const seen = new Map(); // 原始參照字串 → data URI(或原樣,fetch 失敗時)
  const refs = new Set();
  let m;
  while ((m = urlRe.exec(cssText))) {
    const raw = m[2].trim();
    if (!raw || raw.startsWith('data:')) continue;
    refs.add(raw);
  }
  for (const raw of refs) {
    try {
      const abs = toAbsoluteUrl(raw, cssAbsUrl);
      const { buf, contentType } = await fetchAssetBuffer(jar, abs);
      seen.set(raw, `data:${contentType};base64,${buf.toString('base64')}`);
    } catch (e) {
      // 單一圖示抓不到不擋整份 CSS——保留原相對路徑會在 Vercel 端載入失敗但不影響
      // 版面文字/其餘已內嵌樣式,比整份 CSS 放棄划算。
    }
  }
  let out = cssText;
  for (const [raw, dataUri] of seen.entries()) {
    out = out.split(raw).join(dataUri);
  }
  return out;
}

// 對外主函式:printHtml(遠通 UX050508…Print 回應)→ 全自包含 HTML
// (無 <link rel=stylesheet href="/Content...">、無 <img src="/Content...">、
// 無 <script src="/Content...">;CSS 內 url(...) 一併內嵌成 data URI)。
async function inlinePrintAssets(html, jar) {
  const $ = cheerio.load(html);

  // 1. <link rel=stylesheet href="/Content/...">  → <style>{css}</style>
  const linkEls = $('link[rel="stylesheet"]').toArray();
  for (const el of linkEls) {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) continue;
    try {
      const abs = toAbsoluteUrl(href, BASE + '/');
      const { buf } = await fetchAssetBuffer(jar, abs);
      const cssText = await inlineCssUrls(buf.toString('utf8'), abs, jar);
      $el.replaceWith(`<style>${cssText}</style>`);
    } catch (e) {
      $el.remove(); // fetch 失敗:移除而非留殘破 <link href="/Content...">
    }
  }

  // 2. <img src="/Content/...">(或任何相對路徑)→ data:image/...;base64,...
  const imgEls = $('img').toArray();
  for (const el of imgEls) {
    const $el = $(el);
    const src = $el.attr('src');
    if (!src || src.startsWith('data:')) continue;
    try {
      const abs = toAbsoluteUrl(src, BASE + '/');
      const { buf, contentType } = await fetchAssetBuffer(jar, abs);
      $el.attr('src', `data:${contentType};base64,${buf.toString('base64')}`);
    } catch (e) {
      $el.remove();
    }
  }

  // 3. <script src="/Content/...">:移除(見上方註解——純列印 HTML 不需要互動 JS)
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.startsWith('/') || src.startsWith(BASE)) $(el).remove();
  });

  return $.html();
}

// 完整查詢鏈:search → 逐批次 detail → 組 dateTimeJSON → print → 內嵌 print 資產。
// 回 { transactions, total, printHtml, searchHtml }(printHtml 已是自包含 HTML)。
// 供 server.js /query 路由呼叫;session 失效時各步驟會 throw code=SESSION_EXPIRED,
// 由呼叫端 catch 轉成 {ok:false, reason:'session-expired'}。
// opts.skipPrint(Round H1):PDF 改由 /print 端點(0.3.8 純 HTTP 遠通伺服器原生件)產生
// ——/query 若只是要 transactions/total,印一次遠通 print 端點純屬浪費(多一次遠通呼叫+
// inline 資產動輒 2MB),true 時整段跳過,printHtml 回 null。
async function queryAll(jar, { plate, cin, startDate, endDate }, opts = {}) {
  const { skipPrint = false } = opts;
  const fieldToken = await getAntiForgeryToken(jar);
  if (!fieldToken) {
    const err = new Error('session-expired');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  const searchHtml = await search(jar, fieldToken, { plate, cin, startDate, endDate });
  const batches = parseSearchBatches(searchHtml);

  const transactions = [];
  const dateTimeMap = {};
  for (const batch of batches) {
    const detailHtml = await detail(jar, fieldToken, { plate, cin, batchId: batch.batchId });
    const gantries = parseDetailGantries(detailHtml, batch.date);
    for (const g of gantries) transactions.push(g);
    dateTimeMap[batch.batchId] = gantries.map((g) => g.timeStr);
  }

  let printHtml = null;
  if (!skipPrint && Object.keys(dateTimeMap).length) {
    const rawPrintHtml = await print(jar, fieldToken, { plate, cin, dateTimeMap });
    printHtml = await inlinePrintAssets(rawPrintHtml, jar);
  }

  const total = transactions.reduce((sum, t) => sum + (Number.isFinite(t.amount) ? t.amount : 0), 0);

  return { transactions, total, printHtml, searchHtml };
}

// 供 /print 端點用:純 HTTP 準備「只含 times 子集」的 dateTimeMap,不呼叫 print 端點本身
// (print/PDF 兩步由 /print handler 接續呼叫)。times = 呼叫端(Vercel 配對命中的門架時間戳)
// 想收款的子集,格式與 /query 回應 transactions[].timeStr 相同('yyyy/MM/dd HH:mm:ss')。
// 逐批 detail 拿到的每列 g.timeStr 只要在 timesSet 內就收進該 batchId 底下——這正是「PDF
// 不可混入租期外通行紀錄」鐵則在資料層的落地:送進遠通列印端點的 dateTimeJSON 從一開始
// 就只含 times 允許的時間戳,不是先拿全量再事後過濾 printHtml。
// 回 { dateTimeMap, fieldToken }。times 一筆都比對不上任何門架列 → dateTimeMap 為空物件
// (不是例外——呼叫端據此回 {ok:false, reason:'no-rows'})。session 失效沿用既有
// code=SESSION_EXPIRED 慣例(search/detail 底層 postForm 已處理)。
async function buildDateTimeMapForTimes(jar, { plate, cin, startDate, endDate, times }) {
  const fieldToken = await getAntiForgeryToken(jar);
  if (!fieldToken) {
    const err = new Error('session-expired');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  const timesSet = new Set(times);
  const searchHtml = await search(jar, fieldToken, { plate, cin, startDate, endDate });
  const batches = parseSearchBatches(searchHtml);

  const dateTimeMap = {};
  for (const batch of batches) {
    const detailHtml = await detail(jar, fieldToken, { plate, cin, batchId: batch.batchId });
    const gantries = parseDetailGantries(detailHtml, batch.date);
    const matched = gantries.filter((g) => timesSet.has(g.timeStr)).map((g) => g.timeStr);
    if (matched.length) dateTimeMap[batch.batchId] = matched;
  }

  return { dateTimeMap, fieldToken };
}

// ── 遠通伺服器端原生 PDF(0.3.8;Round H1 終局)──────────────────────────
// 「下載PDF文件」按鈕的真身(2026-07-27 逆向列印頁 inline script 證實):前端 downloadPdf()
// 把列印頁 DOM 剝掉 script/pre、URL 絕對化、包成完整 HTML 後 base64,POST 到
// /UX0000Common/UX000006GetPDF——**由遠通伺服器生成 PDF 回傳**(含電子憑證專用章、
// 文字層)。所以原生件根本不需要瀏覽器:純 HTTP 復刻同一包裝即可。
// 已用真 session 實測:回應 application/pdf、%PDF-1.4、版式=官方 Report 同模。
const GETPDF_PATH = '/UX0000Common/UX000006GetPDF';

// 復刻列印頁 downloadPdf() 的內容打包(順序/取代規則一字不差照抄,別「優化」——
// 伺服器端怎麼解析我們不知道,跟瀏覽器送的長一樣才是最穩的):
// 移除 script/pre → head 內所有 href="/src=" 前面補站台 → body 內 src="/(單斜線)補站台
// → 重組 <!DOCTYPE html><html lang="zh-TW">…。
function buildPdfContentFromPrintHtml(printHtml) {
  let s = String(printHtml)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, '');
  const headM = s.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const bodyM = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let head = headM ? headM[1] : '';
  let body = bodyM ? bodyM[1] : s;
  head = head.replace(/href="/gi, 'href="' + BASE).replace(/src="/gi, 'src="' + BASE);
  body = body.replace(/src="\/(?!\/)/gi, 'src="' + BASE + '/');
  return '<!DOCTYPE html><html lang="zh-TW"><head>' + head + '</head><body>' + body + '</body></html>';
}

// printHtml(print() 的**原始**回應,不可用 inline 過的——script 剝法/URL 形態要與
// 瀏覽器端一致)→ 遠通伺服器生成的 PDF Buffer。非 PDF 回應一律 throw(PDF_FAILED)。
async function generateNativePdf(jar, fieldToken, printHtml) {
  const html = buildPdfContentFromPrintHtml(printHtml);
  const content = Buffer.from(html, 'utf-8').toString('base64');
  // ?&r=<ts> 照抄 Portal.Common.SendToURL(避免快取的網址加鹽)
  const resp = await fetch(BASE + GETPDF_PATH + '?&r=' + Date.now(), {
    method: 'POST',
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: BASE + '/Member',
    },
    body: formBody({ content, __RequestVerificationToken: fieldToken }),
  });
  jar.ingest(resp.headers);
  const buf = Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok || buf.subarray(0, 5).toString() !== '%PDF-') {
    const err = new Error(`GetPDF 回應非 PDF(status=${resp.status}, type=${ct}, size=${buf.length})`);
    err.code = 'PDF_FAILED';
    throw err;
  }
  return buf;
}

module.exports = {
  CookieJar,
  getAntiForgeryToken,
  search,
  detail,
  print,
  resolveCin,
  queryAll,
  buildDateTimeMapForTimes,
  generateNativePdf,
  inlinePrintAssets,
  looksLikeLoginRedirect,
  extractFieldToken,
  fmtDate,
  PRINT_PATH,
};
