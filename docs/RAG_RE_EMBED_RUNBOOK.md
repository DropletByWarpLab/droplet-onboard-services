# RAG re-embed runbook — WARP-2196 (all-MiniLM-L6-v2 → bge-small-en-v1.5)

**Status: written, not executed.** Nothing in this document has been run
against a live appliance. Running it is a deliberate human decision — it
deletes and rebuilds every vector in the corpus.

---

## 1. What changed and why

`EMBEDDING_MODEL` moved from `all-MiniLM-L6-v2` to `bge-small-en-v1.5`
(`services/file-indexer/config.py`).

MiniLM's `max_seq_length` is **256**. The chunker has produced **512**-token
chunks since WARP-435. Every full-size chunk therefore had its back half
dropped by the embedder before pooling: the text was written to
`FileContentChunk.text` — so it rendered in the UI and matched the lexical
(`tsvector`) arm — but was absent from `FileContentChunk.embedding`. Vector
search could not reach roughly half of every large document, and nothing
reported it.

`bge-small-en-v1.5` is MIT-licensed, has a **512**-token window, and emits
**384** dimensions — identical to MiniLM. That means:

| | |
|---|---|
| `FileContentChunk.embedding` | unchanged, stays `vector(384)` |
| pgvector index | unchanged, not rebuilt |
| Prisma schema | unchanged (the WARP-2196 migration is pure DML) |
| Every existing vector | **must be recomputed** |

The dimensional match is the hazard, not the convenience. Postgres will store,
index and compare MiniLM and bge vectors in the same column without a word of
complaint, and cosine distance **between** the two spaces is noise. There is
no error, no warning, and no way to tell one from the other after the fact —
search just returns wrong answers, confidently. A partial re-embed is worse
than either model alone.

---

## 2. The heal trap — a deploy alone fixes NOTHING

This is the part that makes the re-embed an explicit operation rather than a
consequence of shipping. Three independent mechanisms each prevent automatic
re-indexing, and **all three** have to be defeated:

1. **`RECONCILE_RETRY_STATUSES = {"indexing", "failed"}`**
   (`services/file-indexer/watcher.py`). A `ready` row is never retried.
   `skipped` is excluded as well, apart from the narrow WARP-1842 /
   WARP-2056 stale-verdict cases — an embedder swap is not one of them.

2. **The mtime short-circuit** immediately after it:

   ```python
   if not retry:
       if os.path.getmtime(abs_path) <= updated_at:
           continue  # already looked at, unchanged since
   ```

   Swapping the embedder changes no file's mtime, so every unchanged file is
   skipped without being examined.

3. **The reconcile runs once, at file-indexer startup**
   (`main.py`, the `warp1140-reconcile` thread). There is no periodic rescan.

Consequences worth stating explicitly:

- Deleting the chunks alone is **not** enough. The reconcile would find a
  `ready` status row with an unchanged mtime and skip the file, leaving it
  permanently unindexed — a silently empty corpus.
- Deleting the status rows alone is **not** enough. The stale MiniLM vectors
  would survive alongside the new bge ones.
- Doing both without restarting the file-indexer is **not** enough. The
  reconcile only runs at process start.

The migration does the two deletes. **You** do the restart.

---

## 3. Brain-sourced chunks do not self-heal

Rows with `source='brain'` come from `BrainMemoryItem` uploads. They are
ingested from an MQTT `droplet/files/brain/uploaded` event
(`services/file-indexer/brain_ingest.py`) and have **no reconcile path at
all** — no watcher, no startup scan, nothing.

The migration deletes their chunks. Only §6 brings them back. If you skip §6,
every chat attachment and uploaded memory silently disappears from retrieval
while the file itself still shows in the UI.

`BrainMemoryItem.status` is deliberately left untouched by the migration:
flipping it to `indexing` with nothing driving the indexing would pin the
dashboard on a spinner that never resolves.

---

## 4. Pre-flight

```bash
cd /opt/droplet            # repo root on the appliance
export DC="docker compose -p droplet -f docker/docker-compose.yml --env-file .env"
```

Record the "before" numbers so §7 has something to compare against:

```bash
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT source, count(*) AS chunks, count(DISTINCT \"userId\") AS owners
  FROM \"FileContentChunk\" GROUP BY source ORDER BY source;"

$DC exec -T db psql -U droplet -d droplet -c "
  SELECT status, count(*) FROM \"FileIndexStatus\" GROUP BY status;"

$DC exec -T db psql -U droplet -d droplet -c "
  SELECT count(*) FROM \"BrainMemoryItem\" WHERE status = 'ready';"
```

