# etag-relay

Home Assistant add-on:遠通(FETC)eTag 通行明細中繼服務。

## 為什麼需要這個

Gafferland 網站的 Vercel 部署(境外 IP)被遠通電收(FETC)網路層擋(連 `fetc.net.tw`
都連線逾時),且遠通會員登入頁有 4 碼圖形驗證碼 + reCAPTCHA v3。實測結論(Round G1):
v3 擋的是「自動化瀏覽器觸發送出」這個動作本身,不論 4 碼是誰填的都一樣判定成機器人——
因此登入唯一路徑是老闆本人透過 noVNC 遠端畫面,親手操作中繼容器裡的瀏覽器完成登入。這個
add-on 跑在使用者家中的 Home Assistant(台灣住宅 IP),作為 Vercel `cron-etag` 與遠通
之間的中繼:

```
Vercel cron-etag ──(Cloudflare Tunnel + Access)──▶ etag-relay(HA)──▶ fetc.net.tw
                 ◀───── transactions/total/PDF 用列印 HTML ─────────
```

**查詢本身不需要瀏覽器**——2026-07-26 實測(E0)證實遠通的通行明細查詢三步驟
(`UX050506` 搜尋 → `UX050507` 明細 → `UX050508` 列印)全程用 session cookie 純
HTTP POST 即可,回應是乾淨的 server-rendered HTML(cheerio 可解)。瀏覽器
(playwright)只在「登入 session 失效、需要重新登入」時才會啟動,平時中繼是輕量
Node process。

## 架構

```
etag-relay/
├── config.yaml       add-on manifest(HA 用)
├── Dockerfile         base = mcr.microsoft.com/playwright:v1.62.0-jammy
├── package.json       deps: cheerio(解析)+ playwright(登入流程用瀏覽器)
├── server.js          Node 內建 http server,路由見下
├── lib/
│   ├── fetc-client.js  遠通 HTTP 查詢客戶端(anti-forgery token/search/detail/print/resolveCin)
│   ├── parse.js        HTML 解析器(cheerio)
│   ├── login.js        playwright 登入流程骨架(session 失效時才用)
│   └── print-pdf.js    Round H1:headless 瀏覽器進遠通真列印頁、按其原生下載鈕取得 PDF
├── test-parse.js       本機解析器驗證腳本(需搭配真實回應檔,見下)
└── test-inline.js      print 資產內嵌驗證腳本(同上)
```

## API

所有端點皆為 `POST`/`GET` JSON。

| 端點 | 驗證 | 說明 |
|---|---|---|
| `POST /query` | `X-Relay-Secret` | `{plate, startDate, endDate, skipPrint?}` → `{ok, transactions, total, printHtml}`;`skipPrint:true` 跳過遠通 print 步驟、回應**不含** `printHtml` 這欄(只要 transactions/total 時省一次遠通呼叫+2MB);未帶 `skipPrint`=行為不變。session 失效回 `{ok:false, reason:'session-expired'}` |
| `POST /print` | `X-Relay-Secret` | Round H1。`{plate, startDate, endDate, times}`(`times`=要收款的門架時間戳子集,`'yyyy/MM/dd HH:mm:ss'`,與 `/query` 回應 `transactions[].timeStr` 同格式)→ 開 headless 瀏覽器進遠通**真**列印頁、按遠通自己的下載按鈕取得原生 PDF。成功 `{ok:true, pdfBase64, via:'fetc-button'\|'page-pdf', printTotal}`(`printTotal` 取不到給 `null`);失敗 `{ok:false, reason:'no-rows'\|'session-expired'\|'pdf-failed'}` |
| `GET /health` | `X-Relay-Secret` | `{ok, sessionValid, lastKeepAlive, vncUrl, ...}`(`vncUrl` 是帶 token 的 noVNC 完整連結) |
| `POST /login` | `X-Relay-Secret` | 手動觸發登入流程(唯一路徑=真人 noVNC);`{ok, started, inFlight, mode:'manual'}` |
| `POST /session` | `X-Relay-Secret` | 內部用:登入流程寫回 session cookie |

## 認證機制(遠通端)

- Session = cookie(`ASP.NET_SessionId`/`FETC_P`/`__RequestVerificationToken`/
  `TS0*`/`Cookie_FEW-WEB`,皆 HttpOnly)+ 一對 ASP.NET anti-forgery
  `__RequestVerificationToken`(cookie 值與 request header/body 值必須是同時
  產生的配對)。
- 中繼持有的 session 只有 cookie 版 token,**每次 POST 前都要先 GET 一個會員
  頁面**取得配對的 field token(`lib/fetc-client.js getAntiForgeryToken`)。
- session 失效的訊號 = 被導回登入頁(`lib/fetc-client.js
  looksLikeLoginRedirect`)。

## print 資產內嵌(E1 中繼收尾,2026-07-26)

