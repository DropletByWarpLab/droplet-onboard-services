/**
 * WARP-2196 — the cosine-similarity floors are model-specific calibration,
 * and they were recalibrated for bge-small-en-v1.5.
 *
 * WHY THESE NUMBERS ARE NOT ARBITRARY
 * -----------------------------------
 * `minSimilarity` is applied CLIENT-SIDE in `searchByVector`, after the SQL
 * has already returned its top-K by distance:
 *
 *     .filter((r) => Number.isFinite(r.score) && r.score >= params.minSimilarity)
 *
 * where `score` is `1 - (embedding <=> $vec)` — cosine similarity. A cosine
 * similarity only means something relative to the distribution the model
 * produces, and bge's distribution is shifted far higher than MiniLM's. From
 * BGE v1.5's own release notes, v1.5 exists to alleviate "the issue of the
 * similarity distribution".
 *
 * MEASURED, on the committed eval fixtures (`tests/retrieval-eval/queries.yaml`
 * cross `ragas/goldens.yaml`, 65 queries x 47 passages, passages wrapped in the
 * production WARP-435 contextual header; matched/unmatched labelled by whether
 * the query's `relevant` doc set intersects the passage's):
 *
 *                     matched   unmatched  conversational
 *   MiniLM  median     +0.374     +0.140      +0.047
 *           p95        +0.655     +0.376      +0.149
 *           min        -0.078     -0.107      -0.096
 *   bge     median     +0.682     +0.564      +0.475
 *           p95        +0.810     +0.687      +0.557
 *           min        +0.401     +0.392      +0.344
 *
 * The bottom-left number is the finding: under bge the MINIMUM score over
 * every pair measured — matched, unmatched and chit-chat alike — is +0.344.
 * A 0.30 floor is therefore not "a bit loose" under bge, it is an EXACT no-op:
 * it rejects nothing that the SQL returned, ever.
 *
 * The replacements preserve MiniLM's operating point, defined as the fraction
 * of the irrelevant-pair population that survives the floor:
 *
 *   0.30 admitted 10.50% of unmatched  ->  bge 0.65 admits 10.7%
 *        (match-recall 96.4% -> 98.2%)
 *   0.50 admitted  1.39% of unmatched  ->  bge 0.75 admits  1.3%
 *        (match-recall 83.6% -> 76.4%)
 *   0.25 admitted 16.33% of unmatched  ->  bge 0.63 admits 15.6%
 *        (match-recall 100% -> 98.2%)
 *
 * Reproduce by embedding those fixtures with `BAAI/bge-small-en-v1.5` and
 * `sentence-transformers/all-MiniLM-L6-v2` and comparing the two score
 * distributions; see docs/RAG_RE_EMBED_RUNBOOK.md §8.
 */
import { describe, it, expect } from "vitest";
import { SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY } from "./file-search.service.js";
import { presetForClass } from "./llm-agent.service.js";

/**
 * Highest score any conversational query scored against any corpus passage
 * under bge, measured on the eval fixtures. The `conversational` preset's
 * whole job is to sit above this so chit-chat retrieves nothing.
 */
const BGE_CONVERSATIONAL_CEILING = 0.59;

/**
 * Lowest score observed under bge across every measured pair. A floor at or
 * below this cannot reject anything — it is an exact no-op.
 */
const BGE_OBSERVED_FLOOR = 0.344;

describe("WARP-2196 similarity floors are calibrated for bge-small-en-v1.5", () => {
  it("the hybrid default floor is the bge-equivalent of MiniLM's 0.3", () => {
    expect(SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY).toBe(0.65);
  });

  it("the conversational preset floor is the bge-equivalent of MiniLM's 0.5", () => {
    const preset = presetForClass("conversational");
    expect(preset.searchOverrides?.minSimilarity).toBe(0.75);
    // perArmK is unrelated to the embedder swap and must not drift with it.
    expect(preset.searchOverrides?.perArmK).toBe(50);
  });

  it("no floor is left in the range where bge makes it a no-op", () => {
    // The regression this catches: carrying a MiniLM-era constant across the
    // model swap. Any floor at or below bge's observed minimum filters
    // nothing at all, which is worse than having no filter — it reads like a
    // safety net in the code while being inert at runtime.
    expect(SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY).toBeGreaterThan(
      BGE_OBSERVED_FLOOR,
    );
    expect(
      presetForClass("conversational").searchOverrides?.minSimilarity,
    ).toBeGreaterThan(BGE_OBSERVED_FLOOR);
  });

  it("the conversational floor actually rejects conversational queries", () => {
    // Under MiniLM the 0.5 floor cleared the chit-chat ceiling (0.200) by
    // 2.5x. Under bge that ceiling is 0.590 — so 0.5 would have admitted
    // 8 of the 10 conversational fixture queries.
    const floor = presetForClass("conversational").searchOverrides
      ?.minSimilarity as number;
    expect(floor).toBeGreaterThan(BGE_CONVERSATIONAL_CEILING);
  });

  it("the conversational floor stays stricter than the default", () => {
    // The preset's premise (WARP-437): conversational turns should retrieve
    // less, not more. An inversion here would silently reverse the routing.
    expect(
      presetForClass("conversational").searchOverrides?.minSimilarity,
    ).toBeGreaterThan(SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY);
  });

  it("presets that are not about similarity are untouched by the swap", () => {
    expect(presetForClass("factual").searchOverrides?.minSimilarity).toBeUndefined();
    expect(
      presetForClass("analytical").searchOverrides?.minSimilarity,
    ).toBeUndefined();
    expect(presetForClass("unknown")).toEqual({});
  });
});
