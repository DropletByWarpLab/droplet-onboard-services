# WARP-437 — Phase 3 Query Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HyDE rewrite, multi-query expansion, and adaptive routing to the retrieval pipeline as a single composable `queryEnhancement` block on `searchHybrid`, with a zero-shot deberta classifier picking presets in the orchestrator's agent loop. Eval gate: per-class NDCG / RAGAS thresholds from the Phase 3 design doc.

**Architecture:** Three orthogonal capabilities (HyDE, multi-query, adaptive) all flow through one new `QueryEnhancementOption` block added to `SearchHybridParams`. The orchestrator owns LLM calls + classification (single process boundary for those concerns); the mcp-server mirror gets the same `searchHybrid` signature change but does not call the LLM itself (callers hand it pre-computed enhancement data). The deberta zero-shot classifier lives in ai-gateway behind a new `ClassifyQuery` gRPC RPC, lazy-singleton-loaded like `RerankerSingleton`.

**Tech Stack:**
- ai-gateway: Python 3.12, FastAPI, gRPC (`grpcio` 1.60+), `transformers`, `optimum[onnxruntime]`, `torch` CPU
- orchestrator: Node 20, TypeScript, Prisma 5, `@grpc/grpc-js`
- Models: `MoritzLaurer/deberta-v3-base-zeroshot-v2.0` (~110 MB int8, lazy from HF), `mistral-7b` (local Ollama) for HyDE + multi-query
- Eval: existing `tests/retrieval-eval/run.integration.test.ts` + `tests/retrieval-eval/ragas/ragas_runner.py`

**Spec:** [`docs/superpowers/specs/2026-05-25-warp-437-query-enhancement-design.md`](../specs/2026-05-25-warp-437-query-enhancement-design.md) (authoritative — read before starting any task).

**Branch / PR:** Single branch `feat/warp-437-query-enhancement`. **WARP-202 mirror constraint:** Tasks 5 and 6 MUST land in the same commit / PR or CI's mirror-drift check fails.

**Execution batching (from ADR-003 §"Phase 3"):**

| Batch | Tasks | Parallelism |
|---|---|---|
| A | 1, 2, 3 | 3 in parallel (3 different file trees) |
| B | 4 | 1 (depends on A) |
| C | 5+6 | 1 PR, 2 files in lockstep (mirror) |
| D | 7, 8 | 2 in parallel (different files) |
| E | 9 | 1 |
| F | 10 | 1 |

---

## File Structure

### New files (this plan creates)

- `services/ai-gateway/query_classifier.py` — `QueryClassifierSingleton`, deberta zero-shot loader + classify call.
- `services/ai-gateway/tests/test_query_classifier.py` — unit tests for the singleton.
- `apps/orchestrator/src/services/query-enhancement.service.ts` — `hydeRewrite`, `multiQueryExpand`, `classifyQuery` wrappers.
- `apps/orchestrator/src/services/query-enhancement.service.test.ts` — unit tests with mocked ai-gateway client.
- `apps/orchestrator/src/services/query-classifier.client.ts` — typed gRPC wrapper for `ClassifyQuery`.

### Modified files (this plan touches)

- `proto/inference.proto` — add `ClassifyQuery` RPC + `ClassifyQueryRequest` / `ClassifyQueryResponse` messages.
- `services/ai-gateway/grpc_server.py` — handler for `ClassifyQuery`.
- `services/ai-gateway/requirements.txt` — add `transformers` extras / pin (already a transitive dep; explicit pin).
- `services/ai-gateway/Dockerfile` — bake the deberta model cache directory.
- `tests/retrieval-eval/queries.yaml` — extend with 3 labeled subsets: 15 under-specified + 10 analytical + 10 conversational, each row tagged with `class:`.
- `apps/orchestrator/src/services/file-search.service.ts` — add `QueryEnhancementOption` + plumb through `searchHybrid`.
- `services/mcp-server/src/file-search.service.ts` — mirror the same signature change.
- `apps/orchestrator/src/services/file-search.service.test.ts` — new tests for enhancement plumbing.
- `services/mcp-server/src/file-search.service.test.ts` (if it exists; otherwise add) — mirror tests.
- `packages/tools-core/src/handlers/files/search-content.ts` — accept `enhance` input, forward to context shim.
- `packages/tools-core/src/handlers/files/__tests__/search-content.test.ts` — new test for `enhance` plumbing.
- `apps/orchestrator/src/services/llm-agent.service.ts` — preset chooser based on classification.
- `apps/orchestrator/src/__tests__/llm-agent.service.test.ts` (if missing, add) — preset routing tests.
- `docs/RAG_RETRIEVAL.md` — new "Query enhancement" section, preset table, measured deltas.

---

## Task 1: `ClassifyQuery` RPC + deberta classifier singleton (ai-gateway)

**ADR-003 row:** 3.1. **Batch:** A.

**Files:**
- Modify: `proto/inference.proto`
- Create: `services/ai-gateway/query_classifier.py`
- Modify: `services/ai-gateway/grpc_server.py`
- Modify: `services/ai-gateway/requirements.txt`
- Modify: `services/ai-gateway/Dockerfile`
- Create: `services/ai-gateway/tests/test_query_classifier.py`

- [ ] **Step 1.1: Extend the proto with `ClassifyQuery`**

Edit `proto/inference.proto` — add to `service InferenceService` (after the `Rerank` line):

```proto
  // Zero-shot query classifier — used by the orchestrator's adaptive
  // retrieval router (WARP-437). Returns one of {factual, analytical,
  // conversational, navigational, unknown}.
  rpc ClassifyQuery(ClassifyQueryRequest) returns (ClassifyQueryResponse);
```

And append the message types at the bottom:

```proto
// ── Query classification (WARP-437 — orchestrator adaptive routing) ──

message ClassifyQueryRequest {
  string query = 1;
  // Optional model override. Default: "MoritzLaurer/deberta-v3-base-zeroshot-v2.0".
  optional string model = 2;
}

message ClassifyQueryResponse {
  // One of: "factual" | "analytical" | "conversational" | "navigational" | "unknown".
  string class = 1;
  // Top-1 confidence in [0, 1]. Callers may threshold via env.
  float confidence = 2;
}
```

- [ ] **Step 1.2: Regenerate the gRPC stubs**

Run:
```bash
cd services/ai-gateway && python -m grpc_tools.protoc \
  -I ../../proto --python_out=grpc_generated --grpc_python_out=grpc_generated \
  ../../proto/inference.proto
```

Expected: `grpc_generated/inference_pb2.py` and `inference_pb2_grpc.py` updated with `ClassifyQuery*` symbols. Verify with `grep ClassifyQuery grpc_generated/*.py`.

- [ ] **Step 1.3: Write a failing test for the singleton**

Create `services/ai-gateway/tests/test_query_classifier.py`:

