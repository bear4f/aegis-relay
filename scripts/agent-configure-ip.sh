#!/bin/sh
# IP 反代模式：以本机公网 IP 作为入口，Nginx 监听 80 端口明文 HTTP 转发到本地 Agent，
# 不申请证书。适用于没有域名、直接用 http://IP/ 访问的场景。
set -eu
umask 077
INSTALL_DIR=/opt/aegis-relay-agent
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] || { echo "未找到 Agent 安装" >&2; exit 1; }

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx

PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
[ -n "$PUBLIC_IP" ] || { echo "无法检测公网 IP" >&2; exit 1; }

SITE=/etc/nginx/sites-available/aegis-relay-agent.conf
BACKUP=""
if [ -f "$SITE" ]; then BACKUP="$SITE.backup.$(date +%Y%m%d%H%M%S)"; cp "$SITE" "$BACKUP"; fi
# default_server 让本机以任意 Host（含裸 IP）响应；覆盖旧的 HTTPS 站点配置。
cat > "$SITE" <<EOF
map \$http_upgrade \$aegis_agent_connection_upgrade { default upgrade; '' close; }
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    access_log off;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$aegis_agent_connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
ln -sfn "$SITE" /etc/nginx/sites-enabled/aegis-relay-agent.conf
rm -f /etc/nginx/sites-enabled/default
if ! nginx -t; then
  [ -n "$BACKUP" ] && cp "$BACKUP" "$SITE"
  echo "Nginx 配置校验失败，已回滚。" >&2
  exit 1
fi
systemctl enable --now nginx
systemctl reload nginx

set_env(){ KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"; awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"; chmod 600 "$TMP"; mv "$TMP" "$FILE"; }
set_env AGENT_DOMAIN ""
set_env AGENT_PROXY_MODE ip
set_env AGENT_PROXY_IP "$PUBLIC_IP"
echo "Agent IP 反代已就绪: http://$PUBLIC_IP/"
