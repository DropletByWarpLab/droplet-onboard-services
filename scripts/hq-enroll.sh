#!/usr/bin/env bash
# =============================================================================
# WARP-3503 — enroll this box's device key with the fleet HQ, once.
# =============================================================================
#
# The box pulls its private OTA images (and later sends telemetry) with a
# short-lived HQ device token, which HQ only issues to a device key enrolled in
# its registry (ADR-068). A box provisioned with DROPLET_PROVISION_TOKEN in its
# .env enrolls itself ~30 s after first boot (the TLS-issuance tick). Run this
# for a box that did not: an already-deployed box, or a token that arrived
# later.
#
# Idempotent. It first asks HQ for a token and only enrolls when HQ answers
# "not enrolled", so a box that is already enrolled is left alone. A revoked
# box stays revoked.
#
# Usage (as root, from the repo root on the box):
#   scripts/hq-enroll.sh
#
# A box that is not enrolled needs DROPLET_PROVISION_TOKEN in the orchestrator's
# environment: put the one-time token minted at HQ
# (POST /api/admin/provision-token) in .env, then recreate the orchestrator
# (`docker restart` does not re-read env_file):
#   docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate orchestrator
#
# The last stdout line is `hq-enroll: result=<result>`:
#   already_enrolled | enrolled | skipped   exit 0 (skipped = no HQ_ISSUANCE_URL)
#   revoked | no_provision_token | failed   exit 1
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_ROOT/docker/docker-compose.yml")
[ ! -f "$REPO_ROOT/.env" ] || COMPOSE+=(--env-file "$REPO_ROOT/.env")

exec "${COMPOSE[@]}" exec -T orchestrator npm run -s hq-enroll
