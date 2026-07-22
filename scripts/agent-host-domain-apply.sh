#!/bin/sh
set -eu
umask 077
INSTALL_DIR="/opt/aegis-relay-agent"
DATA_DIR="$INSTALL_DIR/data"
REQUEST="$DATA_DIR/host-domain-request.json"
STATUS="$DATA_DIR/host-domain-status.json"

[ "$(id -u)" -eq 0 ] || exit 1
[ -f "$REQUEST" ] || exit 0

# The request comes from an unprivileged container, so every field is re-validated here before it
# reaches Nginx or certbot. Anything unexpected drops the request instead of running the workflow.
read_field() {
  python3 -c 'import json,sys; value=json.load(open(sys.argv[1],encoding="utf-8")).get(sys.argv[2],""); print(value if isinstance(value,str) else "")' "$REQUEST" "$1"
}
REQUEST_ID=$(read_field requestId 2>/dev/null || true)
MODE=$(read_field mode 2>/dev/null || true)
[ -n "$MODE" ] || MODE=domain
DOMAIN=$(read_field desiredDomain | tr '[:upper:]' '[:lower:]')
EMAIL=$(read_field certificateEmail | tr '[:upper:]' '[:lower:]')
printf '%s' "$REQUEST_ID" | grep -Eq '^[A-Za-z0-9_-]{8,80}$' || { rm -f "$REQUEST"; exit 1; }
case "$MODE" in
  domain)
    printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { rm -f "$REQUEST"; exit 1; }
    printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { rm -f "$REQUEST"; exit 1; }
    ;;
  ip) DOMAIN="" ;;
  *) rm -f "$REQUEST"; exit 1 ;;
esac

write_status() {
  STATE=$1 MESSAGE=$2 CURRENT=${3:-}
  python3 - "$STATUS" "$REQUEST_ID" "$STATE" "$MODE" "$DOMAIN" "$CURRENT" "$MESSAGE" <<'PY'
import json,sys,datetime,os,tempfile
file,request_id,state,mode,desired,current,message=sys.argv[1:]
value={"requestId":request_id,"state":state,"mode":mode,"desiredDomain":desired,"currentDomain":current,"message":message[:500],"updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
descriptor,temp=tempfile.mkstemp(prefix='.host-domain-status.',dir=os.path.dirname(file))
try:
  with os.fdopen(descriptor,'w',encoding='utf-8') as stream: json.dump(value,stream,separators=(',',':')); stream.write('\n')
  os.chmod(temp,0o644); os.replace(temp,file)
finally:
  if os.path.exists(temp): os.unlink(temp)
PY
}

set_env() {
  KEY=$1 VALUE=$2 FILE="$INSTALL_DIR/.env" TMP="$INSTALL_DIR/.env.tmp"
  awk -v key="$KEY" -v value="$VALUE" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$FILE" > "$TMP"
  chmod 600 "$TMP"; mv "$TMP" "$FILE"
}

CURRENT=$(sed -n 's/^AGENT_DOMAIN=//p' "$INSTALL_DIR/.env" | head -n1)
[ -n "$CURRENT" ] || CURRENT=$(sed -n 's/^AGENT_PROXY_IP=//p' "$INSTALL_DIR/.env" | head -n1)
LOG=$(mktemp /tmp/aegis-agent-domain.XXXXXX)

if [ "$MODE" = ip ]; then
  write_status applying "正在切换为 IP 反代（HTTP）" "$CURRENT"
  if "$INSTALL_DIR/agent-configure-ip.sh" >"$LOG" 2>&1; then
    NEW_IP=$(sed -n 's/^AGENT_PROXY_IP=//p' "$INSTALL_DIR/.env" | head -n1)
    write_status active "已切换为 IP 反代（HTTP）" "$NEW_IP"
    rm -f "$REQUEST" "$LOG"
    exit 0
  fi
  ERROR=$(tail -n 8 "$LOG" | tr '\n' ' ' | cut -c1-480)
  write_status failed "${ERROR:-IP 反代切换失败，请检查 80 端口与 Nginx}" "$CURRENT"
  rm -f "$REQUEST" "$LOG"
  exit 1
fi

write_status applying "正在申请证书并切换 Nginx" "$CURRENT"
if "$INSTALL_DIR/agent-configure-domain.sh" "$DOMAIN" "$EMAIL" >"$LOG" 2>&1; then
  # Persist the new domain so a restarted agent keeps reporting the value that is actually serving,
  # and drop the IP-mode marker so the env fallback agrees with the active status.
  set_env AGENT_DOMAIN "$DOMAIN"
  set_env AGENT_PROXY_MODE domain
  write_status active "域名已切换，证书自动续期已启用" "$DOMAIN"
  rm -f "$REQUEST" "$LOG"
  exit 0
fi
ERROR=$(tail -n 8 "$LOG" | tr '\n' ' ' | cut -c1-480)
write_status failed "${ERROR:-域名切换失败，请检查 DNS、Cloudflare 与 80/443 端口}" "$CURRENT"
rm -f "$REQUEST" "$LOG"
exit 1
