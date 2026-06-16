# HQ deploy + first-box bring-up runbook (ADR-023)

Stand up the fleet-server issuer on `hq.warp-lab.com` and bring the lab box
(`192.168.1.87`) to a green padlock. Steps A–B are HQ; C–D are the box; E is
validation. Do everything on **LE staging** first (the default), flip to prod
only at the end.

> Placeholders are `<IN_ANGLE_BRACKETS>`. Nothing here is committed with real
> values — secrets live only in the HQ `.env` (never tracked).

---

## Prerequisites
- Cloudflare account that manages **`warp-lab.ai`** (already on Cloudflare).
- A host/registrar where **`warp-lab.com`** DNS is managed (Google) **or** use
  `hq.warp-lab.ai` instead (one fewer provider — Cloudflare). This runbook uses
  `hq.warp-lab.ai` to keep DNS in one place; substitute `hq.warp-lab.com` if you
  prefer and add its A record in Google DNS.
- A Hetzner account.

---

## A. Cloudflare — token + zone id (~5 min)
The box FQDNs live at `*.devices.warp-lab.ai`, which is inside the existing
`warp-lab.ai` zone — **no new zone/delegation needed**. DNS-01 just writes
`_acme-challenge.d-<hmac>.devices.warp-lab.ai` TXT records in that zone.

1. **Scoped API token** — Cloudflare → My Profile → API Tokens → Create Token →
   *Custom token*:
   - Permissions: **Zone → DNS → Edit**
   - Zone Resources: **Include → Specific zone → `warp-lab.ai`**
   - Create → copy the token → this is `CLOUDFLARE_API_TOKEN` (HQ-only).
2. **Zone ID** — `warp-lab.ai` → Overview → right sidebar **Zone ID** → this is
   `CLOUDFLARE_ZONE_ID`.

---

## B. Hetzner HQ + deploy (~20 min)

1. **Create the server** — Hetzner Cloud → CX22, **Ubuntu 24.04**, Frankfurt.
   Note its public IP `<HQ_IP>`.
2. **DNS** — in Cloudflare, add an **A record** `hq` → `<HQ_IP>` in `warp-lab.ai`
   (gives `hq.warp-lab.ai`). Leave it **DNS-only (grey cloud)** so Caddy can do
   HTTP-01 for the HQ front cert. Open ports 80, 443 in the Hetzner firewall.
3. **Base packages**
   ```bash
   ssh root@<HQ_IP>
   apt-get update && apt-get install -y docker.io docker-compose-v2 git
   ```
4. **Get the code** — clone the branch (until merged):
   ```bash
   git clone -b feat/fleet-server-tls-issuance \
     https://github.com/DropletByWarpLab/droplet-onboard-services.git
   cd droplet-onboard-services/services/fleet-server
   ```
5. **HQ `.env`** (this file is never committed):
   ```bash
   cat > .env <<'EOF'
   POSTGRES_PASSWORD=<STRONG_RANDOM>
   HQ_LABEL_SECRET=<STRONG_RANDOM_32B>     # openssl rand -hex 32
   CLOUDFLARE_API_TOKEN=<FROM_STEP_A1>
   CLOUDFLARE_ZONE_ID=<FROM_STEP_A2>
   ISSUANCE_DOMAIN_BASE=devices.warp-lab.ai
   ACME_CONTACT_EMAIL=ops@warp-lab.ai
   # ACME_DIRECTORY_URL unset -> defaults to LE STAGING (correct for now)
   EOF
   ```
   Keep `HQ_LABEL_SECRET` safe — it deterministically derives every box's
   public label; rotating it changes every FQDN.
6. **TLS front (the one gap to close).** The service listens on `8088` HTTP; the
   box must reach it over HTTPS. Add a Caddy front (auto LE for the HQ name via
   HTTP-01) as a compose override:
   ```bash
   cat > docker-compose.override.yml <<'EOF'
   services:
     fleet-server:
       ports: !reset []          # don't publish 8088 to the host
     caddy:
       image: caddy:2
       restart: unless-stopped
       depends_on: [fleet-server]
       ports: ["80:80", "443:443"]
       command: caddy reverse-proxy --from hq.warp-lab.ai --to fleet-server:8088
       volumes: [caddy-data:/data]
   volumes:
     caddy-data:
   EOF
   ```
7. **Boot it** (migrations apply idempotently at startup):
   ```bash
   docker compose up -d --build
   docker compose logs -f fleet-server   # watch for "migrations applied" + readyz
   curl -s https://hq.warp-lab.ai/readyz   # expect 200 once Caddy has its cert
   ```

---

## C. Seed the lab box into the registry (~5 min)
The issuer never self-registers a device — insert its TPM public key + fingerprint
first. All three values come straight off the box; the fingerprint formula matches
exactly what the box sends (`sha256:` + sha256 of the cert PEM).