```python
"""Unit tests for QueryClassifierSingleton (WARP-437)."""
import pytest
from query_classifier import (
    QueryClassifierSingleton,
    QUERY_CLASSES,
    CLASSIFIER_CONFIDENCE_FLOOR,
)


def test_classifier_returns_known_class():
    c = QueryClassifierSingleton.instance()
    result = c.classify("What is the capital of France?")
    assert result.cls in QUERY_CLASSES
    assert 0.0 <= result.confidence <= 1.0


def test_classifier_returns_unknown_below_floor(monkeypatch):
    """When the top-1 score falls below CLASSIFIER_CONFIDENCE_FLOOR,
    we return 'unknown' rather than guessing."""
    c = QueryClassifierSingleton.instance()
    # Simulate a low-confidence return from the underlying pipeline.
    monkeypatch.setattr(
        c, "_run_pipeline",
        lambda q: {"labels": ["factual"], "scores": [CLASSIFIER_CONFIDENCE_FLOOR - 0.01]},
    )
    result = c.classify("...")
    assert result.cls == "unknown"
```

Run:
```bash
cd services/ai-gateway && pytest tests/test_query_classifier.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'query_classifier'`.

- [ ] **Step 1.4: Implement `query_classifier.py`**

Create `services/ai-gateway/query_classifier.py`:

```python
"""WARP-437 — Deberta zero-shot query classifier singleton.

Mirrors the lazy-init pattern of `reranker.RerankerSingleton`. Model is
~110 MB int8 ONNX, cached to /var/cache/droplet/models/. First call
pays the load cost; subsequent calls are CPU-bound NLI scoring (~50 ms
on x86_64 / Jetson Orin).

Returns one of QUERY_CLASSES, or "unknown" when top-1 confidence is
below CLASSIFIER_CONFIDENCE_FLOOR (we don't route on noise — CLAUDE.md
"no guessing").
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

CLASSIFIER_MODEL_ID = "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"
CLASSIFIER_CACHE_DIR = Path("/var/cache/droplet/models/query-classifier")

QUERY_CLASSES: Tuple[str, ...] = (
    "factual",
    "analytical",
    "conversational",
    "navigational",
)
# Below this top-1 confidence we return 'unknown' and let the caller use defaults.
CLASSIFIER_CONFIDENCE_FLOOR = 0.40


@dataclass(frozen=True)
class ClassifyResult:
    cls: str
    confidence: float


class QueryClassifierSingleton:
    _instance: Optional["QueryClassifierSingleton"] = None

    def __init__(self) -> None:
        from transformers import pipeline

        CLASSIFIER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(CLASSIFIER_CACHE_DIR))
        logger.info("Loading query classifier from %s", CLASSIFIER_MODEL_ID)
        self._pipeline = pipeline(
            "zero-shot-classification",
            model=CLASSIFIER_MODEL_ID,
            device=-1,  # CPU
        )
        logger.info("Query classifier loaded")

    @classmethod
    def instance(cls) -> "QueryClassifierSingleton":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _run_pipeline(self, query: str) -> dict:
        return self._pipeline(
            query,
            candidate_labels=list(QUERY_CLASSES),
            multi_label=False,
        )

    def classify(self, query: str) -> ClassifyResult:
        if not query or len(query.strip()) < 2:
            return ClassifyResult(cls="unknown", confidence=0.0)
        out = self._run_pipeline(query)
        top_label = out["labels"][0]
        top_score = float(out["scores"][0])
        if top_score < CLASSIFIER_CONFIDENCE_FLOOR:
            return ClassifyResult(cls="unknown", confidence=top_score)
        return ClassifyResult(cls=top_label, confidence=top_score)
```

Run the tests again:
```bash
cd services/ai-gateway && pytest tests/test_query_classifier.py -v
```
Expected: PASS (the second test mocks the pipeline; the first test downloads the model the first time it runs — ~1 min on a cold cache, acceptable for unit-test setup).

- [ ] **Step 1.5: Wire `ClassifyQuery` into `grpc_server.py`**

Open `services/ai-gateway/grpc_server.py`. Add a new method to `InferenceServicer` after `Rerank` (around line 240):

```python
    async def ClassifyQuery(self, request, context):
        """Zero-shot query classifier; routes orchestrator's retrieval presets.

        Delegates to `query_classifier.QueryClassifierSingleton`. First call
        lazy-loads the model (~110 MB int8). Subsequent calls are ~50 ms CPU.
        Returns 'unknown' when confidence falls below CLASSIFIER_CONFIDENCE_FLOOR.
        """
        try:
            query = request.query
            if not query:
                return inference_pb2.ClassifyQueryResponse(**{"class": "unknown", "confidence": 0.0})

            from query_classifier import QueryClassifierSingleton

            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, QueryClassifierSingleton.instance().classify, query
            )
            return inference_pb2.ClassifyQueryResponse(**{
                "class": result.cls,
                "confidence": result.confidence,
            })
        except Exception as e:
            logger.error("gRPC ClassifyQuery error: %s", e)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Classify error: {str(e)}")
            return inference_pb2.ClassifyQueryResponse(**{"class": "unknown", "confidence": 0.0})
```

Note: `**{"class": ...}` because `class` is a Python keyword and can't be a kwarg literal.

- [ ] **Step 1.6: Pin transformers in `requirements.txt`**

Open `services/ai-gateway/requirements.txt` and add (if not already present at a compatible pin):

```
transformers>=4.40,<5
```

(`optimum[onnxruntime]` is already a transitive dep via the reranker.)

- [ ] **Step 1.7: Pre-warm the model in the Dockerfile**

Open `services/ai-gateway/Dockerfile`. Find the existing reranker pre-warm `RUN` directive (search for `RerankerSingleton` or `model_quantized.onnx`). Append a sibling pre-warm:

```dockerfile
# WARP-437: pre-download the deberta zero-shot model so first request
# doesn't pay the 110 MB cold-load latency.
RUN python -c "from query_classifier import QueryClassifierSingleton; QueryClassifierSingleton.instance()" \
    || echo "WARP-437 prewarm soft-fail (first call will lazy-load)"
```

The `|| echo` keeps the image build green if HF Hub is unreachable; we trade prewarm for runtime laziness, not a build failure.

- [ ] **Step 1.8: Smoke-test the RPC**

Start the gateway locally:
```bash
cd services/ai-gateway && uvicorn main:app --port 8000 &
```

In another terminal, use `grpcurl` to hit the RPC:
```bash
grpcurl -plaintext -d '{"query": "What is the capital of France?"}' \
  localhost:50051 droplet.inference.InferenceService/ClassifyQuery
```
Expected: `{ "class": "factual", "confidence": <something > 0.4> }`.

If `grpcurl` isn't installed, the Node-side client tests in Task 4 cover this end-to-end.

- [ ] **Step 1.9: Commit**

```bash
git add proto/inference.proto services/ai-gateway/query_classifier.py \
        services/ai-gateway/tests/test_query_classifier.py \
        services/ai-gateway/grpc_server.py services/ai-gateway/requirements.txt \
        services/ai-gateway/Dockerfile services/ai-gateway/grpc_generated/
git commit -m "feat(ai-gateway): ClassifyQuery gRPC + deberta zero-shot singleton (WARP-437)"
```

