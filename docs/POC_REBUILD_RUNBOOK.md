# POC Rebuild Runbook — wipe `droplet-sys` + redeploy from `feat/poc-single-box-rebuild`

**Branch:** `feat/poc-single-box-rebuild` (merged `feat/dashboard-redesign` into `feat/poc-single-box` on 2026-05-18)
**Target host:** `droplet-sys` — the photo-studio box (Ryzen 7700X, RDNA4 dGPU, 2× 2 TB SATA, MT7922 Wi-Fi)
**SSH from Stefan's Windows box:** `ssh droplet@droplet-sys` (or via the paramiko helper at `C:\Users\Stefan\Documents\3D print code for images\_droplet_ssh.py`)
**Companion docs:** `docs/POC_RUNBOOK.md` (full technical state), `docs/POC_RESUME.md` (session handoff)

This runbook **destroys all local state on the box** (Postgres, Nextcloud uploads, brain memory, camera footage, paired devices, WG peers) and rebuilds from zero on the merged branch. The hardware stays — disks, GPU, Wi-Fi card. Plan ~30-45 min end-to-end.

> ⚠️ **Last chance to back out:** if there's pilot-customer data on the box (uploaded photos, faces in the recognition engine, camera clips that matter), copy it off the box BEFORE running step 4. See "Save what matters" below.

---

## 0. Pre-flight — verify what's on the box now

```bash
# From your Windows machine
ssh droplet@droplet-sys
# Once on the box:
cd /home/droplet/edge-platform
git status
git log --oneline -5
docker compose ps
df -h /mnt/droplet            # sanity: how much data are you about to lose
du -sh /mnt/droplet/* 2>/dev/null
```

Write down:
- The current branch (likely `feat/poc-single-box` or `poc/single-box`)
- The last commit SHA
- The total bytes under `/mnt/droplet/` (so you know what's getting wiped)

---

## 1. Save what matters (optional but recommended)

If you want to preserve **anything** from the current state, pull it off before the wipe. Skip this section if the box is genuinely throw-away and you don't care.

```bash
# On the box — pick what you actually want to keep
sudo tar -czf /tmp/droplet-state-$(date +%Y%m%d).tar.gz \
    /mnt/droplet/nvr \
    /mnt/droplet/data \
    /mnt/droplet/data2 \
    /home/droplet/edge-platform/docker/secrets

# From Windows — pull the tarball over
scp droplet@droplet-sys:/tmp/droplet-state-*.tar.gz "C:\Users\Stefan\Backups\"
```

Snapshot anything else as needed (`/etc/systemd/system/droplet-*` for the attach service, `/etc/default/droplet-openwrt-attach` for the AP SSID/PSK).

---

## 2. Stop everything cleanly

```bash
# On the box
cd /home/droplet/edge-platform

# Bring the Docker stack down. The -v flag is intentional — it
# DELETES the named volumes (pgdata, nextcloud-data, frigate-config,
# brain-memory-data, etc). That's the whole point.
docker compose down -v --remove-orphans

# Stop the systemd unit that brings up the OpenWrt netns + attaches
# the Wi-Fi card. We'll restart it on the new branch.
sudo systemctl stop droplet-openwrt-attach.service
sudo systemctl disable droplet-openwrt-attach.service || true
```

Confirm:

```bash
docker ps -a               # should be empty (or only Docker Desktop bits)
docker volume ls           # should NOT list droplet-* volumes
docker network ls          # droplet_default should be gone
```

---

## 3. Nuke disk state

```bash
# On the box

# 3a. Drop the orchestrator's working tree. The repo gets re-cloned
#     in step 5.
sudo rm -rf /home/droplet/edge-platform

# 3b. Wipe the data partition mountpoints. The Phase F (memory:
#     droplet 2.6 standards) move put everything under /mnt/droplet/
#     so this is the one address. If you saved a tarball in step 1,
#     it's safe in /tmp.
sudo find /mnt/droplet -mindepth 1 -maxdepth 2 -type d \
    \( -name "nvr" -o -name "data" -o -name "data2" \
       -o -name "nextcloud" -o -name "brain-memory" \
       -o -name "matter-storage" -o -name "frigate" \) \
    -exec sudo rm -rf {} + 2>/dev/null
sudo find /mnt/droplet -mindepth 1 -maxdepth 1 -type f -delete

# 3c. Drop any stray Docker state Docker compose down -v missed.
docker system prune -af --volumes
```

Verify the slate is clean:

```bash
ls -la /mnt/droplet                 # empty or only top-level mountpoints
docker ps -a                        # empty
docker volume ls                    # empty of droplet-*
docker network ls                   # bridge, host, none only
sudo systemctl list-units --type=service | grep -i droplet  # gone
```

---

## 4. Fresh clone on the merged branch

```bash
# On the box
cd /home/droplet
git clone git@github.com:DropletByWarpLab/droplet-pi-platform.git edge-platform
cd edge-platform
git checkout feat/poc-single-box-rebuild

# Verify
git log --oneline -10
# You should see the merge commit at the top:
#   32f73a4 merge: bring feat/dashboard-redesign into POC line ...
# Followed by both the POC commits (29e8b81, b5f4f4b, …) and the
# redesign commits (86441b3, b288f7b, cdcb8c5, 054aa6b, e040dd7,
# 8a51fbe, bc60e69, 18690f7, ccd5646).
```

If the box's `gh` is logged in as `stefan17x-eng` (no org access — see memory `feedback_git_two_github_accounts.md`), use SSH key auth (the box's deploy key) or unset the credential override per that memory.

