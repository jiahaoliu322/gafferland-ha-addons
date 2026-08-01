# Gafferland eTag Session — fetc-session-bridge

Chrome 擴充功能。在自己電腦的 Chrome 正常登入遠通電收(fetc.net.tw)會員區後,點一下擴充功能,就能把遠通的 cookies(含 HttpOnly)送到 Gafferland 站台 API,由站台轉發給 HA 中繼完成 eTag session 更新,之後系統會自動補跑結算。單一使用者的內部工具。

## 安裝

1. Chrome 開啟 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」
4. 選擇 `fetc-session-bridge` 資料夾

## 使用

1. 同一個 Chrome 需已登入 Gafferland 後台(能開 `{站台}/collect` 即可)
2. 登入遠通電收會員區(fetc.net.tw)
3. 點擴充功能圖示 →「更新 Gafferland session」

## 疑難排解

- **403**:先在這個 Chrome 登入 Gafferland 後台,再回來重試。
- **session 無效**:重新登入遠通會員區後再試一次。
- **都不行**:點擴充功能內的「複製 Cookie 字串」,貼到 `{站台}/collect` 頁面的「貼 Cookie 補救」欄位。

## 註記

若 Gafferland 正式網域上線(www.gafferland.net),到擴充功能的「設定」把 Base URL 改成正式網域即可,不需重裝擴充功能。
