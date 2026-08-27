# RAG re-embed runbook — WARP-2196 (all-MiniLM-L6-v2 → bge-small-en-v1.5)

**Status: written, not executed.** Nothing here has been run against a live
appliance. The re-embed is **operator-gated**: no migration deletes anything,
and you pick the maintenance window.

**If you are here because the file-indexer logged `REFUSING TO INDEX`, go
straight to §5.**

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
| Prisma schema | unchanged — **no migration ships with this** |
| Every existing vector | **must be recomputed** |

The dimensional match is the hazard, not the convenience. Postgres will store,
index and compare MiniLM and bge vectors in the same column without a word of
complaint, and cosine distance **between** the two spaces is noise. There is
no error, no warning, and no way to tell one from the other after the fact —
search just returns wrong answers, confidently. **A partial re-embed is worse
than either model alone.**

---

## 2. The staleness guard — what stops you skipping this

Because the re-embed is operator-gated rather than forced by a migration, a
box could take the update and simply never run it. Left unguarded, that box
would keep indexing: new chunks in bge, old corpus in MiniLM, mixed
irreversibly and undetectably.

So the box records which model built its corpus and **refuses to add to a
corpus it did not build**.

- **Marker:** a `WorkspaceSetting` row keyed `ai.embedding.corpusModel`. It
  lives in the same database as the corpus so it stays in sync across
  `pg_dump`/`pg_restore` — a file on the data volume would survive a database
  restore that rolled the corpus back and then confidently describe vectors
  that are no longer there. The `ai` settings section is excluded from the
  settings route, so no dashboard surface can read or edit it.
- **Check:** at file-indexer startup (`corpus_state.check_corpus_model`,
  before the brain-ingest subscription and before the reconcile thread).
- **Verdicts:**

  | corpus | marker | outcome |
  |---|---|---|
  | empty | anything | stamp the configured model, index normally |
  | non-empty | matches `EMBEDDING_MODEL` | index normally |
  | non-empty | differs | **block writes**, log `ERROR` |
  | non-empty | absent | **block writes**, log `ERROR` |
  | — | check itself failed | **block writes**, log `ERROR` |

  "Non-empty with no marker" is the upgrade path and the most important row:
  a corpus built before the guard existed has unknown provenance, and on any
  box upgrading through WARP-2196 it is MiniLM. Treating absent as "probably
  fine" would let the mixed corpus build up silently on every appliance.

- **Fail-closed on writes, not reads.** A blocked box keeps answering queries
  from its existing corpus, which is internally consistent and perfectly
  useful. It refuses new chunks. The service stays **up** — it does not exit,
  because taking search down entirely over a corpus that still works would be
  a worse outage than the stale index. Deletes stay open too: they are how the
  re-embed script's work lands and how the watcher retires removed files.

What you will see in `docker compose logs file-indexer`:

```
ERROR REFUSING TO INDEX: embedding-model mismatch. the existing corpus was
embedded by all-MiniLM-L6-v2, but EMBEDDING_MODEL is bge-small-en-v1.5.
124312 chunk(s) would be mixed across two different vector spaces. ...
To fix, run scripts/rag-re-embed.sh ... Full procedure:
docs/RAG_RE_EMBED_RUNBOOK.md
ERROR file-indexer is running in READ-ONLY mode: no new chunks will be
written until the corpus is re-embedded.
```

The same text is the exception message raised by any write attempt, so it
turns up both in the startup log and against an individual failed index.

**Per-chunk provenance** — the column that would make this incremental instead
of all-or-nothing — is **WARP-2210**. This corpus-wide marker is the cheap
guard that makes the gate safe today, not the long-term model.

---

## 3. Why the corpus does not heal on its own

Even with the chunks gone, three separate mechanisms stop the corpus
rebuilding by itself. This is why §5 has a restart step and why the script
deletes `FileIndexStatus` as well as `FileContentChunk`:

1. **`RECONCILE_RETRY_STATUSES = {"indexing", "failed"}`**
   (`services/file-indexer/watcher.py`). A `ready` row is never retried.
   `skipped` is excluded too, apart from the narrow WARP-1842 / WARP-2056
   stale-verdict cases — an embedder swap is not one of them.

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

Consequences:

- Deleting the chunks alone is **not** enough — the reconcile would find a
  `ready` row with an unchanged mtime and skip the file, leaving a silently
  empty corpus.
- Deleting the status rows alone is **not** enough — the stale MiniLM vectors
  would survive.
- Doing both without restarting the file-indexer is **not** enough — the
  reconcile only runs at process start.

`scripts/rag-re-embed.sh` does both deletes in one transaction. **You** do the
restart.

