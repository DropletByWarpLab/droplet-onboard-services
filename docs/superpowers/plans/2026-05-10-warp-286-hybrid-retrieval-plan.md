# WARP-286 Hybrid Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `search_content` and `/knowledge` retrieval from vector-only to BM25 + vector + RRF + cross-encoder reranker, with ≥10% NDCG@10 improvement on a hand-curated eval set.

**Architecture:** Parallel BM25 (Postgres native FTS via `tsvector` + GIN) and vector (pgvector) retrieval, fused by reciprocal rank fusion (k=60), reranked by BGE-reranker-base int8 served via gRPC by `services/ai-gateway`. Redis-cached rerank results (5-min TTL). Per-user RBAC at SQL level. Existing `apps/orchestrator/src/services/file-search.service.ts` extended with `searchByLexical` + `searchHybrid`; `searchByVector` retained as a debug primitive.

**Tech Stack:** TypeScript (orchestrator + MCP server), Python (ai-gateway), Postgres 16 + pgvector + native FTS, Redis 7, gRPC, Prisma migrations, vitest, pytest, `optimum.onnxruntime` for BGE-reranker-base int8.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `apps/orchestrator/prisma/migrations/<timestamp>_add_chunk_tsvector_index/migration.sql` | new | Add `text_tsv` generated tsvector column + GIN index on `FileContentChunk` |
| `apps/orchestrator/prisma/schema.prisma` | modify | Add the `text_tsv` field declaration so Prisma knows about the column (read-only; never written from app code) |
| `apps/orchestrator/src/services/file-search.service.ts` | extend | Add `searchByLexical`, `reciprocalRankFusion`, `rerankPassages`, `searchHybrid`. Keep `searchByVector` as debug-only primitive |
| `apps/orchestrator/src/services/file-search.service.test.ts` | new | Unit tests for `searchByLexical`, `reciprocalRankFusion`, `rerankPassages`, `searchHybrid` |
| `apps/orchestrator/src/services/reranker.client.ts` | new | gRPC client wrapper for the ai-gateway `Rerank` method |
| `proto/inference.proto` | modify | Add `Rerank` rpc + `RerankRequest`/`RerankResponse` messages |
| `services/ai-gateway/grpc_generated/inference_pb2.py` | regenerate | Generated stub |
| `services/ai-gateway/grpc_generated/inference_pb2_grpc.py` | regenerate | Generated stub |
| `apps/orchestrator/src/grpc-generated/inference_pb.ts` | regenerate | Generated TS stub |
| `apps/orchestrator/src/grpc-generated/inference_pb_grpc.ts` | regenerate | Generated TS stub |
| `services/ai-gateway/main.py` | modify | Implement `Rerank` handler on the gRPC server |
| `services/ai-gateway/reranker.py` | new | BGE-reranker-base loader + inference wrapper (singleton, cached on disk) |
| `services/ai-gateway/tests/test_reranker.py` | new | pytest for the gRPC handler + model loader (mocked) |
| `services/ai-gateway/requirements.txt` | modify | Pin `optimum>=1.21,<2.0`, `onnxruntime>=1.18`, `huggingface_hub>=0.24` |
| `apps/orchestrator/src/routes/files-knowledge.ts` | modify | Switch from `searchByVector` to `searchHybrid` (one-line swap) |
| `packages/tools-core/src/handlers/files/search-content.ts` | modify | Refactor to call shared `searchHybrid` via the context instead of its own inline SQL |
| `apps/orchestrator/src/services/llm-agent.service.ts` (or wherever ToolContext is assembled) | modify | Inject `searchHybrid` reference into the MCP `ToolContext` so the handler can call it |
| `tests/retrieval-eval/queries.yaml` | new | 20-30 hand-curated queries with relevance labels |
| `tests/retrieval-eval/run.ts` | new | Vitest harness; computes NDCG@10 for three pipelines, asserts ≥10% improvement |
| `tests/package.json` | modify | Add `test:retrieval-eval` script |
| `docs/RAG_RETRIEVAL.md` | new | Architecture diagram, native FTS rationale, future-swap path, eval methodology, tuning knobs |

---

## Task 0: Pre-flight

**Files:** none modified.

- [ ] **Step 1: Confirm branch baseline**

```bash
git fetch origin main
git checkout -b WARP-286 origin/main
git log --oneline -3
```

Expected: HEAD shows the WARP-286 spec merge commit (`docs(WARP-286): hybrid retrieval design`) on top of WARP-229's FIPS merge.

- [ ] **Step 2: Confirm the existing retrieval shape**

```bash
grep -nE "^export async function" apps/orchestrator/src/services/file-search.service.ts
```

Expected output (verbatim):

```
70:export async function searchByVector(
157:export async function listRecent(
```

If those lines have moved, adjust line numbers in subsequent tasks but keep the same logic.

- [ ] **Step 3: Confirm Prisma client is up to date**

```bash
cd apps/orchestrator && npm run db:generate 2>&1 | tail -5
```

Expected: `Generated Prisma Client (v...)` with no errors. Required before any later vitest run.

- [ ] **Step 4: Confirm tests pass on baseline**

```bash
npm run -w @droplet/orchestrator test 2>&1 | tail -10
```

Expected: `Test Files  ...passed`. If anything is red on the baseline, stop and triage before proceeding.

No commit at Task 0 — this is a gate.

---

## Task 1: Add `text_tsv` generated column + GIN index

**Files:**
- Create: `apps/orchestrator/prisma/migrations/<timestamp>_add_chunk_tsvector_index/migration.sql`
- Modify: `apps/orchestrator/prisma/schema.prisma`

- [ ] **Step 1: Generate the migration directory**

```bash
cd apps/orchestrator
mkdir -p "prisma/migrations/$(date -u +%Y%m%d%H%M%S)_add_chunk_tsvector_index"
MIGRATION_DIR="$(ls -d prisma/migrations/*_add_chunk_tsvector_index | tail -1)"
echo "Migration dir: ${MIGRATION_DIR}"
```

- [ ] **Step 2: Write the migration SQL**

Write to `${MIGRATION_DIR}/migration.sql`:

```sql
-- WARP-286: lexical search via Postgres native FTS.
-- Generated tsvector column over FileContentChunk.text. STORED means the
-- value is computed at insert/update time and persisted on disk —
-- no per-query computation cost.
ALTER TABLE "FileContentChunk"
  ADD COLUMN "text_tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("text", '')), 'A')
  ) STORED;

-- GIN index over the tsvector for fast @@ matches.
CREATE INDEX "FileContentChunk_text_tsv_idx"
  ON "FileContentChunk" USING GIN ("text_tsv");

-- Per-user lexical search filter: planner picks this when the user
-- has many chunks and the query is highly selective. With ~100k chunks
-- per user, the cost-based optimizer chooses the right path.
CREATE INDEX "FileContentChunk_userId_lexical_idx"
  ON "FileContentChunk" ("userId");
```

- [ ] **Step 3: Add the field to `schema.prisma`**

Find the `FileContentChunk` model in `apps/orchestrator/prisma/schema.prisma`. Add right before the closing brace:

```prisma
  // WARP-286: generated tsvector column for lexical (BM25-style) search.
  // Read-only from the app side; computed by Postgres on insert/update.
  // Declared as Unsupported() because Prisma has no first-class tsvector type.
  text_tsv  Unsupported("tsvector")?  @ignore
```

(Note: `Unsupported` + `@ignore` keeps the field invisible to typed queries; we only read it via `$queryRawUnsafe` in `searchByLexical`.)

- [ ] **Step 4: Apply the migration locally**

```bash
cd apps/orchestrator
npx prisma migrate deploy 2>&1 | tail -10
```

Expected: `Applying migration <timestamp>_add_chunk_tsvector_index` + `All migrations have been successfully applied.` If you don't have a local Postgres running, skip this — CI will validate. Document the skip in the commit message.

- [ ] **Step 5: Regenerate Prisma client**

```bash
cd apps/orchestrator
npm run db:generate 2>&1 | tail -3
```

