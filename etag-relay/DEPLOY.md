# 部署步驟(E1-b,使用者操作)

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
| `FETC_ACCOUNT` | 遠通會員帳號 |
| `FETC_PASSWORD` | 遠通會員密碼 |
| `RELAY_SECRET` | 自訂一組長隨機字串(建議 32 bytes 以上),Vercel 呼叫 `/query`/`/health`/`/login` 用(與 Vercel 端 `ETAG_RELAY_SECRET` 一致) |
| `VERCEL_CAPTCHA_URL` | Vercel 端接收「請老闆進 noVNC 登入」通知的 URL(`https://gafferland.vercel.app/api/collect?action=etag-captcha`,實際路徑以 Vercel 端實作為準) |
| `VERCEL_CALLBACK_SECRET` | 中繼呼叫 Vercel `etag-captcha` 時帶的 `secret` 欄位值(需與 Vercel 端 `ETAG_RELAY_CALLBACK_SECRET` 一致) |
| `PUBLIC_BASE_URL` | 中繼對外可達的網址(下一步設定的 Cloudflare Tunnel hostname,如 `https://etag-relay.gafferland.net`)——⚠ Round G1 起未被程式碼實際使用(舊版曾用來組驗證碼圖片端點的完整 URL,該端點已隨軌道 A 一併移除),先保留選項,尚未清除 |

存檔後啟動 add-on,看「Log」分頁確認 `[etag-relay] listening on :8099`。

## 4. Cloudflare Tunnel Public Hostname + Access

前提:`Gafferland_tunnel` 已 HEALTHY(R1-4 教學已完成)。

1. Cloudflare Zero Trust → Networks → Tunnels → `Gafferland_tunnel` → **Public
   Hostname** → 新增:
   - Subdomain: `etag-relay`
   - Domain: `gafferland.net`
   - Service: `HTTP://localhost:8099`(HA 主機上 add-on 對外的 port)
2. Zero Trust → Access → Applications → 新增一個 Application 保護
   `etag-relay.gafferland.net`(此為 API 埠 8099,與 noVNC 的 8098 是獨立設定):
   - **Service Auth**(service token)方式,只讓帶正確 Client ID/Secret 的請求
     (Vercel)進得來。產生 service token 後記下 `CF_ACCESS_CLIENT_ID` /
     `CF_ACCESS_CLIENT_SECRET`,待會填進 Vercel env。
   - （Round G1 起 noVNC 入口 8098 已**拿掉** Cloudflare Access,改用連結內建
     長亂數 token + VNC 密碼兩層,見 `lib/vnc.js`;此處只設定 8099 API 的 Access,
     不要把 8098 也一併保護,否則帶 token 的連結會先被 Access 擋下。）
3. `etag-relay.gafferland.net/health` 用 curl 帶 `X-Relay-Secret` 應回
   `{"ok":true,...}`(driving through Access 需另帶 `CF-Access-Client-Id` /
   `CF-Access-Client-Secret` header,視 Access 規則設定)。

## 5. Vercel env

Vercel 專案 → Settings → Environment Variables 新增:

| 變數 | 值 |
|---|---|
| `ETAG_RELAY_URL` | `https://etag-relay.gafferland.net` |
| `ETAG_RELAY_SECRET` | 與 add-on `RELAY_SECRET` 一致 |
| `CF_ACCESS_CLIENT_ID` | 步驟 4 產生的 service token ID |
| `CF_ACCESS_CLIENT_SECRET` | 步驟 4 產生的 service token secret |
| `ETAG_RELAY_CALLBACK_SECRET` | 與 add-on `VERCEL_CALLBACK_SECRET` 一致 |

（`FETC_ACCOUNT`/`FETC_PASSWORD` 只留在 HA add-on config,Vercel 端不需要、也
不應該存這兩個值。）

## 驗收

- Add-on Log 顯示啟動成功、無例外。
- `curl -H "X-Relay-Secret: ..." https://etag-relay.gafferland.net/health` 回
  `{"ok":true,"sessionValid":false,...}`(尚未登入前 `sessionValid` 應為
  `false`,這是預期行為——session 要靠真人 noVNC 登入建立)。

後續步驟(E1-c/E1-d)：Vercel `settleEtagOrders`/`cron-etag`/`etag-captcha`
action/`line-webhook` 擴充見主線計劃 `Round E` 節,不在本文件範圍。