---

## 5. Provision the box

The POC setup script is `scripts/setup.sh` — see `docs/POC_RUNBOOK.md` for full detail. The merge picked up both POC infra changes AND redesign work, so this single bootstrap sets up everything.

```bash
# On the box
cd /home/droplet/edge-platform

# Idempotent setup — installs deps, generates secrets, configures
# /etc/default/droplet-openwrt-attach (AP SSID/PSK durability, Phase
# 4 of the POC), installs systemd units, mounts disks under
# /mnt/droplet, registers Nextcloud external storage. Re-runs are
# safe.
sudo ./scripts/setup.sh

# Pick the WiFi AP SSID + PSK when prompted, OR pre-set them:
#   sudo bash -c 'cat > /etc/default/droplet-openwrt-attach <<EOF
#   AP_SSID=Droplet-POC
#   AP_PSK=YourStrongPassphraseHere
#   EOF'
# THEN re-run setup.sh — it picks them up.

# The attach service starts as part of setup.sh; verify:
sudo systemctl status droplet-openwrt-attach.service
# Should be "active (exited)" after attach completes.
```

---

## 6. Bring up the Docker stack

```bash
# Still on the box
cd /home/droplet/edge-platform

# Confirm .env is populated (setup.sh wrote it).
test -s .env && echo "env ok" || echo "env missing — re-run setup.sh"

# Bring up the prod stack. First time: pulls ~3 GB of images,
# builds the orchestrator + dashboard + ai-gateway + voice-io +
# file-indexer + display + routing + switch images, ~10-15 min.
docker compose up -d

# Tail the orchestrator until you see "🚀 orchestrator listening"
docker compose logs -f orchestrator
```

The merge pulled in:
- The **violet brand** (ADR-003) — dashboard now renders in `#6d28d9` violet not indigo
- The **dual workspace concept** (ADR-003 + ADR-005) — `WorkspaceProvider`, `Workspace` Prisma model, `/api/settings/workspace` endpoint, sidebar pill, admin items gated by workspace
- **Topbar on 9 pages** (Phase 2b + 2c) — Home / Cameras / Settings / Network / Files / Devices / Calendar / Knowledge / Remote-access / Events
- **`?return=body` on `/api/auth/login`** + body refresh — unblocks mobile apps in prod
- **The dev compose stack** at `docker/docker-compose.dev.yml` — for future Windows-side iteration
- **ADRs 003-005** — design tokens, native mobile contract, canonical architecture (from the whiteboard)

The Prisma migration `20260518000000_add_workspace` runs automatically on first orchestrator boot via the entrypoint's `prisma migrate deploy`.

---

## 7. Smoke test