---

## Task 2: `query-enhancement.service.ts` (orchestrator) — HyDE + multi-query

**ADR-003 row:** 3.2. **Batch:** A. **Independent of Task 1's deliverable** (does not import the gRPC stubs; that's Task 4's job).

**Files:**
- Create: `apps/orchestrator/src/services/query-enhancement.service.ts`
- Create: `apps/orchestrator/src/services/query-enhancement.service.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `apps/orchestrator/src/services/query-enhancement.service.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  hydeRewrite,
  multiQueryExpand,
  MULTI_QUERY_DEFAULT_N,
} from "./query-enhancement.service.js";

describe("hydeRewrite", () => {
  it("returns the passage from ai-gateway chat", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "Paris is the capital of France." });
    const out = await hydeRewrite({ query: "capital of france?", chat });
    expect(out).toBe("Paris is the capital of France.");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("returns the raw query on chat failure", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await hydeRewrite({ query: "x", chat });
    expect(out).toBe("x");
  });
});

describe("multiQueryExpand", () => {
  it("parses a 3-element JSON array from chat output", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '["q1", "q2", "q3"]',
    });
    const out = await multiQueryExpand({ query: "x", chat });
    expect(out).toEqual(["q1", "q2", "q3"]);
  });

  it("falls back to [query] on parse failure", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "not json" });
    const out = await multiQueryExpand({ query: "x", chat });
    expect(out).toEqual(["x"]);
  });

  it("clamps n to the requested count if model over-produces", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '["q1", "q2", "q3", "q4", "q5"]',
    });
    const out = await multiQueryExpand({ query: "x", chat, n: 3 });
    expect(out).toHaveLength(3);
  });

  it("default n equals MULTI_QUERY_DEFAULT_N", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '["a","b","c","d","e"]',
    });
    const out = await multiQueryExpand({ query: "x", chat });
    expect(out).toHaveLength(MULTI_QUERY_DEFAULT_N);
  });
});
```

Run:
```bash
npx vitest run apps/orchestrator/src/services/query-enhancement.service.test.ts
```
Expected: FAIL with `Cannot find module './query-enhancement.service.js'`.

- [ ] **Step 2.2: Implement `query-enhancement.service.ts`**

Create `apps/orchestrator/src/services/query-enhancement.service.ts`:

```typescript
/**
 * WARP-437 — Query enhancement (HyDE + multi-query).
 *
 * Two functions, both routed through an injected `chat` callable so the
 * test surface stays mock-friendly. The real binding (production) plugs
 * `ai-gateway.client.chat` in; tests pass a vi.fn().
 *
 * `searchHybrid` does NOT call these directly — keeping LLM-orchestration
 * out of `searchHybrid` lets the same file run unchanged in both the
 * orchestrator and the mcp-server (WARP-202 mirror).
 */

export const MULTI_QUERY_DEFAULT_N = 3;
const HYDE_MAX_TOKENS = 200;
const MULTI_QUERY_MAX_TOKENS = 300;

const HYDE_PROMPT = (query: string): string =>
  [
    "You are a helpful assistant that writes a short hypothetical passage that",
    "would answer the user's question. Write 1 paragraph, 60-120 words, in the",
    "style of a document body (not a chat reply). Do NOT add disclaimers or",
    "preambles. Do NOT use markdown.",
    "",
    `Question: ${query}`,
    "",
    "Passage:",
  ].join("\n");

const MULTI_QUERY_PROMPT = (query: string, n: number): string =>
  [
    `Rewrite the user's question as ${n} alternative search queries that capture the`,
    "same intent from different angles. Each rewrite must be self-contained (no",
    `references to "the question"). Output as a JSON array of exactly ${n} strings,`,
    "no markdown, no commentary.",
    "",
    `Question: ${query}`,
    "",
    "Rewrites:",
  ].join("\n");

export interface ChatClient {
  (args: {
    prompt: string;
    temperature: number;
    maxTokens: number;
    priority: number;
  }): Promise<{ content: string }>;
}

export interface HydeRewriteParams {
  query: string;
  chat: ChatClient;
}

export async function hydeRewrite({ query, chat }: HydeRewriteParams): Promise<string> {
  try {
    const r = await chat({
      prompt: HYDE_PROMPT(query),
      temperature: 0.2,
      maxTokens: HYDE_MAX_TOKENS,
      priority: 5, // automation, not user-initiated
    });
    const passage = r.content.trim();
    return passage.length > 0 ? passage : query;
  } catch {
    // Never let HyDE failures escape — fall back to the raw query.
    return query;
  }
}

export interface MultiQueryExpandParams {
  query: string;
  chat: ChatClient;
  n?: number;
}

export async function multiQueryExpand({
  query,
  chat,
  n = MULTI_QUERY_DEFAULT_N,
}: MultiQueryExpandParams): Promise<string[]> {
  let raw: { content: string };
  try {
    raw = await chat({
      prompt: MULTI_QUERY_PROMPT(query, n),
      temperature: 0.5,
      maxTokens: MULTI_QUERY_MAX_TOKENS,
      priority: 5,
    });
  } catch {
    return [query];
  }
  const parsed = tryParseJsonArray(raw.content);
  if (!parsed || parsed.length === 0) return [query];
  const cleaned = parsed
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, n);
  return cleaned.length > 0 ? cleaned : [query];
}

function tryParseJsonArray(text: string): string[] | null {
  // Local 7B models often wrap JSON in ```json fences or prose. Strip both.
  const stripped = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr.every((x) => typeof x === "string") ? (arr as string[]) : null;
  } catch {
    return null;
  }
}
```

Run:
```bash
npx vitest run apps/orchestrator/src/services/query-enhancement.service.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 2.3: Commit**

```bash
git add apps/orchestrator/src/services/query-enhancement.service.ts \
        apps/orchestrator/src/services/query-enhancement.service.test.ts
git commit -m "feat(orchestrator): hydeRewrite + multiQueryExpand service (WARP-437)"
```

---

## Task 3: Extend eval corpus with labeled subsets

**ADR-003 row:** 3.3. **Batch:** A. Independent of all other tasks.

**Files:**
- Modify: `tests/retrieval-eval/queries.yaml`

- [ ] **Step 3.1: Read the existing corpus shape**

```bash
head -40 tests/retrieval-eval/queries.yaml
```
Note the field names (`id`, `query`, `expected_*` etc.) so the new rows match.

- [ ] **Step 3.2: Append 15 under-specified queries (`class: factual`, 1–3 words each)**

Append to `tests/retrieval-eval/queries.yaml` — 15 entries with the existing schema plus a new `class` field. Use queries like `status`, `latest invoice`, `meeting notes`, `wifi password`, `camera one`, `nextcloud`, `frigate logs`, `dns config`, `device id`, `mqtt broker`, `home view`, `last upload`, `error code`, `family schedule`, `recent photo`. Each row gets `class: factual` and a curated expected-chunk list against the existing fixture corpus.

