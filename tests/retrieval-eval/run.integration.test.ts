/**
 * WARP-286 retrieval eval — compares three pipelines:
 *   1. vector-only            (existing searchByVector — baseline)
 *   2. RRF                    (searchHybrid without reranker)
 *   3. full hybrid + reranker (searchHybrid with reranker)
 *
 * Computes NDCG@10 for each pipeline against tests/retrieval-eval/queries.yaml.
 * Asserts: ndcg(hybrid) >= NDCG_IMPROVEMENT_THRESHOLD * ndcg(vector-only).
 *
 * Gated by RUN_RAG_INTEGRATION=1. Reuses tests/helpers/rag-retrieval.ts for
 * compose-up + fixture seeding (the same harness WARP-224 ships).
 *
 * Run command: `npm run -w tests test:retrieval-eval` (or
 *              `RUN_RAG_INTEGRATION=1 ./scripts/test-rag.sh`).
 *
 * Per CLAUDE.md no-guessing rule, the acceptance threshold is a named
 * constant — not a sprinkle of `* 1.1` literals across the file.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  REPO_ROOT,
  SHOULD_RUN,
  API_URL,
  sh,
  dbQuery,
  uploadBrainFile,
  uploadNextcloudFile,
  pollUntilBrainIndexed,
  pollNcChunkCount,
  COMPOSE,
} from "../helpers/rag-retrieval";

/**
 * WARP-436: when RAGAS_ENABLED=1 is set in the environment, the eval
 * suite also runs ragas_runner.py against the same stack and asserts
 * threshold envelopes derived from tests/retrieval-eval/ragas/baselines.json.
 * Default OFF — RAGAS is offline-judge-driven and too slow for per-PR CI.
 */
const RAGAS_ENABLED = process.env.RAGAS_ENABLED === "1";
const RAGAS_JUDGE = process.env.RAGAS_JUDGE ?? "local";

/**
 * Acceptance criterion per WARP-286 spec: hybrid must beat vector-only
 * by at least 10% NDCG@10 averaged across the curated query set. The
 * eval harness asserts this verbatim so a regression future-fails the
 * gate, not just the spec.
 */
const NDCG_IMPROVEMENT_THRESHOLD = 1.1;

/** Result depth for the metric. WARP-286 §Eval harness pins this. */
const NDCG_K = 10;

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
  // WARP-436: snippet is added by the admin-retrieval-eval endpoint
  // extension for the RAGAS runner. The NDCG@10 harness doesn't use it,
  // but typing it here keeps the wire shape in sync between TS + Python
  // consumers of the same endpoint.
  snippet?: string;
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

