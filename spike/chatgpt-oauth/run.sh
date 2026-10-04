#!/bin/sh
# up:   start a cloudflared quick tunnel to the public listener only, then the harness.
# down: stop both. status: show pids and the public base URL.
# State (events.jsonl, spike passkey credentials, pids) lives in ./.state (gitignored).
set -eu
cd "$(dirname "$0")"
S=${STATE_DIR:-.state}; export STATE_DIR="$S"; mkdir -p "$S"; chmod 700 "$S"
PUBLIC_PORT=${PUBLIC_PORT:-7534}
case "${1:-}" in
up)
  [ -f "$S/tunnel.pid" ] && kill -0 "$(cat $S/tunnel.pid)" 2>/dev/null && { echo "already up: $(cat $S/base)"; exit 0; }
  : > "$S/cloudflared.log"
  nohup cloudflared tunnel --no-autoupdate --config /dev/null --url "http://127.0.0.1:$PUBLIC_PORT" > "$S/cloudflared.log" 2>&1 &
  echo $! > "$S/tunnel.pid"
  i=0; until grep -qo 'https://[a-z0-9-]*\.trycloudflare\.com' "$S/cloudflared.log"; do i=$((i+1)); [ $i -gt 60 ] && { echo "tunnel URL not found"; exit 1; }; sleep 0.5; done
  grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$S/cloudflared.log" | head -1 > "$S/base"
  PUBLIC_BASE=$(cat "$S/base") PUBLIC_PORT=$PUBLIC_PORT nohup node harness.mjs > "$S/harness.log" 2>&1 &
  echo $! > "$S/harness.pid"
  sleep 1; echo "public: $(cat $S/base)/mcp"; echo "local:  http://localhost:${LOCAL_PORT:-7533}/";;
down)
  for p in harness tunnel; do [ -f "$S/$p.pid" ] && kill "$(cat $S/$p.pid)" 2>/dev/null || true; rm -f "$S/$p.pid"; done; echo down;;
status)
  for p in harness tunnel; do printf '%s: ' $p; [ -f "$S/$p.pid" ] && kill -0 "$(cat $S/$p.pid)" 2>/dev/null && echo "up ($(cat $S/$p.pid))" || echo down; done
  [ -f "$S/base" ] && echo "base: $(cat $S/base)";;
*) echo "usage: $0 up|down|status"; exit 2;;
esac
