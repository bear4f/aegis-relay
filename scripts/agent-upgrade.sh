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
set_env(){ KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"; awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"; chmod 600 "$TMP"; mv "$TMP" "$FILE"; }
set_env AGENT_VERSION 0.8.0
set_env AGENT_PROXY_PUBLISH_IP 127.0.0.1
cd "$INSTALL_DIR"; docker build -f Dockerfile.agent -t aegis-relay-agent:local .
if docker compose version >/dev/null 2>&1; then docker compose -f compose.agent.yml up -d --force-recreate; else docker-compose -f compose.agent.yml up -d --force-recreate; fi
echo "Agent 已升级到 0.8.0，原注册身份、本地快照和流量统计已保留。"
DOMAIN=$(sed -n 's/^AGENT_DOMAIN=//p' "$INSTALL_DIR/.env" | head -n1)
EMAIL=$(sed -n 's/^AGENT_EMAIL=//p' "$INSTALL_DIR/.env" | head -n1)
if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then "$INSTALL_DIR/agent-configure-domain.sh" "$DOMAIN" "$EMAIL" || true; else echo "若尚未配置 HTTPS，请执行: sudo aegis-relay-agent domain $DOMAIN 你的邮箱"; fi