Confirm the new model is what the box will actually use:

```bash
grep -E '^EMBEDDING_MODEL=' .env || echo "(unset — falls back to the config.py default)"
```

`EMBEDDING_MODEL` must be either unset or exactly `bge-small-en-v1.5`. A box
with `EMBEDDING_MODEL=all-MiniLM-L6-v2` still pinned in `.env` will now fail
loudly: the ai-gateway's `EmbedText` allow-list rejects the id with
`INVALID_ARGUMENT`, and the chunker's budget guard raises `ChunkBudgetError`
because 512-token chunks do not fit MiniLM's 256-token window. Both are
intentional — failing closed beats writing MiniLM vectors into a column being
refilled with bge ones. **Unset it before deploying.**

Expect the ai-gateway's first embed call after the swap to pull
`BAAI/bge-small-en-v1.5` (~130 MB) from the HuggingFace Hub. On a box with
restricted egress, pre-warm the HF cache first or the re-embed stalls at the
first batch.

---

## 5. Procedure — the watcher (Nextcloud) corpus

1. **Deploy** the release containing WARP-2196 as normal. The orchestrator's
   guarded boot entrypoint (`apps/orchestrator/scripts/migrate-and-start.sh`)
   takes a `pg_dump` snapshot and then applies
   `20260827000000_warp_2196_bge_re_embed`, which runs:

   ```sql
   DELETE FROM "FileContentChunk";
   DELETE FROM "FileIndexStatus";
   ```

   Confirm it landed:

   ```bash
   $DC exec -T db psql -U droplet -d droplet -c "
     SELECT migration_name, finished_at FROM _prisma_migrations
     WHERE migration_name LIKE '%warp_2196%';"
   ```

2. **Restart the file-indexer.** This is the step the migration cannot do,
   and without it nothing is re-indexed:

   ```bash
   $DC up -d --force-recreate --no-deps file-indexer
   ```

   Recreate rather than `docker restart` — the service reads `.env` through
   `env_file`, and a plain restart keeps the old environment.

3. **Watch the reconcile drain.** It logs its own scope on completion:

   ```bash
   $DC logs -f file-indexer | grep -E 'reconcile|Indexed'
   # reconcile: scanned N file(s), processed N
   ```

   Re-embedding is CPU-bound sentence-transformers work on the appliance.
   Budget on the order of a few files per second; a large corpus is an
   hours-long job, not a minutes-long one. It is resumable — if the container
   dies, restarting it re-runs the reconcile and picks up whatever still has
   no status row.

---

## 6. Procedure — the brain corpus (mandatory, see §3)

Brain items need their upload event replayed. Publish one
`droplet/files/brain/uploaded` message per `ready` item; `handle_brain_uploaded`
is idempotent (it deletes any existing chunks for the item before inserting).

Payload shape (`itemId`, `userId`, `path`, `mimeType` — `path` is
`BrainMemoryItem.storagePath`):

```bash
$DC exec -T db psql -U droplet -d droplet -tA -F$'\t' -c "
  SELECT id, \"userId\", \"storagePath\", coalesce(\"mimeType\",'')
  FROM \"BrainMemoryItem\"
  WHERE status = 'ready'
  ORDER BY \"uploadedAt\";" > /tmp/brain-items.tsv

wc -l /tmp/brain-items.tsv     # sanity-check against the §4 count
```

Replay them one at a time, pacing the loop so the embedder is not swamped
while the watcher reconcile from §5 is still running:

```bash
while IFS=$'\t' read -r id user path mime; do
  payload=$(printf '{"itemId":"%s","userId":"%s","path":"%s","mimeType":"%s"}' \
    "$id" "$user" "$path" "$mime")
  $DC exec -T mqtt mosquitto_pub \
    -t droplet/files/brain/uploaded -m "$payload"
  sleep 1
done < /tmp/brain-items.tsv
```

Adjust the broker flags to match the box's mosquitto auth/TLS configuration —
the internal broker requires credentials on a hardened appliance.

Items whose bytes were purged (`hasOriginalBytes = false`) cannot be
re-embedded; `brain_ingest` marks them `failed` with `file_missing`. Note them
and move on — their chunks are gone for good, which is the documented
consequence of a bytes-purge, not a defect in this procedure.

---

## 7. Verification

