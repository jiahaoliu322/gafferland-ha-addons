# etag-relay

Home Assistant add-on:遠通(FETC)eTag 通行明細中繼服務。

## 為什麼需要這個

Gafferland 網站的 Vercel 部署(境外 IP)被遠通電收(FETC)網路層擋(連 `fetc.net.tw`
都連線逾時),且遠通會員登入需要 4 碼圖形驗證碼(人工)+ reCAPTCHA v3(真瀏覽器自動
過)。這個 add-on 跑在使用者家中的 Home Assistant(台灣住宅 IP),作為 Vercel
`cron-etag` 與遠通之間的中繼:

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
│   └── login.js        playwright 登入流程骨架(session 失效時才用)
├── test-parse.js       本機解析器驗證腳本(需搭配真實回應檔,見下)
└── test-inline.js      print 資產內嵌驗證腳本(同上)
```

## API

所有端點皆為 `POST`/`GET` JSON,除了 `/cap/{token}.png`(回 PNG)。

| 端點 | 驗證 | 說明 |
|---|---|---|
| `POST /query` | `X-Relay-Secret` | `{plate, startDate, endDate}` → `{ok, transactions, total, printHtml}`;session 失效回 `{ok:false, reason:'session-expired'}` |
| `GET /health` | `X-Relay-Secret` | `{ok, sessionValid, lastKeepAlive}` |
| `POST /session` | `X-Relay-Secret` | 內部用:登入流程寫回 session cookie |
| `POST /captcha` | `X-Relay-Secret`(`RELAY_SECRET` 或 `VERCEL_CALLBACK_SECRET` 皆可) | Vercel line-webhook 轉發老闆回的 4 碼:`{loginId, code}` |
| `GET /cap/{token}.png` | **不驗密鑰**(Cloudflare Access 例外放行) | 回目前 pending 登入的驗證碼截圖,供 LINE 抓圖 |

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

## 本機測試

```bash
npm install
node --check server.js lib/*.js   # 語法檢查
node test-parse.js                # 解析器驗證(需搭配 E0 真實回應檔,見檔頭註解)
node test-inline.js                # print 資產內嵌驗證(同上,活 session 沙盒可達 fetc.net.tw 才會抓到真資產)
```

部署方式見 `DEPLOY.md`。