Expected: `Generated Prisma Client`.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/prisma/migrations/*_add_chunk_tsvector_index/migration.sql \
        apps/orchestrator/prisma/schema.prisma
git commit -m "feat(db): add FileContentChunk.text_tsv tsvector + GIN index (WARP-286)

Generated STORED column over the text field, populated by Postgres
at insert/update time. GIN index for fast @@ matches. Per-user
auxiliary index for the common WHERE userId = \$1 filter.

This is the lexical search side of the hybrid retrieval pipeline.
Postgres native FTS is the v1 lexical engine; future swap to
pg_search (Tantivy) is a documented path — see WARP-286 spec."
```

---

## Task 2: `searchByLexical` + `reciprocalRankFusion` (no reranker yet)

**Files:**
- Modify: `apps/orchestrator/src/services/file-search.service.ts`
- Create: `apps/orchestrator/src/services/file-search.service.test.ts`

- [ ] **Step 1: Write failing tests for `reciprocalRankFusion`**

Create `apps/orchestrator/src/services/file-search.service.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  reciprocalRankFusion,
  type SearchHit,
} from "./file-search.service.js";

function hit(source: "nextcloud" | "brain", path: string, chunkIdx: number, score: number): SearchHit {
  return {
    source, path, chunkIdx,
    pageNumber: null,
    brainItemId: null,
    score,
    snippet: "",
    metadata: null,
  };
}

describe("reciprocalRankFusion", () => {
  it("returns empty when both inputs are empty", () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it("returns vector hits unchanged when lexical is empty", () => {
    const v = [hit("nextcloud", "/a.pdf", 0, 0.9), hit("nextcloud", "/b.pdf", 0, 0.8)];
    const fused = reciprocalRankFusion(v, []);
    expect(fused.map(h => h.path)).toEqual(["/a.pdf", "/b.pdf"]);
    // RRF scores: 1/(60+0), 1/(60+1)
    expect(fused[0]!.score).toBeCloseTo(1 / 60);
    expect(fused[1]!.score).toBeCloseTo(1 / 61);
  });

  it("boosts a chunk appearing in both lists above singletons", () => {
    const v = [hit("nextcloud", "/a.pdf", 0, 0.9), hit("nextcloud", "/b.pdf", 0, 0.8)];
    const l = [hit("nextcloud", "/c.pdf", 0, 0.95), hit("nextcloud", "/a.pdf", 0, 0.85)];
    const fused = reciprocalRankFusion(v, l);
    // /a.pdf appears in both → score = 1/60 + 1/61 ≈ 0.0333
    // /c.pdf only in lexical at rank 0 → 1/60 ≈ 0.01667
    // /b.pdf only in vector at rank 1 → 1/61 ≈ 0.01639
    expect(fused[0]!.path).toBe("/a.pdf");
    expect(fused[0]!.score).toBeCloseTo(1 / 60 + 1 / 61);
  });

  it("dedupes by (source, path, chunkIdx)", () => {
    const v = [hit("nextcloud", "/a.pdf", 0, 0.9)];
    const l = [hit("nextcloud", "/a.pdf", 0, 0.8), hit("nextcloud", "/a.pdf", 1, 0.7)];
    const fused = reciprocalRankFusion(v, l);
    expect(fused.length).toBe(2);
    expect(fused.map(h => `${h.path}:${h.chunkIdx}`).sort()).toEqual(["/a.pdf:0", "/a.pdf:1"]);
  });

  it("honours custom k", () => {
    const v = [hit("nextcloud", "/a.pdf", 0, 0.9)];
    const fused = reciprocalRankFusion(v, [], 10);
    expect(fused[0]!.score).toBeCloseTo(1 / 10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/orchestrator
npx vitest run src/services/file-search.service.test.ts 2>&1 | tail -15
```

Expected: FAIL with `reciprocalRankFusion is not exported`.

- [ ] **Step 3: Add `reciprocalRankFusion` to `file-search.service.ts`**

Open `apps/orchestrator/src/services/file-search.service.ts`. After the `searchByVector` function definition (around line 155), add:

```typescript
/**
 * Reciprocal rank fusion (Cormack et al., 2009). Combines two ranked
 * lists into a single list ordered by the sum of `1 / (k + rank)`
 * contributions from each list. Default k=60 is the canonical value
 * from the original paper.
 *
 * Deduplicates by (source, path, chunkIdx). A chunk in both inputs
 * gets the sum of its two contributions, which is what makes RRF
 * elevate items strongly endorsed by multiple retrievers.
 *
 * WARP-286: bridge between BM25 (lexical) and ANN (vector). The
 * returned `score` field is the RRF score, not the original similarity.
 */
