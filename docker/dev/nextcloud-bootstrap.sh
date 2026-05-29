#!/usr/bin/env bash
# Seeds Nextcloud with a second user + 10 sample files via the
# OCS API + WebDAV. Run AFTER the dev stack is up:
#
#   docker compose -f docker/docker-compose.dev.yml exec nextcloud \
#       bash /workspace/docker/dev/nextcloud-bootstrap.sh
#
# (Or invoke from host — needs curl + the admin password.)
#
# Idempotent — re-running won't duplicate users or files.

set -euo pipefail

NC_URL="${NC_URL:-http://localhost:8082}"
NC_ADMIN="${NEXTCLOUD_ADMIN_USER:-admin}"
NC_ADMIN_PASSWORD="${NEXTCLOUD_ADMIN_PASSWORD:-dropletdev}"
AUTH="-u ${NC_ADMIN}:${NC_ADMIN_PASSWORD}"

log() { echo "[nc-bootstrap] $*"; }

# ─── second user: stefan ───
SECOND_USER="${SECOND_USER:-stefan}"
SECOND_PASSWORD="${SECOND_PASSWORD:-dropletdev}"

log "Creating user ${SECOND_USER} (idempotent)…"
curl -sS -X POST $AUTH \
  -H "OCS-APIRequest: true" \
  -d "userid=${SECOND_USER}&password=${SECOND_PASSWORD}" \
  "${NC_URL}/ocs/v1.php/cloud/users" >/dev/null || true

# ─── 10 sample files in admin's Files ───
declare -a FILES=(
  "Welcome.md|# Welcome to Droplet\nThis is a dev-mode workspace. Browse around — nothing on this Nextcloud is shared with the real POC."
  "Q2-roadmap.md|## Q2 roadmap\n- Ship dashboard violet rehaul\n- Native iOS + Android scaffolds\n- Docker Desktop dev stack"
  "supplier-nda-draft.md|Mutual NDA — draft v0.3\n\nSee Stefan for redlines before counter-sign."
  "loading-bay-incident-2026-05-18.txt|Back-lot camera dropped 14m. Recovered automatically."
  "weekly-storage-report.csv|day,used_gb,total_gb\n2026-05-12,1380,4000\n2026-05-18,1420,4000"
  "investor-pitch-outline.md|## Pitch outline\n1. Problem: SMBs paying for SaaS they don't trust\n2. Wedge: on-prem appliance\n3. Moat: 3yr lease + compliance"
  "team-onboarding.md|## Team onboarding\n- Day 1: install Droplet app, pair Droplet, set push prefs\n- Day 2: tour the cameras + files"
  "compliance-checklist.md|- TAA: yes\n- NDAA-889: yes\n- FIPS 140-3: in progress (boot self-test)"
  "voice-assistant-notes.md|## Wake word\nopenWakeWord trained on 50 phone recordings. Latency ~600ms."
  "lease-terms-summary.md|3 yr lease, monthly billing, includes hardware replacement + remote support."
)

log "Uploading ${#FILES[@]} sample files to admin's home…"
for entry in "${FILES[@]}"; do
  IFS='|' read -r name content <<<"$entry"
  curl -sS $AUTH \
    -T <(printf "%b" "$content") \
    "${NC_URL}/remote.php/dav/files/${NC_ADMIN}/${name}" >/dev/null
  log "  uploaded ${name}"
done

log "Done. Open http://localhost:8082 and sign in as ${NC_ADMIN} / ${NC_ADMIN_PASSWORD}"
