# RAG integration testing

Operator's guide for the WARP-201..206 RAG integration suite. If you're
triaging a failed `rag-tests` CI run or about to ship a change to
`services/file-indexer/`, `apps/orchestrator/src/routes/files-*`, or
the embedding plumbing, start here.

## What gets tested

Six vitest files live in `tests/`. They share one Compose stack so the
boot cost is amortized.

| File | What it covers |
|---|---|
| `rag-extractors.integration.test.ts` | WARP-201. Drops PDF/DOCX/PNG/text fixtures into Nextcloud, runs `occ files:scan`, asserts `FileContentChunk` rows land with the expected text. Verifies extractor dispatch, MIME routing, and Tesseract OCR. |
| `rag-search.integration.test.ts` | WARP-202. Drives the MCP `search_content` tool over the stdio transport against the live ai-gateway gRPC + pgvector. Asserts `AUTH_REQUIRED` gating, per-user RBAC, and `EMBEDDING_UNAVAILABLE` when ai-gateway is down. |
| `rag-brain-upload.integration.test.ts` | WARP-203. POSTs to `/api/files/brain/upload`, polls until the file-indexer flips `BrainMemoryItem.indexedAt` and writes `FileContentChunk(source='brain')` rows. Asserts the upload returns `202 {itemId, status:"indexing"}` and that another user's row is invisible. |
| `rag-knowledge.integration.test.ts` | WARP-204. Seeds chunks for two users, hits `GET /api/files/knowledge/recent` and `GET /api/files/knowledge/search`. Asserts ordering, cursor pagination (`?before=`), and the cross-user filter. |
| `rag-brain-export.integration.test.ts` | WARP-205. Uploads a brain file, exports the zip via `GET /api/files/brain/export?all=1`, deletes the row, asserts cascade deletion of chunks. |
| `rag-end-to-end.integration.test.ts` | WARP-206. The full chain: PDF into Nextcloud + PNG via brain-upload → wait for indexedAt → POST `/api/llm/chat` twice → assert each response cites the right file with non-empty snippets. Loops 5x for retrieval determinism. |

## Running locally

The runner script handles boot, health checks, and teardown.

```bash
./scripts/test-rag.sh
```

**Prereqs:**
- Docker Desktop or Docker Engine running.
- ≥4 GB free RAM, ≥30 GB free disk (cold image pulls + builds total ~5 GB).
- Allow 20-30 min on the first cold run; 5-12 min once images are cached.

**Run a single file** (escape hatch when iterating on one ticket):

```bash
./scripts/test-rag.sh --only end-to-end       # rag-end-to-end only
./scripts/test-rag.sh --only brain-upload     # rag-brain-upload only
```

**Don't tear down on exit** (useful when you want to poke at the live
stack after a failure):

```bash
./scripts/test-rag.sh --no-down
# Stack stays up. Tear it down by hand later:
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml down -v
```

**Dry run** (print the commands without executing):

```bash
./scripts/test-rag.sh --dry-run
```

### Manual mode (without the runner)

If you need finer control:

```bash
# 1. Boot the stack with the test-port override.
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml \
  up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud

# 2. Wait for orchestrator health.
curl -sf http://localhost:3000/api/orchestrator/health

# 3. Run vitest directly.
cd tests
RUN_RAG_INTEGRATION=1 API_URL=http://localhost:3000 \
  npx vitest run --no-file-parallelism rag-end-to-end.integration.test.ts
```

## The skip gate

Every RAG integration test wraps its `describe` block in
`describe.skipIf(!SHOULD_RUN)` where `SHOULD_RUN === process.env.RUN_RAG_INTEGRATION === "1"`.

This means:
- Default `npm test` runs do NOT pay the Compose-up tax.
- The full suite runs only when `RUN_RAG_INTEGRATION=1` is set.
- The `tests/package.json` script `test:rag` sets it for you.

## Reading failure modes

Container logs are the primary triage surface. CI uploads them as an
artifact (`rag-tests-logs-<run_id>`); locally, attach a log tail to
the failure manually.

| Symptom | First service to check |
|---|---|
| Extractor unit tests fail; chunks never land | `file-indexer` — Tesseract install, pypdf import, MIME dispatch. |
| Brain-upload returns 500 / chunks never land for brain items | `orchestrator` (multer multipart, BrainMemoryItem write) → `file-indexer` (extractors.dispatch in the brain branch). |
| `search_content` returns empty / `EMBEDDING_UNAVAILABLE` | `ai-gateway` — gRPC port, embed model loaded, JETSON_OLLAMA_URL reachable. |
| `/api/llm/chat` returns 200 but trace has no `search_content` call | `orchestrator` — agent loop iter limit, model not honoring tool prompt. The retrieval test loops 5x to surface this kind of flake. |
| Nextcloud `occ files:scan` hangs forever | `nextcloud` — bootstrap not done yet (occ status fails), or admin user-files dir missing. |
| `localhost:3000` connection refused | The test override wasn't loaded — re-run with `./scripts/test-rag.sh` instead of just `docker compose up`. |

```bash
# Tail one service's logs from a still-running stack:
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml \
  logs --tail 100 file-indexer

# Dump everything relevant to a file (mirrors what CI uploads):
for svc in file-indexer orchestrator ai-gateway nextcloud db mcp-server; do
  docker compose -f docker/docker-compose.yml \
    -f docker/docker-compose.test.override.yml \
    logs --no-color "$svc" > "rag-${svc}.log"
done
```

## CI

The `.github/workflows/rag-tests.yml` workflow runs on:
- Pull requests touching the RAG paths (file-indexer, embedding clients,
  files-* routes, prisma migrations, `tests/rag-*.integration.test.ts`,
  the test override compose file, the workflow yaml itself).
- Pushes to `main` on the same path filter.

Path filtering is non-negotiable — the suite takes 20-25 min on a
GHA `ubuntu-latest` runner; running it on every PR would block cores
that other CI lanes need.

**Job timeout:** 35 min. Above that we'd start dropping legit slow runs
as flakes; below it Nextcloud's cold bootstrap (~3 min) eats too much
of the budget.

**Failure artifacts:** `rag-tests-logs-<run_id>`. Retention 7 days.
Contains one file per service plus a `ps.txt` snapshot. Download and
grep for `ERROR` / `WARN` first.

## LLM determinism caveat (e2e test)

`rag-end-to-end.integration.test.ts` asserts the **retrieval chain**
(does the agent call `search_content`? does it return the right path?
is the snippet non-empty?), NOT the model's free-form prose.

The "5 runs in a row" loop checks that retrieval — same chunks, same
file, same sentinel — stays stable across model invocations. Free-text
output is allowed to vary; that's a model property, not a RAG one. The
header comment in the test file spells out which axes are deterministic.

If your ai-gateway routes to an off-line Jetson (the default in this
repo), the e2e test will hit the iteration limit on the agent loop —
`stop_reason: "iteration_limit"` is acceptable as long as
`search_content` was called and returned hits. Set
`RAG_E2E_MODEL=<your-test-model>` to override the default model name
the test sends.

## Updating the suite

When you add a new RAG-touching code path:

1. Add a unit test inside the relevant service workspace
   (`services/file-indexer/tests/`, `apps/orchestrator/src/...`,
   `packages/tools-core/`).
2. Only add a new integration test if it spans services. The bar for
   adding to this suite is high — every test increases the suite's
   per-PR latency.
3. Update the path filter in `.github/workflows/rag-tests.yml` so the
   workflow re-runs when your code changes.
4. Update this doc's "What gets tested" table.
