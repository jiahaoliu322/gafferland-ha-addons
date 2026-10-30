#!/usr/bin/env bash
# etag-relay 啟動腳本(0.5.0:登入/VNC/Chrome 全套拆除後,只剩純 Node 服務)。
set -u
exec node server.js
