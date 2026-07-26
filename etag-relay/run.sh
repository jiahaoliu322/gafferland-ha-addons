#!/usr/bin/env bash
# etag-relay 啟動腳本:先起 Xvfb 虛擬螢幕(headed Chrome 過 reCAPTCHA v3 用),再跑 server。
set -u
export DISPLAY=:99
echo "[etag-relay] 啟動 Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!
# 等 Xvfb 就緒(最多 10 秒);沒起來也繼續跑(server 會以 headless 失敗回報,不致無聲卡死)
for i in $(seq 1 20); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then echo "[etag-relay] Xvfb 就緒"; break; fi
  sleep 0.5
done
trap 'kill ${XVFB_PID} 2>/dev/null || true' EXIT
exec node server.js
