# Gafferland Relay(原 etag-relay)— HA add-on
#
# 0.8.0:拆遠通 eTag 路由(/query /print /session、keep-alive、lib/fetc-client.js、lib/parse.js),
# 只剩 /sms 簡訊轉送與店內 IP 心跳;零 npm 依賴(cheerio 移除)。映像名不變。
#
# ⚠ 0.3.2 起改用 node:20-bookworm-slim,**不再用 mcr.microsoft.com/playwright 官方映像**
# (playwright 官方映像太肥,曾讓 GitHub Actions build+push 卡死;見舊版 changelog)。
#
# 0.5.0:登入/VNC/Chrome 全套拆除,中繼本體完全不需要瀏覽器/虛擬螢幕/VNC,映像大瘦身。
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

# 只裝 production 依賴(0.8.0 起為零個;保留 npm ci 讓日後加依賴時 lock 不同步仍 fail-fast)。
# npm ci 要求 package-lock.json 存在且與 package.json 完全同步,不同步/缺 lock 直接 fail-fast。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# lib/ 整個 COPY(0.8.0 起只剩 sms-forward.js、siteip-heartbeat.js)
COPY server.js ./
COPY lib ./lib

# HA add-on 標準:options.json 由 supervisor 掛進 /data(map: data:rw,見 config.yaml)
VOLUME ["/data"]

EXPOSE 8099

COPY run.sh ./
RUN chmod +x run.sh

CMD ["./run.sh"]