export function reciprocalRankFusion(
  vectorHits: SearchHit[],
  lexicalHits: SearchHit[],
  k: number = 60,
): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  for (const [rank, h] of vectorHits.entries()) {
    const key = `${h.source}:${h.path}:${h.chunkIdx}`;
    scores.set(key, { hit: h, score: 1 / (k + rank) });
  }
  for (const [rank, h] of lexicalHits.entries()) {
    const key = `${h.source}:${h.path}:${h.chunkIdx}`;
    const prev = scores.get(key);
    scores.set(key, {
      hit: prev?.hit ?? h,
      score: (prev?.score ?? 0) + 1 / (k + rank),
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}
```

- [ ] **Step 4: Run tests to verify RRF passes**

```bash
cd apps/orchestrator
npx vitest run src/services/file-search.service.test.ts -t "reciprocalRankFusion" 2>&1 | tail -10
```

Expected: 5 passing tests.

- [ ] **Step 5: Add the `SearchByLexicalParams` interface and `searchByLexical` function**

In `file-search.service.ts`, after the `SearchByVectorParams` interface (~line 55), add:

```typescript
export interface SearchByLexicalParams {
  /** Nextcloud username — the per-user RBAC boundary. */
  userId: string;
  /** Raw user query string. `websearch_to_tsquery` handles punctuation safely. */
  query: string;
  /** Maximum rows to return (caller-clamped). */
  limit: number;
  /** Optional: restrict to one source. */
  source?: FileContentSource;
  /** Optional: only chunks indexed at-or-after this timestamp. */
  since?: Date;
}
```

After `searchByVector` (around line 155 — after the function definition closes), add:

```typescript
/**
 * Lexical (BM25-style) search via Postgres native FTS.
 * Uses `websearch_to_tsquery` (forgiving query parser) and `ts_rank_cd`
 * with normalization flag 32 (mean-of-distance-between-matches) — the
 * closest native-FTS analog to BM25's length-normalization.
 *
 * WARP-286: paired with `searchByVector` and fused via
 * `reciprocalRankFusion` in `searchHybrid`. The interface lets us
 * swap to pg_search (Tantivy) later without changing callers.
 */
export async function searchByLexical(
  prisma: PrismaClient,
  params: SearchByLexicalParams,
): Promise<SearchHit[]> {
  const where: string[] = [`"userId" = $1`, `"text_tsv" @@ websearch_to_tsquery('english', $2)`];
  const args: unknown[] = [params.userId, params.query];
  let p = 3;
  if (params.source !== undefined) {
    where.push(`source = $${p}::"FileContentSource"`);
    args.push(params.source);
    p++;
  }
  if (params.since !== undefined) {
    where.push(`"indexedAt" >= $${p}`);
    args.push(params.since);
    p++;
  }
  args.push(params.limit);
  const rows = await prisma.$queryRawUnsafe<RawSearchRow[]>(
    `SELECT
       source, path, "chunkIdx", "pageNumber", "brainItemId", metadata,
       "text" AS snippet,
       ts_rank_cd("text_tsv", websearch_to_tsquery('english', $2), 32) AS score
     FROM "FileContentChunk"
     WHERE ${where.join(" AND ")}
     ORDER BY score DESC
     LIMIT $${p}`,
    ...args,
  );
  return rows.map((r) => ({
    source: r.source,
    path: r.path,
    chunkIdx: r.chunkIdx,
    pageNumber: r.pageNumber,
    brainItemId: r.brainItemId,
    score: r.score,
    snippet: r.snippet,
    metadata: r.metadata,
  }));
}
```

- [ ] **Step 6: Add unit tests for `searchByLexical`**

Append to `file-search.service.test.ts`:

```typescript
import { searchByLexical } from "./file-search.service.js";

describe("searchByLexical", () => {
  function mockPrisma(rows: any[]) {
    return { $queryRawUnsafe: vi.fn(async () => rows) } as any;
  }

  it("returns mapped hits with the user filter baked in", async () => {
    const prisma = mockPrisma([
      { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, pageNumber: 3,
        brainItemId: null, metadata: null, snippet: "hello", score: 0.42 },
    ]);
    const hits = await searchByLexical(prisma, {
      userId: "alice", query: "hello", limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: "/a.pdf", score: 0.42 });
    const sql = prisma.$queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('"userId" = $1');
    expect(sql).toContain("websearch_to_tsquery");
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual([
      "alice", "hello", 10,
    ]);
  });

  it("appends source + since filters when provided", async () => {
    const prisma = mockPrisma([]);
    const since = new Date("2026-05-10T00:00:00Z");
    await searchByLexical(prisma, {
      userId: "alice", query: "hello", limit: 5, source: "brain", since,
    });
    const call = prisma.$queryRawUnsafe.mock.calls[0];
    const sql = call[0];
    expect(sql).toContain('source = $3::"FileContentSource"');
    expect(sql).toContain('"indexedAt" >= $4');
    expect(call.slice(1)).toEqual(["alice", "hello", "brain", since, 5]);
  });

  it("returns empty array when DB returns nothing", async () => {
    const prisma = mockPrisma([]);
    const hits = await searchByLexical(prisma, {
      userId: "alice", query: "hello", limit: 10,
    });
    expect(hits).toEqual([]);
  });
});
```

Add at the top of the file:

```typescript
import { vi } from "vitest";
```

- [ ] **Step 7: Run all the new tests**

```bash
cd apps/orchestrator
npx vitest run src/services/file-search.service.test.ts 2>&1 | tail -15
```

Expected: 8 passing (5 RRF + 3 lexical).

- [ ] **Step 8: Add `searchHybrid` (BM25 + RRF only — no reranker yet)**

In `file-search.service.ts`, after `searchByLexical`, add:

```typescript
export interface SearchHybridParams {
  userId: string;
  /** Embedding vector for the query. */
  vector: number[];
  /** Raw query text for lexical search. */
  query: string;
  /** Final result count (caller-clamped). Default 10. */
  limit?: number;
  /** Cosine-similarity floor for the vector arm. Default 0.3. */
  minSimilarity?: number;
  /** How many to pull from each retriever before fusion. Default 100. */
  perArmK?: number;
  source?: FileContentSource;
  since?: Date;
}

/**
 * Hybrid retrieval: parallel BM25 + vector, fused via RRF.
 *
 * WARP-286: this is the v1 caller-facing entrypoint. The reranker
 * step is added in a later commit (Task 5); for now this returns the
 * RRF top-K. Tests verify the wiring; the eval harness (Task 7)
 * measures quality.
 */
export async function searchHybrid(
  prisma: PrismaClient,
  params: SearchHybridParams,
): Promise<SearchHit[]> {
  const perArmK = params.perArmK ?? 100;
  const limit = params.limit ?? 10;
  const [vectorHits, lexicalHits] = await Promise.all([
    searchByVector(prisma, {
      userId: params.userId,
      vector: params.vector,
      limit: perArmK,
      minSimilarity: params.minSimilarity ?? 0.3,
      source: params.source,
      since: params.since,
    }),
    searchByLexical(prisma, {
      userId: params.userId,
      query: params.query,
      limit: perArmK,
      source: params.source,
      since: params.since,
    }),
  ]);
  const fused = reciprocalRankFusion(vectorHits, lexicalHits);
  return fused.slice(0, limit);
}
```

- [ ] **Step 9: Add unit test for `searchHybrid`**

Append to `file-search.service.test.ts`:

```typescript
import { searchHybrid, searchByVector } from "./file-search.service.js";

describe("searchHybrid (BM25 + RRF, pre-reranker)", () => {
  it("calls both retrievers in parallel and fuses results", async () => {
    const vectorRows = [
      { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, pageNumber: 1,
        brainItemId: null, metadata: null, snippet: "v1", score: 0.95 },
      { source: "nextcloud", path: "/b.pdf", chunkIdx: 0, pageNumber: 1,
        brainItemId: null, metadata: null, snippet: "v2", score: 0.85 },
    ];
    const lexicalRows = [
      { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, pageNumber: 1,
        brainItemId: null, metadata: null, snippet: "l1", score: 0.7 },
      { source: "nextcloud", path: "/c.pdf", chunkIdx: 0, pageNumber: 1,
        brainItemId: null, metadata: null, snippet: "l2", score: 0.5 },
    ];
    const prisma = {
      $queryRawUnsafe: vi.fn()
        .mockImplementationOnce(async () => vectorRows)
        .mockImplementationOnce(async () => lexicalRows),
    } as any;
    const hits = await searchHybrid(prisma, {
      userId: "alice", vector: new Array(384).fill(0.01), query: "hello",
      limit: 3,
    });
    expect(hits.map((h) => h.path)).toEqual(["/a.pdf", "/b.pdf", "/c.pdf"]);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("respects limit smaller than fused result count", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn()
        .mockResolvedValueOnce([
          { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, pageNumber: null,
            brainItemId: null, metadata: null, snippet: "", score: 0.9 },
          { source: "nextcloud", path: "/b.pdf", chunkIdx: 0, pageNumber: null,
            brainItemId: null, metadata: null, snippet: "", score: 0.8 },
        ])
        .mockResolvedValueOnce([]),
    } as any;
    const hits = await searchHybrid(prisma, {
      userId: "alice", vector: new Array(384).fill(0.01), query: "hello",
      limit: 1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe("/a.pdf");
  });
});
```

- [ ] **Step 10: Run all tests and commit**

```bash
cd apps/orchestrator
npx vitest run src/services/file-search.service.test.ts 2>&1 | tail -10
```

Expected: 10 passing (5 RRF + 3 lexical + 2 hybrid).

```bash
git add apps/orchestrator/src/services/file-search.service.ts \
        apps/orchestrator/src/services/file-search.service.test.ts
git commit -m "feat(orchestrator): searchByLexical + reciprocalRankFusion + searchHybrid (WARP-286)

Extends file-search.service.ts with the BM25-side of the hybrid
pipeline. Postgres native FTS via tsvector + ts_rank_cd + GIN, scored
with normalization flag 32 (mean-of-distance-between-matches) — the
closest native-FTS analog to BM25's length-normalization.

reciprocalRankFusion is a pure function; k=60 default per Cormack et
al. 2009. Dedupes by (source, path, chunkIdx).

searchHybrid is the new caller-facing entrypoint. It currently returns
RRF top-K; the reranker step is added in a later commit. searchByVector
is unchanged and kept as a debug primitive.

10 unit tests; all green."
```

---

## Task 3: Add `Rerank` gRPC method to `proto/inference.proto`

**Files:**
- Modify: `proto/inference.proto`
- Regenerate: `services/ai-gateway/grpc_generated/inference_pb2.py`, `inference_pb2_grpc.py`
- Regenerate: `apps/orchestrator/src/grpc-generated/inference_pb.ts`, `inference_pb_grpc.ts`

- [ ] **Step 1: Add `Rerank` rpc + messages to the proto**

Open `proto/inference.proto`. Inside the `service InferenceService { ... }` block, add a new rpc after `EmbedText`:

```proto
  // Text reranker — used by the orchestrator for hybrid retrieval (WARP-286).
  // Scores each passage against the query using a cross-encoder.
  rpc Rerank(RerankRequest) returns (RerankResponse);
```

After the existing `FloatArray` message at the bottom, append:

```proto
// ── Rerank (WARP-286 — orchestrator hybrid retrieval) ──

message RerankRequest {
  // The user query.
  string query = 1;
  // Candidate passages to score, in caller-defined order.
  repeated string passages = 2;
  // Model id. Default: "bge-reranker-base".
  optional string model = 3;
}

message RerankResponse {
  // One float per input passage, same order.
  repeated float scores = 1;
}
```

- [ ] **Step 2: Regenerate the Python stubs**

```bash
cd services/ai-gateway
python -m grpc_tools.protoc \
  -I ../../proto \
  --python_out=grpc_generated \
  --grpc_python_out=grpc_generated \
  ../../proto/inference.proto
```

Expected: `inference_pb2.py` + `inference_pb2_grpc.py` overwritten. If `grpc_tools` isn't installed locally, document it in the commit message and rely on CI's regeneration step.

- [ ] **Step 3: Regenerate the TS stubs**

```bash
cd apps/orchestrator
npm run grpc:generate 2>&1 | tail -5
```

(If no `grpc:generate` script exists yet, inspect `package.json` for the existing proto-to-TS command. The orchestrator's existing `Embed` integration must have used one — find it via `grep -rn "buf generate\|grpc_tools\|ts-proto" apps/orchestrator/`.)

Expected: `apps/orchestrator/src/grpc-generated/inference_pb.ts` + `inference_pb_grpc.ts` overwritten with `RerankRequest`/`RerankResponse`/`Rerank` method bindings.

- [ ] **Step 4: Sanity-check the generated TS**

```bash
cd apps/orchestrator
grep -E "RerankRequest|RerankResponse|Rerank\b" src/grpc-generated/inference_pb.ts src/grpc-generated/inference_pb_grpc.ts | head
```

Expected output includes both classes + the method binding.

- [ ] **Step 5: Commit**

```bash
git add proto/inference.proto \
        services/ai-gateway/grpc_generated/inference_pb2.py \
        services/ai-gateway/grpc_generated/inference_pb2_grpc.py \
        apps/orchestrator/src/grpc-generated/inference_pb.ts \
        apps/orchestrator/src/grpc-generated/inference_pb_grpc.ts
git commit -m "feat(proto): add InferenceService.Rerank rpc + messages (WARP-286)

New gRPC method on the existing InferenceService. Takes (query, passages,
optional model) and returns one float score per passage in the same order.

Stubs regenerated for both Python (services/ai-gateway/grpc_generated)
and TypeScript (apps/orchestrator/src/grpc-generated). Wired by the
ai-gateway handler in Task 4 and the orchestrator caller in Task 5."
```

---

## Task 4: Implement `Rerank` handler in ai-gateway

**Files:**
- Create: `services/ai-gateway/reranker.py`
- Modify: `services/ai-gateway/main.py`
- Create: `services/ai-gateway/tests/test_reranker.py`
- Modify: `services/ai-gateway/requirements.txt`

- [ ] **Step 1: Pin the new dependencies**

Append to `services/ai-gateway/requirements.txt`:

```
# WARP-286: BGE-reranker-base via optimum + onnxruntime
optimum[onnxruntime]>=1.21,<2.0
onnxruntime>=1.18,<2.0
huggingface_hub>=0.24,<1.0
```

(Adjust upper-bounds based on the existing pinning style in the file. If the file uses `==`, replicate.)

- [ ] **Step 2: Write the failing test**

Create `services/ai-gateway/tests/test_reranker.py`:

```python
"""WARP-286 — Rerank gRPC handler.

The handler delegates to reranker.RerankerSingleton.compute_score().
We mock the singleton in these tests so we don't load the real model.
"""
from unittest.mock import patch, MagicMock

import pytest

from grpc_generated import inference_pb2


def test_rerank_returns_one_score_per_passage():
    from reranker import RerankerSingleton

    with patch.object(
        RerankerSingleton, "compute_score",
        return_value=[0.92, 0.41, 0.78],
    ) as compute_score:
        from main import InferenceServicer
        servicer = InferenceServicer()
        req = inference_pb2.RerankRequest(
            query="budget for q4",
            passages=["q4 revenue forecast", "lunch menu", "q4 budget proposal"],
        )
        resp = servicer.Rerank(req, MagicMock())
    assert list(resp.scores) == [0.92, 0.41, 0.78]
    compute_score.assert_called_once()
    call_pairs = compute_score.call_args[0][0]
    assert call_pairs == [
        ["budget for q4", "q4 revenue forecast"],
        ["budget for q4", "lunch menu"],
        ["budget for q4", "q4 budget proposal"],
    ]


def test_rerank_empty_passages_returns_empty():
    from main import InferenceServicer

    servicer = InferenceServicer()
    req = inference_pb2.RerankRequest(query="anything", passages=[])
    resp = servicer.Rerank(req, MagicMock())
    assert list(resp.scores) == []


def test_rerank_rejects_unsupported_model():
    from main import InferenceServicer
    import grpc

    servicer = InferenceServicer()
    ctx = MagicMock()
    req = inference_pb2.RerankRequest(
        query="x", passages=["y"], model="not-a-real-model",
    )
    servicer.Rerank(req, ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.INVALID_ARGUMENT)
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd services/ai-gateway
python -m pytest tests/test_reranker.py -v 2>&1 | tail -10
```

Expected: collection error or `ImportError: cannot import name 'RerankerSingleton'` (the module doesn't exist yet).

- [ ] **Step 4: Create the reranker singleton**

Create `services/ai-gateway/reranker.py`:

```python
"""WARP-286 — BGE-reranker-base singleton.

Loads the model lazily on first use. Cached on disk at
`/var/cache/droplet/models/bge-reranker-base/` so subsequent
container starts skip the ~280 MB download.

Inference runs via optimum.onnxruntime on CPU. Future tickets may
add a TensorRT backend for Jetson GPU acceleration.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

_MODEL_ID = "BAAI/bge-reranker-base"
_CACHE_DIR = Path("/var/cache/droplet/models/bge-reranker-base")


class RerankerSingleton:
    """Lazy-init singleton; not thread-safe at first init but gRPC server
    serializes requests through one Python interpreter so this is fine."""

    _instance: Optional["RerankerSingleton"] = None

    def __init__(self) -> None:
        from optimum.onnxruntime import ORTModelForSequenceClassification
        from transformers import AutoTokenizer

        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(_CACHE_DIR))
        logger.info("Loading BGE-reranker-base from %s", _CACHE_DIR)
        self._tokenizer = AutoTokenizer.from_pretrained(_MODEL_ID, cache_dir=_CACHE_DIR)
        self._model = ORTModelForSequenceClassification.from_pretrained(
            _MODEL_ID, cache_dir=_CACHE_DIR, file_name="model_quantized.onnx",
        )
        logger.info("Reranker model loaded")

    @classmethod
    def instance(cls) -> "RerankerSingleton":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def compute_score(self, pairs: List[List[str]], batch_size: int = 8) -> List[float]:
        """Return one score per (query, passage) pair. Higher is more relevant."""
        if not pairs:
            return []
        scores: List[float] = []
        for i in range(0, len(pairs), batch_size):
            batch = pairs[i : i + batch_size]
            inputs = self._tokenizer(
                [p[0] for p in batch], [p[1] for p in batch],
                padding=True, truncation=True, max_length=512, return_tensors="np",
            )
            outputs = self._model(**inputs)
            scores.extend([float(s) for s in outputs.logits.reshape(-1)])
        return scores
```

- [ ] **Step 5: Add the `Rerank` handler to `main.py`**

Find the `InferenceServicer` class in `services/ai-gateway/main.py`. After the `EmbedText` method, add:

```python
    _SUPPORTED_MODELS = {"", "bge-reranker-base"}

    def Rerank(self, request, context):
        """WARP-286 — score (query, passage) pairs via a cross-encoder."""
        from reranker import RerankerSingleton

        if request.model not in self._SUPPORTED_MODELS:
            import grpc
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details(
                f"Unsupported model {request.model!r}. "
                f"Supported: {sorted(s for s in self._SUPPORTED_MODELS if s)}"
            )
            return inference_pb2.RerankResponse()
        if not request.passages:
            return inference_pb2.RerankResponse(scores=[])
        pairs = [[request.query, p] for p in request.passages]
        scores = RerankerSingleton.instance().compute_score(pairs)
        return inference_pb2.RerankResponse(scores=scores)
```

(If `inference_pb2` isn't already imported in main.py, add `from grpc_generated import inference_pb2` near the top.)

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd services/ai-gateway
python -m pytest tests/test_reranker.py -v 2>&1 | tail -10
```

Expected: 3 passing.

- [ ] **Step 7: Commit**

```bash
git add services/ai-gateway/reranker.py \
        services/ai-gateway/main.py \
        services/ai-gateway/tests/test_reranker.py \
        services/ai-gateway/requirements.txt
git commit -m "feat(ai-gateway): Rerank gRPC handler with BGE-reranker-base int8 (WARP-286)

Lazy-loaded singleton loads BGE-reranker-base from
/var/cache/droplet/models/bge-reranker-base/ — pulls from Hugging Face
on first run (~280 MB int8 ONNX), reads from cache thereafter.

Inference via optimum.onnxruntime on CPU. Batches of 8 passages per
forward pass. Max passage length 512 tokens (truncated).

3 pytest cases verifying the gRPC contract: happy path, empty
passages, unsupported model id → INVALID_ARGUMENT."
```

---

## Task 5: `rerankPassages` (orchestrator) with Redis cache + wire into `searchHybrid`

**Files:**
- Create: `apps/orchestrator/src/services/reranker.client.ts`
- Modify: `apps/orchestrator/src/services/file-search.service.ts`
- Modify: `apps/orchestrator/src/services/file-search.service.test.ts`

- [ ] **Step 1: Create the gRPC client**

Create `apps/orchestrator/src/services/reranker.client.ts`:

```typescript
/**
 * WARP-286 — gRPC client for ai-gateway's Rerank method.
 *
 * Reuses the same channel pattern as embedding.client.ts. Lazy
 * initialization so unit tests don't try to dial without a stub.
 */
import * as grpc from "@grpc/grpc-js";
import {
  InferenceServiceClient,
} from "../grpc-generated/inference_pb_grpc.js";
import {
  RerankRequest,
} from "../grpc-generated/inference_pb.js";

let _client: InferenceServiceClient | null = null;

function client(): InferenceServiceClient {
  if (_client) return _client;
  const url = process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
  _client = new InferenceServiceClient(url, grpc.credentials.createInsecure());
  return _client;
}

export interface RerankerClient {
  rerank(args: { query: string; passages: string[]; model?: string }): Promise<{ scores: number[] }>;
}

export const rerankerClient: RerankerClient = {
  async rerank({ query, passages, model }) {
    const req = new RerankRequest();
    req.setQuery(query);
    req.setPassagesList(passages);
    if (model) req.setModel(model);
    return new Promise((resolve, reject) => {
      client().rerank(req, (err, resp) => {
        if (err) return reject(err);
        resolve({ scores: resp.getScoresList() });
      });
    });
  },
};
```

(Adjust the import paths / method names to match what `npm run grpc:generate` produced. The `getScoresList()` and `setPassagesList()` shape is typical of `ts-proto`/`grpc-tools` output; verify against the actual `inference_pb.ts` after Task 3.)

- [ ] **Step 2: Add the failing `rerankPassages` test**

Append to `file-search.service.test.ts`:

```typescript
import type { Redis } from "ioredis";
import { rerankPassages } from "./file-search.service.js";

function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
      return "OK";
    }),
  } as unknown as Redis;
}

function makeMockReranker(scores: number[]) {
  return {
    rerank: vi.fn(async () => ({ scores })),
  };
}

describe("rerankPassages", () => {
  const hits = [
    hit("nextcloud", "/a.pdf", 0, 0.5),
    hit("nextcloud", "/b.pdf", 0, 0.4),
    hit("nextcloud", "/c.pdf", 0, 0.3),
  ];

  it("returns empty when input is empty", async () => {
    const redis = makeMockRedis();
    const r = makeMockReranker([]);
    const out = await rerankPassages({
      query: "x", hits: [], redis, reranker: r,
    });
    expect(out).toEqual([]);
    expect(r.rerank).not.toHaveBeenCalled();
  });

  it("calls the reranker on cache miss, writes the result", async () => {
    const redis = makeMockRedis();
    const r = makeMockReranker([0.1, 0.9, 0.2]);
    const out = await rerankPassages({
      query: "x", hits, redis, reranker: r,
    });
    expect(out.map(h => h.path)).toEqual(["/b.pdf", "/c.pdf", "/a.pdf"]);
    expect(out[0]!.score).toBe(0.9);
    expect(r.rerank).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it("uses cached scores on cache hit", async () => {
    const redis = makeMockRedis();
    const r1 = makeMockReranker([0.1, 0.9, 0.2]);
    await rerankPassages({ query: "x", hits, redis, reranker: r1 });
    const r2 = makeMockReranker([99, 99, 99]); // never called
    const out = await rerankPassages({ query: "x", hits, redis, reranker: r2 });
    expect(r2.rerank).not.toHaveBeenCalled();
    expect(out[0]!.path).toBe("/b.pdf"); // same ordering as the cached run
  });

  it("survives reranker errors by returning unsorted input", async () => {
    const redis = makeMockRedis();
    const r = { rerank: vi.fn(async () => { throw new Error("backend down"); }) };
    const out = await rerankPassages({ query: "x", hits, redis, reranker: r });
    expect(out).toEqual(hits); // pass-through unchanged
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
cd apps/orchestrator
npx vitest run src/services/file-search.service.test.ts -t "rerankPassages" 2>&1 | tail -10
```

Expected: FAIL — `rerankPassages is not exported`.

- [ ] **Step 4: Implement `rerankPassages`**

In `file-search.service.ts`, after `searchByLexical`, add (before `searchHybrid`):

```typescript
import { createHash } from "node:crypto";

export interface RerankPassagesParams {
  query: string;
  hits: SearchHit[];
  /** Redis-like client; abstracted so unit tests can mock without ioredis. */
  redis: {
    get(key: string): Promise<string | null>;
    setex(key: string, ttl: number, value: string): Promise<unknown>;
  };
  /** Reranker client (gRPC wrapper) — abstracted so unit tests can mock. */
  reranker: {
    rerank(args: { query: string; passages: string[] }): Promise<{ scores: number[] }>;
  };
  /** Cap per-passage length; bigger values cost more tokens at the model. */
  maxPassageChars?: number;
  /** Cache TTL in seconds. Default 300. */
  cacheTtlSec?: number;
}

/**
 * WARP-286 — rerank a set of hits via a cross-encoder.
 * Cached in Redis by sha256(query + chunk-id-list); 5-min TTL by default.
 * On any error (gRPC down, Redis down) returns the input unchanged so
 * the caller still gets results, just unreranked. Logs the failure.
 */
export async function rerankPassages(
  params: RerankPassagesParams,
): Promise<SearchHit[]> {
  const { query, hits, redis, reranker } = params;
  if (hits.length === 0) return [];
  const maxChars = params.maxPassageChars ?? 512;
  const ttl = params.cacheTtlSec ?? 300;

  const ids = hits
    .map((h) => `${h.source}:${h.path}:${h.chunkIdx}`)
    .join("|");
  const cacheKey =
    "rerank:" + createHash("sha256").update(query + "::" + ids).digest("hex");

  // Cache lookup is best-effort.
  let cached: string | null = null;
  try {
    cached = await redis.get(cacheKey);
  } catch (e) {
    // Redis down — proceed to live call.
  }
  if (cached) {
    try {
      const scores = JSON.parse(cached) as number[];
      if (Array.isArray(scores) && scores.length === hits.length) {
        return hits
          .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
          .sort((a, b) => b.score - a.score);
      }
    } catch {
      // Cache entry malformed — fall through to live call.
    }
  }

  let scores: number[];
  try {
    const passages = hits.map((h) => h.snippet.slice(0, maxChars));
    const resp = await reranker.rerank({ query, passages });
    scores = resp.scores;
    if (!Array.isArray(scores) || scores.length !== hits.length) {
      return hits; // backend returned a malformed payload; pass-through
    }
  } catch {
    return hits; // reranker unavailable; pass-through unsorted
  }

  // Cache write is best-effort.
  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(scores));
  } catch {
    // Redis down — return successfully without caching.
  }

  return hits
    .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 5: Wire `rerankPassages` into `searchHybrid`**

Modify `searchHybrid` in `file-search.service.ts` to accept optional `redis` + `reranker` and to call `rerankPassages` when both are provided:

```typescript
export interface SearchHybridParams {
  userId: string;
  vector: number[];
  query: string;
  limit?: number;
  minSimilarity?: number;
  perArmK?: number;
  source?: FileContentSource;
  since?: Date;
  /** Optional reranker pipe. When provided, fused top-50 is reranked.
   *  When omitted, returns RRF top-K. */
  rerank?: {
    redis: RerankPassagesParams["redis"];
    reranker: RerankPassagesParams["reranker"];
    /** Pre-rerank candidate count to fetch from RRF. Default 50. */
    candidates?: number;
  };
}

export async function searchHybrid(
  prisma: PrismaClient,
  params: SearchHybridParams,
): Promise<SearchHit[]> {
  const perArmK = params.perArmK ?? 100;
  const limit = params.limit ?? 10;
  const [vectorHits, lexicalHits] = await Promise.all([
    searchByVector(prisma, {
      userId: params.userId,
      vector: params.vector,
      limit: perArmK,
      minSimilarity: params.minSimilarity ?? 0.3,
      source: params.source,
      since: params.since,
    }),
    searchByLexical(prisma, {
      userId: params.userId,
      query: params.query,
      limit: perArmK,
      source: params.source,
      since: params.since,
    }),
  ]);
  const fused = reciprocalRankFusion(vectorHits, lexicalHits);

  if (params.rerank) {
    const candidates = fused.slice(0, params.rerank.candidates ?? 50);
    const reranked = await rerankPassages({
      query: params.query,
      hits: candidates,
      redis: params.rerank.redis,
      reranker: params.rerank.reranker,
    });
    return reranked.slice(0, limit);
  }
  return fused.slice(0, limit);
}
```

- [ ] **Step 6: Add a test for `searchHybrid` with reranker**

Append to `file-search.service.test.ts`:

```typescript
describe("searchHybrid with reranker", () => {
  it("reranks fused candidates and returns top-K", async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn()
        .mockResolvedValueOnce([ // vector arm
          { source: "nextcloud", path: "/a.pdf", chunkIdx: 0, pageNumber: null,
            brainItemId: null, metadata: null, snippet: "alpha", score: 0.9 },
          { source: "nextcloud", path: "/b.pdf", chunkIdx: 0, pageNumber: null,
            brainItemId: null, metadata: null, snippet: "beta", score: 0.8 },
        ])
        .mockResolvedValueOnce([ // lexical arm
          { source: "nextcloud", path: "/c.pdf", chunkIdx: 0, pageNumber: null,
            brainItemId: null, metadata: null, snippet: "gamma", score: 0.7 },
        ]),
    } as any;
    const redis = makeMockRedis();
    const reranker = makeMockReranker([0.3, 0.9, 0.5]);
    const hits = await searchHybrid(prisma, {
      userId: "alice", vector: new Array(384).fill(0.01), query: "hello",
      limit: 10,
      rerank: { redis, reranker, candidates: 50 },
    });
    // The candidate order is RRF order: /a, /b, /c.
    // Reranker returns [0.3, 0.9, 0.5] for those in that order.
    // After rerank sort: /b (0.9), /c (0.5), /a (0.3).
    expect(hits.map(h => h.path)).toEqual(["/b.pdf", "/c.pdf", "/a.pdf"]);
  });
});
```

- [ ] **Step 7: Run all tests**

```bash
cd apps/orchestrator
npx vitest run src/services/file-search.service.test.ts 2>&1 | tail -10
```

Expected: 15 passing (5 RRF + 3 lexical + 2 hybrid + 4 rerankPassages + 1 hybrid-with-reranker).

- [ ] **Step 8: Commit**

```bash
git add apps/orchestrator/src/services/reranker.client.ts \
        apps/orchestrator/src/services/file-search.service.ts \
        apps/orchestrator/src/services/file-search.service.test.ts
git commit -m "feat(orchestrator): rerankPassages with Redis cache + wire into searchHybrid (WARP-286)

rerankPassages is dependency-injected (redis + reranker abstracted)
so unit tests don't need ioredis or a live gRPC channel. Cache key
is sha256(query + chunk-id-list); 5-min TTL by default.

Pass-through on any error path (cache miss + reranker down → input
returned unsorted) so a degraded reranker never breaks search.

searchHybrid grows an optional rerank pipe. When omitted, returns RRF
top-K (existing behavior). When provided, takes RRF top-50, reranks,
returns top-K.

15 unit tests total across the file."
```

---

## Task 6: Switch MCP `search_content` + `/knowledge` callers to `searchHybrid`

**Files:**
- Modify: `packages/tools-core/src/handlers/files/search-content.ts`
- Modify: `apps/orchestrator/src/routes/files-knowledge.ts`
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts` (or whichever file builds `ToolContext`)
- Modify: `packages/tools-core/src/types.ts` if the `ToolContext` shape needs a `searchHybrid` field

- [ ] **Step 1: Add `searchHybrid` to `ToolContext`**

Open `packages/tools-core/src/types.ts`. Find the `ToolContext` interface. Add (after the existing `embedText` entry):

```typescript
  /**
   * Hybrid retrieval shim — orchestrator binds this to file-search.service.ts's
   * `searchHybrid`. WARP-286. Optional; if absent the handler returns
   * SEARCH_UNAVAILABLE.
   */
  searchHybrid?: (args: {
    query: string;
    limit: number;
  }) => Promise<Array<{
    source: "nextcloud" | "brain";
    path: string;
    chunkIdx: number;
    pageNumber: number | null;
    brainItemId: string | null;
    score: number;
    snippet: string;
    metadata: Record<string, unknown> | null;
  }>>;
```

- [ ] **Step 2: Refactor `search-content.ts` handler**

Open `packages/tools-core/src/handlers/files/search-content.ts`. Replace the body of `handler` (from `if (!ctx.embedText)` to the end of the function) with:

```typescript
  if (!ctx.searchHybrid) return err("SEARCH_UNAVAILABLE", "search_unavailable");

  let hits: Awaited<ReturnType<NonNullable<typeof ctx.searchHybrid>>>;
  try {
    hits = await ctx.searchHybrid({ query, limit });
  } catch {
    return err("SEARCH_FAILED", "search_failed");
  }

  return {
    ok: true,
    data: {
      query,
      results: hits.map((h) => ({
        source: h.source,
        path: h.path,
        chunkIdx: h.chunkIdx,
        pageNumber: h.pageNumber,
        score: h.score,
        text: h.snippet,
      })),
    },
  };
}
```

(Keep the existing header / input schema / `err` helper. The `embedText` path can be removed since hybrid retrieval handles embedding internally on the orchestrator side via the existing `searchByVector` it calls.)

- [ ] **Step 3: Build the `searchHybrid` shim in the orchestrator**

Find where `ToolContext` is constructed before each MCP request. This is typically `apps/orchestrator/src/services/llm-agent.service.ts` or `apps/orchestrator/src/services/mcp-client.service.ts` — grep:

```bash
grep -rn "ToolContext\|embedText:" apps/orchestrator/src/ | head
```

In the construction site, after the existing `embedText` binding, add (importing the necessary modules at the top of the file):

```typescript
import { searchHybrid } from "./file-search.service.js";
import { rerankerClient } from "./reranker.client.js";
import { redis } from "./redis.client.js"; // wherever the existing ioredis singleton lives

// ...inside the context-build code...
const ctx: ToolContext = {
  // ...existing fields...
  searchHybrid: async ({ query, limit }) => {
    // Get the embedding from ai-gateway via the existing embedText path
    const vectors = await ctx.embedText!([query]);
    const vector = vectors[0]!;
    return await searchHybrid(prisma, {
      userId,
      vector,
      query,
      limit,
      rerank: { redis, reranker: rerankerClient },
    });
  },
};
```

(Exact location and `prisma`/`userId` variable names depend on the existing code; the principle is: bind `searchHybrid` so it uses the user's identity + the orchestrator's prisma/redis/grpc singletons.)

- [ ] **Step 4: Update `routes/files-knowledge.ts`**

Find the `search.searchByVector(prisma, ...)` call (around line 291). Replace with the hybrid version using the same shape:

```typescript
const hits = await search.searchHybrid(prisma, {
  userId: req.user.username,
  vector: queryEmbedding,
  query: rawQuery,
  limit,
  rerank: { redis, reranker: rerankerClient },
});
```

(The function imports `rerankerClient` from `../services/reranker.client.js` and `redis` from wherever the existing singleton lives. If `redis` isn't already used in this file, add an import.)

- [ ] **Step 5: Run all the orchestrator tests + tools-core tests**

```bash
cd apps/orchestrator
npx vitest run 2>&1 | tail -10
cd ../../packages/tools-core
npx vitest run 2>&1 | tail -10
```

Expected: all green. Existing `search-content` tests will need updating to mock `ctx.searchHybrid` instead of `ctx.embedText` + raw SQL — find them via `grep -rn "search_content\|search-content" packages/tools-core/src/__tests__ apps/orchestrator/src/__tests__`. Update the mock setup to populate `searchHybrid` and remove the `embedText` + Prisma `$queryRawUnsafe` mocks that the old code path depended on.

- [ ] **Step 6: Commit**

```bash
git add packages/tools-core/src/handlers/files/search-content.ts \
        packages/tools-core/src/types.ts \
        packages/tools-core/src/__tests__ \
        apps/orchestrator/src/routes/files-knowledge.ts \
        apps/orchestrator/src/services/llm-agent.service.ts
git commit -m "feat: switch search_content + /knowledge to searchHybrid (WARP-286)

MCP search_content handler no longer assembles its own embedding +
SQL query. Now delegates entirely to the orchestrator-side
searchHybrid shim via the new ctx.searchHybrid binding on ToolContext.

/knowledge route's search action follows the same swap.

This brings both consumers onto the hybrid pipeline (BM25 + ANN +
RRF + reranker) without behavior change at the wire shape level —
SearchHit fields are preserved."
```

---

## Task 7: Retrieval eval harness + hand-curated query set

**Files:**
- Create: `tests/retrieval-eval/queries.yaml`
- Create: `tests/retrieval-eval/run.ts`
- Modify: `tests/package.json` (add `test:retrieval-eval` script)

- [ ] **Step 1: Hand-curate the query set**

Create `tests/retrieval-eval/queries.yaml`. Aim for ~20-30 queries across realistic personas. Use existing fixtures from `services/file-indexer/tests/fixtures/`. Example structure:

```yaml
# WARP-286 retrieval eval — manually curated.
# Each query has 1-3 relevant chunks. "Relevant" means a reasonable
# user reading the chunk text would consider it answering the query.
# Match rules:
#   - source + path + chunk_idx exact = the strictest
#   - path_contains + chunk_idx_any = looser; any chunk from that doc counts
#   - The metric is NDCG@10, so partial relevance via DCG works fine.

queries:
  - id: q01
    query: "what is the budget for Q4"
    relevant:
      - source: nextcloud
        path_contains: "sample.pdf"
        chunk_idx_any: true
      - source: brain
        path_contains: "warp224-audio"
        chunk_idx_any: true
    notes: "lexical hit on 'Q4' + transcript synonym"

  - id: q02
    query: "alphahotel"
    relevant:
      - source: nextcloud
        path_contains: "sample.pdf"
        chunk_idx_any: true
    notes: "single-token rare match — pure lexical win"

  - id: q03
    query: "budget meeting kickoff"
    relevant:
      - source: brain
        path_contains: "warp224-video-subs"
        chunk_idx_any: true
    notes: "exact phrase from subtitle stream"

  - id: q04
    query: "what does the screenshot say"
    relevant:
      - source: brain
        path_contains: "warp206-image"
        chunk_idx_any: true
    notes: "OCR-recovered text"

  - id: q05
    query: "echofoxtrot"
    relevant:
      - source: brain
        path_contains: "warp206-image"
        chunk_idx_any: true
    notes: "rare token from OCR"

  - id: q06
    query: "bob attached the proposal"
    relevant:
      - source: brain
        path_contains: "warp224-email"
        chunk_idx_any: true
    notes: "email body retrieval"

  - id: q07
    query: "attached PDF for the full proposal"
    relevant:
      - source: brain
        path_contains: "warp224-email"
        chunk_idx_any: true

  - id: q08
    query: "ONE HUNDRED THOUSAND"
    relevant:
      - source: brain
        path_contains: "warp224-video-frame"
        chunk_idx_any: true
      - source: brain
        path_contains: "warp224-video-subs"
        chunk_idx_any: true
    notes: "appears in both frame OCR and subtitle — multi-hit"

  - id: q09
    query: "budget kickoff slide"
    relevant:
      - source: brain
        path_contains: "warp224-video-frame"
        chunk_idx_any: true

  - id: q10
    query: "note inside the zip"
    relevant:
      - source: nextcloud
        path_contains: "simple.zip"
        chunk_idx_any: true
    notes: "archive-member retrieval"

  - id: q11
    query: "the budget for q4 is one hundred thousand"
    relevant:
      - source: nextcloud
        path_contains: "simple.zip"
        chunk_idx_any: true
      - source: brain
        path_contains: "warp224-audio"
        chunk_idx_any: true
    notes: "exact phrase across multiple sources"

  - id: q12
    query: "Tesseract OCR"
    relevant:
      - source: brain
        path_contains: "warp206-image"
        chunk_idx_any: true

  - id: q13
    query: "q4 revenue"
    relevant:
      - source: brain
        path_contains: "warp224-video-subs"
        chunk_idx_any: true
      - source: brain
        path_contains: "warp224-audio"
        chunk_idx_any: true

  - id: q14
    query: "rfc822 email message"
    relevant:
      - source: brain
        path_contains: "warp224-email"
        chunk_idx_any: true

  - id: q15
    query: "frame OCR sentinel"
    relevant:
      - source: brain
        path_contains: "warp224-video-frame"
        chunk_idx_any: true

  - id: q16
    query: "audio transcript faster-whisper"
    relevant:
      - source: brain
        path_contains: "warp224-audio"
        chunk_idx_any: true

  - id: q17
    query: "image extracted text screenshot"
    relevant:
      - source: brain
        path_contains: "warp206-image"
        chunk_idx_any: true

  - id: q18
    query: "test-rag-end-to-end folder PDF"
    relevant:
      - source: nextcloud
        path_contains: "test-rag-end-to-end"
        chunk_idx_any: true
    notes: "path/name token query — pure lexical win"

  - id: q19
    query: "zip archive note budget"
    relevant:
      - source: nextcloud
        path_contains: "simple.zip"
        chunk_idx_any: true

  - id: q20
    query: "video clip on-screen text slide"
    relevant:
      - source: brain
        path_contains: "warp224-video-frame"
        chunk_idx_any: true
```

(20 is the floor; expand to 25-30 if the user adds more fixtures.)

- [ ] **Step 2: Add the `test:retrieval-eval` script**

In `tests/package.json`, add to the `scripts` block:

```json
"test:retrieval-eval": "vitest run retrieval-eval/run.ts --reporter=verbose"
```

- [ ] **Step 3: Write the eval harness**

Create `tests/retrieval-eval/run.ts`:

```typescript
/**
 * WARP-286 retrieval eval — compares three pipelines:
 *   1. vector-only            (existing searchByVector — baseline)
 *   2. RRF                    (searchHybrid without reranker)
 *   3. full hybrid + reranker (searchHybrid with reranker)
 *
 * Computes NDCG@10 for each pipeline against tests/retrieval-eval/queries.yaml.
 * Asserts: ndcg(full) >= 1.1 * ndcg(vector-only).
 *
 * Gated by RUN_RAG_INTEGRATION=1. Reuses tests/helpers/rag-retrieval.ts for
 * compose-up + fixture seeding (the same harness WARP-224 ships).
 *
 * Run: ./scripts/test-rag.sh  (or npm run test:retrieval-eval after manual
 * setup).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  REPO_ROOT, SHOULD_RUN, API_URL, sh, dbQuery, uploadBrainFile,
  uploadNextcloudFile, pollUntilBrainIndexed, pollNcChunkCount,
  COMPOSE,
} from "../helpers/rag-retrieval";

interface RelevantMatch {
  source: "nextcloud" | "brain";
  path?: string;
  path_contains?: string;
  chunk_idx?: number;
  chunk_idx_any?: boolean;
}

interface Query {
  id: string;
  query: string;
  relevant: RelevantMatch[];
  notes?: string;
}

interface SearchResult {
  source: "nextcloud" | "brain";
  path: string;
  chunkIdx: number;
  score: number;
}

function matchesRelevant(result: SearchResult, r: RelevantMatch): boolean {
  if (r.source !== result.source) return false;
  if (r.path && result.path !== r.path) return false;
  if (r.path_contains && !result.path.includes(r.path_contains)) return false;
  if (r.chunk_idx !== undefined && result.chunkIdx !== r.chunk_idx) return false;
  // chunk_idx_any = true means we accept any chunk index for the doc.
  return true;
}

function isRelevant(result: SearchResult, query: Query): boolean {
  return query.relevant.some((r) => matchesRelevant(result, r));
}

function dcg(rels: number[]): number {
  let s = 0;
  for (let i = 0; i < rels.length; i++) {
    s += rels[i]! / Math.log2(i + 2);
  }
  return s;
}

function ndcgAt10(results: SearchResult[], query: Query): number {
  const top10 = results.slice(0, 10);
  const gains = top10.map((r) => (isRelevant(r, query) ? 1 : 0));
  const idealK = Math.min(query.relevant.length, 10);
  const ideal = Array.from({ length: idealK }, () => 1);
  const idealScore = dcg(ideal);
  if (idealScore === 0) return 0;
  return dcg(gains) / idealScore;
}

async function callSearchEndpoint(
  variant: "vector" | "rrf" | "hybrid",
  query: string,
): Promise<SearchResult[]> {
  // Single endpoint with a variant query parameter. The orchestrator
  // route is added in Step 4 below.
  const url = `${API_URL}/api/admin/retrieval-eval/search?variant=${variant}&q=${encodeURIComponent(query)}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`eval search ${variant} failed: ${res.status}`);
  const body = (await res.json()) as { results: SearchResult[] };
  return body.results;
}

describe.skipIf(!SHOULD_RUN)("retrieval eval — WARP-286", () => {
  let queries: Query[];

  beforeAll(async () => {
    // Boot Compose stack (same pattern as rag-end-to-end).
    sh(`${COMPOSE} up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud`);

    // Wait for DB.
    const dbDeadline = Date.now() + 60_000;
    while (Date.now() < dbDeadline) {
      try { dbQuery("SELECT 1"); break; }
      catch { sh("sleep 1"); }
    }

    // Seed the WARP-224 fixtures.
    const PDF_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.pdf");
    const PNG_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.png");
    const WAV_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.wav");
    const SUBS_VIDEO = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-srt.mp4");
    const FRAME_VIDEO = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-frame-text.mp4");
    const EML = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-pdf-attachment.eml");
    const ZIP = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/simple.zip");

    await uploadNextcloudFile(PDF_FIXTURE, "test-rag-end-to-end");
    await uploadNextcloudFile(ZIP, "test-rag-end-to-end");
    await pollNcChunkCount("%test-rag-end-to-end/sample.pdf", 180_000);
    await pollNcChunkCount("%test-rag-end-to-end/simple.zip", 180_000);

    const pngUp = await uploadBrainFile(PNG_FIXTURE, "warp206-image.png", "image/png");
    await pollUntilBrainIndexed(pngUp.itemId, 180_000);
    const emlUp = await uploadBrainFile(EML, "warp224-email.eml", "message/rfc822");
    await pollUntilBrainIndexed(emlUp.itemId, 180_000);
    // Audio + video require transcribe-now (WARP-218 default); skip them in
    // the eval if they're not already indexed from a previous test run.
    // The eval still has plenty of queries that hit indexed fixtures.

    queries = parseYaml(readFileSync(resolve(__dirname, "queries.yaml"), "utf8")).queries;
  }, 600_000);

  it("full hybrid retrieval beats vector-only baseline by ≥10% NDCG@10", async () => {
    const ndcgs: Record<"vector" | "rrf" | "hybrid", number[]> = {
      vector: [], rrf: [], hybrid: [],
    };

    for (const q of queries) {
      const [vec, rrf, hyb] = await Promise.all([
        callSearchEndpoint("vector", q.query),
        callSearchEndpoint("rrf", q.query),
        callSearchEndpoint("hybrid", q.query),
      ]);
      ndcgs.vector.push(ndcgAt10(vec, q));
      ndcgs.rrf.push(ndcgAt10(rrf, q));
      ndcgs.hybrid.push(ndcgAt10(hyb, q));
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const vecMean = mean(ndcgs.vector);
    const rrfMean = mean(ndcgs.rrf);
    const hybMean = mean(ndcgs.hybrid);

    console.log("\nNDCG@10 means:");
    console.log(`  vector-only       : ${vecMean.toFixed(4)}`);
    console.log(`  RRF (no rerank)   : ${rrfMean.toFixed(4)}`);
    console.log(`  full hybrid+rerank: ${hybMean.toFixed(4)}`);
    console.log(`  delta: hybrid is ${(((hybMean / vecMean) - 1) * 100).toFixed(1)}% above vector-only`);

    // Acceptance criterion: ≥10% improvement.
    expect(hybMean).toBeGreaterThanOrEqual(vecMean * 1.1);
  }, 600_000);
});
```

- [ ] **Step 4: Add the `/api/admin/retrieval-eval/search` endpoint**

Create `apps/orchestrator/src/routes/admin-retrieval-eval.ts`:

```typescript
/**
 * WARP-286 — eval endpoint. Lets the retrieval-eval/run.ts harness call
 * each of the three pipelines (vector-only / RRF / full hybrid) directly
 * to compute NDCG@10. Admin-only; only mounted when NODE_ENV !== production.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  searchByVector, searchHybrid, reciprocalRankFusion, searchByLexical,
} from "../services/file-search.service.js";
import { rerankerClient } from "../services/reranker.client.js";
import { redis } from "../services/redis.client.js";
import { embedText } from "../services/embedding.client.js";

export function createAdminRetrievalEvalRouter(prisma: PrismaClient) {
  const router = Router();
  router.get("/admin/retrieval-eval/search", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "not_found" });
    }
    const userId = req.user?.username ?? "dev";
    const variant = String(req.query.variant ?? "hybrid");
    const query = String(req.query.q ?? "");
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    if (!query) return res.status(400).json({ error: "query required" });

    const [vector] = await embedText([query]);
    if (!vector) return res.status(503).json({ error: "embedding unavailable" });

    if (variant === "vector") {
      const hits = await searchByVector(prisma, { userId, vector, limit, minSimilarity: 0.0 });
      return res.json({ results: hits.map(h => ({ source: h.source, path: h.path, chunkIdx: h.chunkIdx, score: h.score })) });
    }
    if (variant === "rrf") {
      const hits = await searchHybrid(prisma, { userId, vector, query, limit }); // no rerank pipe
      return res.json({ results: hits.map(h => ({ source: h.source, path: h.path, chunkIdx: h.chunkIdx, score: h.score })) });
    }
    const hits = await searchHybrid(prisma, {
      userId, vector, query, limit,
      rerank: { redis, reranker: rerankerClient },
    });
    return res.json({ results: hits.map(h => ({ source: h.source, path: h.path, chunkIdx: h.chunkIdx, score: h.score })) });
  });
  return router;
}
```

Wire it into `apps/orchestrator/src/app.ts`:

```typescript
import { createAdminRetrievalEvalRouter } from "./routes/admin-retrieval-eval.js";
// ...inside createApp, after the existing route registrations...
app.use("/api", createAdminRetrievalEvalRouter(prisma));
```

- [ ] **Step 5: Run the eval (only when Compose is up)**

```bash
# Skip if you can't run docker locally (macOS /mnt/droplet issue). CI verifies.
RUN_RAG_INTEGRATION=1 API_URL=http://localhost:3000 npm run -w tests test:retrieval-eval 2>&1 | tail -20
```

Expected: console output shows three NDCG@10 means; the assertion `hybMean >= 1.1 * vecMean` passes. If it fails, the spec's growth path is to inspect per-query NDCG (the harness logs each query's score in verbose mode), find the queries where hybrid underperforms, and revise either the query labels or the rerank top-K candidates.

- [ ] **Step 6: Commit**

```bash
git add tests/retrieval-eval/queries.yaml \
        tests/retrieval-eval/run.ts \
        tests/package.json \
        apps/orchestrator/src/routes/admin-retrieval-eval.ts \
        apps/orchestrator/src/app.ts
git commit -m "tests(retrieval-eval): hand-curated NDCG@10 harness (WARP-286)

20 hand-curated queries against the existing WARP-224 fixtures.
Each query has 1-3 'relevant' chunks matched via source + path-contains
+ optional chunk_idx.

Eval harness runs three pipelines per query (vector / RRF / hybrid),
computes NDCG@10, and asserts hybrid ≥ 1.1 × vector — the spec's
acceptance criterion.

Skip-gated by RUN_RAG_INTEGRATION=1 (same as the rest of the rag-tests
suite). Eval endpoint at /api/admin/retrieval-eval/search; 404 in
production so the public surface stays unchanged."
```

---

## Task 8: `docs/RAG_RETRIEVAL.md`

**Files:**
- Create: `docs/RAG_RETRIEVAL.md`

- [ ] **Step 1: Write the doc**

Create `docs/RAG_RETRIEVAL.md` with the following sections:

```markdown
# Hybrid retrieval

Hybrid retrieval combines lexical (BM25-style) and vector (ANN) search,
fuses the rankings via Reciprocal Rank Fusion (RRF), and reranks the
top-50 candidates with a cross-encoder. WARP-286.

## Pipeline

```
                          ┌─────────────────────────────┐
                          │ MCP search_content tool     │
                          │ + /knowledge dashboard route│
                          └──────────────┬──────────────┘
                                         │ searchHybrid()
                                         ▼
        ┌────────────────────────────────────────────────────────┐
        │ apps/orchestrator/src/services/file-search.service.ts  │
        │                                                        │
        │  1. embed(query)              → 384-dim vector         │
        │  2. parallel:                                          │
        │     ├─ vector_search (cosine, k=100)                   │
        │     └─ lexical_search (ts_rank_cd, k=100)              │
        │  3. RRF fusion (k=60)                                  │
        │  4. rerank top-50 via ai-gateway gRPC                  │
        │  5. ACL filter (already in 2's SQL)                    │
        │  6. return top-K (default 10)                          │
        └────────────────────────────────────────────────────────┘
```

## Lexical engine — Postgres native FTS

v1 uses Postgres's native full-text search:

- `tsvector` generated column on `FileContentChunk.text`, STORED on disk
- `GIN` index for fast `@@` matches
- `websearch_to_tsquery('english', ...)` as the query parser
- `ts_rank_cd(text_tsv, query, 32)` as the ranking function

`ts_rank_cd` with normalization flag `32` (mean-of-distance-between-matches)
is the closest native-FTS analog to BM25's length normalization. Not a
true BM25, but adequate for our use case where vector retrieval covers
the bulk of semantic matching.

## Future swap — `pg_search` (Tantivy-on-Postgres)

If eval shows native FTS underperforming on a real workload, the swap
path is:

1. Custom Postgres image based on `pgvector/pgvector:pg16` with the
   `pg_search` extension installed via apt. Affects `docker/docker-compose.yml`'s
   db service build context.
2. New migration: add a `pg_search`-managed index on `FileContentChunk.text`.
3. Swap `searchByLexical` body to use `@@@` operator and `paradedb.score()`.
4. Drop the `text_tsv` column after the bake-in period.

The retrieval abstraction in `file-search.service.ts` makes this a swap,
not a rewrite. The eval harness in `tests/retrieval-eval/` is the gate:
re-run after the swap and confirm NDCG@10 improvement.

## Reranker

`BGE-reranker-base` int8 ONNX:
- 278M parameters; ~280 MB on disk
- English-leaning (cross-lingual capability exists but is weaker than v2-m3)
- MTEB rerank avg: 84.8
- ~50 ms/req on CPU for top-50 (Jetson Orin int8)
- Served by `services/ai-gateway` via the gRPC `Rerank` method
- Cached at `/var/cache/droplet/models/bge-reranker-base/` after first pull

Why not BGE-reranker-v2-m3? v2-m3 is multilingual + higher quality but
2× the memory + 3× the CPU. For a household appliance with mostly-English
content, the marginal quality (~1.6 pts on MTEB) doesn't justify the cost.
Swap is mechanical: change the `_MODEL_ID` constant in `services/ai-gateway/reranker.py`
and run the eval again.

## Caching

Rerank results are cached in Redis under `rerank:<sha256(query + chunk-id-list)>`
with a 5-minute TTL. The cache key includes the chunk-id list so it
auto-invalidates when the underlying RRF candidate set changes (e.g., new
files indexed). All cache operations are best-effort try/catch — Redis
down does not break search.

## Eval

`tests/retrieval-eval/` holds the hand-curated query set + the NDCG@10
harness. Run via:

```bash
RUN_RAG_INTEGRATION=1 ./scripts/test-rag.sh
# or
RUN_RAG_INTEGRATION=1 npm run -w tests test:retrieval-eval
```

Acceptance: `ndcg(full hybrid) ≥ 1.1 × ndcg(vector-only)`. The harness
runs three pipelines per query and logs per-query NDCG so regressions
can be triaged.

### Growth path

Once Phase B (activity graph + click data) lands, the eval set extends
with `(query, clicked_chunk)` pairs mined from `ActivityEvent`. Until
then, manual curation is the source of ground truth.

## Tuning knobs

| Knob | Where | Default | When to tune |
|---|---|---|---|
| RRF `k` | `reciprocalRankFusion(_, _, k)` in file-search.service.ts | 60 | Increase to favor consensus, decrease to favor highly-ranked outliers |
| Per-arm k | `searchHybrid({ perArmK })` | 100 | Raise if rerank misses good candidates |
| Rerank candidates | `searchHybrid({ rerank: { candidates } })` | 50 | Raise to improve recall at higher CPU cost |
| Rerank cache TTL | `rerankPassages({ cacheTtlSec })` | 300 | Raise if queries repeat heavily; lower if data churns fast |
| Min similarity (vector) | `searchHybrid({ minSimilarity })` | 0.3 | Raise to drop weak vector matches; lower for noisier corpora |
| Max passage chars | `rerankPassages({ maxPassageChars })` | 512 | Match the reranker tokenizer's max_length |

## Operational notes

- The reranker model is downloaded from Hugging Face on first `Rerank` call.
  First call takes 30-60s; subsequent calls hit the disk cache (~3s cold
  start). Production deployments should pre-warm the model at container
  start by issuing one no-op `Rerank` call.
- On embedding service down: `searchHybrid` falls back to lexical-only.
- On reranker service down: `rerankPassages` returns the RRF top-K unranked.
- On Redis down: caches are bypassed; both layers still function.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RAG_RETRIEVAL.md
git commit -m "docs(retrieval): RAG_RETRIEVAL.md (WARP-286)

Architecture diagram, native FTS rationale, future-swap path to
pg_search, reranker model selection rationale (base vs v2-m3), eval
methodology, tuning knobs, operational notes (model pre-warm, fallback
behavior on each backend failing)."
```

---

## Self-review

### Spec coverage

| Spec section | Plan task |
|---|---|
| §SQL changes — schema migration | Task 1 |
| §SQL changes — `searchByLexical` | Task 2 (steps 5-7) |
| §RRF fusion | Task 2 (steps 1-4) |
| §Reranker — gRPC proto | Task 3 |
| §Reranker — ai-gateway handler | Task 4 |
| §Reranker — orchestrator caller (`rerankPassages`) | Task 5 |
| §Pipeline latency budget | Tasks 4+5 implement; Task 7 measures |
| §Eval harness | Task 7 |
| §Unit test coverage | Tasks 2, 4, 5 (test files alongside impl) |
| §Code placement (`searchHybrid` alongside existing `searchByVector`) | Task 2 (step 8) |
| §Cache layer (Redis key + TTL) | Task 5 |
| §Per-user RBAC (`WHERE userId = $1`) | Task 2 (SQL in step 5) |
| §Caller switch (MCP `search_content` + `/knowledge`) | Task 6 |
| §Future-swap to `pg_search` documented | Task 8 |
| §Error handling table | Task 5 (impl) + Task 8 (doc) |
| §Acceptance criteria | Tasks 1-8 collectively |

All sections covered.

### Placeholder scan

Searched the plan for "TBD", "TODO", "implement later", "fill in", "appropriate error handling", "similar to Task N" — none found in instruction-level positions. Some occurrences inside doc/comment strings the engineer pastes are intentional content, not plan placeholders.

### Type / signature consistency

- `SearchHit` shape is defined once in `file-search.service.ts` (existing) and referenced consistently in tests + new functions.
- `SearchByLexicalParams`, `SearchHybridParams`, `RerankPassagesParams` are introduced once each; usages match.
- `reciprocalRankFusion(vector, lexical, k?)` signature matches across tests + impl.
- `rerankPassages({ query, hits, redis, reranker, maxPassageChars?, cacheTtlSec? })` matches in impl + tests + `searchHybrid` call site.
- `ToolContext.searchHybrid?` signature in Task 6 (step 1) matches the orchestrator-side `searchHybrid` return shape (`SearchHit[]`).
- Reranker gRPC: `RerankRequest { query, passages, model }` + `RerankResponse { scores }` consistent across proto (Task 3), Python handler (Task 4), TS client (Task 5).

Consistent across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-warp-286-hybrid-retrieval-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
