#!/bin/sh
set -eu
umask 077
INSTALL_DIR=/opt/aegis-relay-agent
DOMAIN=$1
EMAIL=$2
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "域名格式无效" >&2; exit 1; }
printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "邮箱格式无效" >&2; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
SITE=/etc/nginx/sites-available/aegis-relay-agent.conf
cat > "$SITE" <<EOF
map \$http_upgrade \$aegis_agent_connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    access_log off;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$aegis_agent_connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
ln -sfn "$SITE" /etc/nginx/sites-enabled/aegis-relay-agent.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"
systemctl enable --now certbot.timer 2>/dev/null || true
set_env(){ KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"; awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"; chmod 600 "$TMP"; mv "$TMP" "$FILE"; }
set_env AGENT_DOMAIN "$DOMAIN"
set_env AGENT_EMAIL "$EMAIL"
echo "Agent HTTPS 已就绪: https://$DOMAIN/"