```bash
# 1. Chunks are back, and there are roughly as many as before.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT source, count(*) AS chunks FROM \"FileContentChunk\"
  GROUP BY source ORDER BY source;"

# 2. Nothing is stuck. `failed` should be empty or explainable per row.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT status, count(*) FROM \"FileIndexStatus\" GROUP BY status;"
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT \"userId\", path, reason FROM \"FileIndexStatus\"
  WHERE status = 'failed' LIMIT 20;"

# 3. Brain items did not regress into failure.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT status, \"failureReason\", count(*) FROM \"BrainMemoryItem\"
  GROUP BY status, \"failureReason\";"
```

Expect the chunk count to **rise**, not merely return. Chunks are now sized to
448 body tokens (512 minus the 64-token header reservation, WARP-2191) instead
of 512, so a given document yields modestly more of them — and none of them is
half-invisible to vector search any more.

Then confirm retrieval end-to-end from the dashboard: search a phrase that
lives in the **second half** of a long document. That is the case which was
broken before this ticket and is the point of the whole exercise.

---

## 8. Recalibration — why the similarity floors changed too

`minSimilarity` is a cosine floor applied client-side in `searchByVector`,
after the SQL has returned its top-K. A cosine similarity only means something
relative to the distribution a given model produces, and bge's is shifted far
higher than MiniLM's — v1.5's release notes describe the change as alleviating
"the issue of the similarity distribution".

Measured over the committed eval fixtures (`tests/retrieval-eval/queries.yaml`
crossed with `ragas/goldens.yaml`: 65 queries × 47 passages, passages wrapped
in the production WARP-435 contextual header, pairs labelled matched/unmatched
by whether the query's `relevant` doc set intersects the passage's):

| | matched | unmatched | conversational |
|---|---|---|---|
| **MiniLM** median | +0.374 | +0.140 | +0.047 |
| p95 | +0.655 | +0.376 | +0.149 |
| min | −0.078 | −0.107 | −0.096 |
| **bge** median | +0.682 | +0.564 | +0.475 |
| p95 | +0.810 | +0.687 | +0.557 |
| min | +0.401 | +0.392 | +0.344 |

The bottom-left cell is the finding: under bge the **minimum score over every
pair measured** — matched, unmatched and chit-chat alike — is **+0.344**. A
0.30 floor is not "a little loose" under bge, it is an **exact no-op**.

Each floor was re-derived to preserve MiniLM's operating point, defined as the
fraction of the irrelevant-pair population that survives it:

| Constant | was | now | unmatched admitted | match recall |
|---|---|---|---|---|
| `SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY` | 0.30 | **0.65** | 10.5% → 10.7% | 96.4% → 98.2% |
| `presetForClass("conversational")` | 0.50 | **0.75** | 1.4% → 1.3% | 83.6% → 76.4% |
| `SEARCH_MIN_SIMILARITY` (files-knowledge) | 0.25 | **0.63** | 16.3% → 15.6% | 100% → 98.2% |

The conversational floor matters most: its job is to sit **above** whatever
chit-chat scores against the corpus so those turns retrieve nothing. Under
MiniLM the chit-chat ceiling was 0.200 and 0.5 cleared it 2.5×. Under bge that
ceiling is 0.590 — 0.5 would have admitted 8 of the 10 conversational fixture
queries, inverting the gate from "skip retrieval" to "retrieve almost always".

Reproduce by embedding those fixtures with both models and comparing the
distributions. The numbers are pinned in
`apps/orchestrator/src/services/similarity-floors.test.ts`, so a future
embedder swap that forgets this step fails CI rather than shipping a decorative
constant.

**Any future embedder change must repeat this measurement.** Carrying a cosine
floor across a model swap is how it stops being a filter.

---

## 9. Rollback

There is no clean rollback, and that is by design — reverting the code without
reverting the data leaves bge vectors being queried by a MiniLM query encoder,
which is the mixed-space failure in its worst form.

If the re-embed has to be abandoned mid-flight:

1. Revert the release (restores `EMBEDDING_MODEL=all-MiniLM-L6-v2` and the old
   floors).
2. Restore the pre-migration snapshot taken by `migrate-and-start.sh` from
   `/data/migration-snapshots` — this brings back the MiniLM vectors **and**
   the `FileIndexStatus` rows together, which is the only self-consistent
   state available.
3. Recreate the file-indexer.

Restoring only the chunks, or only the status rows, reproduces the §2 trap.

Note that rolling back also restores the original defect: the back half of
every 512-token chunk is once again missing from its vector.
