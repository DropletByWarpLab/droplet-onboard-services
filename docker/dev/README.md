# Droplet — Docker Desktop dev stack

Local development for the dashboard + orchestrator on **Windows Docker Desktop**
(or macOS / Linux). Spins up Postgres + Redis + MQTT + Nextcloud + orchestrator
+ dashboard. Brings up the subset of services that doesn't need Linux hardware —
hot-reload on the dashboard, JWT auth, seeded fake cameras / Matter devices /
chat sessions, all locally.

**The production POC stack stays on the Linux box.** This dev stack is for
iteration speed. When you're ready to ship, that's a separate flow.

---

## What's in it / what's not

| Service | In dev stack? | Why |
|---|---|---|
| Postgres (pgvector) | ✅ | Same image as prod. Orchestrator + Nextcloud share it. |
| Redis | ✅ | Sessions + queues. No password in dev. |
| MQTT (Mosquitto) | ✅ | Real-time events. Anonymous in dev. |
| Nextcloud | ✅ | Files surface — dashboard's `/files` tab pulls from it. |
| Orchestrator | ✅ | Bind-mounted source, `tsx watch` hot-reload. |
| Dashboard (Next.js) | ✅ | Bind-mounted source, `next dev` HMR. |
| `gateway` (nginx) | ❌ | Skip — access services on `localhost:3001` / `:3000` directly. |
| `ai-gateway` / `ai-stack` | ❌ | Needs Linux ROCm GPU. Chat UI shows "AI offline" banner. |
| `routing` / `openwrt` | ❌ | Needs WiFi card + Linux netns. Network admin UI hits 503s gracefully. |
| `frigate` | ❌ | Needs iGPU render node. Camera grid renders from seeded DB rows. |
| `camera-discovery` | ❌ | Needs LAN multicast. Add cameras manually via the dashboard. |
| `voice-io` / `wyoming-*` | ❌ | Needs USB mic. Voice button on chat is hidden in dev. |
| `device-identity-svc` / `mcp-server` | ❌ | Stub-able — orchestrator handles missing companion services. |

If any of those become must-haves for your dev loop, add them to
`docker-compose.dev.yml` — patterns are obvious by symmetry with the existing
services.

---

## Quickstart (Windows + Docker Desktop)

1. **Install Docker Desktop** with the WSL2 backend enabled (Settings →
   General → "Use the WSL 2 based engine"). 4+ GB RAM allocated.

