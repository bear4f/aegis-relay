#!/bin/sh
set -eu
umask 077
INSTALL_DIR=/opt/aegis-relay-agent
REPO=bear4f/aegis-relay
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/data/identity.json" ] || { echo "未找到已注册的 AegisRelay Agent" >&2; exit 1; }
TMP_DIR=$(mktemp -d /tmp/aegis-agent-upgrade.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" -o "$TMP_DIR/source.tar.gz"
mkdir -p "$TMP_DIR/source"
tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR/source" --strip-components=1
cp "$TMP_DIR/source/Dockerfile.agent" "$TMP_DIR/source/compose.agent.yml" "$TMP_DIR/source/package.json" "$INSTALL_DIR/"
rm -rf "$INSTALL_DIR/src"; cp -a "$TMP_DIR/source/src" "$INSTALL_DIR/src"
install -m 0755 "$TMP_DIR/source/scripts/aegis-relay-agent" /usr/local/bin/aegis-relay-agent
install -m 0755 "$TMP_DIR/source/scripts/agent-configure-domain.sh" "$INSTALL_DIR/agent-configure-domain.sh"
install -m 0755 "$TMP_DIR/source/scripts/agent-configure-ip.sh" "$INSTALL_DIR/agent-configure-ip.sh"
set_env(){ KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"; awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"; chmod 600 "$TMP"; mv "$TMP" "$FILE"; }
SOURCE_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/source/package.json" | head -n1)
set_env AGENT_VERSION "$SOURCE_VERSION"
set_env AGENT_PROXY_PUBLISH_IP 127.0.0.1
install -m 0755 "$TMP_DIR/source/scripts/agent-host-domain-apply.sh" "$INSTALL_DIR/agent-host-domain-apply.sh"
# Existing machines predate the domain watcher, so install it here as well.
if command -v systemctl >/dev/null 2>&1 && [ -f "$INSTALL_DIR/agent-host-domain-apply.sh" ]; then
  cat > /etc/systemd/system/aegis-relay-agent-domain.service <<EOF
[Unit]
Description=AegisRelay agent constrained proxy domain switch
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh $INSTALL_DIR/agent-host-domain-apply.sh
EOF
  cat > /etc/systemd/system/aegis-relay-agent-domain.path <<EOF
[Unit]
Description=Watch AegisRelay agent proxy domain requests

[Path]
PathExists=$INSTALL_DIR/data/host-domain-request.json
Unit=aegis-relay-agent-domain.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now aegis-relay-agent-domain.path
fi
cd "$INSTALL_DIR"; docker build -f Dockerfile.agent -t aegis-relay-agent:local .
if docker compose version >/dev/null 2>&1; then docker compose -f compose.agent.yml up -d --force-recreate; else docker-compose -f compose.agent.yml up -d --force-recreate; fi
echo "Agent 已升级到 $SOURCE_VERSION，原注册身份、本地快照和流量统计已保留。"
DOMAIN=$(sed -n 's/^AGENT_DOMAIN=//p' "$INSTALL_DIR/.env" | head -n1)
EMAIL=$(sed -n 's/^AGENT_EMAIL=//p' "$INSTALL_DIR/.env" | head -n1)
MODE=$(sed -n 's/^AGENT_PROXY_MODE=//p' "$INSTALL_DIR/.env" | head -n1)
# Re-assert whichever入口 this machine already uses so Nginx stays consistent with the new build;
# both configure scripts are idempotent. env-persisted mode/domain means the入口 survives upgrades.
if [ "$MODE" = ip ]; then
  "$INSTALL_DIR/agent-configure-ip.sh" || true
elif [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  "$INSTALL_DIR/agent-configure-domain.sh" "$DOMAIN" "$EMAIL" || true
else
  echo "若尚未配置入口，请执行 HTTPS: sudo aegis-relay-agent domain 域名 邮箱，或 IP 反代: sudo aegis-relay-agent ip"
fi
