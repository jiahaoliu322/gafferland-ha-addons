# etag-relay — HA add-on
#
# ⚠ 0.3.2 起改用 node:20-bookworm-slim,**不再用 mcr.microsoft.com/playwright 官方映像**。
# 原因(2026-07-27 實測):playwright 官方映像壓縮後約 2GB、解壓 6-8GB,在 GitHub Actions
# 上 build+push 連續兩次都卡在 build-push 超過 45/79 分鐘無法完成(runner 只有約 14GB 磁碟,
# 匯出/上傳這種體積會撐在邊緣)。改成 slim base ＋ 只裝 chromium,映像預估降到 1GB 以內,
# 順帶讓 HA 端首次 pull 快得多。
#
# 瀏覽器只有「真人透過 noVNC 手動登入遠通」這一步會用到(查詢/結算全是純 HTTP,見
# lib/fetc-client.js),所以只需要 chromium,不需要官方映像那整套多瀏覽器環境。
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
# 瀏覽器裝到固定路徑,避免落在 root 家目錄而在不同執行使用者下找不到
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 只裝 production 依賴(cheerio 解析、playwright 登入、ws＋@novnc/novnc 遠端畫面)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# chromium ＋ 其系統相依(playwright 官方 --with-deps 會裝該版對應的那批 lib)。
# ⚠ 這裡**故意不設** PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD——slim base 沒有內建瀏覽器,
# 這步就是要真的把 chromium 抓下來。
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# xvfb 虛擬螢幕(headed chromium 用)＋x11vnc(noVNC 遠端登入)＋
# CJK 字型(**必要**:遠通登入頁是中文,少了字型在 noVNC 只會看到一堆方框,人根本沒辦法操作)。
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11-utils x11vnc fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY server.js ./
COPY lib ./lib

# HA add-on 標準:options.json 由 supervisor 掛進 /data(map: data:rw,見 config.yaml)
VOLUME ["/data"]

EXPOSE 8099
EXPOSE 8098

COPY run.sh ./
RUN chmod +x run.sh

CMD ["./run.sh"]
