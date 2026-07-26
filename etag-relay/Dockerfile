# etag-relay — HA add-on
#
# Base image 已內建 chromium + 所有系統相依套件(fonts/libs),版本 tag 與
# package.json 的 "playwright" npm 套件版本必須完全一致(否則 npm install 會
# 嘗試下載另一版 chromium,容器內無網路寫入權限/體積暴增)。
# 目前 pin: v1.61.1(package.json 同步 pin "playwright": "1.61.1")。
# 之後升級 playwright 版本時,務必同時改這裡的 tag 與 package.json 的版本號。
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# 只裝 production 依賴(cheerio 解析 + playwright,登入流程用)。
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1:base image 已含對應版本 chromium,
# 避免 npm install 的 postinstall 重複下載(容器內無此需求、也省建置時間)。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib

# HA add-on 標準:options.json 由 supervisor 掛進 /data(map: data:rw,見 config.yaml)
VOLUME ["/data"]

EXPOSE 8099

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1440x900x24", "node", "server.js"]