The exact ids should be `q-short-001` through `q-short-015`. Anchor `expected_chunks` against fixtures that exist today; pick at least one from each fixture document so coverage is broad.

- [ ] **Step 3.3: Append 10 analytical queries (`class: analytical`)**

10 multi-faceted queries that need synthesis across documents. Ids `q-analytical-001`..`q-analytical-010`. Examples: "compare network usage this week vs last week across cameras", "summarize all device-identity related changes from the last 30 days", "which cameras have failed health checks more than once this month and what was the root cause".

- [ ] **Step 3.4: Append 10 conversational queries (`class: conversational`)**

Ids `q-conv-001`..`q-conv-010`. Examples: "hey what's up", "good morning", "thanks", "can you help me", "what can you do", "tell me a joke", "are you there", "i'm tired", "how's the weather", "ok cool". Each row has `expected_chunks: []` — the gate for conversational is "do not retrieve junk", measured as a *negative* outcome (low retrieval, low rerank cost).

- [ ] **Step 3.5: Add a `class` field default to existing rows**

For every existing row in `queries.yaml` that doesn't already have `class:`, add `class: factual` (the WARP-201..286 corpus is primarily factual). This makes the per-class slicing in step 9 work without special cases.

- [ ] **Step 3.6: Verify the corpus parses**

```bash
node -e "console.log(require('js-yaml').load(require('fs').readFileSync('tests/retrieval-eval/queries.yaml','utf8')).length)"
```
Expected: original count + 35.

- [ ] **Step 3.7: Run the existing eval harness to confirm no regressions**

```bash
npm run test -- tests/retrieval-eval/run.integration.test.ts
```
Expected: the harness either passes or skips cleanly (skip is expected on Mac with no stack). It MUST NOT fail to parse the YAML.

- [ ] **Step 3.8: Commit**

```bash
git add tests/retrieval-eval/queries.yaml
git commit -m "test(retrieval-eval): add 35 labeled queries for adaptive routing (WARP-437)"
```

---

## Task 4: `classifyQuery` gRPC client wrapper + service binding

**ADR-003 row:** 3.4. **Batch:** B. Depends on Tasks 1 and 2.

**Files:**
- Create: `apps/orchestrator/src/services/query-classifier.client.ts`
- Modify: `apps/orchestrator/src/services/query-enhancement.service.ts` (add `classifyQuery` export + cache)
- Modify: `apps/orchestrator/src/services/query-enhancement.service.test.ts` (cover the new export)

- [ ] **Step 4.1: Generate Node gRPC types**

The orchestrator's gRPC client uses `@grpc/grpc-js` with proto-loader. Find the existing reranker client (`apps/orchestrator/src/services/ai-gateway.grpc-client.ts` or similar `grep -rn "Rerank" apps/orchestrator/src`) and copy its loader pattern.

```bash
grep -rn "loadPackageDefinition\|@grpc/proto-loader" apps/orchestrator/src/ | head
```

- [ ] **Step 4.2: Write the failing test for `query-classifier.client.ts`**

Append to `apps/orchestrator/src/services/query-enhancement.service.test.ts`:

```typescript
import { classifyQuery, CLASSIFIER_CACHE_TTL_SEC } from "./query-enhancement.service.js";

describe("classifyQuery", () => {
  it("returns the class + confidence from the gRPC client", async () => {
    const rpc = vi.fn().mockResolvedValue({ class: "factual", confidence: 0.91 });
    const out = await classifyQuery({ query: "what is x", rpc, cache: makeMemoryCache() });
    expect(out).toEqual({ cls: "factual", confidence: 0.91 });
  });

  it("caches by query SHA-256 with TTL", async () => {
    const rpc = vi.fn().mockResolvedValue({ class: "factual", confidence: 0.9 });
    const cache = makeMemoryCache();
    await classifyQuery({ query: "x", rpc, cache });
    await classifyQuery({ query: "x", rpc, cache });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'unknown' on RPC failure", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await classifyQuery({ query: "x", rpc, cache: makeMemoryCache() });
    expect(out.cls).toBe("unknown");
  });
});

function makeMemoryCache() {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    async get(k: string) {
      const e = store.get(k);
      if (!e) return null;
      if (e.exp < Date.now()) {
        store.delete(k);
        return null;
      }
      return e.v;
    },
    async setex(k: string, ttl: number, v: string) {
      store.set(k, { v, exp: Date.now() + ttl * 1000 });
    },
  };
}
```

Run:
```bash
npx vitest run apps/orchestrator/src/services/query-enhancement.service.test.ts
```
Expected: FAIL with `classifyQuery is not exported`.

- [ ] **Step 4.3: Implement `classifyQuery` in `query-enhancement.service.ts`**

Append to `query-enhancement.service.ts`:

```typescript
import { createHash } from "node:crypto";

import type { QueryClass } from "../types/query-enhancement.js";

// Re-export for type-narrowing call sites.
export type { QueryClass } from "../types/query-enhancement.js";

/** Classifier results are deterministic for a given query; 24 h TTL is safe. */
export const CLASSIFIER_CACHE_TTL_SEC = 24 * 60 * 60;

const CLASSIFIER_CACHE_PREFIX = "warp437:cls:";

export interface ClassifyQueryRpc {
  (args: { query: string }): Promise<{ class: string; confidence: number }>;
}

export interface ClassifyQueryCache {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
}

export interface ClassifyQueryParams {
  query: string;
  rpc: ClassifyQueryRpc;
  cache: ClassifyQueryCache;
}

export interface ClassifyResult {
  cls: QueryClass;
  confidence: number;
}

const KNOWN_CLASSES: ReadonlySet<QueryClass> = new Set([
  "factual",
  "analytical",
  "conversational",
  "navigational",
  "unknown",
]);

export async function classifyQuery({
  query,
  rpc,
  cache,
}: ClassifyQueryParams): Promise<ClassifyResult> {
  const key = CLASSIFIER_CACHE_PREFIX + createHash("sha256").update(query).digest("hex");
  const cached = await cache.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ClassifyResult;
      if (KNOWN_CLASSES.has(parsed.cls)) return parsed;
    } catch {
      // fallthrough to fresh RPC
    }
  }
  try {
    const r = await rpc({ query });
    const cls: QueryClass = KNOWN_CLASSES.has(r.class as QueryClass)
      ? (r.class as QueryClass)
      : "unknown";
    const result: ClassifyResult = { cls, confidence: r.confidence };
    await cache.setex(key, CLASSIFIER_CACHE_TTL_SEC, JSON.stringify(result));
    return result;
  } catch {
    return { cls: "unknown", confidence: 0 };
  }
}
```

- [ ] **Step 4.4: Create the `QueryClass` type**

Create `apps/orchestrator/src/types/query-enhancement.ts`:

```typescript
/** Adaptive-routing query class (WARP-437). */
export type QueryClass =
  | "factual"
  | "analytical"
  | "conversational"
  | "navigational"
  | "unknown";
```

