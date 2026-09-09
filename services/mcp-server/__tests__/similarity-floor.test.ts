/**
 * WARP-2196 — this service's cosine floor must stay in lockstep with the
 * orchestrator's.
 *
 * `services/mcp-server/src/file-search.service.ts` is a deliberate mirror of
 * `apps/orchestrator/src/services/file-search.service.ts`, and this constant is
 * the LLM tool path's copy of `SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY`. QA found
 * that reverting it to the pre-WARP-2196 `0.3` produced zero test failures
 * anywhere in the repo: the file's own comment says the two "have to move in
 * lockstep" and nothing enforced it.
 *
 * That matters more here than almost anywhere else. `search_content` is the
 * agent's retrieval path, and under bge-small-en-v1.5 the LOWEST score across
 * every measured pair — matched, unmatched and chit-chat alike — is +0.344.
 * A 0.3 floor is therefore not "a bit loose", it is an exact no-op: it reads
 * like a relevance guard in the source while rejecting nothing at runtime.
 *
 * Derivation and the full score distributions live in
 * `apps/orchestrator/src/services/similarity-floors.test.ts` and
 * `docs/RAG_RE_EMBED_RUNBOOK.md` section 8.
 */
import { describe, it, expect } from "vitest";
import { SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY } from "../src/file-search.service.js";

/** Lowest score observed under bge across every measured pair. */
const BGE_OBSERVED_FLOOR = 0.344;

describe("WARP-2196 — mcp-server similarity floor", () => {
  it("matches the orchestrator's recalibrated default", () => {
    expect(SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY).toBe(0.65);
  });

  it("is not in the range where bge makes it inert", () => {
    expect(SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY).toBeGreaterThan(
      BGE_OBSERVED_FLOOR,
    );
  });
});
