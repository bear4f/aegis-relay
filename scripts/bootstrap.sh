#!/bin/sh
set -eu
umask 077

REPO="bear4f/aegis-relay"
BRANCH="main"
INSTALL_DIR="/opt/aegis-relay"

[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行安装命令" >&2; exit 1; }

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl tar
  if ! command -v docker >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
  fi
  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 2>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose
  fi
else
  echo "自动安装目前支持 Debian/Ubuntu；其他系统请参照 README 手动部署。" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d /tmp/aegis-relay.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" -o "$TMP_DIR/source.tar.gz"
mkdir -p "$TMP_DIR/source" "$INSTALL_DIR"
tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR/source" --strip-components=1
cp -a "$TMP_DIR/source/." "$INSTALL_DIR/"
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
  APP_KEY=$(openssl rand -base64 48 | tr -d '\n')
  SETUP=$(openssl rand -hex 32)
  ADMIN_SLUG="admin-$(openssl rand -hex 12)"
  sed -e "s|replace-with-at-least-32-random-bytes|$APP_KEY|" -e "s|replace-with-an-independent-random-token|$SETUP|" -e "s|replace-with-a-random-admin-path|$ADMIN_SLUG|" .env.example > .env
  chmod 600 .env
  FIRST_INSTALL=1
else
  FIRST_INSTALL=0
fi

mkdir -p data
chmod 700 data
if docker compose version >/dev/null 2>&1; then docker compose up -d --build; else docker-compose up -d --build; fi
install -m 0755 scripts/aegis-relay /usr/local/bin/aegis-relay

PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
ADMIN_SLUG=$(sed -n 's/^ADMIN_PATH=//p' .env | head -n1)
if [ "$FIRST_INSTALL" -eq 1 ]; then
  echo
  echo "AegisRelay 已启动（临时公网初始化模式）"
  echo "管理地址: http://$PUBLIC_IP:9080/$ADMIN_SLUG"
  echo "Setup Token: $SETUP"
  echo
  echo "完成管理员和 2FA 设置后，执行："
  echo "sudo aegis-relay domain 你的域名 你的邮箱"
else
  echo "AegisRelay 已更新并重新启动，现有密钥与数据保持不变。"
fi