function ndcgAtK(results: SearchResult[], query: Query, k: number = NDCG_K): number {
  const topK = results.slice(0, k);
  const gains = topK.map((r) => (isRelevant(r, query) ? 1 : 0));
  const idealK = Math.min(query.relevant.length, k);
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
  // route lives at `/api/admin/retrieval-eval/search` and is mounted
  // only when NODE_ENV !== production.
  const url = `${API_URL}/api/admin/retrieval-eval/search?variant=${variant}&q=${encodeURIComponent(query)}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`eval search ${variant} failed: ${res.status}`);
  const body = (await res.json()) as { results: SearchResult[] };
  return body.results;
}

describe.skipIf(!SHOULD_RUN)("retrieval eval — WARP-286", () => {
  let queries: Query[];

  beforeAll(async () => {
    // Boot Compose stack (same pattern as rag-end-to-end). The harness
    // assumes the orchestrator + ai-gateway + db + file-indexer are
    // reachable on API_URL; the explicit `up -d` is idempotent.
    sh(
      `${COMPOSE} up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud`,
    );

    // Wait for DB readiness with an explicit deadline — no `while True`.
    const dbDeadline = Date.now() + 60_000;
    while (Date.now() < dbDeadline) {
      try {
        dbQuery("SELECT 1");
        break;
      } catch {
        sh("sleep 1");
      }
    }

    // Seed the WARP-224 fixtures. We do best-effort uploads here — the
    // eval still works against a partial fixture set; it just gates on
    // whichever queries map to indexed files. Each upload polls until
    // the indexer reports chunks for the file.
    const FIXTURES = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures");
    const PDF = `${FIXTURES}/sample.pdf`;
    const ZIP = `${FIXTURES}/simple.zip`;
    const PNG = `${FIXTURES}/sample.png`;
    const EML = `${FIXTURES}/with-pdf-attachment.eml`;

    await uploadNextcloudFile(PDF, "test-rag-end-to-end");
    await uploadNextcloudFile(ZIP, "test-rag-end-to-end");
    await pollNcChunkCount("%test-rag-end-to-end/sample.pdf", 180_000);
    await pollNcChunkCount("%test-rag-end-to-end/simple.zip", 180_000);

    const pngUp = await uploadBrainFile(PNG, "warp206-image.png", "image/png");
    await pollUntilBrainIndexed(pngUp.itemId, 180_000);
    const emlUp = await uploadBrainFile(
      EML,
      "warp224-email.eml",
      "message/rfc822",
    );
    await pollUntilBrainIndexed(emlUp.itemId, 180_000);
    // Audio + video fixtures require transcribe-now (WARP-218); skip them
    // when not already indexed. The eval still has plenty of queries
    // that hit the seeded fixtures.

    queries = parseYaml(
      readFileSync(resolve(__dirname, "queries.yaml"), "utf8"),
    ).queries as Query[];
  }, 600_000);

  it("full hybrid retrieval beats vector-only baseline by ≥10% NDCG@10", async () => {
    const ndcgs: Record<"vector" | "rrf" | "hybrid", number[]> = {
      vector: [],
      rrf: [],
      hybrid: [],
    };

    for (const q of queries) {
      const [vec, rrf, hyb] = await Promise.all([
        callSearchEndpoint("vector", q.query),
        callSearchEndpoint("rrf", q.query),
        callSearchEndpoint("hybrid", q.query),
      ]);
      ndcgs.vector.push(ndcgAtK(vec, q));
      ndcgs.rrf.push(ndcgAtK(rrf, q));
      ndcgs.hybrid.push(ndcgAtK(hyb, q));
    }

    const mean = (xs: number[]) =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const vecMean = mean(ndcgs.vector);
    const rrfMean = mean(ndcgs.rrf);
    const hybMean = mean(ndcgs.hybrid);

    // eslint-disable-next-line no-console
    console.log("\nNDCG@10 means:");
    // eslint-disable-next-line no-console
    console.log(`  vector-only       : ${vecMean.toFixed(4)}`);
    // eslint-disable-next-line no-console
    console.log(`  RRF (no rerank)   : ${rrfMean.toFixed(4)}`);
    // eslint-disable-next-line no-console
    console.log(`  full hybrid+rerank: ${hybMean.toFixed(4)}`);
    const liftPct =
      vecMean === 0 ? Infinity : ((hybMean / vecMean - 1) * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`  delta: hybrid is ${liftPct}% above vector-only`);

    // Acceptance criterion: ≥10% improvement (NDCG_IMPROVEMENT_THRESHOLD).
    // Spec acceptance text + threshold are paired here verbatim so a
    // future change to the threshold has to touch the named constant.
    expect(hybMean).toBeGreaterThanOrEqual(
      vecMean * NDCG_IMPROVEMENT_THRESHOLD,
    );
  }, 600_000);

  // WARP-436 — RAGAS metrics layered on top of NDCG@10. Gated by env so
  // we don't pay the judge-LLM cost on every PR's vitest run.
  it.skipIf(!RAGAS_ENABLED)(
    "RAGAS metrics stay above baseline thresholds (WARP-436)",
    async () => {
      const ragasDir = resolve(REPO_ROOT, "tests/retrieval-eval/ragas");
      const runner = resolve(ragasDir, "ragas_runner.py");
      const resultsJson = resolve(ragasDir, "results.json");
      const baselinesJson = resolve(ragasDir, "baselines.json");

      // Spawn the runner against the still-running Compose stack. The
      // venv is created/refreshed by scripts/test-rag.sh --with-ragas;
      // when running through `npx vitest` directly the caller is
      // expected to have provisioned it. We don't auto-create a venv
      // here to keep this test's responsibility tight.
      const pythonBin = process.env.RAGAS_PYTHON
        ?? resolve(ragasDir, ".ragas-venv/bin/python");
      const args = [
        runner,
        "--variant", "hybrid",
        "--limit", "10",
        "--judge", RAGAS_JUDGE,
        "--api-url", API_URL,
        "--out", resultsJson,
        "--out-md", resolve(ragasDir, "results.md"),
      ];

      // eslint-disable-next-line no-console
      console.log(`\n[RAGAS] ${pythonBin} ${args.join(" ")}`);
      execSync(`${pythonBin} ${args.map((a) => JSON.stringify(a)).join(" ")}`,
        { stdio: "inherit" });

      expect(existsSync(resultsJson)).toBe(true);
      const results = JSON.parse(readFileSync(resultsJson, "utf8")) as {
        metrics: Record<string, { mean: number; p50: number; p95: number }>;
      };

      // If baselines.json exists, assert every metric's mean is within the
      // p50 - 1.5*IQR envelope. If it doesn't (first-ever run on a new
      // appliance), record-mode: print numbers, don't fail.
      if (!existsSync(baselinesJson)) {
        // eslint-disable-next-line no-console
        console.log(
          "\n[RAGAS] baselines.json not found — recording mode. " +
          "Inspect tests/retrieval-eval/ragas/results.json and commit " +
          "baselines.json with the 5-run aggregates per docs/RAG_TESTING.md.",
        );
        return;
      }

      const baselines = JSON.parse(
        readFileSync(baselinesJson, "utf8"),
      ) as {
        envelopes: Record<string, { floor: number }>;
      };

      for (const [metric, stats] of Object.entries(results.metrics)) {
        const floor = baselines.envelopes?.[metric]?.floor;
        if (typeof floor !== "number") continue;
        // eslint-disable-next-line no-console
        console.log(
          `[RAGAS] ${metric}: mean=${stats.mean.toFixed(3)} floor=${floor.toFixed(3)}`,
        );
        expect(stats.mean).toBeGreaterThanOrEqual(floor);
      }
    },
    // Judge LLM call per metric per query → can be slow on local mistral.
    1_800_000,
  );
});
