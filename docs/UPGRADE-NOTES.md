# Upgrade Notes

Operator-facing notes on deployment ordering for cross-cutting schema /
auth migrations. Each section captures the **before-after invariant** and
the **required deploy order** for migrations whose business logic
depends on each other.

Add a new section at the top of the list each time a migration depends
on a code change in the same release. Section title format:
`## WARP-NNN <short title>`. Keep the section ≤30 lines so it stays a
checklist rather than a story.

---

## WARP-488 — `Camera*.userId` username→UUID backfill (depends on WARP-485)

**Background.** Before WARP-485 the OCS-auth fallback set `req.user.id`
to the Nextcloud user-id string (e.g. `stefan-cruceru`), and any row
written using `req.user.id` at the time landed keyed by username rather
than by `User.id` UUID. WARP-485 normalizes `req.user.id` to the local
UUID at every auth path. WARP-488 backfills the persistent state that
pre-fix code wrote with the username key:

- `CameraPin.userId`             (read at `routes/cameras.ts:269`)
- `CameraNotificationPref.userId` (read at `routes/cameras.ts:1549, :1577`)
- `BRAIN_ROOT/<userId>/` on-disk dirs (rewritten by boot-time
  `migrateBrainMemoryDirectoryLayout` in `services/brain-memory.service.ts`)

**Required deploy order.**

1. **Deploy the WARP-485-bearing orchestrator code AND the WARP-488
   migration in the same release.** The orchestrator's `prisma migrate
   deploy` invocation in `setup.sh` runs the WARP-488 SQL on boot before
   any route is mounted; the brain-memory directory migrator runs right
   after Prisma connects and before any service / cron / route is wired.
   Both finish before the first request hits the new code.

2. **Do NOT** deploy the WARP-485 orchestrator code WITHOUT this
   migration. Users with pre-WARP-485 OCS-auth history would silently
   lose camera pins, notification prefs, and brain-memory items on the
   first post-deploy request — pre-fix rows are still keyed by username
   while every read now uses the UUID. (BLOCKER status on WARP-488.)

**Idempotency.** Re-running the migration on a converged DB updates zero
rows — both UPDATE statements filter on a UUID-regex `WHERE` clause that
excludes already-flipped rows. The brain-memory directory migrator skips
top-level dirs whose name is already a UUID. Both are safe to re-run any
number of times.

**Orphans.** Rows whose `userId` is a username string with no matching
`User.nextcloudUsername` are LOGGED (via `RAISE NOTICE` in SQL and
`logger.warn` for the brain-memory dirs) and LEFT IN PLACE. The
operator decides whether to manually re-attribute them (via psql or
a follow-up People surface ticket) or drop them. The migration does
NOT delete orphan rows under any condition.

**Conflict guard (brain-memory only).** If both `BRAIN_ROOT/<username>/`
AND `BRAIN_ROOT/<uuid>/` exist for the same user, the migrator logs
the conflict and SKIPS the rename. Renaming over an existing UUID dir
would be a data-loss bug; operator merges manually.

**Verification on a deployed device.** Read-only checks:

```bash
# CameraPin rows still keyed by a non-UUID userId (= orphans only after
# the migration ran):
psql -c "SELECT COUNT(*) FROM \"CameraPin\"
         WHERE \"userId\" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';"

# CameraNotificationPref equivalent:
psql -c "SELECT COUNT(*) FROM \"CameraNotificationPref\"
         WHERE \"userId\" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';"

# Brain-memory dirs whose name is not a UUID:
ls /data/brain-memory/ | grep -vE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
```

All three should return either 0 / empty (clean) or the operator-known
orphan count (un-paired pre-fix usernames).
