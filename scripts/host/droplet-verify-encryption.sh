#!/usr/bin/env bash
# =============================================================================
# WARP-966 — droplet-verify-encryption: on-hardware encryption verification
# (rest + transit) producing a signed, hash-chained evidence bundle.
#
# One command on the appliance —
#     sudo bash scripts/host/droplet-verify-encryption.sh
# — probes data-at-rest (LUKS2) and every in-transit hop (Postgres, Redis,
# MQTT, internal service mesh, nginx edge) and emits a signed, timestamped,
# hash-chained evidence bundle under $DROPLET_VFY_OUTPUT_ROOT satisfying the
# WARP-966 acceptance criteria.
#
# CONTRACT (same rule as droplet-watchdog.sh — explicit enums, never inferred
# from absence): every registered check ALWAYS appears in the report with one of
# PASS | FAIL | SKIP. A missing subsystem (no LUKS device, tls-port closed,
# tcpdump not installed, container not running) is a SKIP with a reason or a
# posture FAIL — never a crash. The runner is `set -u` (NOT `set -e`): a
# verification pass must survive any single probe failing and still write the
# bundle.
#
# EXIT CODES:
#   0  no FAIL (SKIPs allowed and listed)
#   1  >= 1 FAIL (bundle still fully produced — the AC's "plaintext path is a
#      release blocker" surface)
#   2  harness error (could not even produce a bundle)
#
# All external binaries are resolved via PATH and all box paths via env knobs so
# tests/verify-encryption.test.sh can drive the real runner end-to-end against
# stub binaries.
#
# TEST HOOKS (env knobs, see below): DROPLET_VFY_OUTPUT_ROOT, _REPO_ROOT,
#   _COMPOSE_PROJECT, _COMPOSE_FILE, _DATA_PATHS, _USB_GLOB, _MESH_TARGETS,
#   _REDIS_TLS_PORT, _PCAP_SECONDS, _SIGNER_CONTAINER, _TPM_DIR, _CHECKS,
#   _RAW_DEVICE.
#
# CLI: [--list] [--checks a,b,c] [--pcap-seconds N] [--verify-bundle DIR]
# =============================================================================
set -u

VFY_OUTPUT_ROOT="${DROPLET_VFY_OUTPUT_ROOT:-/var/lib/droplet/verify}"
VFY_REPO_ROOT="${DROPLET_VFY_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
VFY_COMPOSE_PROJECT="${DROPLET_VFY_COMPOSE_PROJECT:-droplet}"
VFY_COMPOSE_FILE="${DROPLET_VFY_COMPOSE_FILE:-$VFY_REPO_ROOT/docker/docker-compose.yml}"
VFY_DATA_PATHS="${DROPLET_VFY_DATA_PATHS:-/var/lib/docker/volumes /var/lib/droplet $VFY_REPO_ROOT/data/secrets $VFY_REPO_ROOT/.env}"
VFY_USB_GLOB="${DROPLET_VFY_USB_GLOB:-/mnt/droplet/*}"
VFY_MESH_TARGETS="${DROPLET_VFY_MESH_TARGETS:-ai-gateway:8000 mcp-server:9090 web-dashboard:3001}"
VFY_REDIS_TLS_PORT="${DROPLET_VFY_REDIS_TLS_PORT:-6380}"
VFY_PCAP_SECONDS="${DROPLET_VFY_PCAP_SECONDS:-60}"
VFY_SIGNER_CONTAINER="${DROPLET_VFY_SIGNER_CONTAINER:-droplet-device-identity-svc}"
VFY_TPM_DIR="${DROPLET_VFY_TPM_DIR:-/var/lib/droplet/tpm}"
VFY_CHECKS="${DROPLET_VFY_CHECKS:-all}"
VFY_RAW_DEVICE="${DROPLET_VFY_RAW_DEVICE:-}"

# shellcheck source=droplet-verify-encryption-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/droplet-verify-encryption-lib.sh"

# id|family|maps_to|threat_ids|description
VFY_REGISTRY="
rest.luks.device|rest|WARP-232|T5.8|data mount backed by a dm-crypt (LUKS) device
rest.luks.header|rest|WARP-232|T5.8|LUKS2 header with aes-xts + Argon2id keyslot
rest.luks.tpm-token|rest|WARP-232|T5.8|TPM2 token enrolled in a LUKS keyslot
rest.entropy|rest|WARP-232|T5.8|raw partition reads as ciphertext (entropy + magic scan)
rest.mount-coverage|rest|WARP-232|T5.8|all data surfaces on encrypted devices
rest.usb-luks|rest|WARP-232|T5.8|USB automount drives are LUKS-enrolled
transit.pg.plaintext-rejected|transit|WARP-233|T5.8|psql with sslmode=disable is rejected
transit.pg.tls13|transit|WARP-233|T1.2|Postgres negotiates TLSv1.3
transit.pg.scram|transit|WARP-233|T5.8|password_encryption is scram-sha-256
transit.redis.plaintext-refused|transit|WARP-234|T5.8|non-TLS Redis port refuses connections
transit.redis.tls|transit|WARP-234|T5.8|Redis TLS port serves authenticated PING
transit.mqtt.plaintext-closed|transit|WARP-235|T5.8|plaintext MQTT :1883 no longer accepts publishes
transit.mqtt.mtls-required|transit|WARP-235|T5.8|MQTT :8883 refuses clients without certs
transit.mesh.plain-http-refused|transit|WARP-236|T2.8|internal APIs refuse plain HTTP
transit.edge.tls-policy|transit|WARP-1021|T1.2|nginx :443 floor TLSv1.2, :80 redirects
transit.pcap.canary|transit|WARP-966|T5.8|no canary/secret plaintext in sampled capture
"