2. **Clone the repo** somewhere Docker Desktop can reach. If you're using the
   WSL2 backend, **clone INSIDE WSL** (e.g. `~/code/droplet-onboard-services`) — not
   under `C:\Users\…\GitHub\`. Bind-mounts from `/mnt/c/` into Linux containers
   are 10–100× slower than mounts inside the WSL2 filesystem. If you must stay
   on `C:\`, expect first-boot to take 10+ minutes and `next dev` recompiles to
   feel sluggish.

   ```bash
   # Inside WSL2 (Ubuntu)
   cd ~ && mkdir -p code && cd code
   git clone git@github.com:DropletByWarpLab/droplet-onboard-services.git
   cd droplet-onboard-services
   git checkout stage
   ```

3. **Copy the env file:**

   ```bash
   cp docker/dev/.env.example .env
   ```

   Edit `.env` if you want non-default secrets. The defaults are fine for
   local dev — they're labeled `dev-only` so nobody mistakes them for prod.

4. **Up:**

   ```bash
   docker compose --env-file .env -f docker/docker-compose.dev.yml up
   ```

   First boot takes **~5 minutes**: pulling images (~2 GB), running
   `npm install` for the orchestrator + dashboard workspaces (~3 min total),
   Prisma migrations + seed (~10 sec), Next.js first compile (~30 sec).

   Subsequent boots take **~30 seconds** — the named volumes persist
   `node_modules`, the database, and Nextcloud state.

5. **Open** http://localhost:3001 — the dashboard.

   A fresh stack has **no accounts at all**, so the first thing you see is the
   setup wizard, not a login. Walk it:

   - **Claim code:** `DRPL7K2Q9F4M` — already set in `docker/dev/.env.example`.
     On a real box this is minted and shown on the lid display; the dev stack
     has no display, so the env file pins a known one.
   - **Account step:** pick any email and password you'll remember. The
     password must be 12–128 characters with at least 3 of
     {lowercase, uppercase, digit, symbol} — the same policy the product
     enforces (`packages/auth-policy/src/password.ts`).

   That creates the box's single `owner`. **Afterwards you sign in with the
   email, not a username** — ADR-013 made the local directory the auth source
   of truth, so `POST /auth/login` looks the account up by email and verifies
   argon2id against `User.passwordHash`. Nextcloud does not authenticate
   anyone, and the username is derived server-side from the email's local part
   (`dev@warp-lab.ai` → `dev`); typing it will not log you in.

   > Setup is one-shot. Once an `owner` row exists, `POST /auth/setup` answers
   > `409 OWNER_EXISTS` and touches nothing — so a re-POST can neither create a
   > second owner nor overwrite the first one's password. To start over, tear
   > the stack down **with its volumes** (see "Wipe everything" below).

6. **Optional — seed Nextcloud users + 10 sample files** (one-time):

   ```bash
   bash docker/dev/nextcloud-bootstrap.sh
   ```

   This adds a `stefan` user and uploads 10 markdown / CSV samples to the
   admin's Nextcloud home so the Files tab isn't empty.

   Note what this does **not** do: it creates users in Nextcloud over OCS and
   never writes the local `User` row the dashboard authenticates against. A
   user created here cannot sign in to the dashboard. Its job is to give the
   Files surface something to show.

---

## Service URLs

| URL | What |
|---|---|
| http://localhost:3001 | Dashboard (Next.js, hot-reload) |
| http://localhost:3000 | Orchestrator API (Express, tsx watch) |
| http://localhost:8082 | Nextcloud admin UI (login: `admin` / `dropletdev` — a Nextcloud-only credential; it is not a dashboard login) |
| `postgresql://droplet:dropletdev@localhost:5432/droplet` | Postgres (use TablePlus / DataGrip / psql) |
| `redis://localhost:6379` | Redis (use redis-cli / RedisInsight) |
| `mqtt://localhost:1883` | MQTT broker (use MQTT Explorer) |

---

## Hot-reload behavior

| Edit | What happens |
|---|---|
| `apps/web-dashboard/src/**/*.tsx` | Next.js HMR — browser updates in 1–2s. No restart. |
| `apps/web-dashboard/src/app/globals.css` | Tailwind recompiles, page reflows. |
| `apps/orchestrator/src/**/*.ts` | `tsx watch` restarts the orchestrator (~2s). Refresh the dashboard. |
| `apps/orchestrator/prisma/schema.prisma` | Run `docker compose -f docker/docker-compose.dev.yml exec orchestrator npx prisma migrate dev --name your-change-name`. |
| New npm dependency | `docker compose -f docker/docker-compose.dev.yml exec orchestrator npm install <pkg> -w @droplet/orchestrator` (or `-w @droplet/web-dashboard`). The named volume persists. |
| `package.json` lock change | `docker compose -f docker/docker-compose.dev.yml exec orchestrator rm -rf node_modules && exit` then `docker compose ... restart orchestrator` — forces a fresh `npm install`. |

---

## Common operations

```bash
# Tail the dashboard logs
docker compose -f docker/docker-compose.dev.yml logs -f web-dashboard

# Open a shell in the orchestrator container
docker compose -f docker/docker-compose.dev.yml exec orchestrator bash

# Re-seed dev data (idempotent)
docker compose -f docker/docker-compose.dev.yml exec orchestrator \
    npx tsx prisma/seed.dev.ts

# Connect to Postgres
docker compose -f docker/docker-compose.dev.yml exec db \
    psql -U droplet droplet

# Wipe everything and start fresh
docker compose -f docker/docker-compose.dev.yml down -v
```

---

## When the AI / cameras / network panels look empty or broken

That's expected — see the "what's not in the dev stack" table above. Each
of those surfaces has a graceful fallback:

