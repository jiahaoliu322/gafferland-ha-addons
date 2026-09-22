# etag-relay

Home Assistant add-on:遠通(FETC)eTag 通行明細中繼服務。

## 為什麼需要這個

Gafferland 網站的 Vercel 部署(境外 IP)被遠通電收(FETC)網路層擋(連 `fetc.net.tw`
都連線逾時)。這個 add-on 跑在使用者家中的 Home Assistant(台灣住宅 IP),作為 Vercel
`cron-etag` 與遠通之間的中繼——**查詢本身不需要瀏覽器**:通行明細查詢三步驟
(`UX050506` 搜尋 → `UX050507` 明細 → `UX050508` 列印)全程用 session cookie 純
HTTP POST 即可,回應是乾淨的 server-rendered HTML(cheerio 可解)。

session(登入態)的取得則靠**人**:遠通會員登入頁有圖形驗證碼 + reCAPTCHA v3,自動化
沒有安全路徑繞過,所以改成使用者自己在家用電腦的 Chrome 正常登入一次遠通會員區,
點一下 `fetc-session-bridge` 擴充功能,把登入後的 cookies 送進 Gafferland 站台、
再轉發給這個中繼(見下方架構圖第二條線)。中繼本體全程是輕量 Node process,不含
瀏覽器,也不含任何遠端桌面畫面。

## 架構

```
Vercel cron-etag ──(Cloudflare Tunnel + Access)──▶ etag-relay(HA)──▶ fetc.net.tw
                 ◀───── transactions/total/PDF 用列印 HTML ─────────

使用者 Chrome(fetc-session-bridge 擴充,已登入 fetc.net.tw)
   │  點擴充「更新 session」
   ▼
Gafferland 站台 API(轉發,擴充本身不直打中繼)
   │  Cloudflare Tunnel
   ▼
etag-relay  POST /session  ──真驗證(getAntiForgeryToken)通過才生效──▶ 換 jar/存檔
                                                                    │
                                                                    ▼
                                                     fire-and-forget 回呼 Vercel
                                                     (mode:'success',觸發補跑結算)
```

檔案樹:

```
etag-relay/
├── config.yaml       add-on manifest(HA 用;version 變更見檔頭 changelog)
├── Dockerfile         base = node:20-bookworm-slim(釘 digest)
├── package.json       deps: cheerio(HTML 解析)
├── server.js          Node 內建 http server,路由見下
├── lib/
│   ├── fetc-client.js       遠通 HTTP 查詢客戶端(anti-forgery token/search/detail/print/
│   │                         resolveCin/keep-alive/PDF)
│   ├── siteip-heartbeat.js  店內 IP 心跳(每 5 分鐘 POST Vercel,供打卡 Wi-Fi 判定)
│   └── parse.js             HTML 解析器(cheerio)
├── fixtures/           測試用合成 HTML(零真實資料;search/detail/print 三份)
├── test-parse.js       lib/parse.js 本機驗證(讀 fixtures/,離線)
├── test-inline.js      print 資產內嵌驗證(stub fetch,離線)
├── test-heartbeat.js   店內 IP 心跳驗證(stub fetch + 可注入 timer,離線)
├── README.md
└── DEPLOY.md
```

## API

所有端點皆為 `POST`/`GET` JSON,皆需 `X-Relay-Secret` header(與 `RELAY_SECRET`
add-on 設定一致,timing-safe 比對)。

| 端點 | 說明 |
|---|---|
| `POST /query` | `{plate, startDate, endDate, skipPrint?}` → 三步查詢鏈 → `{ok:true, transactions, total, printHtml}`。`skipPrint:true` 跳過遠通 print 步驟、回應**不含** `printHtml` 這欄(只要 transactions/total 時省一次遠通呼叫 + 內嵌資產動輒 2MB);未帶 `skipPrint` 行為不變。session 失效回 `{ok:false, reason:'session-expired'}`,其餘失敗回 `{ok:false, reason:'cin-not-found'\|'internal-error'}` |
| `POST /print` | `{plate, startDate, endDate, times}`(`times` = 要收款的門架時間戳子集,`'yyyy/MM/dd HH:mm:ss'`,與 `/query` 回應 `transactions[].timeStr` 同格式)→ 純 HTTP 復刻遠通「下載PDF文件」打包,POST 遠通 `UX000006GetPDF` 由**遠通伺服器**生成原生 PDF。成功 `{ok:true, pdfBase64, via:'fetc-native', printTotal}`(`printTotal` 取不到給 `null`);失敗 `{ok:false, reason:'no-rows'\|'session-expired'\|'pdf-failed'}` |
| `GET /health` | `{ok:true, sessionValid, lastKeepAlive, siteIpHeartbeat:{lastOkAt, lastIp}}` |
| `POST /session` | 瀏覽器擴充功能(經站台轉發)餵入新 session。`{cookies}`(陣列 `[{name,value}]` 或物件 `{name:value}` 皆可)→ 先用 `getAntiForgeryToken` 真驗證這組 cookies 真的能打會員頁,驗不過回 `400 {ok:false, reason:'session-invalid'}`(不蓋既有 jar/不存檔);驗證通過才換上全域 jar、存檔、回應 `{ok:true, verified:true}`,回應送出後 fire-and-forget 回呼 Vercel(`mode:'success'`,觸發補跑結算) |

