# Gafferland Relay(資料夾／映像名仍為 etag-relay)

Home Assistant add-on:Gafferland 簡訊轉送(every8d)與店內對外 IP 心跳中繼(台灣住宅 IP 出口)。

> 0.8.0 起改名 **Gafferland Relay**,遠通(FETC)eTag 的舊路由全部拆除——eTag 通行明細改由員工
> 電腦的瀏覽器擴充功能 `fetc-session-bridge` 代查,收款憑證由員工在網站匯入遠通原生 PDF,
> 中繼不再碰遠通。資料夾名 `etag-relay/`、add-on slug `etag_relay_v3`、映像
> `ghcr.io/jiahaoliu322/etag-relay-amd64` 刻意不改(改了 HA 會當成另一個 add-on)。
>
> **HA 更新到 0.8.0 後,設定頁的遠通帳密欄(`FETC_ACCOUNT`/`FETC_PASSWORD`)可以清空**——程式
> 已不讀取,schema 只是暫留為選填讓舊設定通過驗證,下版再移除。

## 為什麼需要這個

Gafferland 網站跑在 Vercel(境外 IP、沒有固定 IP),有兩件事需要一個台灣住宅 IP 出口:

1. **簡訊(every8d)**:every8d 擋境外 IP,海外解鎖只給固定 IP 白名單,Vercel 給不出來。
   家中 HA 是台灣住宅 IP,不需要跟 every8d 申請任何東西——Vercel 把簡訊請求經這個中繼轉送。
2. **店內 IP 心跳**:員工打卡的 Wi-Fi 判定＝「請求來源 IP 等於店內對外 IP」。店內 IP 浮動,
   由這個 add-on(與員工 Wi-Fi 同一個 WAN 出口)定時告訴 Vercel 目前的店內對外 IP。

中繼本體是輕量 Node process,零 npm 依賴、不含瀏覽器。

## 架構

```
Vercel(lib/sms.js)──(Cloudflare Tunnel + Access)──▶ Gafferland Relay(HA)POST /sms ──▶ api.e8d.tw
                    ◀────────── {ok, status, body}(e8d 原始回應)─────────────

Gafferland Relay(HA)──每 5 分鐘 POST──▶ Vercel /api/punch?action=site-ip(記下來源 IP)
```

檔案樹:

```
etag-relay/
├── config.yaml       add-on manifest(HA 用;version 變更見檔頭 changelog)
├── Dockerfile         base = node:20-bookworm-slim(釘 digest)
├── package.json       零 npm 依賴
├── server.js          Node 內建 http server,路由見下
├── lib/
│   ├── sms-forward.js       簡訊純轉發(GET api.e8d.tw sendSMS.ashx,15s 逾時)
│   └── siteip-heartbeat.js  店內 IP 心跳(每 5 分鐘 POST Vercel,供打卡 Wi-Fi 判定)
├── test-sms.js         簡訊轉發驗證(stub fetch,離線)
├── test-heartbeat.js   店內 IP 心跳驗證(stub fetch + 可注入 timer,離線)
├── test-server.js      本機起 server 端到端驗證(/health、/sms 守門與成功/不通、心跳送達、eTag 舊路由 404)
├── test-helpers/       test-server 用:no-egress.js(禁止對外連線)、fake-e8d.js(本機假簡訊端點);不進映像
├── README.md
└── DEPLOY.md
```

## API

所有端點皆需 `X-Relay-Secret` header(與 `RELAY_SECRET` add-on 設定一致,timing-safe 比對;
不符或 `RELAY_SECRET` 未設定一律 `401 {ok:false, reason:'unauthorized'}`)。

| 端點 | 說明 |
|---|---|
| `POST /sms` | `{uid, pwd, sb, msg, dest}`(every8d 帳密由 Vercel 每次請求帶入,中繼不存帳密)→ 純轉發 `lib/sms-forward.js`。成功 `200 {ok:true, status, body}`(`body`＝e8d 原始回應文字,CSV 判讀交回呼叫端 gafferland-main `lib/sms.js`);e8d 連不上/逾時 `200 {ok:false, reason:'e8d-unreachable'}`;缺 `uid`/`pwd`/`msg`/`dest` 回 `400 {ok:false, reason:'missing-params'}`;body 不是 JSON 回 `400 bad-request`。log 只印遮罩後的 `dest` 與 HTTP status,`pwd`/`msg`(含 OTP 驗證碼)絕不落 log |
| `GET /health` | `{ok:true, siteIpHeartbeat:{lastOkAt, lastIp}}`(0.8.0 起拿掉 `sessionValid`/`sessionReason`/`lastKeepAlive`) |
| 其他路徑 | `404 {ok:false, reason:'not-found'}`——含 0.8.0 拆掉的 `/query`、`/print`、`/session` |

## 店內 IP 心跳

**零新密鑰、零新必填選項**:沿用既有 `VERCEL_CAPTCHA_URL`(只取 origin;名字是舊的遠通驗證碼
回呼網址留下來的,現在只用來推導站台網址)與 `VERCEL_CALLBACK_SECRET`(Vercel 端對
`ETAG_RELAY_CALLBACK_SECRET`)。目的地 URL ＝ `new URL(VERCEL_CAPTCHA_URL).origin +
'/api/punch?action=site-ip'`。若 Vercel 端點路徑未來改變,可用選填的 `PUNCH_SITEIP_URL`
直接覆寫完整 URL(一般不需要設定)。

行為(`lib/siteip-heartbeat.js`,server.js 啟動段呼叫):啟動後 15 秒先送一次,之後每 5 分鐘
一次;POST body `{secret, source:'etag-relay'}`。成功且來源 IP 與上次不同才印一行 log(避免
洗版),失敗(未設定/HTTP 非 2xx/逾時/例外)每次都印警告(不含密鑰內容)。日誌長這樣:

```
[etag-relay] site-ip 心跳 ok ip=1.2.3.4        # 成功且 IP 有變化
[etag-relay] site-ip 心跳失敗 status=404 reason=-  # 失敗(如 Vercel 端點尚未上線)
```

`/health` 的 `siteIpHeartbeat: {lastOkAt, lastIp}`(`lastIp` 是店內對外 IP,非機密)。

## 本機測試

```bash
npm ci                            # 依 package-lock.json 精確安裝(零依賴;CI/映像建置同款)
node --check server.js lib/*.js   # 語法檢查
npm test                          # = node test-sms.js && node test-heartbeat.js && node test-server.js
                                   # 全離線:stub fetch／本機假伺服器,test-server 掛 no-egress 禁止對外連線
```

本機 smoke test:非 HA 環境讀不到 `/data/options.json`,改讀環境變數 `RELAY_SECRET`、
`VERCEL_CAPTCHA_URL`、`VERCEL_CALLBACK_SECRET`、`PUNCH_SITEIP_URL`,`node server.js` 即在
`:8099` 起服務(心跳目的地請指向本機假伺服器,別打正式站)。

部署方式見 `DEPLOY.md`。
