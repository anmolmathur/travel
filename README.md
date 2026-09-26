# Wander

A free, open alternative to the paid flight-tracking apps, for anyone who wants to log their travels and see them beautifully. This repository is `travel`; the app calls itself **Wander** and runs at [wander.anmolmathur.com](https://wander.anmolmathur.com).

A self-hosted flight logbook. Every flight you've taken on a 3D globe, lifetime statistics, trips stitched together automatically, a review queue that catches flights you booked but never took, and entry by form, by pasted booking email, by boarding-pass photo or by an AI agent.

It is a single Node.js process with a built-in SQLite database and no npm dependencies, shipped as one Docker image.

## What it does

**Atlas.** A night-side globe (or flat map) with every route drawn as a glowing great-circle arc, weighted by how often you flew it, and small planes moving along the busiest ones. Visited countries are lit, home base pulses, and upcoming trips are dashed. Click an airport or route for details. **Replay the years** animates your map growing year by year. Below the map: a passport of country stamps in the order you first arrived, records (longest, shortest, furthest from home, north/south/east/west-most), airline cards with logos (defunct carriers are marked), and the full OpenFlights-style numbers.

**Trips.** Flights are grouped into journeys that leave home and end when you land back, with a mini-map and route chain for each. A ⋯ in the chain marks a leg that isn't in the log.

**Insights.** Flights and new airports per year, a month-by-year heatmap, month and weekday patterns, top routes and airports, aircraft families and types, haul bands, domestic vs international and a rough CO₂ estimate.

**Review.** Flags likely errors: codeshares logged twice (TK774 and WY5774), exact duplicates, a route rebooked within four days with no return in between, days whose flights can't form one journey, and planned flights whose date has passed. **Not flown** keeps a flight in the log (struck through) but removes it from every statistic, and can be undone.

**Family.** Every flight records who flew it. Switch the whole app (map, stats, passport, trips) between people or the whole family with the buttons above the stats. Trips have one-click "Who went" buttons, and flights imported from someone else's bookings arrive unassigned and wait in Review until you say whose they were. Manage the list under Logbook → People, or seed it with `WANDER_PEOPLE=me:Anmol,kruti:Kruti`. CSV exports and imports carry a `Travellers` column (`me;kruti`, or `unassigned`).

**Logbook.** Searchable, sortable table with edit, not-flown and delete. OpenFlights CSV import and export.

### Gemini features

With `GEMINI_API_KEY` set, these switch on. All calls go from the server, so the key never reaches the browser.

- **Smart add**: paste a confirmation email or itinerary, or drop a boarding-pass or e-ticket screenshot; Gemini returns every segment for you to check before saving.
- **Ask your logbook**: questions in plain English ("How many times have I flown to Delhi?", "Which airline did I fly most in 2023?").
- **Year in review**: a short written recap with highlights for any year (cached until that year's flights change).
- **Trip names**: evocative names and one-line summaries for trips.
- **Where next**: destination ideas you haven't visited, reachable from home.

`GEMINI_MODEL` (default `gemini-2.5-flash`) handles extraction and trip names; `GEMINI_MODEL_SMART` handles questions, recaps and ideas. Change either if Google renames or retires a model.

If an AI feature shows an error, run this on the server. It checks the key, lists the models your key can use and makes two small test calls:

```bash
docker exec wander node --disable-warning=ExperimentalWarning server/cli.js ai-check
```

If a configured model has been retired, Wander switches to the newest available model of the same family (flash or pro) and logs which one it picked (`docker logs wander`).

### Flight lookup (optional)

With an AeroDataBox key from RapidAPI (free tier: 600 units a month), **Look up** on the Add form fills in route, departure time, duration and registration from a flight number and date.

A booking reference (PNR) alone can't be looked up: no public API returns a booking from its PNR. Smart add with the confirmation email is the practical route.

## Run it locally

Needs Node 22.13 or newer.

```bash
npm run dev                        # http://localhost:3000, no password, data in ./data/dev.db
npm run import -- ~/Downloads/openflights-export.csv
npm test
```

## Host it on a server (Hetzner or any Docker host)

### One-click deploy from GitHub (recommended)

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `HETZNER_HOST` | Server IP or hostname reachable over SSH from GitHub |
| `HETZNER_USER` | SSH user that can run `docker` (and create `/opt/wander`, or has passwordless sudo) |
| `HETZNER_SSH_KEY` | Private key for that user (the matching public key goes in `~/.ssh/authorized_keys`) |
| `HETZNER_PORT` | Optional, if SSH isn't on 22 |
| `GEMINI_API_KEY` | Optional, turns on the AI features |
| `AERODATABOX_API_KEY` | Optional, turns on flight lookup |

Then run **Actions → Deploy → Run workflow**, or push to `main`. `deploy/remote-deploy.sh` runs on the server over SSH. On the first run it creates `/opt/wander` with a random password and API token. On every run it pulls the new image and recreates only the `wander` container. If `cloudflared` runs in Docker, it also joins Wander to the same network. The log ends with the URL to use for the Cloudflare tunnel route (`http://wander:3000` for a containerised `cloudflared`, `http://localhost:3040` otherwise). Read the generated password on the server with `grep WANDER_PASSWORD /opt/wander/.env`.

### Manual setup

1. **DNS.** Add an `A` record for `wander.anmolmathur.com` pointing at the server's IPv4 (and `AAAA` for IPv6). If the domain is on Cloudflare, either leave it DNS-only and let Caddy/certbot issue the certificate, or proxy it and use a Cloudflare origin certificate.
2. **Image access.** The GitHub Action publishes `ghcr.io/anmolmathur/travel`. While the repo is private, log the server in once with a personal access token that has `read:packages`:
   `echo <token> | docker login ghcr.io -u anmolmathur --password-stdin`
3. **Start it.** Copy `deploy/setup-server.sh` to the server and run it. It creates `/opt/wander` with a compose file and a `.env` containing a random password and API token, then starts the container on `127.0.0.1:3040`.
4. **Add your keys.** Edit `/opt/wander/.env` and set `GEMINI_API_KEY` (and optionally `AERODATABOX_API_KEY`), then `docker compose up -d`.
5. **Publish it.** Point your reverse proxy at `127.0.0.1:3040` using the matching file in `deploy/` (Caddy, nginx or Traefik). With Cloudflare Tunnel, add a public hostname `wander.anmolmathur.com → http://localhost:3040`.
6. **Load your history.** Sign in and use Logbook → Import CSV, or on the server:
   `docker compose exec wander node server/cli.js import /data/openflights.csv` (copy the file into the volume first with `docker cp`).
7. **Automatic deploys (optional).** Add repository secrets `HETZNER_HOST`, `HETZNER_USER` and `HETZNER_SSH_KEY` (and `HETZNER_PORT` if not 22). Every push to `main` then runs the tests, builds a multi-arch image and restarts the container on the server.

Back up the database with `docker compose exec wander node server/cli.js export > wander-backup.csv`, or copy `/data/wander.db` from the `wander-data` volume.

## Let Claude (or any agent) keep the log

Wander serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`, authenticated with `WANDER_API_TOKEN`. Tools: `list_flights`, `list_people`, `set_travellers`, `replace_airport`, `add_flight`, `add_flights`, `update_flight`, `mark_not_flown`, `restore_flight`, `delete_flight`, `get_stats`, `review_queue`, `lookup_flight`.

Claude Code:

```bash
claude mcp add --transport http wander https://wander.anmolmathur.com/mcp \
  --header "Authorization: Bearer $WANDER_API_TOKEN"
```

Clients that can't send headers (such as a claude.ai custom connector) can use `https://wander.anmolmathur.com/mcp/<WANDER_API_TOKEN>`. Treat that URL like a password.

Then just say "Add IndiGo 6E 2114 Mumbai to Delhi on 12 October, seat 14A" or "Mark my 9 October Kolkata flight as not flown".

### REST API

Send `Authorization: Bearer <WANDER_API_TOKEN>`, or sign in for a session cookie.

| Method | Path | |
|---|---|---|
| GET | `/api/flights` | All flights |
| POST | `/api/flights` | Add one (`date`, `from`, `to` required; IATA codes) |
| PUT / PATCH / DELETE | `/api/flights/:id` | Replace, change fields (e.g. `{"status":"cancelled"}`), delete |
| POST | `/api/import` | OpenFlights CSV as the request body |
| GET | `/api/export.csv` | OpenFlights-compatible export |
| GET | `/api/stats?year=` · `/api/trips` · `/api/review` | Summaries |
| GET | `/api/lookup?flight=&date=` | AeroDataBox lookup |
| POST | `/api/ai/extract` · `/api/ai/ask` · `/api/ai/story` · `/api/ai/trips` · `/api/ai/next` | Gemini features |

## Configuration

See `.env.example`. `WANDER_PASSWORD` is required on any public server; without it the app is open to anyone who can reach it. `PUBLIC_READ=true` lets anyone with the link view (not edit).

## Data and credits

Airports from [OurAirports](https://ourairports.com/data/) (public domain). Airline and aircraft codes from [OpenFlights](https://openflights.org/data.php) (ODbL). Country shapes from Natural Earth via [world-atlas](https://github.com/topojson/world-atlas). Map drawing with [D3](https://d3js.org) and [topojson-client](https://github.com/topojson/topojson-client) (ISC, vendored in `public/vendor`). Airline logos load from pics.avs.io and flags from flagcdn.com at view time.

## Ideas for later

Email forwarding address that files bookings automatically; boarding-pass barcode (IATA BCBP) and Apple Wallet pass import; nightly status checks that mark cancelled flights; a shareable year-in-review image; public profile pages with per-flight privacy; family logs where a shared trip appears on everyone's map; aircraft registration history ("you flew VT-ISK three times").