## 認證機制(遠通端)

- Session = cookie(`ASP.NET_SessionId`/`FETC_P`/`__RequestVerificationToken`/
  `TS0*`/`Cookie_FEW-WEB`,皆 HttpOnly)+ 一對 ASP.NET anti-forgery
  `__RequestVerificationToken`(cookie 值與 request header/body 值必須是同時
  產生的配對)。
- 中繼持有的 session 只有 cookie 版 token,**每次 POST 前都要先 GET 一個會員
  頁面**取得配對的 field token(`lib/fetc-client.js getAntiForgeryToken`)。
- session 失效的訊號 = 被導回登入頁(`lib/fetc-client.js
  looksLikeLoginRedirect`)。

## session 生命週期

- **保溫(keep-alive)**:啟動後每 ~10 分鐘 ping 一次會員頁(借用
  `getAntiForgeryToken` 的登入頁重導向偵測),成功即更新 `lastKeepAlive` 並存檔
  (遠通 ping 回應可能帶 `Set-Cookie` 續期,不存回等於白 ping)。啟動當下也會立即
  驗一次,補上「重啟後要空等 10 分鐘才發現失效」的盲區。
- **失效**:keep-alive、`/query`、`/print` 任一撞到 session 失效都只會 `console.log`
  (`noteSessionDead`),**不會**自動觸發任何登入流程——那條路徑已隨 0.5.0 拆除。是否
  提醒使用者,交給 Vercel 端「有單才提醒」的邏輯處理。
- **恢復**:唯一路徑是使用者重新從 `fetc-session-bridge` 擴充餵一次 cookies 進
  `POST /session`(見上方架構圖)。

## print 資產內嵌

`lib/fetc-client.js inlinePrintAssets(html, jar)`:queryAll 拿到列印 HTML 後自動呼叫,
把 `<link rel=stylesheet>`(換 `<style>`)、CSS 內 `url(...)` 背景圖(如遠通 logo,實測是
`.logo{background-image:url(../images/logo.png)}` 而非 `<img>`)、`<img src>` 全部換成
`<style>`/`data:` 內嵌,`<script src>` 一律移除(純列印用途不需要互動 JS,且 Vercel 對
fetc.net.tw 網域不可達,留著只會造成無謂請求)。驗證見 `test-inline.js`(對合成的列印
HTML 片段跑,`globalThis.fetch` 用 stub 攔截資產請求,零真實資料、零網路;斷言零殘留
`/Content` 相對路徑、含 `<style>`/`data:image`)。

## 店內 IP 心跳

員工打卡的 Wi-Fi 判定＝「請求來源 IP 等於店內對外 IP」。店內 IP 浮動,由這個 add-on(跑在
店內 HA 上,與員工 Wi-Fi 同一個 UDM WAN 出口)每 5 分鐘 POST 一次 Vercel,Vercel 記下
來源 IP(KV 20 分鐘過期)。

**零新密鑰、零新必填選項**:沿用既有 `VERCEL_CAPTCHA_URL`(取 origin)與
`VERCEL_CALLBACK_SECRET`(Vercel 端對 `ETAG_RELAY_CALLBACK_SECRET`)。目的地 URL =
`new URL(VERCEL_CAPTCHA_URL).origin + '/api/punch?action=site-ip'`。若 Vercel 端點路徑
未來改變,可用選填的 `PUNCH_SITEIP_URL` 直接覆寫完整 URL(一般不需要設定)。