---

## 4. Pre-flight

```bash
cd /opt/droplet            # repo root on the appliance
export DC="docker compose -p droplet -f docker/docker-compose.yml --env-file .env"
```

Confirm the box will actually use the new model:

```bash
grep -E '^EMBEDDING_MODEL=' .env || echo "(unset — falls back to the config.py default)"
```

It must be unset or exactly `bge-small-en-v1.5`. A box still pinning
`all-MiniLM-L6-v2` fails loudly and correctly: the ai-gateway's `EmbedText`
allow-list rejects the id with `INVALID_ARGUMENT`, and the chunker's budget
guard raises `ChunkBudgetError` because 512-token chunks do not fit MiniLM's
256-token window. **Unset it before you start.**

See what you are about to do — the script's dry run touches nothing:

```bash
./scripts/rag-re-embed.sh --dry-run
```

It prints the marker, the configured model, the chunk and status row counts,
and the number of brain items that will need the §6 replay. **Write the brain
count down.** You will need it, and it is the step that is easiest to skip.

Expect the ai-gateway's first embed call after the swap to pull
`BAAI/bge-small-en-v1.5` (~130 MB) from the HuggingFace Hub. On a box with
restricted egress, pre-warm the HF cache first or the rebuild stalls at the
first batch.

There is **no automatic pre-migration snapshot** for this operation (no
migration runs, so `migrate-and-start.sh` takes none). If you want a rollback
point, take one yourself now:

```bash
$DC exec -T db pg_dump -U droplet -Fc droplet > /data/pre-re-embed-$(date +%F).dump
```

---

## 5. Procedure — the watcher (Nextcloud) corpus

1. **Deploy** the release containing WARP-2196 as normal. Nothing is deleted.
   The file-indexer comes up, detects the mismatch, logs the `REFUSING TO
   INDEX` error from §2, and serves reads from the existing corpus while
   refusing new chunks. **The box is in a safe, stable state here** — you can
   leave it like this until your window.

2. **Run the re-embed** in your maintenance window:

   ```bash
   ./scripts/rag-re-embed.sh
   ```

   It prints the same summary as `--dry-run`, then requires you to type
   `REBUILD`. Use `-y` only in automation. It deletes `FileContentChunk` and
   `FileIndexStatus` in a single transaction — never one without the other,
   which is the state §3 warns about.

3. **Recreate the file-indexer.** This is the step the script deliberately
   does not do for you, and nothing is re-indexed until you do:

   ```bash
   $DC up -d --force-recreate --no-deps file-indexer
   ```

   Recreate rather than `docker restart` — the service reads `.env` through
   `env_file`, and a plain restart keeps the old environment.

   On start it finds an empty corpus, stamps `bge-small-en-v1.5` as the new
   corpus owner, unblocks writes, and the reconcile begins. The re-embed
   completes itself; there is no "mark it done" step to forget.

4. **Watch it drain:**

   ```bash
   $DC logs -f file-indexer | grep -E 'reconcile|Indexed|corpus_state'
   # corpus_state: corpus marked as embedded by bge-small-en-v1.5
   # reconcile: scanned N file(s), processed N
   ```

   Re-embedding is CPU-bound sentence-transformers work on the appliance.
   Budget a few files per second; a large corpus is an hours-long job. It is
   resumable — if the container dies, restarting re-runs the reconcile and
   picks up whatever still has no status row.

---

## 6. 🔴 Procedure — the brain corpus. DO NOT SKIP THIS.

**This is the step that gets skipped, and skipping it is silent.**

Under the old auto-migration design the brain replay was a forced consequence
of an unavoidable deploy. It is now one manual step among several, which makes
it much easier to miss — and nothing downstream will tell you it was missed.

Chunks with `source='brain'` come from `BrainMemoryItem` uploads. They are
ingested from an MQTT `droplet/files/brain/uploaded` event
(`services/file-indexer/brain_ingest.py`) and have **no reconcile path at all**
— no watcher, no startup scan, nothing. §5 does not touch them.

If you stop after §5: every chat attachment and uploaded memory is **gone from
search**, while the file still appears in the UI and the item still says
`ready`. There is no error and no badge. You will find out when someone asks
why the assistant can no longer see a document they uploaded.

Dump the items:

```bash
$DC exec -T db psql -U droplet -d droplet -tA -F$'\t' -c "
  SELECT id, \"userId\", \"storagePath\", coalesce(\"mimeType\",'')
  FROM \"BrainMemoryItem\"
  WHERE status = 'ready'
  ORDER BY \"uploadedAt\";" > /tmp/brain-items.tsv

wc -l /tmp/brain-items.tsv     # must match the count from §4
```

