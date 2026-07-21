#!/bin/sh
set -eu
umask 077
INSTALL_DIR="/opt/aegis-relay"
DOMAIN=$1
EMAIL=$2

[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "域名格式无效" >&2; exit 1; }
printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "邮箱格式无效" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] || { echo "未找到 AegisRelay 安装" >&2; exit 1; }

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
ADMIN_PATH=$(sed -n 's/^ADMIN_PATH=//p' "$INSTALL_DIR/.env" | head -n1)
[ -n "$ADMIN_PATH" ] || { echo "ADMIN_PATH 缺失" >&2; exit 1; }

PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
if [ -n "$PUBLIC_IP" ] && [ -n "$DNS_IP" ] && [ "$PUBLIC_IP" != "$DNS_IP" ]; then
  echo "警告：$DOMAIN 当前解析到 $DNS_IP，本机公网 IP 为 $PUBLIC_IP。"
  echo "请确认 DNS 已生效，否则证书申请会失败。"
fi

SITE="/etc/nginx/sites-available/aegis-relay.conf"
BACKUP=""
if [ -f "$SITE" ]; then BACKUP="$SITE.backup.$(date +%Y%m%d%H%M%S)"; cp "$SITE" "$BACKUP"; fi
cat > "$SITE" <<EOF
map \$http_upgrade \$aegis_connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    access_log off;
    client_max_body_size 0;

    location = /$ADMIN_PATH { return 301 /$ADMIN_PATH/; }
    location ^~ /$ADMIN_PATH/ {
        proxy_pass http://127.0.0.1:9080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$aegis_connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
ln -sfn "$SITE" /etc/nginx/sites-enabled/aegis-relay.conf
if ! nginx -t; then
  [ -n "$BACKUP" ] && cp "$BACKUP" "$SITE"
  echo "Nginx 配置校验失败，已回滚。" >&2
  exit 1
fi
systemctl enable --now nginx
systemctl reload nginx

if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"; then
  echo "证书申请失败。9080 临时公网入口保持不变，请修复 DNS/防火墙后重试。" >&2
  exit 1
fi
systemctl enable --now certbot.timer 2>/dev/null || true

set_env() {
  KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"
  awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"
  chmod 600 "$TMP"; mv "$TMP" "$FILE"
}
set_env SECURE_COOKIES true
set_env ADMIN_PUBLISH_IP 127.0.0.1
set_env PROXY_PUBLISH_IP 127.0.0.1
set_env PUBLIC_BASE_URL "https://$DOMAIN"
set_env CERTIFICATE_EMAIL "$EMAIL"
cd "$INSTALL_DIR"
if docker compose version >/dev/null 2>&1; then docker compose up -d --force-recreate; else docker-compose up -d --force-recreate; fi
nginx -t && systemctl reload nginx

echo
echo "HTTPS 收口完成："
echo "管理面板: https://$DOMAIN/"
echo "代理入口: https://$DOMAIN/<节点别名>/<访问密钥>/"
echo "公开节点页（可选）: https://$DOMAIN/gateway/"
echo "9080 已仅绑定 127.0.0.1；旧随机管理路径仍兼容，证书续期由 certbot.timer 管理。"
