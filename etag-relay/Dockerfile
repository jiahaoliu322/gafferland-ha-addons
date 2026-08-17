# etag-relay — HA add-on
#
# ⚠ 0.3.2 起改用 node:20-bookworm-slim,**不再用 mcr.microsoft.com/playwright 官方映像**
# (playwright 官方映像太肥,曾讓 GitHub Actions build+push 卡死;見舊版 changelog)。
#
# 0.5.0:登入/VNC/Chrome 全套拆除——session 更新改由使用者電腦的 Chrome 擴充功能把
# cookies POST 進 /session(見 server.js handleSession),查詢/結算原本就是純 HTTP
# (見 lib/fetc-client.js),中繼本體完全不需要瀏覽器/虛擬螢幕/VNC,映像大瘦身。
#
# 0.5.1:base image 改釘 digest(供應鏈完整性——tag 可被上游重新指向,digest 不可變)。
# 更新法(本機無 docker CLI,用 registry API 查 manifest list digest;buildx 會依平台
# 自動從 index 選對應 linux/amd64 manifest,故釘的是 index/manifest-list digest 而非
# 單一平台 manifest digest):
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
#     https://registry-1.docker.io/v2/library/node/manifests/20-bookworm-slim \
#     | grep -i docker-content-digest
# 保留 tag 註解供人讀(下面 FROM 行的 :20-bookworm-slim 只是可讀提示,實際鎖的是 @sha256 digest)。
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

ENV NODE_ENV=production

# 只裝 production 依賴(cheerio 解析)。npm ci 要求 package-lock.json 存在且與
# package.json 完全同步,不同步/缺 lock 直接 fail-fast(比 npm install 更適合 CI/映像建置)。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib

# HA add-on 標準:options.json 由 supervisor 掛進 /data(map: data:rw,見 config.yaml)
VOLUME ["/data"]

EXPOSE 8099

COPY run.sh ./
RUN chmod +x run.sh

CMD ["./run.sh"]
