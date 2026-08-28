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

## WARP-2196 — embedder swap MiniLM→bge (operator-gated re-embed)

**Background.** `EMBEDDING_MODEL` moves to `bge-small-en-v1.5`. Both models
are 384-dim, so `FileContentChunk.embedding` and its index are unchanged —
which is precisely why every vector must be recomputed: Postgres compares
MiniLM and bge vectors happily and the result is noise.

**No migration ships with this.** Deploying deletes nothing. The file-indexer
records which model built the corpus (`WorkspaceSetting` key
`ai.embedding.corpusModel`) and, on a mismatch, logs `REFUSING TO INDEX` and
**blocks chunk writes while continuing to serve reads**. A box that never runs
the re-embed keeps its self-consistent MiniLM corpus and stops indexing,
loudly. It never mixes two vector spaces.

**Required order:**

1. Unset `EMBEDDING_MODEL` in `.env` if it still pins `all-MiniLM-L6-v2` —
   that id is no longer in the gateway's EmbedText allow-list and now fails
   the chunk-budget guard.
2. Deploy. The box enters read-only indexing and stays there safely until
   your maintenance window. Rollback up to this point is free.
3. `./scripts/rag-re-embed.sh` — deletes `FileContentChunk` +
   `FileIndexStatus` in one transaction. Interactive confirm; `--dry-run` to
   preview; safe to re-run.
4. **Recreate the file-indexer** (`up -d --force-recreate --no-deps
   file-indexer`). It stamps the new marker, unblocks writes and re-indexes.
   Nothing rebuilds until you do this.
5. **Replay brain uploads.** `source='brain'` chunks have no reconcile path;
   step 4 does not touch them. Skipping this silently removes every chat
   attachment from search while the file still shows in the UI.

Take your own `pg_dump` before step 3 if you want a rollback point — no
migration runs, so `migrate-and-start.sh` takes no automatic snapshot.

**Full procedure, verification and rollback:** `docs/RAG_RE_EMBED_RUNBOOK.md`.

---

## WARP-493 — brain-memory username→UUID cutover (atomic; depends on WARP-485)

**Background.** Brain-memory was the last pre-WARP-485 surface keyed by
Nextcloud username: `BrainMemoryItem.userId` + `.storagePath`,
brain-sourced `FileContentChunk.userId`, the on-disk
`BRAIN_ROOT/<username>/` dirs, and the reader/writer code around them.

**All surfaces flip in ONE release — partial deploy = read regression:**

1. SQL backfill `20260702000000_warp_491_brain_memory_userid_backfill`
   (runs via `prisma migrate deploy` before routes mount). Data-only.
2. Boot-time `migrateBrainMemoryDirectoryLayout` renames
   `BRAIN_ROOT/<username>/` → `BRAIN_ROOT/<User.id>/` (atomic rename;
   UUID-shaped names skipped, so re-boot is a no-op).
3. Reader/writer flips: `routes/files-brain.ts::getUserId`,
   `routes/me-context-stats.ts::getUserId`, chat-attachment ownership in
   `routes/llm.ts` (`brainOwnerId`), ws-bridge extra
   `droplet/files/<user.id>/#` subscription, and the MQTT
   `droplet/files/brain/uploaded` publisher (so `brain_ingest.py` writes
   UUID-keyed rows).

Deploying the code without the migration (or vice-versa) reproduces the
WARP-488-reviewer scenario: renamed dirs + username-keyed reads (or the
inverse) = 404/ENOENT on every pre-fix brain item.

**Idempotency.** SQL re-runs update zero rows (UUID-regex `WHERE`
guard); the dir migrator skips UUID-shaped names; both proven by re-run
tests (scratch-Postgres double-apply + vitest integration suite).

**Orphans.** Rows/dirs keyed by a username with no matching
`User.nextcloudUsername` are logged (`RAISE NOTICE` / orchestrator boot
log) and NEVER deleted. Convergence after the user's first sign-in
(which writes their mapping row) differs by layer:

- **Dirs converge automatically** — the boot migrator re-runs on every
  orchestrator start.
- **Rows do NOT** — `prisma migrate deploy` runs the backfill exactly
  once, so an operator must manually re-apply the backfill SQL (psql)
  for users who sign in after the deploy. Safe and fully convergent:
  orphan rows retain both the username `userId` and the username
  `storagePath`, so rewrite-then-flip still applies, and the UUID-regex
  guards make the re-apply idempotent.

