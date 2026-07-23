#!/bin/sh
set -eu
umask 077
INSTALL_DIR="/opt/aegis-relay"
PROXY_DOMAIN=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
EMAIL=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
printf '%s' "$PROXY_DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { echo "代理域名格式无效" >&2; exit 1; }
printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "证书邮箱格式无效" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] || { echo "未找到 AegisRelay 安装" >&2; exit 1; }
PUBLIC_BASE_URL=$(sed -n 's/^PUBLIC_BASE_URL=//p' "$INSTALL_DIR/.env" | head -n1)
PANEL_DOMAIN=$(printf '%s' "$PUBLIC_BASE_URL" | sed -n 's#^https://\([^/:]*\)/\?$#\1#p' | tr '[:upper:]' '[:lower:]')
ADMIN_PATH=$(sed -n 's/^ADMIN_PATH=//p' "$INSTALL_DIR/.env" | head -n1 | sed 's#^/##;s#/$##')
[ -n "$PANEL_DOMAIN" ] || { echo "请先执行 aegis-relay domain 配置 HTTPS 面板域名" >&2; exit 1; }
printf '%s' "$PANEL_DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { echo "PUBLIC_BASE_URL 中的面板域名无效" >&2; exit 1; }
[ -n "$ADMIN_PATH" ] || { echo "ADMIN_PATH 缺失" >&2; exit 1; }
[ "$PANEL_DOMAIN" != "$PROXY_DOMAIN" ] || { echo "面板域名与代理域名必须不同" >&2; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
DNS_IP=$(getent ahostsv4 "$PROXY_DOMAIN" | awk 'NR==1{print $1}')
if [ -n "$PUBLIC_IP" ] && [ -n "$DNS_IP" ] && [ "$PUBLIC_IP" != "$DNS_IP" ]; then
  echo "提示：$PROXY_DOMAIN 可能启用了 CDN/Cloudflare 代理；将继续使用 HTTP-01 验证。"
fi
SITE="/etc/nginx/sites-available/aegis-relay.conf"
BACKUP=""
if [ -f "$SITE" ]; then BACKUP="$SITE.backup.$(date +%Y%m%d%H%M%S)"; cp "$SITE" "$BACKUP"; fi
restore_site() { if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then cp "$BACKUP" "$SITE"; nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; fi; }
trap 'restore_site' HUP INT TERM
cat > "$SITE" <<EOF
map \$http_upgrade \$aegis_connection_upgrade { default upgrade; '' ''; }
upstream aegis_relay_backend {
    server 127.0.0.1:8080;
    keepalive 64;
}
upstream aegis_admin_backend {
    server 127.0.0.1:9080;
    keepalive 16;
}

# 控制面：只允许面板、Agent 注册/同步和安装脚本，不承载 Emby 节点。
server {
    listen 80;
    listen [::]:80;
    server_name $PANEL_DOMAIN;
    access_log off;
    client_max_body_size 1m;
    if (\$host != $PANEL_DOMAIN) { return 421; }
    location = /$ADMIN_PATH { return 301 /$ADMIN_PATH/; }
    location ^~ /$ADMIN_PATH/ {
        proxy_pass http://aegis_admin_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        proxy_buffer_size 64k;
    }
    location / {
        proxy_pass http://aegis_relay_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        proxy_buffer_size 64k;
    }
}

# 本地数据面：只承载 Emby 网关与播放流量。
server {
    listen 80;
    listen [::]:80;
    server_name $PROXY_DOMAIN;
    access_log off;
    client_max_body_size 0;
    if (\$host != $PROXY_DOMAIN) { return 421; }
    location / {
        proxy_pass http://aegis_relay_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$aegis_connection_upgrade;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_buffer_size 256k;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
ln -sfn "$SITE" /etc/nginx/sites-enabled/aegis-relay.conf
rm -f /etc/nginx/sites-enabled/default
if ! nginx -t; then restore_site; echo "Nginx 双域名配置校验失败，已回滚。" >&2; exit 1; fi
systemctl enable --now nginx
systemctl reload nginx
if ! certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"; then restore_site; echo "面板域名证书配置失败，已恢复旧配置。" >&2; exit 1; fi
if ! certbot --nginx -d "$PROXY_DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"; then restore_site; echo "代理域名证书申请失败，已恢复旧配置。请检查 DNS、Cloudflare 和 80/443 端口。" >&2; exit 1; fi
systemctl enable --now certbot.timer 2>/dev/null || true
set_env() {
  KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"
  awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"
  chmod 600 "$TMP"; mv "$TMP" "$FILE"
}
set_env LOCAL_PROXY_BASE_URL "https://$PROXY_DOMAIN"
set_env CERTIFICATE_EMAIL "$EMAIL"
cd "$INSTALL_DIR"
if docker compose version >/dev/null 2>&1; then docker compose up -d --force-recreate; else docker-compose up -d --force-recreate; fi
nginx -t && systemctl reload nginx
trap - HUP INT TERM
echo "代理域名已切换为 https://$PROXY_DOMAIN/；面板仍为 https://$PANEL_DOMAIN/。"
echo "旧代理域名已从 Nginx 路由移除，不再承载 Emby 流量。"
