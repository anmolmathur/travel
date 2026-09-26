#!/usr/bin/env bash
# Runs on the server, piped over SSH by .github/workflows/deploy.yml. Safe to run repeatedly.
# It only ever creates, pulls or recreates the "wander" container; nothing else on the host is touched.
#
# Inputs (exported by the workflow; all optional):
#   GEMINI_API_KEY, AERODATABOX_API_KEY  written into .env when given
#   GHCR_TOKEN, GHCR_USER                used to log in to ghcr.io for the pull
#   WANDER_IMAGE                         image to run (default ghcr.io/anmolmathur/travel:latest)
#   WANDER_DIR                           install folder (default /opt/wander)
set -euo pipefail
{ # whole script in one block so bash has read all of it before anything runs

DIR=${WANDER_DIR:-/opt/wander}
IMAGE=${WANDER_IMAGE:-ghcr.io/anmolmathur/travel:latest}
say() { printf '\n==> %s\n' "$*"; }

if [ ! -d "$DIR" ]; then
  say "Creating $DIR"
  if mkdir -p "$DIR" 2>/dev/null; then :; else sudo -n mkdir -p "$DIR" && sudo -n chown "$(id -un)" "$DIR"; fi
fi
cd "$DIR"

if [ ! -f docker-compose.yml ]; then
  say "Writing docker-compose.yml"
  cat > docker-compose.yml <<YML
services:
  wander:
    image: ${IMAGE}
    container_name: wander
    restart: unless-stopped
    env_file: .env
    volumes:
      - wander-data:/data
    ports:
      - "127.0.0.1:3040:3000"
volumes:
  wander-data:
YML
fi

# .env: create secrets once, never overwrite them; refresh API keys when the workflow supplies them.
touch .env && chmod 600 .env
getenv() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
setenv() { { grep -vE "^$1=" .env || true; printf '%s=%s\n' "$1" "$2"; } > .env.tmp && mv .env.tmp .env && chmod 600 .env; }
rnd() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
NEW_PASSWORD=""
[ -n "$(getenv WANDER_PASSWORD)" ] || { setenv WANDER_PASSWORD "$(rnd 20)"; NEW_PASSWORD=1; }
[ -n "$(getenv WANDER_API_TOKEN)" ] || setenv WANDER_API_TOKEN "$(rnd 40)"
[ -n "$(getenv SESSION_SECRET)" ] || setenv SESSION_SECRET "$(rnd 48)"
[ -n "$(getenv GEMINI_MODEL)" ] || setenv GEMINI_MODEL gemini-2.5-flash
[ -n "$(getenv GEMINI_MODEL_SMART)" ] || setenv GEMINI_MODEL_SMART gemini-2.5-pro
[ -n "$(getenv COOKIE_SECURE)" ] || setenv COOKIE_SECURE true
[ -n "$(getenv PUBLIC_READ)" ] || setenv PUBLIC_READ false
[ -z "${GEMINI_API_KEY:-}" ] || setenv GEMINI_API_KEY "$GEMINI_API_KEY"
[ -z "${AERODATABOX_API_KEY:-}" ] || setenv AERODATABOX_API_KEY "$AERODATABOX_API_KEY"

if [ -n "${GHCR_TOKEN:-}" ]; then
  say "Logging in to ghcr.io"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-anmolmathur}" --password-stdin >/dev/null
fi

say "Pulling and starting wander"
docker compose pull wander
docker compose up -d wander

# Let a containerised cloudflared reach the app as http://wander:3000.
CF=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /cloudflared/ {print $1; exit}')
TUNNEL_URL="http://localhost:3040"
if [ -n "$CF" ]; then
  NETS=$(docker inspect "$CF" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
  for NET in $NETS; do
    if [ "$NET" = "host" ]; then continue; fi
    if docker inspect wander -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | grep -qw "$NET"; then :; else
      docker network connect "$NET" wander && echo "Joined network $NET (shared with $CF)"
    fi
    TUNNEL_URL="http://wander:3000"
  done
  echo "cloudflared container: $CF (networks: $NETS)"
else
  echo "No cloudflared container found; assuming cloudflared runs on the host."
fi

say "Waiting for the health check"
for i in $(seq 1 30); do
  if docker exec wander wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null | grep -q '"ok":true'; then OK=1; break; fi
  sleep 2
done
docker ps --filter name='^wander$' --format 'wander: {{.Status}}  {{.Ports}}'
if [ -z "${OK:-}" ]; then echo "Wander did not become healthy. Last logs:"; docker logs --tail 40 wander; exit 1; fi

say "Done"
echo "Cloudflare tunnel route for wander.anmolmathur.com should point to: $TUNNEL_URL"
echo "Gemini features: $([ -n "$(getenv GEMINI_API_KEY)" ] && echo on || echo 'off (no GEMINI_API_KEY)')"
[ -z "$NEW_PASSWORD" ] || echo "A login password was generated. Read it on the server with: grep WANDER_PASSWORD $DIR/.env"
exit 0
}