Replay them. `handle_brain_uploaded` is idempotent — it deletes any existing
chunks for the item before inserting — so a re-run is safe. Pace the loop so
the embedder is not swamped while the §5 reconcile is still running:

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

Verify the brain chunks actually came back:

```bash
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT count(DISTINCT \"brainItemId\") FROM \"FileContentChunk\"
  WHERE source = 'brain';"
```

Items whose bytes were purged (`hasOriginalBytes = false`) cannot be
re-embedded; `brain_ingest` marks them `failed` with `file_missing`. Note them
and move on — their chunks are gone for good, which is the documented
consequence of a bytes-purge, not a defect here.

---

## 7. Verification

```bash
# 1. The marker moved.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT \"valueJson\", \"updatedAt\" FROM \"WorkspaceSetting\"
  WHERE \"key\" = 'ai.embedding.corpusModel';"

# 2. Chunks are back, both sources.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT source, count(*) AS chunks FROM \"FileContentChunk\"
  GROUP BY source ORDER BY source;"

# 3. Nothing stuck. `failed` should be empty or explainable per row.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT status, count(*) FROM \"FileIndexStatus\" GROUP BY status;"
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT \"userId\", path, reason FROM \"FileIndexStatus\"
  WHERE status = 'failed' LIMIT 20;"

# 4. Brain items did not regress.
$DC exec -T db psql -U droplet -d droplet -c "
  SELECT status, \"failureReason\", count(*) FROM \"BrainMemoryItem\"
  GROUP BY status, \"failureReason\";"

# 5. No lingering block.
$DC logs file-indexer | grep -c 'REFUSING TO INDEX' || true
```

`source = 'brain'` appearing in check 2 is the single best evidence that §6
actually happened.

Expect the total chunk count to **rise**, not merely return. Chunks are now
sized to 448 body tokens (512 minus the 64-token header reservation,
WARP-2191) instead of 512, so a given document yields modestly more of them —
and none is half-invisible to vector search any more.

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
| `SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY` (orchestrator) | 0.30 | **0.65** | 10.5% → 10.7% | 96.4% → 98.2% |
| `presetForClass("conversational")` | 0.50 | **0.75** | 1.4% → 1.3% | 83.6% → 76.4% |
| `SEARCH_MIN_SIMILARITY` (files-knowledge) | 0.25 | **0.63** | 16.3% → 15.6% | 100% → 98.2% |
| `SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY` (mcp-server) | 0.30 | **0.65** | as row 1 | as row 1 |

The conversational floor matters most: its job is to sit **above** whatever
chit-chat scores against the corpus so those turns retrieve nothing. Under
MiniLM the chit-chat ceiling was 0.200 and 0.5 cleared it 2.5×. Under bge that
ceiling is 0.590 — 0.5 would have admitted 8 of the 10 conversational fixture
queries, inverting the gate from "skip retrieval" to "retrieve almost always".

Reproduce by embedding those fixtures with both models and comparing the
distributions. The numbers are pinned in
`apps/orchestrator/src/services/similarity-floors.test.ts`, so a future
embedder swap that forgets this step fails CI rather than shipping a
decorative constant.

**Any future embedder change must repeat this measurement.** Carrying a cosine
floor across a model swap is how it stops being a filter.

---

## 9. Rollback

**Before you start (§5 step 2 not yet run):** rollback is free. Revert the
release. `EMBEDDING_MODEL` goes back to `all-MiniLM-L6-v2`, the marker still
says `all-MiniLM-L6-v2` (or is still absent), the guard is satisfied or
returns to its pre-upgrade state, and indexing resumes against the untouched
corpus. Nothing was deleted. This is the main reason the destructive migration
was removed.

**After the deletes, mid-rebuild:** finish the rebuild. It is resumable, and a
half-built bge corpus plus a MiniLM query encoder is the mixed-space failure in
its worst form. Reverting the code here is the wrong move.

**After the deletes, if the rebuild must be abandoned:**

1. Revert the release (restores `EMBEDDING_MODEL=all-MiniLM-L6-v2` and the old
   floors).
2. Restore the dump you took in §4 — it brings back the MiniLM vectors, the
   `FileIndexStatus` rows and the marker together, which is the only
   self-consistent state available. If you did not take one, there is no
   snapshot: let the rebuild finish instead.
3. Recreate the file-indexer.

Restoring only the chunks, or only the status rows, reproduces the §3 trap.

Note that rolling back also restores the original defect: the back half of
every 512-token chunk is once again missing from its vector.