- **Chat / Ask AI** — shows a "Local models unavailable" banner and the
  send button stays disabled. To get a working chat, point
  `AI_GATEWAY_URL` at a real gateway (Linux POC) or run an Ollama container
  on a Windows machine with NVIDIA + Container Toolkit.
- **Cameras** — renders the seeded 5 cameras (Front door / Reception /
  Garage / Loading bay / Back lot). The Back lot is intentionally set to
  `enabled=false` so you see the "OFFLINE" pill. The live stream player
  fails to load because Frigate isn't running.
- **Network / Devices** — the 3 Matter devices show as `NetworkDevice`
  rows. Real Matter commissioning (`POST /matter/commission`) returns
  502 because the Matter controller binds to host network in prod.
- **Remote Access / VPN** — peer add returns 503 (no routing service).
- **Files** — works fully against Nextcloud. The first 10 files are
  there if you ran `nextcloud-bootstrap.sh`.

---

## Troubleshooting

**"first boot is taking forever"**
First boot installs the full npm workspace (~600 packages including
Next.js, Prisma, Compose UI, etc.). 3–5 minutes is normal on a fast SSD,
10+ on a spinning disk. Watch the logs:
`docker compose -f docker/docker-compose.dev.yml logs -f orchestrator`.

**"dashboard says 'connection refused' on every API call"**
The orchestrator hasn't finished booting. Check:
`docker compose -f docker/docker-compose.dev.yml logs orchestrator`.
Look for `🚀 orchestrator listening on :3000`.

**"`npm install` keeps re-running on every up"**
The `dev-workspace-modules` named volume isn't persisting. Check:
`docker volume ls | grep dev-workspace-modules`. If it's missing,
your Docker daemon may be configured to wipe volumes on stop.

**"changes to my .tsx file don't trigger a reload"**
Check that `WATCHPACK_POLLING=true` is set in the dashboard container's
env (`docker compose -f docker/docker-compose.dev.yml exec web-dashboard env | grep POLLING`).
If polling is on and reload still doesn't happen, your editor may be
writing files via a different inode (some editors do "save → rename");
toggle the editor's "atomic save" setting off.

**"Postgres connection refused after a restart"**
On crash + restart, Postgres can stay in recovery mode for a few seconds.
`docker compose -f docker/docker-compose.dev.yml logs db` will show
"database system is ready to accept connections" when it's up. The
orchestrator entrypoint waits for it automatically.

**"It's slow on `C:\Users\...` paths"**
That's the WSL2 9p-over-Windows bind mount. Move your clone INSIDE WSL2
(`~/code/`) — recompile times drop 10×. This is the single biggest perf
win on Windows + Docker Desktop.

**"`docker compose down -v` deleted my dev data"**
That's the `-v` flag — it removes named volumes. Without `-v`, dev data
(Postgres, Nextcloud, node_modules cache) persists across `down`/`up`.
Use `-v` only when you genuinely want to wipe state.

---

## Going from dev to prod

This dev stack is NOT a deployment target. To ship to the photo-studio
POC or any production Droplet:

```bash
# On the production Linux box
docker compose -f docker/docker-compose.yml up -d
```

That brings up the full prod stack including AI / routing / Frigate /
voice / display. The dev compose and prod compose are deliberately
separate files so dev tweaks never accidentally affect a customer
Droplet.

---

## Architecture decisions captured here

- **Why bind-mount source + named volume `node_modules`:** on Windows, the
  Docker Desktop 9p mount makes serving thousands of `node_modules` files
  from the host catastrophically slow. Named volumes are stored in the
  WSL2 distribution's filesystem and ship at native speed.
- **Why no AI:** chosen 2026-05-18 by Stefan — dev box has no GPU
  worth running Ollama on. ADR-008 §6 explains the production AI path.
- **Why polling for file watchers:** inotify doesn't fire reliably across
  the Windows ⇄ Linux bind. Polling costs ~3% CPU but is predictable.
- **Why same Postgres image as prod (`pgvector/pgvector:pg16`):** keeps
  dev/prod schema parity. The orchestrator uses pgvector for embeddings;
  swapping to vanilla `postgres:16` would silently break the embeddings
  migration.
