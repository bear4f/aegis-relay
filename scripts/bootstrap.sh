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
  # Some minimal VPS images ship an AppArmor-enabled kernel without the apparmor_parser tool, which
  # makes `docker build`/`docker run` abort. Install it if missing and restart dockerd so it re-detects.
  if ! command -v apparmor_parser >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y apparmor || true
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet docker 2>/dev/null; then systemctl restart docker || true; fi
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
chown -R 10001:10001 data
chmod 700 data
if docker compose version >/dev/null 2>&1; then docker compose up -d --build; else docker-compose up -d --build; fi
install -m 0755 scripts/aegis-relay /usr/local/bin/aegis-relay
chmod 0755 scripts/configure-domain.sh scripts/configure-local-domain.sh scripts/host-domain-apply.sh scripts/domain-wizard.sh

# The panel container stays unprivileged. A narrowly scoped host service watches only for
# validated domain-switch requests and can run the fixed Nginx/Certbot workflow as root.
if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/aegis-relay-domain.service <<EOF
[Unit]
Description=AegisRelay constrained local proxy domain switch
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh $INSTALL_DIR/scripts/host-domain-apply.sh
EOF
  cat > /etc/systemd/system/aegis-relay-domain.path <<EOF
[Unit]
Description=Watch AegisRelay local proxy domain requests

[Path]
PathExists=$INSTALL_DIR/data/host-domain-request.json
Unit=aegis-relay-domain.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now aegis-relay-domain.path
fi

PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
ADMIN_SLUG=$(sed -n 's/^ADMIN_PATH=//p' .env | head -n1)
if [ "$FIRST_INSTALL" -eq 1 ]; then
  DOMAIN_DONE=0
  if (exec < /dev/tty > /dev/tty) 2>/dev/null; then
    echo
    echo "AegisRelay 已启动。现在可以直接配置域名并自动申请 HTTPS 证书，"
    echo "跳过临时开放 9080 端口的步骤（需要域名已解析到本机，放行 TCP 80/443）。"
    printf '是否现在配置域名？[Y/n] ' > /dev/tty
    IFS= read -r ANSWER < /dev/tty || ANSWER=n
    case "$ANSWER" in
      ''|[Yy]*)
        if sh scripts/domain-wizard.sh; then
          DOMAIN_DONE=1
        else
          echo "域名配置未完成，可稍后重试：sudo aegis-relay domain" >&2
        fi
        ;;
    esac
  fi
  echo
  if [ "$DOMAIN_DONE" -eq 1 ]; then
    PANEL_BASE=$(sed -n 's/^PUBLIC_BASE_URL=//p' .env | head -n1)
    PROXY_BASE=$(sed -n 's/^LOCAL_PROXY_BASE_URL=//p' .env | head -n1)
    echo "管理地址: $PANEL_BASE/"
    echo "Setup Token: $SETUP"
    echo "Emby 客户端入口: ${PROXY_BASE:-$PANEL_BASE}/<节点别名>/<访问密钥>/"
    echo
    echo "浏览器打开管理地址，用 Setup Token 完成管理员和 2FA 设置。"
    echo "无需在云防火墙开放 9080 端口。"
  else
    echo "AegisRelay 已启动（临时公网初始化模式）"
    echo "管理地址: http://$PUBLIC_IP:9080/$ADMIN_SLUG"
    echo "Setup Token: $SETUP"
    echo
    echo "在云防火墙临时放行 TCP 9080 后完成管理员和 2FA 设置，随后执行："
    echo "sudo aegis-relay domain"
    echo "按提示确认面板域名和 Emby 反代域名（默认同域），证书自动申请。"
  fi
else
  echo "AegisRelay 已更新并重新启动，现有密钥与数据保持不变。代理域名切换执行器已就绪。"
fi
