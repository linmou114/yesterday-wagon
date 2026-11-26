#!/usr/bin/env bash
# =========================================================
# switch-port.sh —— 把 yesterday-wagon 服务切到 80 端口
#
#   用法（服务器上，root）：
#     bash switch-port.sh          # 切到 80
#     bash switch-port.sh 8080     # 切到别的端口
#     bash switch-port.sh 3000     # 切回 3000
#
#   原理：不动物业 unit 文件，只写一个 drop-in 覆盖 Environment=PORT，
#   然后 daemon-reload + restart，最后用 /health 自检。
#   防火墙（阿里云控制台 → 轻量服务器 → 防火墙）要放行对应端口。
# =========================================================
set -euo pipefail

PORT="${1:-80}"
SERVICE="${SERVICE:-yesterday-wagon}"
DROPIN_DIR="/etc/systemd/system/${SERVICE}.service.d"
DROPIN="${DROPIN_DIR}/port.conf"
APP_DIR="${APP_DIR:-/root/yesterday-wagon}"

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 跑：sudo bash $0 ${PORT}"
  exit 1
fi

if ! systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  echo "找不到服务 ${SERVICE}，先确认 systemd unit 名字（systemctl list-units | grep yesterday）"
  exit 1
fi

if ss -ltnp 2>/dev/null | grep -q ":${PORT} " && ! ss -ltnp | grep ":${PORT} " | grep -q "${SERVICE}\|node"; then
  echo "端口 ${PORT} 已被别的程序占用，先腾出来："
  ss -ltnp | grep ":${PORT} "
  exit 1
fi

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN" <<EOF
[Service]
Environment=PORT=${PORT}
EOF

echo "已写入 ${DROPIN}（PORT=${PORT}）"
systemctl daemon-reload
systemctl restart "${SERVICE}"
sleep 2

if curl -s --max-time 4 "http://127.0.0.1:${PORT}/health" | grep -q "ok"; then
  echo "✅ 服务已在 ${PORT} 端口响应：http://127.0.0.1:${PORT}/health"
else
  echo "❌ ${PORT} 端口没响应，看日志："
  journalctl -u "${SERVICE}" -n 30 --no-pager
  exit 1
fi

echo
echo "接下来："
echo "  1) 阿里云控制台 → 轻量应用服务器 → 防火墙 → 放行 TCP ${PORT}"
echo "  2) 浏览器打开 http://yesterday-wagon.xyz  （不要带端口）"
echo "  3) 页脚应能看到「豫ICP备2026059478号-1」并可点开 beian.miit.gov.cn"
echo
echo "回滚：bash $0 3000"