1. **On the box** (`192.168.1.87`) read the three values from the
   device-identity sidecar's storage (mock or real backend both write here):
   ```bash
   # device id (whatever the box is configured with; default "droplet")
   DEVICE_ID="$(grep -E '^DROPLET_DEVICE_ID=' /home/droplet/edge-platform/.env | cut -d= -f2)"
   DEVICE_ID="${DEVICE_ID:-droplet}"

   # public key PEM + the exact fingerprint the box will send
   DI=droplet-device-identity-svc-1   # adjust to the real container name: docker ps | grep device-identity
   docker exec "$DI" cat /var/lib/droplet/tpm/device-id-pub.pem  > /tmp/dev-pub.pem
   FP="sha256:$(docker exec "$DI" sha256sum /var/lib/droplet/tpm/device-id-cert.pem | awk '{print $1}')"
   echo "device_id=$DEVICE_ID  fingerprint=$FP"
   cat /tmp/dev-pub.pem
   ```
   (Sanity-check the fingerprint against the source of truth if you have an admin
   session: `GET https://192.168.1.87/api/admin/device-identity/status` →
   `.certFingerprint` must equal `$FP`.)
2. **On HQ**, insert the row (paste the PEM where shown):
   ```bash
   docker compose exec -T fleet-server-db psql -U fleet -d fleet <<SQL
   INSERT INTO devices (device_id, public_key_pem, key_fingerprint)
   VALUES (
     '<DEVICE_ID>',
     '<PASTE device-id-pub.pem CONTENTS, including BEGIN/END lines>',
     '<FP>'
   )
   ON CONFLICT (device_id) DO UPDATE
     SET public_key_pem = EXCLUDED.public_key_pem,
         key_fingerprint = EXCLUDED.key_fingerprint;
   SQL
   ```

---

## D. Wire the box (~3 min)
Point the box at HQ and pre-set its FQDN (so the bootstrap cert SAN + origin
wiring have it from first boot). You can precompute the FQDN since you hold
`HQ_LABEL_SECRET`:
```bash
# run anywhere with python3
python3 - <<'PY'
import hmac, hashlib
secret=b"<HQ_LABEL_SECRET>"; device_id=b"<DEVICE_ID>"
print("d-"+hmac.new(secret, device_id, hashlib.sha256).hexdigest()[:16]+".devices.warp-lab.ai")
PY
```
On the box, set in `/home/droplet/edge-platform/.env` (for the lab box; on a real
deploy these are written by `single-box.sh`/`secrets.sh`):
```
HQ_ISSUANCE_URL=https://hq.warp-lab.ai
DROPLET_DEVICE_ID=<DEVICE_ID>
DROPLET_PUBLIC_FQDN=<PRECOMPUTED_FQDN>
```
Then restart the orchestrator: `docker compose -f docker/docker-compose.yml up -d orchestrator`.
The daily cron issues on its own; to trigger immediately, restart the orchestrator
(the issuance tick runs on boot when state is `BOOTSTRAP_SELF_SIGNED`).

---

## E. Validate — staging, then prod
1. **Watch issuance** (box): `docker compose logs -f orchestrator | grep tls-issuance`
   → expect `BOOTSTRAP_SELF_SIGNED → LE_ISSUED`.
2. **Staging cert is NOT browser-trusted** — that's expected. Confirm the chain
   says staging:
   ```bash
   openssl s_client -connect 192.168.1.87:443 -servername <FQDN> </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer -subject -ext subjectAltName
   # issuer: (STAGING) Let's Encrypt ... ; SAN: DNS:<FQDN> (the opaque d-... name, no PII)
   ```
3. **Split-horizon** (no renewal needed): from a LAN client `dig <FQDN> @192.168.20.1`
   → the box's LAN/gateway IP; from outside (cellular, VPN off) `dig +short <FQDN> @1.1.1.1`
   → **NXDOMAIN** (no public A record — home IP never published).
4. **Flip to prod LE**: on HQ set `ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory`
   in `.env`, `docker compose up -d fleet-server`, then on the box clear the staging
   state so it re-issues (delete the `TlsCert` row / set state back, or
   `DELETE /api/issuance/registration` then restart orchestrator). Re-run step 2 →
   issuer is real **Let's Encrypt**, and a fresh phone on the LAN browsing
   `https://<FQDN>` shows a **green padlock, no install**. Repeat over WireGuard
   from cellular.
5. **Renewal dry-run**: on HQ temporarily set `RENEW_BEFORE_DAYS=200` and watch the
   daily cron (or restart fleet-server) re-finalize against the stored CSR; set it
   back to `30`.

---

## Notes / gotchas
- **LE rate limit (~50 certs / `warp-lab.ai` / week)** — per-device names rule out a
  wildcard. Fine for the lab box + pilots; request an increase (and/or a dedicated
  delegated zone) before fleet scale. Staging has separate, looser limits — use it
  for all plumbing.
- **Cloudflare token scope** must be exactly `Zone:DNS:Edit` on `warp-lab.ai` only.
- **`device-id-pub.pem` is a PUBLIC key** — safe to copy. The private key stays
  sealed on the box and never appears here.
- **Real-TPM note**: the lab box runs the mock backend (real DER signatures from a
  software key), so this whole flow works today. A hardware-sealed box needs
  WARP-230's real `Sign` implemented (it must also return DER) before its identity
  is TPM-anchored — but the cert flow itself is unchanged.
- HQ holds only the Cloudflare token + the ACME account key + the device **public**
  keys. It can never forge a box's signature or reach a box inbound.
