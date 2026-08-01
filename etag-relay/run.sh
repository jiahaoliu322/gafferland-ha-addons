#!/usr/bin/env bash
# etag-relay 啟動腳本(0.5.0:登入/VNC/Chrome 全套拆除後,只剩純 Node 服務)。
# session 更新改由使用者電腦的 Chrome 擴充功能把 cookies POST 進既有的 /session
# 端點(見 server.js handleSession),不再需要 Xvfb/x11vnc 或任何虛擬螢幕/瀏覽器。
set -u
exec node server.js
