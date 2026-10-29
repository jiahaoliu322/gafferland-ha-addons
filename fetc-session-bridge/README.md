# Gafferland eTag Session — fetc-session-bridge

Chrome 擴充功能(2.2.0)。裝在店裡(或自己)的電腦上,**在這台電腦已登入的遠通電收(fetc.net.tw)會員區裡**代為查詢通行明細,結果交回 Gafferland 站台計算金額。單一使用者的內部工具。

運作方式:擴充功能只做**查詢與金額**;員工按「執行」才跑,平常不連遠通也不問站台。按下「執行」後問站台「有沒有工作」;沒有就什麼都不做;有就在背景開一個遠通分頁,把 `fetc-parse.js`＋`fetc-chain.js` 注入該分頁執行(請求由遠通網頁本身發出),結果 POST 回站台,佇列做完(站台回空)關掉分頁。擴充功能的背景頁自己只連 Gafferland 站台,不直接連遠通。

收款憑證:擴充功能**不抓憑證**。員工自己在遠通下載該車的通行費紀錄 PDF(遠通原生檔),再到網站 /collect「eTag 待補憑證」匯入,網站自動比對歸位。popup 會顯示「憑證 M 份待補」與「開啟匯入頁」鈕(開已配對站台的 /collect 匯入區)。

## 安裝／更新

1. Chrome 開啟 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」,選擇 `fetc-session-bridge` 資料夾
4. **更新**:把資料夾裡的檔案換成新版後,到 `chrome://extensions` 在這個擴充功能上按「重新載入」(圓形箭頭)

## 配對(每台電腦一次)

1. 同一個 Chrome 登入 Gafferland 後台,開 `{站台}/collect` 的「eTag 電腦」區 → 輸入電腦名稱 → 取得 8 碼配對碼(10 分鐘內有效)
2. 擴充功能圖示 →「設定」→「這台電腦」→ 貼上配對碼 → 按「配對」,顯示「已配對:<名稱>」
3. 要結算時:在這個 Chrome 登入遠通電收會員區(fetc.net.tw)
4. 擴充功能圖示應顯示「已配對／遠通已登入」與「站台待處理」筆數,按「執行」跑完佇列;/collect 的電腦列會看到心跳(打開 popup 也會回報一次)

換電腦或重裝:先到 /collect 把舊的移除,再重新配對。解除配對(設定頁)只清這台本機的設定。

## 狀態與處理

- **遠通未登入**:到遠通會員區登入後,再按「執行」。
- **遠通分頁出現驗證**(Cloudflare):擴充功能會把那個遠通分頁留著,請在那個分頁上自己完成驗證後再按一次「執行」。擴充功能不會自動導頁或送出任何表單。
- **憑證待補**:popup 顯示「憑證 M 份待補」時,到遠通下載該車的通行費紀錄 PDF,再按「開啟匯入頁」到網站「eTag 待補憑證」匯入。按「執行」不會處理憑證。
- **最後錯誤列**:popup 顯示最近一次真正的錯誤(遠通驗證沒過、需要重新登入、其他錯誤,含步驟與 HTTP 狀態,不含任何 cookie／密碼);「查無車牌」「沒有明細」這類正常結果不算錯誤、不會出現在這裡。
- **這台已被移除**:/collect 把這台移除了;到設定頁重新配對。
- 站台網址只允許 `admin.gafferland.com`(manifest `host_permissions`);設定頁填別的網址會被擋下並提示。

## 舊中繼(備援)

popup 下方「舊中繼(備援)」摺疊區保留 1.x 的兩個功能,只在站台仍使用 HA 中繼(`ETAG_MODE=relay`)時需要:

- 「更新 Gafferland session」:把遠通 cookies(含 HttpOnly)送到站台,由站台轉給 HA 中繼。需先在同一個 Chrome 登入 Gafferland 後台。
- 「複製 Cookie 字串」:貼到 `{站台}/collect` 的「貼 Cookie 補救」欄位。

疑難排解(舊中繼):403 → 先登入 Gafferland 後台再重試;session 無效 → 重新登入遠通會員區。

## 開發

```
cd fetc-session-bridge && npm ci && npm test
```

- `agent-core.js`:「執行」一輪的分頁／回報流程與 peek(可注入依賴,測試用假 chrome.*)
- `background.js`:只接 runtime 訊息(popup「執行」／peek)與舊鍵清理
- `fetc-parse.js`、`fetc-chain.js`:遠通查詢鏈(瀏覽器純模組,由 etag-relay 移植,parity 測試鎖住)
- 零密鑰、零真實車牌／帳號(本 repo 公開);測試資料全為合成

## 註記

預設送到 https://admin.gafferland.com;設定頁的網址留空即用預設。1.0.x 存過的舊網址(gafferland.vercel.app、gafferland.net)會自動視同未設定、改送預設網址。