`lib/fetc-client.js inlinePrintAssets(html, jar)`:queryAll 拿到列印 HTML 後自動呼叫,
把 `<link rel=stylesheet>`(換 `<style>`)、CSS 內 `url(...)` 背景圖(如遠通 logo,實測是
`.logo{background-image:url(../images/logo.png)}` 而非 `<img>`)、`<img src>` 全部換成
`<style>`/`data:` 內嵌,`<script src>` 一律移除(純列印用途不需要互動 JS,且 Vercel 對
fetc.net.tw 網域不可達,留著只會造成無謂請求)。驗證見 `test-inline.js`(對 scratchpad
`fetc-print-resp.txt` 跑,斷言零殘留 `/Content` 相對路徑、含 `<style>`/`data:image`)。

## PDF 產生(Round H1,`/print`)

鐵則(使用者裁示):PDF 是收款憑證,**必須是遠通自己生成的檔案**。E0 實測列印頁上的
「下載PDF文件」按鈕按下去無任何網路請求=瀏覽器端由遠通頁面自己的 JS 生成 PDF(有文字層,
天然含 CJK)。之前 Vercel 端用 serverless chromium 把中繼回的 `printHtml` 另外
render 成 PDF 踩了兩個雷:①serverless 無 CJK 字型,PDF 中文全消失;②`print` 傳了整日
全部門架時間戳,PDF 混入租期外的通行紀錄。

`/print` 的做法(`lib/print-pdf.js`):

1. 純 HTTP 準備(`lib/fetc-client.js buildDateTimeMapForTimes`):search → 逐批 detail →
   只保留請求 `times` 集合內的時間戳,組出「裁切過」的 `dateTimeMap`——送進遠通列印端點
   的 payload 從一開始就不含租期外的紀錄,不是先印全部再事後裁切。
2. `chromium.launch({headless:true})` → 把中繼手上的 session cookie 灌進 playwright
   context → 進首頁 → 用 `page.evaluate` 動態組一張真表單 POST 進
   `/UX0505Traffic/UX050508TrafficAdvancedSearchPrint`——**絕不 `page.setContent()`
   塞自家 HTML**,落地的必須是遠通伺服器原生吐出來的那份列印頁(原站 CSS/JS/字型原生載入)。
3. 找遠通自己的下載按鈕(selector 未能從 fixture 100% 確認,見下方待驗證項目)、點擊、
   `page.waitForEvent('download')` 攔截 → `via:'fetc-button'`。找不到/逾時 → 降級
   `page.pdf({format:'A4'})` 印同一張真列印頁 → `via:'page-pdf'`(仍是遠通原生 DOM,只是
   不是遠通自己按鈕產出的檔案,log 會警告降級)。
4. `printTotal` 重用 `lib/parse.js parsePrintRows` 對 `page.content()` 解析總計列,取不到
   給 `null`,不擋 PDF 回傳。

## 已知待驗證項目(E1-a 只寫骨架,列於程式碼 TODO)

- `resolveCin`(車牌→加密車 id):端點/HTML 結構未經 E0 實測,`lib/fetc-client.js`
  裡是推測骨架。
- `lib/login.js` 整支(登入頁 DOM 選擇器、reCAPTCHA v3 token 擷取時機、驗證碼
  提交後成功/失敗判斷、keep-alive ping 目標、v3 token 是否擋 headless):本輪
  (E1-a/收尾)只 correct-by-construction 寫好+接線(server.js triggerLogin 已串
  keep-alive 失效/查詢失效/首次啟動無 session 三個觸發點),**無法在本機安全跑真
  登入**(避免鎖帳號),需 HA 活 session/實機驗證(E1-d)後校正選擇器與時機。
- anti-forgery token 來源頁 `TOKEN_SOURCE_PATH`(目前用 `/Member/Setting`)未
  100% 確認一定存在且未登入會 302。
- `lib/print-pdf.js` 的「下載PDF文件」按鈕 selector:本輪開發時可用的真實列印頁 fixture
  (前一輪工作階段抓下的 scratchpad 檔案)已被清空,**未能實測確認**實際 DOM/selector。
  現況是寬鬆多選一 fallback(`a:has-text("下載PDF文件")` 等,見檔案內 `DOWNLOAD_SELECTORS`)
  + 找不到/逾時一律降級 `page.pdf()`(`via:'page-pdf'`)。需要一次活 session 實測校正
  selector,並確認 `via` 是否真的命中 `'fetc-button'`。

## 本機測試

```bash
npm install
node --check server.js lib/*.js   # 語法檢查
node test-parse.js                # 解析器驗證(需搭配 E0 真實回應檔,見檔頭註解)
node test-inline.js                # print 資產內嵌驗證(同上,活 session 沙盒可達 fetc.net.tw 才會抓到真資產)
```

部署方式見 `DEPLOY.md`。
