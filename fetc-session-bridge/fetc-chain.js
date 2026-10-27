// ── 遠通(FETC)查詢鏈(瀏覽器版,移植自 etag-relay/lib/fetc-client.js)──────────────
// 在遠通分頁(同源、自帶 session cookie)內執行的純模組:不碰 chrome.*、不碰 storage、
// 不 require 任何套件。fetch 與 DOM 解析一律由呼叫端注入:
//   createFetcChain({ fetchImpl, parseHtml, base, now, parser, cinCache })
// 請求的路徑／方法／表單欄位／__RequestVerificationToken、X-Requested-With、Content-Type 與
// 中繼版完全相同(test/request-parity.test.js 鎖住);不送 User-Agent／Cookie／Referer
// (瀏覽器自帶,在遠通頁面內執行時 Referer 自然是遠通網址)。fetch 一律 credentials:'include'。
//
// PDF 鐵則:收款憑證必須是遠通伺服器生成的原生 PDF(UX000006GetPDF);送進列印端點的
// dateTimeJSON 只含 payload 的 times 子集(buildDateTimeMapForTimes)。沒有任何自家渲染 fallback。
//
// 載入方式:<script> / executeScript({files}) → globalThis.GflFetcChain(需先載入 fetc-parse.js,
// 或由 options.parser 注入);Node → module.exports。
(function (root) {
  'use strict';

  const FETCH_TIMEOUT_MS = 30000; // search/detail/token 等一般 HTML 回應
  const PDF_TIMEOUT_MS = 60000; // 遠通伺服器生成 PDF 較慢
  const MAX_HTML_BYTES = 10 * 1024 * 1024;
  const MAX_PDF_BYTES = 20 * 1024 * 1024;

  const TOKEN_SOURCE_PATH = '/Member/Setting'; // 已登入才看得到的會員頁,用來取新鮮 field token
  const MEMBER_VEHICLES_PATH = '/Member'; // 車輛清單(.swiper-slide[data-cin][data-cln])
  const SEARCH_PATH = '/UX0505Traffic/UX050506TrafficAdvancedSearch';
  const DETAIL_PATH = '/UX0505Traffic/UX050507AdvancedSearchDetail';
  const PRINT_PATH = '/UX0505Traffic/UX050508TrafficAdvancedSearchPrint';
  const GETPDF_PATH = '/UX0000Common/UX000006GetPDF';

  function makeErr(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  // ── bytes / base64(大 HTML 不能 String.fromCharCode(...整包))──────────────
  function bytesToBase64(u8) {
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return root.btoa(bin);
  }

  // 字串 → UTF-8 bytes → base64(中文安全)
  function utf8ToBase64(str) {
    return bytesToBase64(new TextEncoder().encode(String(str)));
  }

  function utf8ByteLength(str) {
    return new TextEncoder().encode(str).length;
  }

  // 復刻列印頁 downloadPdf() 的內容打包——順序/取代規則一字不差照抄 etag-relay 版,別「優化」:
  // 移除 script/pre → head 內所有 href="/src=" 前面補站台 → body 內 src="/(單斜線)補站台
  // → 重組 <!DOCTYPE html><html lang="zh-TW">…。
  function buildPdfContentFromPrintHtml(printHtml, base) {
    const BASE = base || 'https://www.fetc.net.tw';
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

  // 例外 → 10-common 的 reason
  function reasonOf(e) {
    switch (e && e.code) {
      case 'LOGIN_REQUIRED':
        return 'login-required';
      case 'CF_CHALLENGE':
        return 'cf-challenge';
      case 'CIN_NOT_FOUND':
        return 'cin-not-found';
      case 'PDF_FAILED':
        return 'pdf-failed';
      default:
        return 'error';
    }
  }

  function createFetcChain(options) {
    const opts = options || {};
    const base = opts.base || 'https://www.fetc.net.tw';
    const now = opts.now || (() => Date.now());
    const cinCache = opts.cinCache || {};
    const fetchImpl = opts.fetchImpl || (root.fetch ? root.fetch.bind(root) : null);
    const parseHtml = opts.parseHtml || undefined; // 不給 → fetc-parse.js 預設走 DOMParser
    const P = opts.parser || root.GflFetcParse;
    if (typeof fetchImpl !== 'function') throw new Error('createFetcChain: 需要 fetchImpl');
    if (!P) throw new Error('createFetcChain: 找不到 GflFetcParse(先載入 fetc-parse.js 或傳 options.parser)');

    // 一般 HTML 請求:大小檢查(TextEncoder)＋CF 挑戰偵測。不送 UA/Cookie/Referer。
    async function rawFetch(path, { method = 'GET', body, headers = {} } = {}) {
      const url = path.startsWith('http') ? path : base + path;
      const resp = await fetchImpl(url, {
        method,
        redirect: 'follow',
        credentials: 'include',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { ...headers },
        body,
      });
      const lenHeader = resp.headers && resp.headers.get('content-length');
      if (lenHeader && Number(lenHeader) > MAX_HTML_BYTES) {
        throw makeErr('RESPONSE_TOO_LARGE', `response-too-large:content-length=${lenHeader}`);
      }
      const html = await resp.text();
      const size = utf8ByteLength(html);
      if (size > MAX_HTML_BYTES) {
        throw makeErr('RESPONSE_TOO_LARGE', `response-too-large:actual=${size}`);
      }
      const mitigated = ((resp.headers && resp.headers.get && resp.headers.get('cf-mitigated')) || '').toLowerCase();
      if (
        P.isCfChallengeBody(resp.status, html) ||
        ((resp.status === 403 || resp.status === 503) && mitigated === 'challenge')
      ) {
        throw makeErr('CF_CHALLENGE', 'cf-challenge:遠通官網回 Cloudflare 挑戰頁(status=' + resp.status + ')');
      }
      return { resp, html, finalUrl: resp.url };
    }

    async function postForm(path, fields, fieldToken) {
      const { html, finalUrl } = await rawFetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          __RequestVerificationToken: fieldToken,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formBody(fields),
      });
      if (P.looksLikeLoginRedirect(finalUrl, html)) throw makeErr('LOGIN_REQUIRED', 'login-required');
      return html;
    }

    // GET 會員頁 → 與目前 cookie 配對的新鮮 field token。被導回登入頁／取不到 → LOGIN_REQUIRED。
    async function getToken() {
      const { html, finalUrl } = await rawFetch(TOKEN_SOURCE_PATH);
      if (P.looksLikeLoginRedirect(finalUrl, html)) throw makeErr('LOGIN_REQUIRED', 'login-required');
      const token = P.extractFieldToken(html, parseHtml);
      if (!token) throw makeErr('LOGIN_REQUIRED', 'login-required');
      return token;
    }

    // 車牌 → cin(快取在注入的 cinCache);查無 → CIN_NOT_FOUND
    async function getCin(plate) {
      if (cinCache[plate]) return cinCache[plate];
      const { html, finalUrl } = await rawFetch(MEMBER_VEHICLES_PATH);
      if (P.looksLikeLoginRedirect(finalUrl, html)) throw makeErr('LOGIN_REQUIRED', 'login-required');
      const cin = P.findCinForPlate(html, plate, parseHtml);
      if (!cin) throw makeErr('CIN_NOT_FOUND', 'cin-not-found');
      cinCache[plate] = cin;
      return cin;
    }

    // 1. search → 批次列 HTML
    function search(fieldToken, { plate, cin, startDate, endDate }) {
      return postForm(
        SEARCH_PATH,
        {
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
        },
        fieldToken
      );
    }

    // 2. detail → 逐門架列 HTML
    function detail(fieldToken, { plate, cin, batchId }) {
      return postForm(
        DETAIL_PATH,
        { __RequestVerificationToken: fieldToken, cin, cln: plate, txBatchId: batchId },
        fieldToken
      );
    }

    // 3. print → 列印 HTML;dateTimeMap = { [batchId]: ['yyyy/MM/dd HH:mm:ss', ...] }
    function print(fieldToken, { plate, cin, dateTimeMap }) {
      return postForm(
        PRINT_PATH,
        {
          __RequestVerificationToken: fieldToken,
          cln: plate,
          cin,
          dateTimeJSON: JSON.stringify(dateTimeMap),
        },
        fieldToken
      );
    }

    // search → 逐批 detail。回 { transactions, total }(＝relay queryAll 的 skipPrint 版)
    async function queryPlate({ plate, startDate, endDate }) {
      const cin = await getCin(plate);
      const fieldToken = await getToken();
      const searchHtml = await search(fieldToken, { plate, cin, startDate, endDate });
      const batches = P.parseSearchBatches(searchHtml, parseHtml);
      const transactions = [];
      for (const batch of batches) {
        const detailHtml = await detail(fieldToken, { plate, cin, batchId: batch.batchId });
        const gantries = P.parseDetailGantries(detailHtml, batch.date, parseHtml);
        for (const g of gantries) transactions.push(g);
      }
      const total = transactions.reduce((sum, t) => sum + (Number.isFinite(t.amount) ? t.amount : 0), 0);
      return { transactions, total };
    }

    // 只收 times 子集進 dateTimeMap(「PDF 不混入租期外紀錄」鐵則在資料層的落地)。
    // 回 { dateTimeMap, fieldToken };times 一筆都比對不上 → dateTimeMap 為空物件。
    async function buildDateTimeMapForTimes({ plate, cin, startDate, endDate, times }) {
      const fieldToken = await getToken();
      const timesSet = new Set(times);
      const searchHtml = await search(fieldToken, { plate, cin, startDate, endDate });
      const batches = P.parseSearchBatches(searchHtml, parseHtml);
      const dateTimeMap = {};
      for (const batch of batches) {
        const detailHtml = await detail(fieldToken, { plate, cin, batchId: batch.batchId });
        const gantries = P.parseDetailGantries(detailHtml, batch.date, parseHtml);
        const matched = gantries.filter((g) => timesSet.has(g.timeStr)).map((g) => g.timeStr);
        if (matched.length) dateTimeMap[batch.batchId] = matched;
      }
      return { dateTimeMap, fieldToken };
    }

    // printHtml(print() 的原始回應)→ 遠通伺服器生成的原生 PDF(Uint8Array)。非 PDF 一律 throw PDF_FAILED。
    async function generateNativePdf(fieldToken, printHtml) {
      const html = buildPdfContentFromPrintHtml(printHtml, base);
      const content = utf8ToBase64(html);
      // ?&r=<ts> 照抄 Portal.Common.SendToURL(避免快取的網址加鹽)
      const resp = await fetchImpl(base + GETPDF_PATH + '?&r=' + now(), {
        method: 'POST',
        redirect: 'follow',
        credentials: 'include',
        signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ content, __RequestVerificationToken: fieldToken }),
      });
      const lenHeader = resp.headers && resp.headers.get('content-length');
      if (lenHeader && Number(lenHeader) > MAX_PDF_BYTES) {
        throw makeErr('PDF_FAILED', `GetPDF 回應過大(content-length=${lenHeader})`);
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) {
        throw makeErr('PDF_FAILED', `GetPDF 回應過大(實際 ${buf.length} bytes)`);
      }
      const head = new TextDecoder().decode(buf.subarray(0, 5));
      if (!resp.ok || head !== '%PDF-') {
        // 先分辨「被擋」與「單純產 PDF 失敗」:CF 挑戰／登入頁會讓剩下的車牌停打(STOP_REASONS)。
        const ct = (resp.headers && resp.headers.get('content-type')) || '';
        const mitigated = ((resp.headers && resp.headers.get && resp.headers.get('cf-mitigated')) || '').toLowerCase();
        let text = '';
        if (head !== '%PDF-') {
          try {
            text = new TextDecoder().decode(buf.subarray(0, 262144));
          } catch (e) {
            text = '';
          }
        }
        if (P.isCfChallengeBody(resp.status, text) || ((resp.status === 403 || resp.status === 503) && mitigated === 'challenge')) {
          throw makeErr('CF_CHALLENGE', 'cf-challenge:GetPDF 回 Cloudflare 挑戰頁(status=' + resp.status + ')');
        }
        if (head !== '%PDF-' && P.looksLikeLoginRedirect(resp.url, text)) {
          throw makeErr('LOGIN_REQUIRED', 'login-required');
        }
        throw makeErr('PDF_FAILED', `GetPDF 回應非 PDF(status=${resp.status}, type=${ct}, size=${buf.length})`);
      }
      return buf;
    }

    // ── 工作層(不 throw;逐車轉 reason)───────────────────────────────────────
    // login-required／cf-challenge 發生後,剩下的車牌不再打,同一 reason 帶出。
    const STOP_REASONS = { 'login-required': 1, 'cf-challenge': 1 };

    async function runQueryJob(payload) {
      const { plates, startDate, endDate } = payload;
      const perPlate = {};
      let stop = null;
      for (const plate of plates) {
        if (stop) {
          perPlate[plate] = { ok: false, reason: stop };
          continue;
        }
        try {
          const r = await queryPlate({ plate, startDate, endDate });
          perPlate[plate] = {
            ok: true,
            transactions: r.transactions.map((t) => ({
              timeStr: t.timeStr,
              route: t.route,
              gantry: t.gantry,
              amount: t.amount,
            })),
          };
        } catch (e) {
          const reason = reasonOf(e);
          perPlate[plate] = { ok: false, reason };
          if (STOP_REASONS[reason]) stop = reason;
        }
      }
      return { perPlate };
    }

    // scan 與 settle-query 的輸入輸出相同(plates + 查詢窗)
    function runScanJob(payload) {
      return runQueryJob(payload);
    }

    // settle-print:payload.plates=[{plateRaw,times}]。attach-print 的單車形狀
    // ({plateRaw,times,startDate,endDate})也接受,視為單元素 plates。
    async function runPrintJob(payload) {
      const { startDate, endDate } = payload;
      const plates = Array.isArray(payload.plates)
        ? payload.plates
        : [{ plateRaw: payload.plateRaw, times: payload.times }];
      const pdfs = [];
      let stop = null;
      for (const item of plates) {
        const plateRaw = item.plateRaw;
        if (stop) {
          pdfs.push({ plateRaw, ok: false, reason: stop });
          continue;
        }
        try {
          const times = Array.isArray(item.times) ? item.times : [];
          if (!times.length) {
            pdfs.push({ plateRaw, ok: false, reason: 'no-rows' });
            continue;
          }
          const cin = await getCin(plateRaw);
          const { dateTimeMap, fieldToken } = await buildDateTimeMapForTimes({
            plate: plateRaw,
            cin,
            startDate,
            endDate,
            times,
          });
          if (!Object.keys(dateTimeMap).length) {
            pdfs.push({ plateRaw, ok: false, reason: 'no-rows' });
            continue;
          }
          const printHtml = await print(fieldToken, { plate: plateRaw, cin, dateTimeMap });

          // printTotal 供伺服器與彙總金額對數(取不到不擋)
          let printTotal = null;
          try {
            const { total } = P.parsePrintRows(printHtml, parseHtml);
            if (total && total.toll) {
              const amt = P.parseAmount(total.toll);
              if (Number.isFinite(amt)) printTotal = amt;
            }
          } catch (e) {
            /* 對數輔助欄位,解析失敗回 null */
          }

          const pdf = await generateNativePdf(fieldToken, printHtml);
          pdfs.push({ plateRaw, ok: true, pdfBase64: bytesToBase64(pdf), printTotal });
        } catch (e) {
          const reason = reasonOf(e);
          pdfs.push({ plateRaw, ok: false, reason });
          if (STOP_REASONS[reason]) stop = reason;
        }
      }
      return { pdfs };
    }

    return {
      getToken,
      getCin,
      search,
      detail,
      print,
      queryPlate,
      buildDateTimeMapForTimes,
      buildPdfContentFromPrintHtml: (printHtml) => buildPdfContentFromPrintHtml(printHtml, base),
      generateNativePdf,
      runQueryJob,
      runPrintJob,
      runScanJob,
    };
  }

  const api = {
    createFetcChain,
    buildPdfContentFromPrintHtml,
    bytesToBase64,
    utf8ToBase64,
    reasonOf,
    fmtDate,
    formBody,
  };

  root.GflFetcChain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
