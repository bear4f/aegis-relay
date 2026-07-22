#!/bin/sh
# 域名与自动证书向导：步骤 1 确认面板域名，步骤 2 确认本机 Emby 反代域名
# （回车默认与面板同域），随后自动申请证书并完成 Nginx 切换。
set -eu
umask 077
INSTALL_DIR="/opt/aegis-relay"

[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] || { echo "未找到 AegisRelay 安装" >&2; exit 1; }

PANEL_DOMAIN=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
EMAIL=$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')
PROXY_DOMAIN=$(printf '%s' "${3:-}" | tr '[:upper:]' '[:lower:]')

valid_domain() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'; }
valid_email() { printf '%s' "$1" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$'; }

TTY_OK=0
if (exec < /dev/tty > /dev/tty) 2>/dev/null; then TTY_OK=1; fi
ask() {
  printf '%s' "$1" > /dev/tty
  IFS= read -r REPLY < /dev/tty || REPLY=''
}

INTERACTIVE=0
if [ -z "$PANEL_DOMAIN" ]; then
  [ "$TTY_OK" -eq 1 ] || { echo "用法: sudo aegis-relay domain [面板域名 证书邮箱 [Emby反代域名]]" >&2; exit 1; }
  INTERACTIVE=1
  while :; do
    ask "步骤 1/2 - 面板域名（已解析到本机，如 panel.example.com）: "
    PANEL_DOMAIN=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]')
    valid_domain "$PANEL_DOMAIN" && break
    echo "域名格式无效，请重新输入。" > /dev/tty
  done
fi
valid_domain "$PANEL_DOMAIN" || { echo "面板域名格式无效" >&2; exit 1; }

if [ -z "$EMAIL" ]; then
  [ "$TTY_OK" -eq 1 ] || { echo "缺少证书邮箱" >&2; exit 1; }
  INTERACTIVE=1
  SAVED_EMAIL=$(sed -n 's/^CERTIFICATE_EMAIL=//p' "$INSTALL_DIR/.env" | head -n1)
  while :; do
    if [ -n "$SAVED_EMAIL" ]; then
      ask "证书邮箱（Let's Encrypt 到期提醒）[回车使用 $SAVED_EMAIL]: "
    else
      ask "证书邮箱（Let's Encrypt 到期提醒）: "
    fi
    EMAIL=$(printf '%s' "${REPLY:-$SAVED_EMAIL}" | tr '[:upper:]' '[:lower:]')
    valid_email "$EMAIL" && break
    echo "邮箱格式无效，请重新输入。" > /dev/tty
  done
fi
valid_email "$EMAIL" || { echo "证书邮箱格式无效" >&2; exit 1; }

if [ -z "$PROXY_DOMAIN" ] && [ "$INTERACTIVE" -eq 1 ]; then
  while :; do
    ask "步骤 2/2 - 本机 Emby 反代域名 [回车默认同面板域名 $PANEL_DOMAIN]: "
    PROXY_DOMAIN=$(printf '%s' "${REPLY:-$PANEL_DOMAIN}" | tr '[:upper:]' '[:lower:]')
    valid_domain "$PROXY_DOMAIN" && break
    echo "域名格式无效，请重新输入。" > /dev/tty
  done
fi
[ -n "$PROXY_DOMAIN" ] || PROXY_DOMAIN="$PANEL_DOMAIN"
valid_domain "$PROXY_DOMAIN" || { echo "Emby 反代域名格式无效" >&2; exit 1; }

if [ "$INTERACTIVE" -eq 1 ]; then
  {
    echo "即将执行："
    echo "  面板域名:      https://$PANEL_DOMAIN"
    if [ "$PROXY_DOMAIN" = "$PANEL_DOMAIN" ]; then
      echo "  Emby 反代域名: https://$PROXY_DOMAIN （同面板域名，单证书）"
    else
      echo "  Emby 反代域名: https://$PROXY_DOMAIN （独立域名，自动申请第二张证书）"
    fi
    echo "  证书邮箱:      $EMAIL"
  } > /dev/tty
  ask "确认无误，开始自动申请证书并切换 Nginx？[Y/n] "
  case "$REPLY" in ''|[Yy]*) ;; *) echo "已取消，未做任何修改。" > /dev/tty; exit 1;; esac
fi

"$INSTALL_DIR/scripts/configure-domain.sh" "$PANEL_DOMAIN" "$EMAIL"
if [ "$PROXY_DOMAIN" != "$PANEL_DOMAIN" ]; then
  "$INSTALL_DIR/scripts/configure-local-domain.sh" "$PROXY_DOMAIN" "$EMAIL"
fi
