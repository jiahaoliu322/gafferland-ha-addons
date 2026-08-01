# etag-relay — HA add-on
#
# ⚠ 0.3.2 起改用 node:20-bookworm-slim,**不再用 mcr.microsoft.com/playwright 官方映像**
# (playwright 官方映像太肥,曾讓 GitHub Actions build+push 卡死;見舊版 changelog)。
#
# 0.5.0:登入/VNC/Chrome 全套拆除——session 更新改由使用者電腦的 Chrome 擴充功能把
# cookies POST 進 /session(見 server.js handleSession),查詢/結算原本就是純 HTTP
# (見 lib/fetc-client.js),中繼本體完全不需要瀏覽器/虛擬螢幕/VNC,映像大瘦身。
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

# 只裝 production 依賴(cheerio 解析)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib

# HA add-on 標準:options.json 由 supervisor 掛進 /data(map: data:rw,見 config.yaml)
VOLUME ["/data"]

EXPOSE 8099

COPY run.sh ./
RUN chmod +x run.sh

CMD ["./run.sh"]