行為(`lib/siteip-heartbeat.js`,啟動段呼叫,server.js 零其餘改動):啟動後 15 秒先送一次,
之後每 5 分鐘一次;成功且來源 IP 與上次不同才印一行 log(避免洗版),失敗(未設定/HTTP
非 2xx/逾時/例外)每次都印警告(不含密鑰內容)。日誌長這樣:

```
[etag-relay] site-ip 心跳 ok ip=1.2.3.4        # 成功且 IP 有變化
[etag-relay] site-ip 心跳失敗 status=404 reason=-  # 失敗(如 Vercel 端點尚未上線)
```

`/health` 回應加 `siteIpHeartbeat: {lastOkAt, lastIp}`(`lastIp` 是店內對外 IP,非機密)。
驗證見 `test-heartbeat.js`(stub `fetchImpl` + 可注入 timer,零網路)。

## PDF 產生(`/print`)

鐵則(使用者裁示):PDF 是收款憑證,**必須是遠通自己生成的檔案**。實測列印頁上的
「下載PDF文件」按鈕按下去無任何網路請求=瀏覽器端由遠通頁面自己的 JS 生成 PDF(有文字層,
天然含 CJK)。

`/print` 的做法(全純 HTTP):

1. 純 HTTP 準備(`lib/fetc-client.js buildDateTimeMapForTimes`):search → 逐批 detail →
   只保留請求 `times` 集合內的時間戳,組出「裁切過」的 `dateTimeMap`——送進遠通列印端點
   的 payload 從一開始就不含租期外的紀錄。⚠ search 必須帶完整表單參數(rdoRatingDate/
   weekend/gantry/payment 全套),缺了會回空表、後續 print 直接 500。
2. `print()` 拿**原始**列印 HTML(含站方 script,不可先 inline)。
3. `generateNativePdf()`:復刻站方「下載PDF文件」按鈕 JS 的打包(剝 script/pre、URL 絕對化、
   包完整 HTML、base64)→ POST 遠通 `/UX0000Common/UX000006GetPDF` → **遠通伺服器生成
   原生 PDF 回傳**(含電子憑證專用章、文字層,與會員手動下載完全同源)。`via:'fetc-native'`。
4. 刻意**沒有任何自家渲染 fallback**:PDF 是收款憑證,寧可失敗回 `pdf-failed`(Vercel 記
   pdfError、代收列照寫,之後可還原重出),也不把非原生件掛上客戶收款憑證欄。
5. `printTotal` 用 `lib/parse.js parsePrintRows` 解列印 HTML 總計列,供 Vercel 對數。

## 限流

`lib/fetc-client.js` 三個對遠通的 fetch(`rawFetch`/`fetchAssetBuffer`/
`generateNativePdf`)皆有逾時與回應大小上限,避免遠通異常/掛起時把中繼(以及等待中的
Vercel 呼叫端)一起拖死;`lib/parse.js` 三個解析函式皆有列數上限,避免非預期回應內容
爆量吃記憶體/CPU。超限行為:fetch 逾時/過大直接 `throw`(落既有錯誤處理,`/query` 轉
`internal-error`、`/print` 轉 `pdf-failed`、資產內嵌單一資產失敗降級不擋整體);解析器
超限則是**截斷 + `console.warn`,不 `throw`**(回應契約沒有 `too-many-rows` 這個
reason,截斷後仍回可用的部分結果比 500 斷結算更友善)。

| 項目 | 逾時 | 大小上限 |
|---|---|---|
| `rawFetch`(search/detail/token 等一般 HTML) | 30s | 10MB |
| `fetchAssetBuffer`(單一 print 資產:css/img/font) | 20s | 5MB |
| `generateNativePdf`(遠通生成 PDF) | 60s | 20MB |

| 解析函式 | 列數上限 | 論證基準 |
|---|---|---|
| `parseSearchBatches` | 100 批 | 一次查詢窗涵蓋的天數(批次數) |
| `parseDetailGantries` | 500 列 | 單日單批實測 93 列,5 倍以上寬鬆空間 |
| `parsePrintRows` | 5000 列 | 整段租期量級(93 × 30 天 ≈ 2790) |

## 本機測試

```bash
npm ci                            # 依 package-lock.json 精確安裝(CI/映像建置同款)
node --check server.js lib/*.js   # 語法檢查
npm test                          # = node test-parse.js && node test-inline.js
                                   #   && node test-heartbeat.js
                                   # 全離線:fixtures/ 三份合成 HTML(零真實資料)+
                                   # stub fetch,不打任何網路、不需真實遠通回應檔
```

部署方式見 `DEPLOY.md`。
