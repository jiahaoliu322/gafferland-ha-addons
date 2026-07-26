# etag-relay — HA add-on
#
# Base image 已內建 chromium + 所有系統相依套件(fonts/libs),版本 tag 與
# package.json 的 "playwright" npm 套件版本必須完全一致(否則 npm install 會
# 嘗試下載另一版 chromium,容器內無網路寫入權限/體積暴增)。
# 目前 pin: v1.61.1(package.json 同步 pin "playwright": "1.61.1")。
# 之後升級 playwright 版本時,務必同時改這裡的 tag 與 package.json 的版本號。
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# xvfb 虛擬螢幕(headed Chrome 用;base image 不保證有 xvfb-run 包裝腳本,故明確安裝)＋
# x11vnc/noVNC/websockify(Round F 真人遠端登入用:自動登入失敗時老闆透過瀏覽器看畫面手動輸碼)。
# jammy universe 有時缺 novnc/websockify 套件(視 apt 索引狀態),第一段失敗就自動切 pip+tarball
# fallback——build 只跑一次就要成功,不留給人手動重試猜 apt 套件名。
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11-utils x11vnc \
    && ( apt-get install -y --no-install-recommends novnc websockify \
         || ( apt-get install -y --no-install-recommends python3-pip ca-certificates curl \
              && pip3 install --no-cache-dir websockify \
              && mkdir -p /usr/share/novnc \
              && curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
                 | tar xz --strip-components=1 -C /usr/share/novnc ) ) \
    && rm -rf /var/lib/apt/lists/*

# 只裝 production 依賴(cheerio 解析 + playwright,登入流程用)。
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1:base image 已含對應版本 chromium,
# 避免 npm install 的 postinstall 重複下載(容器內無此需求、也省建置時間)。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ⚠ 0.2.1 移除「安裝真 Google Chrome」那一步(原 `npx playwright install --with-deps chrome`)。
# 2026-07-27 實測:該步驟在此環境會讓 docker build 卡住超過 25 分鐘無輸出、無法完成。
# 取捨:真 Chrome 只是為了拉高「自動登入」的 reCAPTCHA v3 分數,而 Round F 的主路線是**真人**
# 透過 noVNC 手動登入——真人操作用 base image 內建的 chromium 一樣過得了 v3。lib/login.js 本就
# 會在 channel:'chrome' 啟動失敗時自動 fallback 回內建 chromium,故此處不裝、程式零改動。
# 日後若要再試真 Chrome,單獨開一版驗證,不要混在功能版一起賭 build。

COPY server.js ./
COPY lib ./lib

# HA add-on 標準:options.json 由 supervisor 掛進 /data(map: data:rw,見 config.yaml)
VOLUME ["/data"]

EXPOSE 8099
EXPOSE 8098

COPY run.sh ./
RUN chmod +x run.sh

CMD ["./run.sh"]
