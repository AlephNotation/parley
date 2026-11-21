#!/bin/sh
# Deploys Parley to a Vers computer and restarts the server there.
#
# First time:
#   vers run -d --name parley oven/bun:1.3.14 -- /bin/sh -c "$(cat scripts/vers-supervisor.sh)"
#   scripts/deploy-vers.sh <computer-id> --init
# Afterwards:
#   scripts/deploy-vers.sh <computer-id>
#
# The computer keeps its SQLite database in /data and its settings in /app/.env, so a
# redeploy replaces only the code. --init writes /app/.env with a fresh admin token and
# saves a copy in .deploy/vers.env (git-ignored).
set -eu

id="${1:?usage: scripts/deploy-vers.sh <computer-id> [--init] [--skip-client]}"
shift
init=0
client=1
for arg in "$@"; do
  case "$arg" in
    --init) init=1 ;;
    --skip-client) client=0 ;;
    *) echo "unknown option $arg" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
port="${PARLEY_PORT:-8787}"
url="https://$id.vm.vers.sh:$port"
run() { vers exec "$id" --timeout "${2:-120}" -- /bin/sh -c "$1"; }

api="${VERS_ORCHESTRATOR_URL:-https://api.vers.sh}"
key="${VERS_API_KEY:-$(sed -n 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME/.versrc" 2>/dev/null)}"
[ -n "$key" ] || { echo "no Vers API key: set VERS_API_KEY or log in so ~/.versrc exists" >&2; exit 1; }

# Copies stdin to a file on the computer through the v2 files route. `vers write` (CLI 0.2.0)
# calls the v1 route, which returns 404 for computers started with `vers run`.
# The mode is decimal: 420 is 0644, 384 is 0600.
put() {
  dest="$1"
  mode="${2:-420}"
  body=$(mktemp)
  { printf '{"path":"%s","create_dirs":true,"mode":%s,"content_b64":"' "$dest" "$mode"; base64 | tr -d '\n'; printf '"}'; } > "$body"
  curl -fsS --max-time 120 -X PUT -H "Authorization: Bearer $key" -H 'content-type: application/json' \
    --data-binary "@$body" "$api/api/v2/computers/$id/files" || { rm -f "$body"; echo "upload of $dest failed" >&2; exit 1; }
  rm -f "$body"
}

if [ "$init" = 1 ]; then
  token=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  mkdir -p .deploy
  umask 077
  printf 'PARLEY_URL=%s\nPARLEY_ADMIN_TOKEN=%s\nPARLEY_COMPUTER=%s\n' "$url" "$token" "$id" > .deploy/vers.env
  printf 'PORT=%s\nPARLEY_DB=/data/parley.db\nPARLEY_PUBLIC_URL=%s\nPARLEY_ADMIN_TOKEN=%s\n' "$port" "$url" "$token" \
    | put /app/.env 384
  echo "wrote /app/.env on the computer and .deploy/vers.env locally"
fi

echo "uploading source"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - package.json bun.lock tsconfig.json src client scripts | put /app/release.tgz
run 'cd /app && tar xzf release.tgz && rm release.tgz && ls'

if [ "$client" = 1 ]; then
  # The computer has Bun but no Rust toolchain, so it builds the Bun client for its own /install.sh.
  # Servers that install the native client from the GitHub release do not need this step.
  echo "building client binaries on the computer"
  run 'cd /app && bun scripts/build-client.ts --bun 2>&1 | grep -E "built|rror"' 290
fi

echo "restarting the server"
run 'if [ -f /data/server.pid ]; then kill "$(cat /data/server.pid)" 2>/dev/null || true; fi'
sleep 4
# Checked from inside the computer first, so a fault in the public route is not mistaken for a failed deploy.
run "bun -e 'const r = await fetch(\"http://[::1]:$port/healthz\"); if (!r.ok) process.exit(1)'" 30 \
  || { echo "the server did not come up; see: GET $api/api/v2/computers/$id/workload/logs" >&2; exit 1; }
echo "server is up on the computer"
curl -fsS --max-time 15 "$url/healthz" >/dev/null && echo "$url is reachable" \
  || echo "warning: $url did not answer from here (public route problem, not the deploy)" >&2