- [ ] **Step 4.5: Create the gRPC wrapper**

Create `apps/orchestrator/src/services/query-classifier.client.ts`. Use the existing reranker client (`grep -l "RerankRequest" apps/orchestrator/src`) as the template. The wrapper exposes one function:

```typescript
export async function callClassifyQuery(args: { query: string }): Promise<{
  class: string;
  confidence: number;
}>;
```

Routes to the `ClassifyQuery` RPC on the shared `@grpc/grpc-js` channel (same channel the rerank client uses; do not open a second connection). Bind the proto symbol from `proto/inference.proto` via the existing `loadPackageDefinition` chain.

- [ ] **Step 4.6: Run tests**

```bash
npx vitest run apps/orchestrator/src/services/query-enhancement.service.test.ts
```
Expected: all PASS (original 4 + 3 new).

- [ ] **Step 4.7: Commit**

```bash
git add apps/orchestrator/src/services/query-enhancement.service.ts \
        apps/orchestrator/src/services/query-enhancement.service.test.ts \
        apps/orchestrator/src/services/query-classifier.client.ts \
        apps/orchestrator/src/types/query-enhancement.ts
git commit -m "feat(orchestrator): classifyQuery wrapper + Redis-cached gRPC client (WARP-437)"
```

---

## Task 5+6: `queryEnhancement` plumbing in `searchHybrid` (orchestrator AND mcp-server — same PR)

**ADR-003 rows:** 3.5 + 3.6. **Batch:** C. **MIRROR CONSTRAINT:** these two tasks MUST land in the same commit or the WARP-202 mirror-drift check fails CI.

**Files:**
- Modify: `apps/orchestrator/src/services/file-search.service.ts`
- Modify: `apps/orchestrator/src/services/file-search.service.test.ts`
- Modify: `services/mcp-server/src/file-search.service.ts`
- Modify: `services/mcp-server/src/file-search.service.test.ts` (create if missing)

- [ ] **Step 5.1: Write the failing test (orchestrator)**

Add to `apps/orchestrator/src/services/file-search.service.test.ts`:

```typescript
describe("searchHybrid with queryEnhancement", () => {
  it("averages HyDE passage embedding with raw query vector", async () => {
    // Mock the prisma vector arm to verify the vector handed in is the
    // element-wise mean of [raw, hyde].
    const rawVec = [1, 0, 0, 0, 0];
    const hydeVec = [0, 1, 0, 0, 0];
    const expectedMean = [0.5, 0.5, 0, 0, 0];

    let observedVector: number[] | null = null;
    const prisma = makeMockPrisma({
      onVectorArm: (vec) => {
        observedVector = vec;
        return [];
      },
    });

    await searchHybrid(prisma, {
      userId: "u1",
      vector: rawVec,
      query: "x",
      queryEnhancement: {
        hydeVector: hydeVec,
      },
    });
    expect(observedVector).toEqual(expectedMean);
  });

  it("RRF-fuses across extra-query vectors before the existing vector+lexical RRF", async () => {
    // Two extraQueries → 3 total vector arms (raw + 2 extras) + 1 lexical arm.
    // Mock prisma vector arm to return distinct hit-lists per call.
    const armReturns = [
      [hit("doc-a", 0)],
      [hit("doc-b", 1)],
      [hit("doc-c", 2)],
    ];
    let armIdx = 0;
    const prisma = makeMockPrisma({
      onVectorArm: () => armReturns[armIdx++] ?? [],
    });

    const out = await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      query: "x",
      queryEnhancement: {
        extraQueryVectors: [[0, 1, 0], [0, 0, 1]],
      },
    });
    // All 3 hits should appear (and be merged via RRF — no specific order assertion here,
    // just that we got all 3 back from a fused list).
    const paths = out.map((h) => h.path);
    expect(paths).toEqual(expect.arrayContaining(["doc-a", "doc-b", "doc-c"]));
  });

  it("applies filenameContains metadata filter to lexical arm", async () => {
    // Mock prisma raw to capture the SQL fragment; assert the LIKE binding.
    // (Implementation detail: filenameContains adds an AND filter to the
    // searchByLexical SQL.)
    let observed: { sql: string; bindings: unknown[] } | null = null;
    const prisma = makeMockPrisma({
      onLexical: (sql, bindings) => {
        observed = { sql, bindings };
        return [];
      },
    });
    await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      query: "settings",
      queryEnhancement: {
        metadataFilter: { filenameContains: "camera-1" },
      },
    });
    expect(observed?.sql).toMatch(/path LIKE \$\d+/i);
    expect(observed?.bindings).toEqual(expect.arrayContaining(["%camera-1%"]));
  });
});
```

