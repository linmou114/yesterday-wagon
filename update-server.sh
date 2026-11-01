#!/usr/bin/env bash
# =========================================================
# 昨日圆车 —— 安全更新脚本
#
#   和 deploy-server.sh 的区别：只覆盖代码，不动 node_modules，
#   不会出现「删了目录依赖没了、服务起不来」的问题。
#
#   用法：
#     bash update-server.sh                       # 默认读 /root/yesterday-wagon-server.zip
#     bash update-server.sh /root/新包.zip        # 指定包
# =========================================================
set -e

APP_DIR="${2:-/root/yesterday-wagon}"
ZIP="${1:-/root/yesterday-wagon-server.zip}"
SERVICE="yesterday-wagon"

green() { echo -e "\033[32m$1\033[0m"; }
yellow() { echo -e "\033[33m$1\033[0m"; }
red() { echo -e "\033[31m$1\033[0m"; }

SUDO=""
[ "$(id -u)" != "0" ] && SUDO="sudo"

if [ ! -f "$ZIP" ]; then
  red "找不到压缩包：$ZIP"
  echo "先上传，或指定路径：bash update-server.sh /root/xxx.zip"
  exit 1
fi
if [ ! -d "$APP_DIR" ]; then
  red "找不到项目目录：$APP_DIR（首次部署请用 deploy-server.sh）"
  exit 1
fi

yellow "[1/4] 解包到临时目录"
TMP="$(mktemp -d)"
python3 -m zipfile -e "$ZIP" "$TMP" 2>/dev/null || unzip -oq "$ZIP" -d "$TMP"
if [ ! -d "$TMP/yesterday-wagon" ]; then
  red "压缩包里没有 yesterday-wagon/ 目录，包可能是坏的"
  rm -rf "$TMP"
  exit 1
fi

yellow "[2/4] 覆盖代码（保留 node_modules）"
cp -a "$TMP/yesterday-wagon/." "$APP_DIR/"
rm -rf "$TMP"
green "已覆盖"

yellow "[3/4] 补齐依赖（没变化时几秒就过）"
cd "$APP_DIR"
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund

yellow "[4/4] 重启服务"
$SUDO systemctl restart "$SERVICE"
sleep 2
if $SUDO systemctl is-active --quiet "$SERVICE"; then
  green "服务已重启"
else
  red "服务没起来，看日志：journalctl -u $SERVICE -n 40 --no-pager"
  exit 1
fi

curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1 && green "健康检查通过" || yellow "健康检查没通，先看日志"

echo ""
echo "============================================================"
green "  更新完成"
echo "  浏览器 Ctrl+F5 强制刷新即可看到新版"
echo "  日志：journalctl -u $SERVICE -f"
echo "============================================================"