```bash
# On the box
# 7a. Service health
curl -fsS http://localhost:3000/api/orchestrator/health | jq .
# Expect: status:"ok", components: [routing:"ok", ai-gateway:"ok",
# nextcloud:"ok", db:"ok", ...]

# 7b. Dashboard
curl -fsS -o /dev/null -w "%{http_code}\n" https://droplet.local/ -k
# Expect: 200

# 7c. Workspace endpoint (Phase 4a)
curl -fsS -b /tmp/cookies.txt http://localhost:3000/api/settings/workspace | jq .
# Without auth, expect 401. With a logged-in session, expect:
#   {"workspaceType":"home","displayName":null,"setBy":null,"setAt":null}

# 7d. Wi-Fi AP up?
sudo systemctl status droplet-openwrt-attach.service
ip addr show wlan0_ap        # AP interface should have an IP
```

---

## 8. From a phone or laptop on the same LAN

1. Connect to Wi-Fi `Droplet-POC` (or whatever AP SSID you set)
2. Open `https://droplet.local` — should redirect to the violet dashboard login
3. Sign in with the admin account created during `setup.sh`
4. Confirm:
   - Sidebar shows **"Home" workspace pill** in the chrome
   - Pages render with **violet accent** (`#6d28d9`)
   - **Cameras / Settings / Network / Files / Devices / Calendar / Knowledge / Remote-access / Events** all have the new Topbar with breadcrumbs
   - Home page renders **Variant B** (ops-first KPIs) since the default workspace is Home

Flip to Business in browser console to validate workspace switching:

```js
fetch("/api/settings/workspace", {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspaceType: "business" }),
}).then((r) => r.json()).then(console.log);
// Reload — sidebar pill flips to "Business" + role-driven home variant
```

---

## 9. If something's broken

The merge bundled ~9 commits of redesign work into a POC line that's been independently iterating. Most-likely surfaces for breakage:

| Symptom | Where to look |
|---|---|
| Orchestrator won't start, Prisma migration error | `docker compose logs orchestrator` — look for migration `20260518000000_add_workspace`. The migration is plain SQL (no `prisma db push` weirdness); should apply clean on a fresh DB. |
| Dashboard 500 on first paint | `/api/auth/me` failing → check `JWT_SECRET` is set in `.env`. Then `docker compose restart orchestrator`. |
| WiFi AP not up | `sudo journalctl -u droplet-openwrt-attach.service -f` while running `sudo systemctl restart droplet-openwrt-attach.service`. The 2026-05-18 fix (`29e8b81`) scoped DNAT to `192.168.20.1` only — confirm that's the AP CIDR you're using. |
| `/api/settings/workspace` 404 | The new route mounted in `app.ts` — confirm orchestrator built from the merged branch (check `docker compose images` for an orchestrator image timestamp ≥ this rebuild). |
| Pages still look indigo | Browser cached the old `globals.css`. Hard reload (Ctrl+Shift+R) or open in an incognito window. |
| Sidebar pill missing | `WorkspaceProvider` not mounted — verify `apps/web-dashboard/src/app/layout.tsx` has `<WorkspaceProvider>` wrapping `<AuthGate>`. Should be in the merge automatically. |

If TSC / vitest run on the box (`cd apps/web-dashboard && npx tsc --noEmit`), they should mirror what I validated on Windows pre-push: clean.

---

## 10. Rollback (if everything's on fire)

Worst case: bring back the pre-rebuild branch.

```bash
# On the box
cd /home/droplet/edge-platform
docker compose down -v
git checkout feat/poc-single-box       # the un-merged POC line
sudo ./scripts/setup.sh                # idempotent
docker compose up -d
```

You'd lose the redesign work + workspace endpoint, but the box is back to what was running before.

---

## What this runbook DELIBERATELY does NOT cover

- **Customer data migration**: this is a clean-slate rebuild. Pilot-customer uploaded photos / cameras need to be re-paired + re-uploaded.
- **Mac dev / Win dev**: the dev compose stack at `docker/docker-compose.dev.yml` is for Stefan's Windows dev box (see `docker/dev/README.md`). This runbook is the **PROD path** on `droplet-sys`.
- **Mobile app rebuild**: iOS / Android / macOS Catalyst / Windows Tauri repos are separate; the merge here only affects the appliance + web dashboard. The mobile clients keep working — they hit the same `/api/devices/pair/claim` + `/api/auth/login` endpoints which now also support `?return=body` (their non-breaking enhancement landed in `b288f7b`).
