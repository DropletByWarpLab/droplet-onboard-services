# Warning-free `droplet.local` (canonical-host redirect) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `droplet.local` never shows a browser warning: when a trusted cert is live it 307-redirects to the per-device FQDN; when it isn't, it serves a plain-HTTP status page instead of forcing the self-signed HTTPS upgrade.

**Architecture:** A render script inside the gateway image writes `/etc/nginx/canonical-host.active.conf` (a `map $host $canonical_target` + the `:80` server blocks) from two inputs: the mounted cert artifact at `/etc/nginx/certs/droplet.crt` and the explicit `DROPLET_LAN_DNS_AUTHORITY` env knob. It runs at container start (`/docker-entrypoint.d/02-canonical-host.sh`) and is re-run by the host-side `tls-reload.sh` choke point before every `nginx -s reload`, so cert swaps and redirect posture always change together. A new unauthenticated orchestrator endpoint `GET /api/tls/status` feeds the status page's auto-advance polling.

**Spec:** `docs/superpowers/specs/2026-07-13-droplet-local-warning-free-redirect-design.md` (approved 2026-07-13).

**Tech Stack:** nginx (Debian bookworm image, `openssl` CLI present), POSIX `sh` for image scripts, bash for host scripts/tests, Express + Prisma + vitest + supertest for the orchestrator endpoint.

## Global Constraints

