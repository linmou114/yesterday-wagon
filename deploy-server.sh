!/usr/bin/env bash
# =========================================================
# 昨日圆车 —— 服务器一键部署脚本（阿里云 / 任意 Linux + systemd）
#
#   用法（在项目目录里执行）：
#     bash deploy-server.sh              # 默认端口 3000
#     PORT=8080 bash deploy-server.sh    # 换端口
#
#   做的事：
#     1. 没有 Node 就从国内镜像装一个（免去翻墙）
#     2. 用淘宝镜像源装依赖
#     3. 注册成 systemd 服务（开机自启 + 崩溃自动重启）
#     4. 放行防火墙端口
#     5. 打印访问地址
# =========================================================
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="yesterday-wagon"
PORT="${PORT:-3000}"
NODE_VERSION="v20.18.0"
NODE_DIR="/usr/local/node-$NODE_VERSION"

green() { echo -e "\033[32m$1\033[0m"; }
yellow() { echo -e "\033[33m$1\033[0m"; }
red() { echo -e "\033[31m$1\033[0m"; }

SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    red "请用 root 运行，或先装 sudo"
    exit 1
  fi
fi

echo "============================================================"
echo "  昨日圆车 · 服务器部署"
echo "  目录: $APP_DIR"
echo "  端口: $PORT"
echo "============================================================"

# ---------- 1. Node ----------
if command -v node >/dev/null 2>&1; then
  green "已安装 Node: $(node -v)"
else
  yellow "没检测到 Node，从 npmmirror 国内镜像下载 $NODE_VERSION（约 25MB）"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) red "不支持的架构: $ARCH"; exit 1 ;;
  esac
  PKG="node-$NODE_VERSION-linux-$NODE_ARCH"
  URL="https://registry.npmmirror.com/-/binary/node/$NODE_VERSION/$PKG.tar.gz"
  TMP="$(mktemp -d)"
  echo "  下载: $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$TMP/node.tar.gz" "$URL"
  else
    wget -O "$TMP/node.tar.gz" "$URL"
  fi
  $SUDO mkdir -p "$NODE_DIR"
  $SUDO tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
  for BIN in node npm npx; do
    $SUDO ln -sf "$NODE_DIR/bin/$BIN" "/usr/local/bin/$BIN"
  done
  green "安装完成: $(node -v)"
fi

NODE_BIN="$(command -v node)"
echo "  Node 路径: $NODE_BIN"

# ---------- 2. 依赖 ----------
echo ""
yellow "[2/5] 安装依赖（淘宝镜像源）"
cd "$APP_DIR"
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
green "依赖装好了"

# ---------- 3. systemd ----------
echo ""
yellow "[3/5] 注册为系统服务（开机自启 / 崩溃自动重启）"
UNIT="/etc/systemd/system/$SERVICE.service"
$SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Yesterday Wagon (Hex strategy game)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/server/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE" >/dev/null 2>&1 || true
$SUDO systemctl restart "$SERVICE"
sleep 2
if $SUDO systemctl is-active --quiet "$SERVICE"; then
  green "服务已启动"
else
  red "服务没起来，看看日志：journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi

# ---------- 4. 防火墙 ----------
echo ""
yellow "[4/5] 放行防火墙端口 $PORT"
if command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null
  $SUDO firewall-cmd --reload >/dev/null
  green "firewalld 已放行"
elif command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  green "ufw 已放行"
else
  yellow "没检测到 firewalld/ufw（可能本来就没开）"
fi

# ---------- 5. 结果 ----------
echo ""
yellow "[5/5] 自检"
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  green "本地健康检查通过"
else
  red "本地健康检查失败：curl http://127.0.0.1:$PORT/health"
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '你的公网IP')"
echo ""
echo "============================================================"
green "  部署完成"
echo ""
echo "  访问地址： http://$IP:$PORT"
echo "  健康检查： http://$IP:$PORT/health"
echo ""
echo "  常用命令："
echo "    systemctl status $SERVICE      # 看状态"
echo "    journalctl -u $SERVICE -f      # 实时日志"
echo "    systemctl restart $SERVICE     # 重启"
echo ""
echo "  ⚠ 还差一步：在阿里云控制台放行 TCP $PORT"
echo "     轻量应用服务器 -> 防火墙 -> 添加规则"
echo "     ECS -> 安全组 -> 入方向 -> 添加 TCP $PORT"
echo "============================================================"
