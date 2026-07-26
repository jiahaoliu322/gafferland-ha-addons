#!/usr/bin/env bash
# etag-relay 啟動腳本:先起 Xvfb 虛擬螢幕(headed Chrome 過 reCAPTCHA v3 用),
# 再視 VNC_PASSWORD 是否設定起 x11vnc(Round F 真人遠端登入用),最後跑 server。
#
# 鐵則:任何一支(Xvfb/x11vnc)起不來都只印警告、絕不讓 server 不啟動——
# 0.1.5 就是因為包裝腳本(xvfb-run)不存在導致容器無聲卡死,不能再犯。
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

# VNC_PASSWORD 讀法不用 jq(不保證 base image 有裝),用 node 讀 /data/options.json 較保險。
# 讀失敗(non-HA 開發環境/檔案不存在)一律當空字串,不讓腳本因此中斷(set -u 底下 || true 保底)。
VNC_PASSWORD="$(node -e 'try{process.stdout.write(String((JSON.parse(require("fs").readFileSync("/data/options.json","utf8")).VNC_PASSWORD)||""))}catch(e){}' 2>/dev/null || true)"

X11VNC_PID=""

if [ -z "${VNC_PASSWORD}" ]; then
  echo "[etag-relay] VNC_PASSWORD 未設定,不啟動 x11vnc(noVNC 遠端登入功能停用)"
else
  # 密碼檔存 /data(持久卷),0600 權限;密碼值本身絕不進 log。
  if x11vnc -storepasswd "${VNC_PASSWORD}" /data/.vncpasswd >/dev/null 2>&1; then
    chmod 600 /data/.vncpasswd 2>/dev/null || true
    x11vnc -display "${DISPLAY}" -forever -shared -rfbauth /data/.vncpasswd \
      -rfbport 5900 -localhost -noxdamage -quiet &
    X11VNC_PID=$!
    echo "[etag-relay] x11vnc 啟動(rfbport 5900,僅 localhost)"
    # noVNC 網頁與 WebSocket 轉發改由 server.js(lib/vnc.js)自己在 :8098 提供,
    # 不再需要 websockify(0.3.0 起;見 lib/vnc.js 檔頭說明)。
  else
    echo "[etag-relay] 警告:x11vnc 密碼檔建立失敗,noVNC 遠端登入停用"
  fi
fi

trap 'kill ${XVFB_PID} ${X11VNC_PID} 2>/dev/null || true' EXIT
exec node server.js
