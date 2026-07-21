#!/bin/sh
set -eu
umask 077
INSTALL_DIR=/opt/aegis-relay-agent
REPO=bear4f/aegis-relay
PANEL= TOKEN= NAME= DOMAIN=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --panel) PANEL=${2:-}; shift 2;;
    --token) TOKEN=${2:-}; shift 2;;
    --name) NAME=${2:-}; shift 2;;
    --domain) DOMAIN=${2:-}; shift 2;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行安装命令" >&2; exit 1; }
case "$PANEL" in https://*) ;; *) echo "面板地址必须使用 HTTPS" >&2; exit 1;; esac
[ -n "$TOKEN" ] && [ -n "$NAME" ] || { echo "注册参数不完整" >&2; exit 1; }

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar
  command -v docker >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 2>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose
  fi
else
  echo "自动安装目前支持 Debian/Ubuntu。" >&2; exit 1
fi

TMP_DIR=$(mktemp -d /tmp/aegis-agent.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" -o "$TMP_DIR/source.tar.gz"
mkdir -p "$TMP_DIR/source" "$INSTALL_DIR/data"
tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR/source" --strip-components=1
cp "$TMP_DIR/source/Dockerfile.agent" "$TMP_DIR/source/compose.agent.yml" "$TMP_DIR/source/package.json" "$INSTALL_DIR/"
rm -rf "$INSTALL_DIR/src"; cp -a "$TMP_DIR/source/src" "$INSTALL_DIR/src"
chown -R 10001:10001 "$INSTALL_DIR/data"; chmod 700 "$INSTALL_DIR/data"
cd "$INSTALL_DIR"; docker build -f Dockerfile.agent -t aegis-relay-agent:local .

TOKEN_ENV="$TMP_DIR/enroll.env"
{
  printf 'PANEL_URL=%s\n' "$PANEL"
  printf 'ENROLLMENT_TOKEN=%s\n' "$TOKEN"
  printf 'AGENT_NAME=%s\n' "$NAME"
  printf 'AGENT_DOMAIN=%s\n' "$DOMAIN"
} > "$TOKEN_ENV"
docker run --rm --user 10001:10001 --env-file "$TOKEN_ENV" -v "$INSTALL_DIR/data:/app/agent-data" aegis-relay-agent:local node src/agent-main.js --enroll
rm -f "$TOKEN_ENV"; TOKEN=
{
  printf 'PANEL_URL=%s\n' "$PANEL"
  printf 'AGENT_DOMAIN=%s\n' "$DOMAIN"
  printf 'AGENT_VERSION=0.5.0\n'
} > .env
chmod 600 .env
if docker compose version >/dev/null 2>&1; then docker compose -f compose.agent.yml up -d; else docker-compose -f compose.agent.yml up -d; fi
install -m 0755 "$TMP_DIR/source/scripts/aegis-relay-agent" /usr/local/bin/aegis-relay-agent
echo "Agent 已注册并开始心跳。卸载命令: sudo aegis-relay-agent uninstall"
