# 部署步驟(使用者操作)

> 本文件的主機名／tunnel 名稱以佔位符表示,實際值見私有 docs(不上傳)。

## 部署模型

映像不在 HA 上 build——HA 本機 build 曾經卡死且無從診斷(見
`.github/workflows/build-etag-relay.yml` 檔頭說明)。改成 GitHub Actions 雲端建置:
push `etag-relay/**` 到 `main` 會自動 build + push 映像到
`ghcr.io/jiahaoliu322/etag-relay-amd64`,tag = `config.yaml` 的 `version`;
`config.yaml` 的 `image:` 指到這裡,HA Supervisor 只做 `docker pull`,不 build。

**⚠ 每次改 `etag-relay/` 底下任何內容,一定要同時把 `config.yaml` 的 `version` 往上
bump**,否則新映像雖然推上 ghcr,HA 端 tag 對不上、永遠不會抓到新版本。

- **0.6.0**:新增「店內 IP 心跳」(見 `README.md` 同名章節與下方步驟 3 的
  `PUNCH_SITEIP_URL` 說明)。HA 端只需按「更新」,零新必填設定。

## 1. 建 GitHub repo

把這個 `etag-relay/` 資料夾整個推成一個新的 GitHub repo(比照
`brenner-tobias/ha-addons` 結構——repo 根目錄下就是 add-on 資料夾,可以只放
`etag-relay/` 一個 add-on,或未來加其他 add-on 並列):

```
your-repo/
└── etag-relay/
    ├── config.yaml
    ├── Dockerfile
    ├── package.json
    ├── server.js
    ├── lib/
    ├── README.md
    └── DEPLOY.md
```

## 2. HA 加入 repo

Home Assistant → **設定 →附加元件 →附加元件商店** → 右上角選單「儲存庫」→
貼上你的 repo URL(如 `https://github.com/<you>/etag-relay-addon`)→ 加入後
重新整理,商店列表會出現「eTag Relay」。

## 3. 安裝 + 設定

點進「eTag Relay」→ 安裝 → **設定**分頁填入:

| 欄位 | 說明 |
|---|---|
| `FETC_ACCOUNT` | ⚠ 0.5.0 起無功能用途(登入流程已拆除,session 改由 Chrome 擴充功能餵入)——可留空,保留只是 Supervisor schema 相容舊設定 |
| `FETC_PASSWORD` | 同上,0.5.0 起無功能用途,可留空 |
| `RELAY_SECRET` | 自訂一組長隨機字串(建議 32 bytes 以上)。所有端點(`/query`/`/print`/`/health`/`/session`)皆驗此值,與 Vercel 端 `ETAG_RELAY_SECRET` 一致 |
| `VERCEL_CAPTCHA_URL` | ⚠ 別被舊名字誤導,**不是**驗證碼用途了——`POST /session` 驗證通過、換上新 session 後,relay 回呼這個 Vercel URL(`etag-captcha` 端點,實際路徑以 Vercel 端實作為準)觸發「有單即自動補跑結算」 |
| `VERCEL_CALLBACK_SECRET` | 中繼呼叫 Vercel `etag-captcha` 時帶的 `secret` 欄位值(需與 Vercel 端 `ETAG_RELAY_CALLBACK_SECRET` 一致) |
| `PUBLIC_BASE_URL` | ⚠ 已停用,選填。舊版曾用來組驗證碼圖片端點的完整 URL,該端點已隨登入流程一併拆除,程式碼不再讀取這個值 |
| `PUNCH_SITEIP_URL` | 0.6.0 新增,選填,一般留空。店內 IP 心跳(每 5 分鐘 POST Vercel 一次目前店內對外 IP,供員工打卡 Wi-Fi 判定)的目的地 URL 覆寫——不填時預設由 `VERCEL_CAPTCHA_URL` 取 origin 推導出 `/api/punch?action=site-ip`,只有 Vercel 端點路徑改變時才需要填 |

存檔後啟動 add-on,看「Log」分頁確認 `[etag-relay] listening on :8099`。

## 4. Cloudflare Tunnel Public Hostname + Access

前提:`<你的 tunnel 名稱>` 已 HEALTHY。

1. Cloudflare Zero Trust → Networks → Tunnels → `<你的 tunnel 名稱>` → **Public
   Hostname** → 新增:
   - Subdomain: `etag-relay`
   - Domain: `<你的網域>`
   - Service: `HTTP://localhost:8099`(HA 主機上 add-on 對外的 port)
2. Zero Trust → Access → Applications → 新增一個 Application 保護
   `<RELAY_HOST>`(例:`etag-relay.example.com`):
   - **Service Auth**(service token)方式,只讓帶正確 Client ID/Secret 的請求
     (Vercel)進得來。產生 service token 後記下 `CF_ACCESS_CLIENT_ID` /
     `CF_ACCESS_CLIENT_SECRET`,待會填進 Vercel env。
3. `<RELAY_HOST>/health` 用 curl 帶 `X-Relay-Secret` 應回
   `{"ok":true,...}`(driving through Access 需另帶 `CF-Access-Client-Id` /
   `CF-Access-Client-Secret` header,視 Access 規則設定)。

## 5. Vercel env

Vercel 專案 → Settings → Environment Variables 新增:

| 變數 | 值 |
|---|---|
| `ETAG_RELAY_URL` | `https://<RELAY_HOST>` |
| `ETAG_RELAY_SECRET` | 與 add-on `RELAY_SECRET` 一致 |
| `CF_ACCESS_CLIENT_ID` | 步驟 4 產生的 service token ID |
| `CF_ACCESS_CLIENT_SECRET` | 步驟 4 產生的 service token secret |
| `ETAG_RELAY_CALLBACK_SECRET` | 與 add-on `VERCEL_CALLBACK_SECRET` 一致 |

（`FETC_ACCOUNT`/`FETC_PASSWORD` 已無功能用途,Vercel 端不需要、也不應該存這兩個值。）

## 6. 建立/更新 session

Add-on 啟動後 session 是空的,需要使用者手動餵入一次(之後靠 keep-alive 保溫,失效
才需要重新操作這一步):

1. 在自己電腦的 Chrome 安裝 `fetc-session-bridge` 擴充功能(見該資料夾
   `README.md`)。
2. 同一個 Chrome 先登入 Gafferland 後台(擴充要靠這個身分把 cookies 轉發給站台)。
3. 再登入遠通電收(fetc.net.tw)會員區。
4. 點擴充功能圖示 →「更新 Gafferland session」。
5. 擴充把 cookies 送進 Gafferland 站台 → 站台轉發到這個中繼的 `POST /session`
   → 中繼用 `getAntiForgeryToken` 真驗證,通過才生效。add-on Log 應出現
   `[etag-relay] /session 收到新 session,驗證通過,已存檔並回呼 Vercel`。
6. `curl -H "X-Relay-Secret: ..." https://<RELAY_HOST>/health`
   確認 `sessionValid` 轉為 `true`。

疑難排解(403 / session 無效)見 `fetc-session-bridge/README.md`。

## 驗收

- Add-on Log 顯示啟動成功、無例外。
- `curl -H "X-Relay-Secret: ..." https://<RELAY_HOST>/health` 回
  `{"ok":true,"sessionValid":false,...}`(尚未餵入 session 前 `sessionValid` 應為
  `false`,這是預期行為)。
- 完成上方「建立/更新 session」步驟後,`sessionValid` 應轉為 `true`。

後續步驟:Vercel `settleEtagOrders`/`cron-etag`/`etag-captcha` action/`line-webhook`
擴充見主線計劃,不在本文件範圍。