(Test helpers `makeMockPrisma`, `hit` follow the patterns already in `file-search.service.test.ts`. If they don't exist there yet, the existing test file has small inline helpers — extend in the same style.)

Run:
```bash
npx vitest run apps/orchestrator/src/services/file-search.service.test.ts
```
Expected: FAIL — `queryEnhancement` field does not exist on `SearchHybridParams`.

- [ ] **Step 5.2: Extend `SearchHybridParams` in the orchestrator**

In `apps/orchestrator/src/services/file-search.service.ts`, add the new option type before `SearchHybridParams`:

```typescript
export interface QueryEnhancementOption {
  /**
   * HyDE-generated passage embedding. When provided, `searchHybrid`
   * averages this vector with `params.vector` element-wise before the
   * vector arm. Caller is responsible for embedding the HyDE passage
   * via the same embedder used for the raw query so dimensions match.
   */
  hydeVector?: number[];
  /**
   * Multi-query expansion: additional query embeddings to fan out
   * vector arms across. The lexical arm still runs once on the raw
   * `query` string. Results from all vector arms RRF-fuse together
   * before fusing with the lexical arm.
   */
  extraQueryVectors?: number[][];
  /**
   * Class-derived metadata filter applied to BOTH arms. Today only
   * `filenameContains` is supported; future fields go here without
   * widening the public surface of `searchHybrid`.
   */
  metadataFilter?: {
    filenameContains?: string;
  };
}
```

Add the field to `SearchHybridParams`:

```typescript
  /**
   * Optional enhancement bundle (WARP-437). When omitted, behaviour is
   * byte-for-byte identical to the WARP-286 pipeline.
   */
  queryEnhancement?: QueryEnhancementOption;
```

- [ ] **Step 5.3: Implement the HyDE-averaging branch**

Inside `searchHybrid`, before the `Promise.all([searchByVector(...), searchByLexical(...)])` block:

```typescript
  const enhancement = params.queryEnhancement;
  const effectiveVector =
    enhancement?.hydeVector && enhancement.hydeVector.length === params.vector.length
      ? params.vector.map((v, i) => (v + (enhancement.hydeVector as number[])[i]) / 2)
      : params.vector;
```

Then pass `effectiveVector` to `searchByVector` instead of `params.vector`. Add a `// WARP-437: HyDE averaging` comment.

- [ ] **Step 5.4: Implement the multi-query fan-out**

Replace the single-vector arm with a fan-out:

```typescript
  const vectorQueries: number[][] = [effectiveVector, ...(enhancement?.extraQueryVectors ?? [])];
  const [vectorHitLists, lexicalHits] = await Promise.all([
    Promise.all(
      vectorQueries.map((vec) =>
        searchByVector(prisma, {
          userId: params.userId,
          vector: vec,
          limit: perArmK,
          minSimilarity: params.minSimilarity ?? SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY,
          source: params.source,
          since: params.since,
          filenameContains: enhancement?.metadataFilter?.filenameContains,
        }),
      ),
    ),
    searchByLexical(prisma, {
      userId: params.userId,
      query: params.query,
      limit: perArmK,
      source: params.source,
      since: params.since,
      filenameContains: enhancement?.metadataFilter?.filenameContains,
    }),
  ]);
  // Fuse the vector arms across extra queries first, then fuse with lexical.
  const vectorFused = vectorHitLists.reduce(
    (acc, list) => reciprocalRankFusion(acc, list),
    [] as SearchHit[],
  );
  const fused = reciprocalRankFusion(vectorFused, lexicalHits);
```

- [ ] **Step 5.5: Plumb `filenameContains` through `searchByVector` + `searchByLexical`**

Add `filenameContains?: string` to both function param interfaces. In their SQL builders, append:

```typescript
  if (params.filenameContains) {
    // Parameterised; never interpolate raw user strings.
    bindings.push(`%${params.filenameContains}%`);
    whereClauses.push(`path LIKE $${bindings.length}`);
  }
```

(The exact knitting depends on the existing SQL builder — preserve the parameterisation pattern of the existing `userId` clause.)

- [ ] **Step 5.6: Run orchestrator tests**

```bash
npx vitest run apps/orchestrator/src/services/file-search.service.test.ts
```
Expected: all PASS.

- [ ] **Step 5.7: Mirror the same changes to mcp-server's `file-search.service.ts`**

Open `services/mcp-server/src/file-search.service.ts`. Apply the identical surface changes:
- Add `QueryEnhancementOption` type (same shape).
- Add `queryEnhancement?: QueryEnhancementOption` to `SearchHybridParams`.
- Add the HyDE-averaging branch.
- Add the multi-query fan-out.
- Add `filenameContains` to the two retriever params.

Per WARP-202 mirror policy, the *implementations* may differ slightly (different imports, different SQL builder helpers) but the *public surface* (exported type names, field names, ordering) must match line-for-line — that's what the CI mirror diff checks.

- [ ] **Step 5.8: Add the mcp-server test (or extend if present)**

If `services/mcp-server/src/file-search.service.test.ts` doesn't exist, create it with one smoke test covering the HyDE-averaging path. If it does exist, add the same three tests as in 5.1.

```bash
ls services/mcp-server/src/file-search.service.test.ts 2>/dev/null
```

- [ ] **Step 5.9: Run mcp-server tests**

```bash
cd services/mcp-server && npm test
```
Expected: all PASS.

- [ ] **Step 5.10: Verify mirror diff passes**

```bash
git diff apps/orchestrator/src/services/file-search.service.ts \
        services/mcp-server/src/file-search.service.ts
```
Visually confirm `SearchHybridParams` and `QueryEnhancementOption` are identical between the two files.

If a `npm run check:mirror` (or similar) script exists, run it:
```bash
grep -rn "mirror\|file-search.*drift" .github/ scripts/ package.json | head
```

- [ ] **Step 5.11: Commit (single commit per mirror rule)**

```bash
git add apps/orchestrator/src/services/file-search.service.ts \
        apps/orchestrator/src/services/file-search.service.test.ts \
        services/mcp-server/src/file-search.service.ts \
        services/mcp-server/src/file-search.service.test.ts
git commit -m "feat(retrieval): queryEnhancement plumbing in searchHybrid (orchestrator + mcp-server mirror) (WARP-437)"
```

---

## Task 7: `search_content` tool — accept `enhance` input

**ADR-003 row:** 3.7. **Batch:** D. Depends on Task 5+6.

**Files:**
- Modify: `packages/tools-core/src/handlers/files/search-content.ts`
- Modify: `packages/tools-core/src/handlers/files/__tests__/search-content.test.ts` (create if missing)
- Modify: `packages/tools-core/src/types.ts` (extend `ToolContext.searchHybrid` signature)

- [ ] **Step 7.1: Extend the input schema**

In `search-content.ts`, replace the `inputSchema` object with:

```typescript
const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language search query (>= 2 characters).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Max results to return (default 10).",
    },
    enhance: {
      type: "object",
      description: "WARP-437: optional query enhancement knobs. Omit for baseline behaviour.",
      properties: {
        hyde: { type: "boolean", description: "Run HyDE rewrite + average embedding." },
        multiQuery: { type: "boolean", description: "Run multi-query expansion (n paraphrases)." },
        n: { type: "integer", minimum: 2, maximum: 5, description: "Paraphrase count (default 3)." },
      },
      additionalProperties: false,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;
```

- [ ] **Step 7.2: Forward `enhance` to `ctx.searchHybrid`**

In the handler body, after the existing `limit` line:

```typescript
  const enhance = (args.enhance ?? undefined) as
    | { hyde?: boolean; multiQuery?: boolean; n?: number }
    | undefined;
  // ... and lower in the call:
  hits = await ctx.searchHybrid({ query, limit, enhance });
```

- [ ] **Step 7.3: Extend `ToolContext.searchHybrid` typings**

Find `ToolContext` (likely `packages/tools-core/src/types.ts`). The `searchHybrid` field's argument type currently looks like `{ query, limit }`; widen to:

```typescript
searchHybrid?: (args: {
  query: string;
  limit?: number;
  enhance?: { hyde?: boolean; multiQuery?: boolean; n?: number };
}) => Promise<SearchHit[]>;
```

- [ ] **Step 7.4: Write the handler test**

Add to `packages/tools-core/src/handlers/files/__tests__/search-content.test.ts` (create file if missing — pattern after a sibling handler's test):

```typescript
import { describe, expect, it, vi } from "vitest";
import { searchContentTool } from "../search-content.js";

describe("search_content with enhance", () => {
  it("forwards enhance to ctx.searchHybrid", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    const ctx: any = { userId: "u1", searchHybrid };
    await searchContentTool.handler(
      { query: "test query", enhance: { hyde: true, multiQuery: true, n: 3 } },
      ctx,
    );
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "test query",
      limit: 10,
      enhance: { hyde: true, multiQuery: true, n: 3 },
    });
  });

  it("omits enhance when not provided", async () => {
    const searchHybrid = vi.fn().mockResolvedValue([]);
    const ctx: any = { userId: "u1", searchHybrid };
    await searchContentTool.handler({ query: "test query" }, ctx);
    expect(searchHybrid).toHaveBeenCalledWith({
      query: "test query",
      limit: 10,
      enhance: undefined,
    });
  });
});
```

- [ ] **Step 7.5: Run tests**

```bash
npx vitest run packages/tools-core
```
Expected: all PASS.

- [ ] **Step 7.6: Commit**

```bash
git add packages/tools-core/src/handlers/files/search-content.ts \
        packages/tools-core/src/handlers/files/__tests__/search-content.test.ts \
        packages/tools-core/src/types.ts
git commit -m "feat(tools-core): search_content accepts enhance input (WARP-437)"
```

---

## Task 8: Adaptive routing in `llm-agent.service.ts`

**ADR-003 row:** 3.8. **Batch:** D. Depends on Tasks 4 + 7.

**Files:**
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts`
- Create (or extend): `apps/orchestrator/src/__tests__/llm-agent.service.test.ts`

- [ ] **Step 8.1: Locate the `search_content` tool dispatch in the agent loop**

```bash
grep -n "search_content\|callTool\|toolName" apps/orchestrator/src/services/llm-agent.service.ts | head
```

This identifies where the orchestrator dispatches MCP tool calls. The adaptive layer hooks in just before that dispatch when the tool name is `search_content`.

- [ ] **Step 8.2: Write the failing test**

Create or extend `apps/orchestrator/src/__tests__/llm-agent.service.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { presetForClass } from "../services/llm-agent.service.js";

describe("presetForClass (WARP-437)", () => {
  it("factual → rerank.candidates=100, no enhance", () => {
    const p = presetForClass("factual");
    expect(p.enhance).toBeUndefined();
    expect(p.searchOverrides?.rerankCandidates).toBe(100);
  });

  it("analytical → multiQuery=true", () => {
    const p = presetForClass("analytical");
    expect(p.enhance?.multiQuery).toBe(true);
  });

  it("conversational → tighter floor, no enhance", () => {
    const p = presetForClass("conversational");
    expect(p.searchOverrides?.minSimilarity).toBe(0.5);
    expect(p.searchOverrides?.perArmK).toBe(50);
    expect(p.enhance).toBeUndefined();
  });

  it("navigational → filenameContains hint", () => {
    const p = presetForClass("navigational", "open camera-1 settings");
    expect(p.filenameContains).toBe("camera-1");
  });

  it("unknown → no overrides", () => {
    const p = presetForClass("unknown");
    expect(p).toEqual({});
  });
});
```

- [ ] **Step 8.3: Implement `presetForClass`**

Add to `apps/orchestrator/src/services/llm-agent.service.ts`:

```typescript
import type { QueryClass } from "../types/query-enhancement.js";

export interface AdaptivePreset {
  enhance?: { hyde?: boolean; multiQuery?: boolean; n?: number };
  searchOverrides?: {
    minSimilarity?: number;
    perArmK?: number;
    rerankCandidates?: number;
  };
  filenameContains?: string;
}

/** Heuristic filename token extraction for navigational queries. */
function extractFilenameToken(query: string): string | undefined {
  // Look for token-shaped sequences (alphanum-with-dashes) of length >= 3.
  const m = query.match(/\b[a-zA-Z0-9][a-zA-Z0-9_\-]{2,}\b/);
  return m?.[0]?.toLowerCase();
}

export function presetForClass(cls: QueryClass, query?: string): AdaptivePreset {
  switch (cls) {
    case "factual":
      return { searchOverrides: { rerankCandidates: 100 } };
    case "analytical":
      return {
        enhance: { multiQuery: true, n: 3 },
        searchOverrides: { rerankCandidates: 80 },
      };
    case "conversational":
      return { searchOverrides: { minSimilarity: 0.5, perArmK: 50 } };
    case "navigational": {
      const token = query ? extractFilenameToken(query) : undefined;
      return token ? { filenameContains: token } : {};
    }
    case "unknown":
    default:
      return {};
  }
}
```

- [ ] **Step 8.4: DESIGN DECISION — pick the enhancement-execution boundary**

This step requires a real design choice that the ADR left implicit. Read this sub-step before writing code.

**Today's flow:** LLM emits `tool_use: search_content(query)` → orchestrator's agent loop dispatches via `mcpClient` (stdio child) → mcp-server's `ctx.searchHybrid` shim (`services/mcp-server/src/index.ts:227-233`) calls `searchHybrid(prisma, ...)`. The orchestrator's *own* copy of `searchHybrid` is only used by `apps/orchestrator/src/routes/admin-retrieval-eval.ts` and `routes/files-knowledge.ts`, NOT by the LLM agent loop.

HyDE + multi-query require an LLM call. The orchestrator has the LLM client; mcp-server does NOT. So the LLM calls + embeddings MUST happen on the orchestrator side. Two options for plumbing the results to `searchHybrid`:

**Option A (recommended): private metadata on the MCP tool call.** Extend the MCP `search_content` call's args with a non-LLM-visible field (e.g. `_enhancement: { hydeVector, extraQueryVectors, metadataFilter, searchOverrides }`). The orchestrator's agent loop computes these locally (classify → preset → HyDE call → embed → multi-query call → embed-batch) and attaches them. mcp-server's `ctx.searchHybrid` shim picks them up and threads them through to `searchHybrid`. The LLM never sees `_enhancement` because it's stripped from the tool's `inputSchema` (private convention: leading underscore = orchestrator-injected). **Preserves WARP-286's "MCP is the canonical retrieval path" abstraction.**

**Option B: short-circuit the MCP call for `search_content` when enhancement is active.** Orchestrator detects the enhancement preset, calls its own `searchHybrid` copy directly (same code as the mirror), skips the MCP round-trip. Faster (no stdio hop), but breaks the canonical-path abstraction and creates a second retrieval entry-point that has to track the mirror.

Pick A. Wire it as follows:

In `apps/orchestrator/src/services/llm-agent.service.ts`, just before the orchestrator dispatches a `search_content` tool call:

```typescript
if (toolName === "search_content") {
  const query = args.query as string;
  const { cls } = await classifyQuery({
    query,
    rpc: callClassifyQuery,
    cache: redisCache,
  });
  const preset = presetForClass(cls, query);

  // LLM-supplied enhance wins over the preset (LLM judgment beats classifier).
  const effective = {
    hyde: args.enhance?.hyde ?? preset.enhance?.hyde ?? false,
    multiQuery: args.enhance?.multiQuery ?? preset.enhance?.multiQuery ?? false,
    n: args.enhance?.n ?? preset.enhance?.n ?? 3,
  };

  let hydeVector: number[] | undefined;
  let extraQueryVectors: number[][] | undefined;

  if (effective.hyde) {
    const passage = await hydeRewrite({ query, chat: aiGatewayChat });
    [hydeVector] = await embedTexts([passage]); // ai-gateway EmbedText, 1 vector
  }
  if (effective.multiQuery) {
    const rewrites = await multiQueryExpand({ query, chat: aiGatewayChat, n: effective.n });
    if (rewrites.length > 0) {
      // Batched single EmbedText call — already supports 256 per batch.
      extraQueryVectors = await embedTexts(rewrites);
    }
  }

  args._enhancement = {
    hydeVector,
    extraQueryVectors,
    metadataFilter: preset.filenameContains
      ? { filenameContains: preset.filenameContains }
      : undefined,
    searchOverrides: preset.searchOverrides,
  };
  // args.enhance stripped — was the LLM-visible knob; downstream only reads _enhancement.
  delete args.enhance;
}
```

- [ ] **Step 8.5: Extend the mcp-server shim to consume `_enhancement`**

In `services/mcp-server/src/index.ts:227-233`, update the `searchHybrid` shim:

```typescript
searchHybrid: async ({ userId, query, limit, _enhancement }) => {
  // ... existing setup ...
  return searchHybrid(prisma, {
    userId,
    query,
    vector,
    limit,
    minSimilarity: _enhancement?.searchOverrides?.minSimilarity,
    perArmK: _enhancement?.searchOverrides?.perArmK,
    queryEnhancement: _enhancement
      ? {
          hydeVector: _enhancement.hydeVector,
          extraQueryVectors: _enhancement.extraQueryVectors,
          metadataFilter: _enhancement.metadataFilter,
        }
      : undefined,
    rerank: rerankPipe ? {
      ...rerankPipe,
      candidates: _enhancement?.searchOverrides?.rerankCandidates,
    } : undefined,
  });
},
```

Update `services/mcp-server/src/context.ts` line 50's `searchHybrid` type to accept `_enhancement?: PrivateEnhancement` where `PrivateEnhancement` is exported from a shared types module.

- [ ] **Step 8.6: Strip `_enhancement` from the JSON-schema published to the LLM**

In `packages/tools-core/src/handlers/files/search-content.ts`, the `inputSchema` already lists allowed properties (`query`, `limit`, `enhance`) and has `additionalProperties: false`. `_enhancement` is NEVER part of the schema — it's only ever set by the orchestrator AFTER the LLM emits the tool call, so it never round-trips through the LLM-visible schema. Verify the validator (if any) on the MCP boundary doesn't reject unknown args; if it does, switch to passing `_enhancement` via the MCP call's `meta` field instead.

```bash
grep -n "additionalProperties\|validate" packages/tools-core/src/handlers/files/search-content.ts services/mcp-server/src/transports/ 2>/dev/null | head
```

- [ ] **Step 8.7: Run tests**

```bash
npx vitest run apps/orchestrator/src/__tests__/llm-agent.service.test.ts
npx vitest run services/mcp-server
```
Expected: all PASS.

- [ ] **Step 8.8: Commit**

```bash
git add apps/orchestrator/src/services/llm-agent.service.ts \
        apps/orchestrator/src/__tests__/llm-agent.service.test.ts
git commit -m "feat(orchestrator): adaptive routing — classify, enhance, route through MCP _enhancement (WARP-437)"
```

---

## Task 9: Eval gate run

**ADR-003 row:** 3.9. **Batch:** E. Depends on Tasks 5+6, 7, 8 + Phase 2 baselines on Linux CI.

**Files:**
- Modify: `tests/retrieval-eval/run.integration.test.ts` (add per-class slicing + gate)
- Modify (potentially): `tests/retrieval-eval/ragas/ragas_runner.py` (per-class slice)

- [ ] **Step 9.1: Add per-class slicing to the eval harness**

In `tests/retrieval-eval/run.integration.test.ts`, after the corpus is loaded, group rows by `class`. For each class subset, run two passes: baseline (no `enhance`), and enhanced (preset per class). Record NDCG@10 per subset.

- [ ] **Step 9.2: Assert the gates**

```typescript
expect(ndcg.short.hyde).toBeGreaterThanOrEqual(ndcg.short.baseline * 1.05);
expect(ndcg.full.allEnhanced).toBeGreaterThanOrEqual(ndcg.full.baseline * 1.03 - REGRESSION_TOLERANCE);
// RAGAS context-recall only when baselines.json has been populated:
if (ragasBaselinesAreReal()) {
  expect(ctxRecall.analytical.multiQuery).toBeGreaterThanOrEqual(
    ctxRecall.analytical.baseline * 1.10,
  );
}
// Conversational: if regress, default-off the preset and re-run.
```

- [ ] **Step 9.3: Run the harness**

```bash
RECORDING_MODE=1 npm run test -- tests/retrieval-eval/run.integration.test.ts
```
Expected on Mac: skipped (no Compose stack); on Linux CI: pass.

- [ ] **Step 9.4: Capture measured deltas**

Pipe the harness output into `docs/superpowers/harness-runs/2026-MM-DD-warp-437-eval.md` for the docs step (Task 10).

- [ ] **Step 9.5: Commit**

```bash
git add tests/retrieval-eval/run.integration.test.ts \
        tests/retrieval-eval/ragas/ragas_runner.py \
        docs/superpowers/harness-runs/
git commit -m "test(retrieval-eval): per-class adaptive gates + RAGAS context-recall (WARP-437)"
```

---

## Task 10: Documentation

**ADR-003 row:** 3.10. **Batch:** F. Depends on Task 9.

**Files:**
- Modify: `docs/RAG_RETRIEVAL.md`

- [ ] **Step 10.1: Add a "Query enhancement" section to `docs/RAG_RETRIEVAL.md`**

Three subsections: HyDE, Multi-query, Adaptive routing. Include the preset table from the design doc, the prompt templates (verbatim), the latency-budget paragraph, and the measured eval deltas from Task 9's harness run. Cross-link to ADR-003 §"Phase 3" and the design doc.

- [ ] **Step 10.2: Update ADR-003's "Tickets" table**

Bump WARP-437 status to `In Progress — batches A–E landed; F pending eval gate` if any batch is deferred, or `Done` if all gates pass and the merge lands.

- [ ] **Step 10.3: Commit**

```bash
git add docs/RAG_RETRIEVAL.md docs/ADR-003-rag-techniques-adoption.md
git commit -m "docs(rag): document Phase 3 query enhancement + adaptive presets (WARP-437)"
```

---

## Cross-task sanity checklist (before opening the PR)

- [ ] `apps/orchestrator/src/services/file-search.service.ts` and `services/mcp-server/src/file-search.service.ts` have identical `QueryEnhancementOption` exports (line-diff acceptable; semantic diff must be zero).
- [ ] `tests/retrieval-eval/queries.yaml` parses; per-class counts are 15 short + 10 analytical + 10 conversational + original count.
- [ ] All four classes have at least one passing test in `presetForClass`.
- [ ] `RECORDING_MODE=1` runs of the eval harness pass on macOS (skip is acceptable; failure to load YAML / parse types is not).
- [ ] `npm run typecheck` clean across orchestrator + mcp-server + tools-core.
- [ ] No new `MATTER_*` env vars (CLAUDE.md rule).
- [ ] No `while True` loops (CLAUDE.md rule).
- [ ] `gh pr create` with the body referencing ADR-003 Phase 3 and WARP-437.