`FileContentChunk` is only flipped for `source = 'brain'` rows —
nextcloud-watcher chunks are username-keyed by design and keep being
written that way.

**Known transition window.** Between `prisma migrate deploy` (rows +
`storagePath` already UUID-rewritten) and the boot-time dir rename, the
file-indexer's transcription worker can ENOENT a queued pre-fix item
and mark it `failed` — recoverable via the transcribe-now retry once
the orchestrator is up.

**Deferred gaps — CLOSED by
[WARP-1014](https://warp-lab.atlassian.net/browse/WARP-1014)
(dual-shape reads).** Both cross-source retrieval surfaces now scope
`FileContentChunk` by BOTH keys (`userId IN (<username>, <User.id UUID>)`):

- `/api/files/knowledge/{recent,search}` reads both shapes off
  `req.user` (`routes/files-knowledge.ts::chunkOwnerKeys`).
- MCP `search_content` keeps the username-keyed `_meta.userId` contract;
  the mcp-server resolves the counterpart key at the query site
  (`services/mcp-server/src/chunk-owner.ts` — also covers the HTTP
  transport, whose `claims.sub` is UUID-shaped).

The rejected alternative (unifying the watcher on UUIDs) would have
flipped `services/file-indexer/watcher.py` + the `(username, path)`
delete bookkeeping in `db.py` for no read-side gain — nextcloud-watcher
rows stay username-keyed by design. No migration; reads accept both
shapes indefinitely.

**Verification on a deployed device.**

```bash
# Non-UUID brain item keys (0, or the operator-known orphan count):
psql -c "SELECT COUNT(*) FROM \"BrainMemoryItem\"
         WHERE \"userId\" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';"
# Username-named dirs left under BRAIN_ROOT (orphans only):
ls /data/brain-memory/
```

---

## WARP-488 — `Camera*.userId` username→UUID backfill (depends on WARP-485)

**Background.** Before WARP-485 the OCS-auth fallback set `req.user.id`
to the Nextcloud user-id string (e.g. `stefan-cruceru`), and any row
written using `req.user.id` at the time landed keyed by username rather
than by `User.id` UUID. WARP-485 normalizes `req.user.id` to the local
UUID at every auth path. WARP-488 backfills the Camera persistent state
that pre-fix code wrote with the username key:

- `CameraPin.userId`             (read at `routes/cameras.ts:269`)
- `CameraNotificationPref.userId` (read at `routes/cameras.ts:1549, :1577`)

**Required deploy order.**

1. **Deploy the WARP-485-bearing orchestrator code AND the WARP-488
   migration in the same release.** The orchestrator's `prisma migrate
   deploy` invocation in `setup.sh` runs the WARP-488 SQL on boot before
   any route is mounted, so the backfill finishes before the first
   request hits the new code.

2. **Do NOT** deploy the WARP-485 orchestrator code WITHOUT this
   migration. Users with pre-WARP-485 OCS-auth history would silently
   lose camera pins and notification prefs on the first post-deploy
   request — pre-fix rows are still keyed by username while every read
   now uses the UUID. (BLOCKER status on WARP-488.)

**Idempotency.** Re-running the migration on a converged DB updates zero
rows — both UPDATE statements filter on a UUID-regex `WHERE` clause that
excludes already-flipped rows. Safe to re-run any number of times.

**Orphans.** Rows whose `userId` is a username string with no matching
`User.nextcloudUsername` are LOGGED via `RAISE NOTICE` in SQL and LEFT
IN PLACE. The operator decides whether to manually re-attribute them
(via psql or a follow-up People surface ticket) or drop them. The
migration does NOT delete orphan rows under any condition.

**Verification on a deployed device.** Read-only checks:

```bash
# CameraPin rows still keyed by a non-UUID userId (= orphans only after
# the migration ran):
psql -c "SELECT COUNT(*) FROM \"CameraPin\"
         WHERE \"userId\" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';"

# CameraNotificationPref equivalent:
psql -c "SELECT COUNT(*) FROM \"CameraNotificationPref\"
         WHERE \"userId\" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';"
```

Both should return either 0 (clean) or the operator-known orphan count
(un-paired pre-fix usernames).

**Brain-memory cutover is OUT OF SCOPE for this ticket.** It landed as
[WARP-493](https://warp-lab.atlassian.net/browse/WARP-493) — see the
section above for the atomic-deploy invariant.