- Friendly-name set is EXACTLY: `droplet.local droplet-ai.local droplet.lan droplet-ai.lan` (mirrors `_generate_tls_cert`'s SAN set and `trust-droplet-cert.sh`).
- The canonical redirect is ALWAYS `307` (method-preserving, non-cacheable). The host-preserving HTTP→HTTPS upgrade for non-friendly hosts stays `301` exactly as today.
- Bare-IP and `localhost` Hosts are NEVER redirected (break-glass rule, spec §Decision).
- No app content over plain HTTP — the `:80` friendly-host OFF server serves ONLY the static status page + the one read-only `/api/tls/status` proxy leg.
- `DROPLET_LAN_DNS_AUTHORITY` is an EXPLICIT 0/1 env knob (repo "no guessing" rule): written by `scripts/lib/single-box.sh`, defaulted `0` in compose. Never derive it.
- Scripts COPY'd into the nginx image are `#!/bin/sh` POSIX (dash), not bash. Host scripts under `scripts/` are bash.
- NEVER `npm install` inside this worktree — the root checkout's `node_modules` is shared; only re-run `npx prisma generate` from the repo root if Prisma types are stale.
- Pre-existing red baseline (do NOT chase): argon2-under-vitest, a11y source-regex, tour/matter suites. Compare failures against `main` before assuming they're yours.
- No new `MATTER_*` env vars; no `while True`-style scheduling loops (the status page's browser `setTimeout` chain is event-driven client polling, not service scheduling — allowed).
- Commit after every task with conventional-commit messages ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Render script + OFF variant + behavior tests

The container-side brain: decides ON/OFF from (knob AND cert-artifact checks) and writes the include. The OFF output must be byte-identical to the tracked default `canonical-host.off.conf` that the Dockerfile bakes (Task 3) — the test enforces this so the two can't drift.

**Files:**
- Create: `docker/nginx/render-canonical-host.sh`
- Create: `docker/nginx/canonical-host.off.conf`
- Create: `tests/nginx-canonical-host.test.sh`

**Interfaces:**
- Consumes: `/etc/nginx/certs/droplet.crt` (mounted, may be absent), env `DROPLET_LAN_DNS_AUTHORITY` (0/1), env overrides `DROPLET_CANONICAL_CERT` / `DROPLET_CANONICAL_OUT` (test seams).
- Produces: `/etc/nginx/canonical-host.active.conf` defining `map $host $canonical_target` (empty string = no redirect) — Task 3's `nginx.conf` references `$canonical_target`; Task 4 execs this script by absolute path `/usr/local/bin/render-canonical-host.sh`.

- [ ] **Step 1: Write the failing test (behavior half)**

Create `tests/nginx-canonical-host.test.sh` (mode 755). Full content:

```bash
#!/usr/bin/env bash
# =============================================================================
# Warning-free droplet.local — canonical-host redirect artifact + behavior
# checks (no Docker). Mirrors tests/nginx-internal-scheme.test.sh.
#
#   * render-canonical-host.sh decisions: knob off → OFF; self-signed → OFF;
#     CA-signed+valid+knob → ON with the right target; friendly/invalid SANs
#     filtered; charset defense.
#   * OFF render output is byte-identical to the baked canonical-host.off.conf.
#   * nginx.conf includes the active file, moved the :80 server out, added the
#     :443 canonical 307.
#   * Dockerfile bakes script + entrypoint + default + status page.
#   * compose passes DROPLET_LAN_DNS_AUTHORITY to the gateway.
#   * tls-reload.sh re-renders before reloading.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_DIR="$REPO_ROOT/docker/nginx"
RENDER="$NGINX_DIR/render-canonical-host.sh"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  nginx canonical-host redirect checks (no Docker)"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- cert fixtures -----------------------------------------------------------
# Self-signed (bootstrap-shaped): even with a public SAN it must render OFF.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/self.key" \
  -out "$WORK/self.crt" -subj "/CN=Droplet Edge Device" -days 2 \
  -addext "subjectAltName=DNS:droplet.local,DNS:d-abc123.devices.warp-lab.ai" \
  >/dev/null 2>&1

# CA-signed leaf (LE-shaped): mini root + leaf with SANs.
make_leaf() { # $1 = out cert path, $2 = subjectAltName value
  openssl req -newkey rsa:2048 -nodes -keyout "$WORK/leaf.key" \
    -out "$WORK/leaf.csr" -subj "/CN=leaf" >/dev/null 2>&1
  printf 'subjectAltName=%s\n' "$2" > "$WORK/san.cnf"
  openssl x509 -req -in "$WORK/leaf.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
    -CAcreateserial -days 2 -extfile "$WORK/san.cnf" -out "$1" >/dev/null 2>&1
}
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/ca.key" \
  -out "$WORK/ca.crt" -subj "/CN=Fake Root" -days 2 >/dev/null 2>&1
make_leaf "$WORK/le.crt"       "DNS:mybox.droplet-us.com"
make_leaf "$WORK/le-mixed.crt" "DNS:droplet.local,DNS:mybox.droplet-us.com"
make_leaf "$WORK/le-bad.crt"   "DNS:bad_host.droplet-us.com"

run_render() { # $1 = authority, $2 = cert path ("" = missing file)
  local out="$WORK/out.$$.conf"
  rm -f "$out"
  DROPLET_LAN_DNS_AUTHORITY="$1" \
  DROPLET_CANONICAL_CERT="${2:-$WORK/nonexistent.crt}" \
  DROPLET_CANONICAL_OUT="$out" \
    sh "$RENDER" >/dev/null 2>&1
  cat "$out" 2>/dev/null
  rm -f "$out"
}

# 1) knob=0 + valid LE-shaped cert → OFF (deployment-shape gate wins).
if run_render 0 "$WORK/le.crt" | grep -q 'redirect: OFF'; then
  pass "authority=0 renders OFF even with a CA-signed cert"
else
  fail "authority=0 did not render OFF"
fi

# 2) knob=1 + self-signed → OFF (bootstrap cert never redirects).
if run_render 1 "$WORK/self.crt" | grep -q 'redirect: OFF'; then
  pass "self-signed cert renders OFF"
else
  fail "self-signed cert did not render OFF"
fi

# 3) knob=1 + missing cert → OFF.
if run_render 1 "" | grep -q 'redirect: OFF'; then
  pass "missing cert renders OFF"
else
  fail "missing cert did not render OFF"
fi

# 4) knob=1 + CA-signed → ON; all four friendly names map to the target.
on_out="$(run_render 1 "$WORK/le.crt")"
ok=true
for name in droplet.local droplet-ai.local droplet.lan droplet-ai.lan; do
  printf '%s\n' "$on_out" | grep -qE "^[[:space:]]*${name}[[:space:]]+\"https://mybox\.droplet-us\.com\";" || ok=false
done
printf '%s\n' "$on_out" | grep -q 'return 307 \$canonical_target\$request_uri;' || ok=false
printf '%s\n' "$on_out" | grep -q 'return 301 https://\$host\$request_uri;' || ok=false
if [ "$ok" = true ]; then
  pass "CA-signed cert renders ON: 4 friendly names → 307 target, others → 301 upgrade"
else
  fail "ON render is missing a friendly-name mapping or the 307/301 returns"
fi

# 5) friendly SANs are filtered out of target selection.
if run_render 1 "$WORK/le-mixed.crt" | grep -q '"https://mybox.droplet-us.com"'; then
  pass "target selection skips .local/.lan SANs"
else
  fail "target selection picked a friendly SAN (or none)"
fi

# 6) charset defense: a SAN with an nginx-unsafe character renders OFF.
if run_render 1 "$WORK/le-bad.crt" | grep -q 'redirect: OFF'; then
  pass "unsafe SAN charset renders OFF (config-injection defense)"
else
  fail "unsafe SAN was rendered into the config"
fi

# 7) OFF render output is byte-identical to the baked default variant.
if [ "$(run_render 0 "$WORK/le.crt")" = "$(cat "$NGINX_DIR/canonical-host.off.conf")" ]; then
  pass "OFF render is byte-identical to canonical-host.off.conf"
else
  fail "OFF render drifted from canonical-host.off.conf"
fi

# 8) the render script uses checkend (expiry gate) — not constructible as a
#    fixture with `openssl x509 -req`, so assert the artifact.
if grep -q 'checkend 0' "$RENDER"; then
  pass "render script gates on cert expiry (openssl -checkend 0)"
else
  fail "render script is missing the expiry gate"
fi

# 9) OFF variant: status page served ONLY on friendly hosts, one proxy leg,
#    no app proxying over HTTP.
off="$NGINX_DIR/canonical-host.off.conf"
if grep -qE 'server_name[[:space:]]+droplet\.local[[:space:]]+droplet-ai\.local[[:space:]]+droplet\.lan[[:space:]]+droplet-ai\.lan;' "$off" \
   && grep -q 'root /usr/share/nginx/tls-status;' "$off" \
   && [ "$(grep -c 'proxy_pass' "$off")" -eq 1 ] \
   && grep -q 'orchestrator:3000' "$off" \
   && ! grep -q 'web-dashboard' "$off"; then
  pass "OFF variant: status page + single /api/tls/status leg, no app over HTTP"
else
  fail "OFF variant server blocks are wrong"
fi

# --- Wiring checks (fail until Tasks 3-4 land; listed here so one file guards
# --- the whole feature) -------------------------------------------------------
conf="$NGINX_DIR/nginx.conf"
if grep -qE 'include[[:space:]]+/etc/nginx/canonical-host\.active\.conf;' "$conf" \
   && grep -q 'return 307 \$canonical_target\$request_uri;' "$conf"; then
  pass "nginx.conf includes canonical-host.active.conf + :443 canonical 307"
else
  fail "nginx.conf is missing the include or the :443 canonical 307"
fi
# the old bare :80 server must be GONE from nginx.conf (moved into the variants)
if [ "$(grep -c 'listen 80' "$conf")" -eq 0 ]; then
  pass "nginx.conf no longer declares its own :80 server (moved to variants)"
else
  fail "nginx.conf still has a :80 server — friendly hosts would be forced to HTTPS"
fi

df="$NGINX_DIR/Dockerfile"
if grep -q 'render-canonical-host.sh' "$df" \
   && grep -q '02-canonical-host.sh' "$df" \
   && grep -q 'canonical-host.off.conf /etc/nginx/canonical-host.active.conf' "$df" \
   && grep -q 'tls-status/index.html' "$df"; then
  pass "Dockerfile bakes render script + entrypoint + OFF default + status page"
else
  fail "Dockerfile is missing a canonical-host artifact"
fi

compose="$REPO_ROOT/docker/docker-compose.yml"
if grep -qE 'DROPLET_LAN_DNS_AUTHORITY=\$\{DROPLET_LAN_DNS_AUTHORITY:-0\}' "$compose"; then
  pass "compose: gateway gets DROPLET_LAN_DNS_AUTHORITY (default 0)"
else
  fail "compose gateway is missing the DROPLET_LAN_DNS_AUTHORITY knob"
fi

if grep -q 'render-canonical-host.sh' "$REPO_ROOT/scripts/lib/tls-reload.sh"; then
  pass "tls-reload.sh re-renders the canonical-host include before reloading"
else
  fail "tls-reload.sh is missing the render hook"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS tests/nginx-canonical-host.test.sh ($TESTS checks)"
  exit 0
fi
echo "FAIL tests/nginx-canonical-host.test.sh ($FAILURES/$TESTS failed)"
exit 1
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/nginx-canonical-host.test.sh`
Expected: FAIL — every check red (render script and variant file don't exist yet). The wiring checks (nginx.conf/Dockerfile/compose/tls-reload) stay red until Tasks 3–4; that's expected — do NOT try to make them pass in this task.

- [ ] **Step 3: Write `docker/nginx/canonical-host.off.conf`**

Exact content (the render script's OFF heredoc must match byte-for-byte):

```nginx
# RENDERED by render-canonical-host.sh — DO NOT EDIT (redirect: OFF)
# Warning-free droplet.local (ADR-023 follow-through): no valid publicly-
# trusted cert is installed (or this box doesn't own the LAN's DNS), so the
# friendly names serve the plain-HTTP status page — NEVER a forced HTTPS
# upgrade into the self-signed interstitial, and NEVER app content over HTTP.
map $host $canonical_target {
    default "";
}
server {
    listen 80;
    server_name droplet.local droplet-ai.local droplet.lan droplet-ai.lan;
    root /usr/share/nginx/tls-status;
    location = /api/tls/status {
        set $upstream_orchestrator "orchestrator:3000";
        proxy_pass http://$upstream_orchestrator/api/tls/status;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        try_files /index.html =404;
    }
}
server {
    listen 80 default_server;
    return 301 https://$host$request_uri;
}
```

- [ ] **Step 4: Write `docker/nginx/render-canonical-host.sh`** (mode 755)

```sh
#!/bin/sh
# render-canonical-host.sh — write /etc/nginx/canonical-host.active.conf from
# the installed cert artifact + the DROPLET_LAN_DNS_AUTHORITY knob.
#
# Warning-free droplet.local (ADR-023 follow-through): the friendly .local/.lan
# names 307-redirect to the publicly-trusted per-device FQDN when — and only
# when — ALL of these hold (spec §2):
#   (a) DROPLET_LAN_DNS_AUTHORITY=1 (box owns the LAN's DHCP/DNS; without it
#       the FQDN is unresolvable client-side and a redirect would dead-end),
#   (b) the installed droplet.crt is NOT self-issued (bootstrap cert),
#   (c) it is unexpired,
#   (d) it carries a public (non-.local/.lan) DNS SAN — that SAN IS the
#       redirect target, so the redirect can never point at a name the served
#       cert doesn't cover.
# Anything else renders the OFF variant (status page on :80, no redirect).
#
# Runs (1) at container start via /docker-entrypoint.d/02-canonical-host.sh and
# (2) via `docker compose exec -T gateway ...` from scripts/lib/tls-reload.sh
# before every reload, so cert swaps and redirect posture change together.
#
# Test seams: DROPLET_CANONICAL_CERT / DROPLET_CANONICAL_OUT override paths.
set -eu

CERT="${DROPLET_CANONICAL_CERT:-/etc/nginx/certs/droplet.crt}"
OUT="${DROPLET_CANONICAL_OUT:-/etc/nginx/canonical-host.active.conf}"
AUTHORITY="${DROPLET_LAN_DNS_AUTHORITY:-0}"

# MUST stay in sync with scripts/lib/secrets.sh::_generate_tls_cert's SAN set
# and trust-droplet-cert.sh. tests/nginx-canonical-host.test.sh guards it.
FRIENDLY_NAMES="droplet.local droplet-ai.local droplet.lan droplet-ai.lan"

write_off() {
  cat > "$OUT.tmp" <<'EOF'
# RENDERED by render-canonical-host.sh — DO NOT EDIT (redirect: OFF)
# Warning-free droplet.local (ADR-023 follow-through): no valid publicly-
# trusted cert is installed (or this box doesn't own the LAN's DNS), so the
# friendly names serve the plain-HTTP status page — NEVER a forced HTTPS
# upgrade into the self-signed interstitial, and NEVER app content over HTTP.
map $host $canonical_target {
    default "";
}
server {
    listen 80;
    server_name droplet.local droplet-ai.local droplet.lan droplet-ai.lan;
    root /usr/share/nginx/tls-status;
    location = /api/tls/status {
        set $upstream_orchestrator "orchestrator:3000";
        proxy_pass http://$upstream_orchestrator/api/tls/status;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        try_files /index.html =404;
    }
}
server {
    listen 80 default_server;
    return 301 https://$host$request_uri;
}
EOF
  mv "$OUT.tmp" "$OUT"
  echo '{"event":"canonical_host_render","gateway":"nginx","redirect":false}'
}

target=""
if [ "$AUTHORITY" = "1" ] && [ -f "$CERT" ]; then
  subj="$(openssl x509 -in "$CERT" -noout -subject 2>/dev/null | sed 's/^subject=//')" || subj=""
  iss="$(openssl x509 -in "$CERT" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" || iss=""
  if [ -n "$subj" ] && [ "$subj" != "$iss" ] \
     && openssl x509 -checkend 0 -noout -in "$CERT" >/dev/null 2>&1; then
    # First DNS SAN that isn't a LAN-only name = the redirect target.
    sans="$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null \
      | tr ',' '\n' | sed -n 's/.*DNS://p' | tr -d ' ')"
    for san in $sans; do
      case "$san" in
        *.local|*.lan|localhost) continue ;;
      esac
      target="$san"
      break
    done
  fi
fi

# Charset defense: the SAN is written into an nginx config — reject anything
# outside hostname characters rather than trusting the cert blindly.
case "$target" in
  ''|*[!a-zA-Z0-9.-]*) write_off; exit 0 ;;
esac

{
  printf '# RENDERED by render-canonical-host.sh — DO NOT EDIT (redirect: ON -> https://%s)\n' "$target"
  printf 'map $host $canonical_target {\n'
  printf '    default            "";\n'
  for name in $FRIENDLY_NAMES; do
    printf '    %-18s "https://%s";\n' "$name" "$target"
  done
  printf '}\n'
  printf 'server {\n'
  printf '    listen 80 default_server;\n'
  printf '    # 307: method-preserving + non-cacheable (posture can flip OFF).\n'
  printf '    if ($canonical_target != "") {\n'
  printf '        return 307 $canonical_target$request_uri;\n'
  printf '    }\n'
  printf '    # Non-friendly hosts (the FQDN itself, IPs): plain HTTPS upgrade.\n'
  printf '    return 301 https://$host$request_uri;\n'
  printf '}\n'
} > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "{\"event\":\"canonical_host_render\",\"gateway\":\"nginx\",\"redirect\":true,\"target\":\"$target\"}"
```

Then: `chmod +x docker/nginx/render-canonical-host.sh tests/nginx-canonical-host.test.sh`

- [ ] **Step 5: Run the test — behavior checks pass, wiring checks still fail**

Run: `bash tests/nginx-canonical-host.test.sh`
Expected: checks 1–9 (render decisions, OFF parity, variant content) PASS; the nginx.conf / Dockerfile / compose / tls-reload wiring checks still FAIL (Tasks 3–4). Overall exit 1 — fine at this stage.

- [ ] **Step 6: Commit**

```bash
git add docker/nginx/render-canonical-host.sh docker/nginx/canonical-host.off.conf tests/nginx-canonical-host.test.sh
git commit -m "feat(gateway): canonical-host render script + OFF variant for warning-free droplet.local

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The plain-HTTP status page

**Files:**
- Create: `docker/nginx/tls-status/index.html`

**Interfaces:**
- Consumes: `GET /api/tls/status` (same-origin, Task 5) returning `{ state, fqdn, redirectTo, hqConfigured }`.
- Produces: static page baked at `/usr/share/nginx/tls-status/index.html` (Task 3 COPYs it; Task 1's OFF variant `root`s it).

- [ ] **Step 1: Write the page**

Exact content of `docker/nginx/tls-status/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Droplet — securing your connection</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b1020; color: #e7eaf3;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.4rem; }
  .spinner { width: 2.5rem; height: 2.5rem; border: 3px solid #2a3354; border-top-color: #7aa2ff;
             border-radius: 50%; margin: 0 auto 1.5rem; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #airgap { display: none; text-align: left; background: #141a33; border-radius: 8px;
            padding: 1rem 1.25rem; margin-top: 1.5rem; font-size: .925rem; }
  code { background: #1d2547; padding: .1rem .35rem; border-radius: 4px; }
  a { color: #7aa2ff; }
</style>
</head>
<body>
<main>
  <div class="spinner" id="spinner"></div>
  <h1>Your Droplet is securing its connection…</h1>
  <p id="msg">This page will move to your Droplet's trusted address automatically. Nothing to do.</p>
  <div id="airgap">
    <strong>This Droplet can't obtain a certificate automatically.</strong>
    <p>If this box is intentionally offline (air-gapped), you have two options:</p>
    <ol>
      <li>Install the Droplet's certificate on this device once:
        <code>./scripts/trust-droplet-cert.sh</code>
        (Windows: <code>trust-droplet-cert.ps1</code>)</li>
      <li><a id="continue" href="https://droplet.local/">Continue anyway</a> —
        your browser will show a warning once.</li>
    </ol>
  </div>
</main>
<script>
  document.getElementById("continue").href = "https://" + location.host + "/";
  async function tick() {
    try {
      const r = await fetch("/api/tls/status", { cache: "no-store" });
      const s = await r.json();
      if (s.redirectTo) { location.replace(s.redirectTo); return; }
      if (s.hqConfigured === false) {
        document.getElementById("airgap").style.display = "block";
        document.getElementById("spinner").style.display = "none";
        document.getElementById("msg").textContent =
          "Automatic certificates are not available on this Droplet.";
      }
    } catch (e) { /* orchestrator still starting — keep polling */ }
    setTimeout(tick, 5000);
  }
  tick();
</script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check it renders**

Run: `open docker/nginx/tls-status/index.html` (macOS) — spinner + headline visible; the fetch fails silently (no orchestrator) and the page keeps polling without console spam beyond network errors.

- [ ] **Step 3: Commit**

```bash
git add docker/nginx/tls-status/index.html
git commit -m "feat(gateway): plain-HTTP TLS status page (cert-less droplet.local, no warning)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: nginx.conf restructure + entrypoint + Dockerfile + compose + CI

**Files:**
- Modify: `docker/nginx/nginx.conf:39-43` (delete `:80` server) and `nginx.conf:46-62` (add include + `:443` canonical 307)
- Create: `docker/nginx/docker-entrypoint-canonical-host.sh`
- Modify: `docker/nginx/Dockerfile:55-92`
- Modify: `docker/docker-compose.yml:99` (gateway environment block)
- Modify: `.github/workflows/setup-tests.yml` (paths ×2 + run step)

**Interfaces:**
- Consumes: `$canonical_target` from Task 1's rendered map; `/usr/local/bin/render-canonical-host.sh`.
- Produces: gateway image whose entrypoint renders at start; `DROPLET_LAN_DNS_AUTHORITY` reaches the container (read by the render script both at start and via Task 4's `exec`).

- [ ] **Step 1: Edit `nginx.conf`**

Replace the `:80` server block (lines 39–43):

```nginx
    # ── HTTP: redirect everything to HTTPS ──
    server {
        listen 80;
        return 301 https://$host$request_uri;
    }
```

with:

```nginx
    # ── HTTP (:80) + the canonical-host map live in the RENDERED include ──
    # Warning-free droplet.local: /docker-entrypoint.d/02-canonical-host.sh
    # (container start) and scripts/lib/tls-reload.sh (every cert swap) run
    # render-canonical-host.sh, which writes this file. Redirect ON → friendly
    # names 307 to the trusted FQDN; OFF → friendly names get the plain-HTTP
    # status page (no forced HTTPS upgrade), everything else 301s to HTTPS.
    include /etc/nginx/canonical-host.active.conf;
```

In the `:443` server, directly after the HSTS `add_header` line (line 61), insert:

```nginx
        # Canonical-host redirect (warning-free droplet.local): a friendly
        # .local/.lan Host with the redirect ON bounces to the trusted FQDN.
        # This leg only fires AFTER a client clicked through the (unavoidable)
        # interstitial on an old explicit-https bookmark — it heals the
        # bookmark. 307 = method-preserving, non-cacheable. NOTE: browsers
        # ignore the HSTS header above on untrusted connections, so it cannot
        # wedge .local clients.
        if ($canonical_target != "") {
            return 307 $canonical_target$request_uri;
        }
```

- [ ] **Step 2: Create `docker/nginx/docker-entrypoint-canonical-host.sh`** (mode 755)

```sh
#!/bin/sh
# 02-canonical-host.sh — render the canonical-host include at container start
# (warning-free droplet.local). Same /docker-entrypoint.d slot pattern as
# 00-fips-profile.sh / 01-internal-scheme.sh. The render script re-runs on
# every cert swap via scripts/lib/tls-reload.sh.
set -eu
/usr/local/bin/render-canonical-host.sh
```

- [ ] **Step 3: Edit the Dockerfile**

After the WARP-1061 COPY block (line 57), add:

```dockerfile
# Warning-free droplet.local: the canonical-host render script (start +
# exec'd by tls-reload.sh on every cert swap), its entrypoint slot, the baked
# OFF default (so `nginx -t` and a bare run are well-formed pre-entrypoint),
# and the plain-HTTP status page the OFF variant serves.
COPY docker/nginx/render-canonical-host.sh          /usr/local/bin/render-canonical-host.sh
COPY docker/nginx/docker-entrypoint-canonical-host.sh /docker-entrypoint.d/02-canonical-host.sh
COPY docker/nginx/canonical-host.off.conf           /etc/nginx/canonical-host.active.conf
COPY docker/nginx/tls-status/index.html             /usr/share/nginx/tls-status/index.html
```

Extend the existing `chmod +x` RUN (line 58) to include the two new scripts:

```dockerfile
RUN chmod +x /docker-entrypoint.d/00-fips-profile.sh /docker-entrypoint.d/01-internal-scheme.sh \
             /docker-entrypoint.d/02-canonical-host.sh /usr/local/bin/render-canonical-host.sh && \
```

Inside the build-time self-test RUN (before the final `rm -f /tmp/t.key ...` line), add a canonical-host parse test of BOTH variants (sh-compatible — no process substitution):

```dockerfile
    # Warning-free droplet.local: both canonical-host variants must parse.
    # OFF = the baked default; ON = a real render against a mini-CA leaf.
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ca.key -out /tmp/ca.crt \
      -subj /CN=TestCA -days 1 >/dev/null 2>&1; \
    openssl req -newkey rsa:2048 -nodes -keyout /tmp/l.key -out /tmp/l.csr \
      -subj /CN=leaf >/dev/null 2>&1; \
    printf 'subjectAltName=DNS:test-box.droplet-us.com\n' > /tmp/san.cnf; \
    openssl x509 -req -in /tmp/l.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial \
      -days 1 -extfile /tmp/san.cnf -out /tmp/l.crt >/dev/null 2>&1; \
    DROPLET_LAN_DNS_AUTHORITY=1 DROPLET_CANONICAL_CERT=/tmp/l.crt \
      DROPLET_CANONICAL_OUT=/tmp/ch-on.conf /usr/local/bin/render-canonical-host.sh; \
    grep -q 'test-box.droplet-us.com' /tmp/ch-on.conf; \
    for ch in /etc/nginx/canonical-host.active.conf /tmp/ch-on.conf; do \
      printf 'events{}\nhttp{\n resolver 127.0.0.11 valid=10s ipv6=off;\n include %s;\n}\n' "$ch" > /tmp/test-nginx.conf; \
      nginx -t -c /tmp/test-nginx.conf; \
    done; \
    rm -f /tmp/ca.key /tmp/ca.crt /tmp/ca.srl /tmp/l.key /tmp/l.csr /tmp/l.crt /tmp/san.cnf /tmp/ch-on.conf; \
    echo "canonical-host self-test OK — OFF + ON variants render and parse"; \
```

- [ ] **Step 4: Compose knob**

In the gateway `environment:` block (after line 99, `DROPLET_INTERNAL_TLS`):

```yaml
      # Warning-free droplet.local: render-canonical-host.sh only turns the
      # friendly-name → FQDN redirect ON when this box owns the LAN's
      # DHCP/DNS (the split-horizon FQDN is unresolvable otherwise). Written
      # 1 by scripts/lib/single-box.sh, absent/0 on every other shape.
      - DROPLET_LAN_DNS_AUTHORITY=${DROPLET_LAN_DNS_AUTHORITY:-0}
```

- [ ] **Step 5: CI wiring**

In `.github/workflows/setup-tests.yml`, add `- "tests/nginx-canonical-host.test.sh"` to BOTH `paths:` lists (next to the two existing `nginx-internal-scheme` entries), and after the "Run nginx internal-scheme unit tests" step add:

```yaml
      - name: Run nginx canonical-host unit tests
        # Warning-free droplet.local: render decisions (authority knob +
        # cert-artifact gates), variant contents, nginx.conf/Dockerfile/
        # compose wiring, tls-reload render hook. Pure bash, no Docker.
        run: bash tests/nginx-canonical-host.test.sh
```

- [ ] **Step 6: Run the artifact test — only the tls-reload check should still fail**

Run: `bash tests/nginx-canonical-host.test.sh`
Expected: everything green except "tls-reload.sh re-renders…" (Task 4). Also confirm no regression: `bash tests/nginx-internal-scheme.test.sh` → PASS.

- [ ] **Step 7: Full-config parse check with real mounts (Docker required; skip if no Docker)**

```bash
tmp=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/droplet.key" -out "$tmp/droplet.crt" -subj /CN=t -days 1
docker build -f docker/nginx/Dockerfile -t droplet-gateway-test .
docker run --rm \
  -v "$PWD/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$tmp:/etc/nginx/certs:ro" \
  droplet-gateway-test nginx -t
rm -rf "$tmp"
```
Expected: build succeeds (self-test line "canonical-host self-test OK" in output) and `nginx -t` prints "syntax is ok / test is successful" — this exercises the edited nginx.conf INCLUDING the `:443` `if ($canonical_target ...)` against the baked OFF map.

- [ ] **Step 8: Commit**

```bash
git add docker/nginx/nginx.conf docker/nginx/Dockerfile docker/nginx/docker-entrypoint-canonical-host.sh docker/docker-compose.yml .github/workflows/setup-tests.yml
git commit -m "feat(gateway): wire canonical-host redirect — nginx.conf include + :443 307, entrypoint, compose knob, CI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: tls-reload.sh render hook

Every cert writer already funnels through `reload_gateway_nginx()` — hook the render there so posture and cert swap atomically from the caller's perspective.

**Files:**
- Modify: `scripts/lib/tls-reload.sh:56-67`

**Interfaces:**
- Consumes: `/usr/local/bin/render-canonical-host.sh` inside the gateway container (Task 3 bakes it; the container env carries `DROPLET_LAN_DNS_AUTHORITY` from compose).
- Produces: nothing new — same `reload_gateway_nginx` contract (0 unless a running gateway genuinely fails to reload).

- [ ] **Step 1: Edit `reload_gateway_nginx`**

Between the "gateway is running" check (line 62) and the reload exec (line 64), insert:

```bash
  # Warning-free droplet.local: re-render the canonical-host include from the
  # freshly-written cert BEFORE reloading, so one reload picks up both the new
  # cert and the matching redirect posture. Best-effort: a render failure
  # (e.g. an older gateway image without the script) must never block serving
  # the new cert — the entrypoint re-renders on the next container start.
  if ! docker compose -f "$compose_file" exec -T gateway \
       /usr/local/bin/render-canonical-host.sh >/dev/null 2>&1; then
    log_warn "reload_gateway_nginx: canonical-host render failed — redirect posture unchanged (cert reload continues)"
  fi
```

- [ ] **Step 2: Run the artifact test — all green now**

Run: `bash tests/nginx-canonical-host.test.sh`
Expected: `PASS tests/nginx-canonical-host.test.sh` (all checks), exit 0.

- [ ] **Step 3: Regression: the setup suite still passes**

Run: `bash tests/setup.test.sh`
Expected: PASS (tls-reload.sh is sourced by secrets.sh paths this suite covers).

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/tls-reload.sh
git commit -m "feat(tls): re-render canonical-host redirect posture on every gateway cert reload

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Orchestrator `GET /api/tls/status` (public, read-only)

**Files:**
- Create: `apps/orchestrator/src/routes/tls-status.public.route.ts`
- Create: `apps/orchestrator/src/routes/tls-status.public.route.test.ts`
- Modify: `apps/orchestrator/src/app.ts` (~line 198, BEFORE `app.use(authMiddleware)` at line 223)

**Interfaces:**
- Consumes: Prisma model `TlsCert` (`fqdn`, `state: TlsCertState`, `notAfter`, `updatedAt`) and `config.DROPLET_PUBLIC_FQDN` / `config.HQ_ISSUANCE_URL` (import `{ config } from "../config.js"` — same as `tls-issuance.adapters.ts:20`).
- Produces: `GET /api/tls/status` → `200 { state: TlsCertStateValue, fqdn: string|null, redirectTo: string|null, hqConfigured: boolean }`. `redirectTo` is non-null iff `state === "LE_ISSUED"` and an fqdn is known — Task 2's page keys its auto-advance on exactly this field.

- [ ] **Step 1: Write the failing test**

`apps/orchestrator/src/routes/tls-status.public.route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createTlsStatusPublicRouter } from "./tls-status.public.route.js";

function appWith(row: unknown, findFirst?: () => Promise<unknown>) {
  const prisma = {
    tlsCert: { findFirst: findFirst ?? (async () => row) },
  } as never;
  const app = express();
  app.use("/api", createTlsStatusPublicRouter(prisma));
  return app;
}

describe("GET /api/tls/status (public)", () => {
  it("reports LE_ISSUED with a redirect target", async () => {
    const res = await request(
      appWith({ fqdn: "mybox.droplet-us.com", state: "LE_ISSUED", notAfter: new Date() }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("LE_ISSUED");
    expect(res.body.fqdn).toBe("mybox.droplet-us.com");
    expect(res.body.redirectTo).toBe("https://mybox.droplet-us.com/");
  });

  it("reports bootstrap state with NO redirect target", async () => {
    const res = await request(
      appWith({ fqdn: "d-abc.devices.warp-lab.ai", state: "BOOTSTRAP_SELF_SIGNED", notAfter: null }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(res.body.redirectTo).toBeNull();
  });

  it("handles a box with no TlsCert row yet", async () => {
    const res = await request(appWith(null)).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(res.body.redirectTo).toBeNull();
    expect(typeof res.body.hqConfigured).toBe("boolean");
  });

  it("degrades to 503 without leaking when the DB read throws", async () => {
    const res = await request(
      appWith(null, async () => {
        throw new Error("db down");
      }),
    ).get("/api/tls/status");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      state: "UNKNOWN",
      fqdn: null,
      redirectTo: null,
      hqConfigured: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/routes/tls-status.public.route.test.ts`
Expected: FAIL — `Cannot find module './tls-status.public.route.js'`.

- [ ] **Step 3: Write the route**

`apps/orchestrator/src/routes/tls-status.public.route.ts`:

```ts
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

/**
 * Warning-free droplet.local (ADR-023 follow-through, spec §3): the gateway's
 * plain-HTTP status page polls this to auto-advance to the trusted FQDN the
 * moment issuance lands. PUBLIC by design — it runs BEFORE any login can
 * exist and rides plain HTTP on the LAN, so the payload carries NO device
 * secrets: cert lifecycle state, the (CT-public) FQDN, and whether HQ
 * issuance is configured at all (drives the page's air-gapped branch).
 * Mounted in app.ts BEFORE authMiddleware, like the other public routers.
 */
export function createTlsStatusPublicRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/tls/status", async (_req, res) => {
    try {
      const row = await prisma.tlsCert.findFirst({ orderBy: { updatedAt: "desc" } });
      const fqdn = row?.fqdn || config.DROPLET_PUBLIC_FQDN || null;
      const state = row?.state ?? "BOOTSTRAP_SELF_SIGNED";
      res.json({
        state,
        fqdn,
        redirectTo: state === "LE_ISSUED" && fqdn ? `https://${fqdn}/` : null,
        hqConfigured: Boolean(config.HQ_ISSUANCE_URL),
      });
    } catch {
      // The page treats any non-advance answer as "keep polling" — degrade
      // without leaking error internals onto an unauthenticated surface.
      res.status(503).json({ state: "UNKNOWN", fqdn: null, redirectTo: null, hqConfigured: false });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/routes/tls-status.public.route.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Mount it in app.ts**

Add the import next to the other route imports:

```ts
import { createTlsStatusPublicRouter } from "./routes/tls-status.public.route.js";
```

then after the `createDeviceSelfRevokeRouter` mount (line ~198) and BEFORE `app.use(authMiddleware)` (line ~223):

```ts
  // Warning-free droplet.local: the gateway's plain-HTTP status page polls
  // this before any session exists — public, read-only, secret-free.
  app.use("/api", createTlsStatusPublicRouter(prisma));
```

- [ ] **Step 6: Typecheck + targeted suites**

Run: `cd apps/orchestrator && npx tsc --noEmit && npx vitest run src/routes/tls-status.public.route.test.ts src/__tests__/auth.middleware.test.ts`
Expected: tsc clean; both suites pass (auth middleware suite proves the public mount didn't disturb the auth chain).

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/routes/tls-status.public.route.ts apps/orchestrator/src/routes/tls-status.public.route.test.ts apps/orchestrator/src/app.ts
git commit -m "feat(orchestrator): public GET /api/tls/status for the gateway TLS status page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The `DROPLET_LAN_DNS_AUTHORITY` knob + FQDN-first setup output + docs

**Files:**
- Modify: `scripts/lib/single-box.sh` (~line 774, in the `upsert_env` knob block)
- Modify: `scripts/setup.sh:620-647` (completion message)
- Modify: `docs/ENVIRONMENT.md` (new row, follow the file's existing format)

**Interfaces:**
- Consumes: `upsert_env <key> <val>` (local helper defined at `single-box.sh:532`); `$REPO_ROOT/.env`.
- Produces: `DROPLET_LAN_DNS_AUTHORITY=1` in `.env` on single-box shapes — compose (Task 3) forwards it to the gateway.

- [ ] **Step 1: single-box knob**

In the knob block (after `upsert_env ROUTING_MODE real`, line ~774), add:

```bash
  # Warning-free droplet.local: on the single-box shape this box IS the
  # router — its dnsmasq answers the split-horizon FQDN for every DHCP
  # client, so the gateway may 307 droplet.local → the trusted FQDN. On any
  # other shape the FQDN is client-unresolvable and the knob stays 0 (compose
  # default), keeping today's behavior. EXPLICIT, never derived.
  upsert_env DROPLET_LAN_DNS_AUTHORITY 1
```

- [ ] **Step 2: FQDN-first completion message**

In `scripts/setup.sh`, the completion block prints `https://droplet-ai.local` first (line 623). Change the block so the trusted FQDN leads when known (read it from the env file the surrounding code already references — same pattern as `single-box.sh:552`'s `grep -E '^COMPOSE_PROFILES=' ... || true` guard):

```bash
  # (plain assignment — confirm whether the surrounding block is a function
  # before adding `local`; the existing block at setup.sh:620 sets the style)
  _fqdn=$(grep -E '^DROPLET_PUBLIC_FQDN=' "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ -n "$_fqdn" ]; then
    printf "  Dashboard:     ${_CYAN}https://%s${_RESET} (trusted — green padlock, works on LAN and over VPN)\n" "$_fqdn"
    printf "  Shortcut:      type ${_CYAN}droplet.local${_RESET} in any browser on this network — it lands there\n"
  else
    printf "  Dashboard:     ${_CYAN}https://droplet-ai.local${_RESET} (mDNS) or ${_CYAN}https://droplet-ai.lan${_RESET} (router DNS)\n"
  fi
```

(Keep the existing API line and the trust-script fallback lines 646–647 as they are — the fallback text is already correctly framed.)

- [ ] **Step 3: ENVIRONMENT.md row**

Add a `DROPLET_LAN_DNS_AUTHORITY` entry following the file's existing per-variable format: default `0`; set to `1` by `setup.sh` on the single-box shape (box owns LAN DHCP/DNS); consumed by the `gateway` container's `render-canonical-host.sh`; when `1` AND a valid publicly-trusted cert is installed, `droplet.local`/`droplet-ai.local`/`droplet.lan`/`droplet-ai.lan` 307-redirect to the per-device FQDN; when `0` those names serve the plain-HTTP TLS status page instead of forcing HTTPS. Never hand-derive; never set on shapes where clients don't use the box's dnsmasq.

- [ ] **Step 4: Run setup + wiring suites**

Run: `bash tests/setup.test.sh && bash tests/internal-mtls-wiring.test.sh && bash tests/nginx-canonical-host.test.sh`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/single-box.sh scripts/setup.sh docs/ENVIRONMENT.md
git commit -m "feat(setup): DROPLET_LAN_DNS_AUTHORITY knob (single-box) + FQDN-first completion message

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Provisioning-bench gate in verify.sh

**Files:**
- Modify: `scripts/verify.sh` (add the helper near the other check functions; add the check in the TLS/security section — find it via `grep -n "TLS\|cert" scripts/verify.sh`)

**Interfaces:**
- Consumes: `check` / `check_warn` helpers (`verify.sh:78-107` — confirm exact names before use; the hard-fail helper is the one that increments `FAIL_COUNT`), `$REPO_ROOT`.
- Produces: bench runbook command `DROPLET_PROVISIONING=1 ./scripts/verify.sh` fails unless a publicly-trusted unexpired cert is installed (spec §4's "padlock green on the bench" gate).

- [ ] **Step 1: Add the check**

```bash
# Warning-free droplet.local (spec §4): the provisioning bench must not box a
# device that would greet its customer with a cert warning. Same artifact
# checks render-canonical-host.sh uses: not self-issued + unexpired.
_trusted_tls_cert_active() {
  local cert="$REPO_ROOT/docker/certs/droplet.crt"
  [ -f "$cert" ] || return 1
  local subj iss
  subj=$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject=//') || return 1
  iss=$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null | sed 's/^issuer=//') || return 1
  [ -n "$subj" ] && [ "$subj" != "$iss" ] || return 1
  openssl x509 -checkend 0 -noout -in "$cert" >/dev/null 2>&1
}

if [ "${DROPLET_PROVISIONING:-0}" = "1" ]; then
  check "Publicly-trusted TLS cert (provisioning gate)" _trusted_tls_cert_active
else
  check_warn "Publicly-trusted TLS cert" _trusted_tls_cert_active
fi
```

- [ ] **Step 2: Verify both modes by hand**

Run: `./scripts/verify.sh 2>/dev/null | grep -i "trusted TLS"` → WARN (dev box has a self-signed cert) — the script still exits per its normal pass/warn rules.
Run: `DROPLET_PROVISIONING=1 ./scripts/verify.sh 2>/dev/null | grep -i "trusted TLS"` → FAIL line appears and the script's exit code is non-zero.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify.sh
git commit -m "feat(verify): provisioning-bench gate — fail unless a publicly-trusted TLS cert is installed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Shell suites**

Run: `bash tests/nginx-canonical-host.test.sh && bash tests/nginx-internal-scheme.test.sh && bash tests/setup.test.sh && bash tests/internal-mtls-wiring.test.sh`
Expected: all PASS.

- [ ] **Step 2: Orchestrator**

Run: `cd apps/orchestrator && npx tsc --noEmit && npx vitest run src/routes/tls-status.public.route.test.ts`
Expected: clean tsc, suite green. (Full `npm run test:orchestrator` optional — compare any reds against the known baseline on `main` before investigating.)

- [ ] **Step 3: Live smoke (Docker available)**

```bash
docker build -f docker/nginx/Dockerfile -t droplet-gateway-test .
tmp=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/droplet.key" -out "$tmp/droplet.crt" -subj /CN=t -days 1
# OFF posture (self-signed cert): friendly host gets the status page, not a 301.
docker run --rm -d --name ch-test -p 8080:80 \
  -v "$PWD/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$tmp:/etc/nginx/certs:ro" \
  -e DROPLET_LAN_DNS_AUTHORITY=1 droplet-gateway-test
sleep 2
curl -s -H "Host: droplet.local" http://localhost:8080/ | grep -q "securing its connection" && echo "OFF: status page OK"
curl -s -o /dev/null -w '%{http_code}' -H "Host: 192.168.1.87" http://localhost:8080/   # → 301 (IP-ish host upgrades)
docker rm -f ch-test; rm -rf "$tmp"
```
Expected: "OFF: status page OK" and `301`. (The ON posture needs a CA-signed cert — covered by the build self-test and Task 1's render tests; full E2E is the hardware gate below.)

- [ ] **Step 4: Record the hardware E2E gate (not executable here)**

Per spec §Testing, the final acceptance is on `192.168.1.87`: type `droplet.local` in Chrome/Safari/Firefox on LAN → padlocked FQDN; over VPN via the FQDN; old `https://droplet.local` bookmark → one interstitial → FQDN. Also verify the spec §4 assumption on hardware: the split-horizon dnsmasq host-record (FQDN → LAN IP) written at install time survives a power-cycle/"move" with NO setup re-run. Note both in the PR body as the remaining manual gate.

- [ ] **Step 5: Commit anything outstanding, then run the preflight skill before opening the PR.**
