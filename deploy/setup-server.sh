#!/usr/bin/env bash
# One-time setup on the Hetzner server. Run as a user that can use docker:
#   curl -fsSL https://raw.githubusercontent.com/anmolmathur/travel/main/deploy/setup-server.sh | bash
# (for a private repo, copy this file over with scp instead).
set -euo pipefail
DIR=${WANDER_DIR:-/opt/wander}
sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR" && cd "$DIR"

if [ ! -f docker-compose.yml ]; then
  cat > docker-compose.yml <<'YML'
services:
  wander:
    image: ghcr.io/anmolmathur/travel:latest
    container_name: wander
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    env_file: .env
    volumes:
      - wander-data:/data
    ports:
      - "127.0.0.1:3040:3000"
volumes:
  wander-data:
YML
fi

if [ ! -f .env ]; then
  rnd() { openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-40; }
  cat > .env <<ENV
WANDER_PASSWORD=$(rnd | cut -c1-20)
WANDER_API_TOKEN=$(rnd)
SESSION_SECRET=$(rnd)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-flash-latest
GEMINI_MODEL_SMART=gemini-flash-latest
AERODATABOX_API_KEY=
PUBLIC_READ=false
COOKIE_SECURE=true
ENV
  chmod 600 .env
  echo "Created $DIR/.env with a random password and API token. Add GEMINI_API_KEY, then read the password with: grep WANDER_PASSWORD $DIR/.env"
fi

docker compose pull
docker compose up -d
echo "Wander is running on 127.0.0.1:3040. Point your reverse proxy at it (see deploy/ in the repo)."
