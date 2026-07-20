#!/bin/sh
set -eu
umask 077
command -v docker >/dev/null 2>&1 || { echo "Docker is required" >&2; exit 1; }
[ -f .env ] || {
  key=$(openssl rand -base64 48 | tr -d '\n')
  setup=$(openssl rand -hex 32)
  admin_path="admin-$(openssl rand -hex 12)"
  sed -e "s|replace-with-at-least-32-random-bytes|$key|" -e "s|replace-with-an-independent-random-token|$setup|" -e "s|replace-with-a-random-admin-path|$admin_path|" .env.example > .env
  chmod 600 .env
  printf 'Setup token (shown once): %s\nAdmin URL path: /%s\n' "$setup" "$admin_path"
}
mkdir -p data && chmod 700 data
docker compose up -d --build
