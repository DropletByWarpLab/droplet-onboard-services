# Embedded PM stack — photo-studio pilot procedure

> **WARP-517** — first real-customer deploy of the embedded Plane PM stack
> introduced in Epic WARP-496 (ADR-010, spec WARP-498). This doc is the
> step-by-step the operator follows on the day of the pilot. It is NOT
> the design — for design see the linked ADR + spec.

## When to run this

After **all** of these have merged to `main`:
- ADR-010 (#286) at status `Accepted` (Romain AGPL sign-off recorded — WARP-499)
- Spec PR #287
- Phase 1 PRs: #301 (skeleton), #302 (compose), #303 (nginx), #304 (provisioning), #305 (ship-check)
- Phase 2 PR #307 (SSO bridge) + the downstream Phase 2 PRs
- Phase 5 PRs: #308 (backup), #309 (security), #310 (docs)

Photo-studio box: `192.168.1.87` (`droplet-sys`). Access per
`scripts/host/` provisioning + the existing `droplet`/`Droplet123!`
credentials.

## Pre-flight (do not skip)

1. **Ship-check clean** locally on `main`:
   ```bash
   ./scripts/test/ship-check.sh --full
   ```
   Must show all eight static checks PASS plus `docker-build-smoke`
   PASS. The `pm-invariants` check (added in WARP-504) is the
   PM-specific gate.

2. **Security sweep clean**:
   ```bash
   ./scripts/test-security.sh
   ```
   Tests 8 + 9 (added in WARP-515) must PASS — no hardcoded
   `DROPLET_PM_*` secret literals and no host-specific defaults in
   `services/pm/`.

3. **Photo-studio backup BEFORE deploy.** Per `factory-reset.sh`
   safety posture, take a full box backup so a worst-case rollback
   is one command away. The Plane-specific backup script
   (`scripts/host/pm-backup.sh`, WARP-514) is for the PM stack only —
   the box-level backup covers everything else.

4. **OQ4 status check.** WARP-513 (mobile API contract) needs OQ4
   (mobile envelope mapping) resolved before merge. If WARP-513 hasn't
   merged, mobile clients won't see project data — the pilot proceeds
   without mobile PM access; document the gap in the pilot ticket.

## Deploy

On the photo-studio box:

```bash
ssh droplet@192.168.1.87
cd /home/droplet/edge-platform
git fetch origin
git checkout main
git pull --ff-only origin main
```

Then re-provision (idempotent; `setup.sh` skips work already done):

```bash
./scripts/setup.sh --sync-secrets
```

This backfills any missing `DROPLET_PM_*` entries via
`migrate_env()` (WARP-503). Verify the new keys:

```bash
grep -E '^DROPLET_PM_' .env | awk -F= '{print $1, "= ["substr($2,1,4)"****]"}'
```

You should see all 11 `DROPLET_PM_*` entries. Then bring the stack up:

```bash
docker compose -f docker/docker-compose.yml --env-file .env up -d \
  postgres-pm redis-pm pm-api pm-worker pm-web pm-health
```

Wait for healthchecks (~60–120 seconds — `pm-api` runs Django
migrations on first boot):

```bash
docker compose -f docker/docker-compose.yml ps --filter "name=pm-"
```

All six should show `healthy` or `running`. Then verify the
standardized envelope:

```bash
curl -sS http://localhost:8090/health | jq .
# Expected:
# { "status": "ok", "service": "pm", "version": "v0.24.1",
#   "plane_api_reachable": true, "cache_age_seconds": <small> }
```

Then verify the LAN-facing URL via Nginx:

```bash
curl -sk https://droplet-ai.local/pm/ | head -5
# Expected: Plane's HTML login page.
```

## First login

From a workstation on the customer LAN, visit:

`https://droplet-ai.local/`

Log into the dashboard as the customer's primary user. Click
**Projects** in the left nav. You should land in Plane authenticated
via the WARP-505 SSO handoff — no second password prompt.

If the wizard prompt fires (WARP-507 first-run path), name the
workspace + first project. The defaults are "<business-name>" and
"Inbox" respectively.

## Observation window (7 days)

The pilot is **deploy + observe + fix P0/P1 only**. AC drift on
anything below P1 is captured as a follow-up ticket per
[`07-jira-workflow/lifecycle.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/07-jira-workflow/lifecycle.md) — do NOT inline-fix.

### What to watch

| Surface | Where | Healthy looks like |
|---|---|---|
| `pm-health` envelope | `curl http://localhost:8090/health` | `status: ok`, `plane_api_reachable: true` |
| Container logs | `docker compose logs pm-api pm-web pm-worker --tail 50` | No `ERROR` / `CRITICAL` / `Traceback` |
| Nginx access log | `docker compose logs gateway --tail 50` | 2xx + 3xx on `/pm/*` |
| Orchestrator | `docker compose logs orchestrator --tail 50` | No `pm.client` warnings, no `WARP-505 SSO` errors |
| Backup cycle | `./scripts/host/pm-backup.sh /tmp/pilot-backups` | Tarball written, manifest sane |
| Restore cycle | `./scripts/host/pm-restore.sh /tmp/pilot-backups/pm-backup-<TS>.tar.gz` | Plane comes back with the same projects + issues + comments |

### Severity definitions for the window

- **P0** — Plane unreachable, dashboard `/projects` errors, data loss,
  fail-OPEN auth, secret leak. Drop everything, fix forward or roll
  back per `scripts/host/pm-restore.sh`.
- **P1** — degraded but usable. Issues like slow `/pm/` page load
  (>5s), `pm-worker` Celery backlog growing, a specific endpoint
  intermittently 5xx. Fix within 48 h via a hot-fix branch +
  cherry-pick, PR'd against `main`.
- **P2 and below** — file as a regular Jira ticket against Epic
  WARP-496 or a follow-up epic. Do NOT inline-fix during the window.

## Decision gate at day 7

Stefan + Romain meet at the close of the observation window and pick
one outcome — record in this ticket as a comment:

1. **GENERAL_AVAILABILITY** — Plane ships to remaining pilots
   (dental, real estate, etc.). Open new pilot tickets per customer.
2. **HOLD** — Specific blockers listed. Each blocker becomes a Jira
   ticket against Epic WARP-496 or a new epic. Plane stays running
   on the photo studio but no further pilots until blockers clear.
3. **ROLLBACK** — Reason recorded. Run
   `./scripts/host/pm-restore.sh` with the pre-deploy backup, then
   `docker compose down postgres-pm redis-pm pm-api pm-worker pm-web pm-health`.
   File the failure mode against the Epic.

## What is NOT in scope for the pilot

- Adding new customers in the same window (one pilot at a time —
  observe before scaling).
- Migrating customer's existing project data from elsewhere (per-
  customer ticket if requested; not part of WARP-517).
- Per-customer Plane UI customization.
- Bumping the Plane upstream pin (separate spec update + ADR-010 OQ3
  refresh).

## Engineering-handbook references (binding)

- [`04-coding-standards/code-quality-rules.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/04-coding-standards/code-quality-rules.md) — rule 1 (shipping-product
  mindset — pilot box runs the same code as customer prod), rule 17
  (no "poc" framing in surfaces the customer sees).
- [`07-jira-workflow/lifecycle.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/07-jira-workflow/lifecycle.md) — AC drift rule (any scope creep during
  the window stops + surfaces).
- [`06-runbooks/lab-access.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/06-runbooks/lab-access.md) — credentials + SSH posture for the
  photo-studio box.
- [`03-claude-harness/skills/droplet-architecture-guard/SKILL.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/03-claude-harness/skills/droplet-architecture-guard/SKILL.md) — rules 14
  (no host-specific defaults), 15 (don't edit shared_brain mirrors),
  16 (every shape is shipping product), 17 (no lifecycle naming).

## Cross-references

- Epic: WARP-496
- ADR: [ADR-010](ADR-010-pm-stack-selection.md)
- Spec: [spec WARP-498](superpowers/specs/2026-05-27-warp-498-pm-stack-design.md)
- All Phase 1–5 tickets: WARP-500..516
