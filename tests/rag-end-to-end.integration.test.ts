/**
 * RAG end-to-end smoke (WARP-206) — proves the whole chain works
 * against a live Compose stack.
 *
 *   PDF (Nextcloud) ─┐
 *                    ├─→ file-indexer ─→ FileContentChunk + indexedAt
 *   PNG (brain)   ───┘
 *
 *   then: POST /api/llm/chat ─→ orchestrator agent loop ─→
 *         search_content (MCP, stdio) ─→ pgvector ─→ chunks
 *         ─→ trace[].result.results[] ─→ "citations"
 *
 * Skip-gated by `RUN_RAG_INTEGRATION=1` to match the rest of the RAG
 * suite. Without it the suite skips so the default unit run stays
 * fast.
 *
 * # On orchestrator reachability
 *
 * The production `docker/docker-compose.yml` does NOT publish the
 * orchestrator's port 3000 to the host (gateway:80 is the public
 * entry point). The integration tests assume `localhost:3000` works,
 * which is true only with the test override
 * `docker/docker-compose.test.override.yml` layered on top. The
 * `scripts/test-rag.sh` runner and the `rag-tests` GitHub Actions
 * workflow both apply that override; running these tests by hand
 * without it will fail with ECONNREFUSED at the first fetch().
 *
 * # On LLM determinism
 *
 * The default ai-gateway routes Ollama → the Jetson appliance, which
 * is unreachable on a CI runner / a developer laptop. We can't make
 * the agent loop emit deterministic prose either way, so we assert
 * the *retrieval* axis:
 *
 *   - the agent called search_content,
 *   - the call returned results pointing at the indexed file's path,
 *   - the matched chunk text is non-empty.
 *
 * This is the part the spec actually constrains. The model's free-
 * form answer can still vary turn-to-turn — that's an LLM property,
 * not a RAG one — but the citation chain is what we promised to
 * stabilize in §11 of `2026-04-28-rag-system-design.md`.
 *
 * # Determinism harness
 *
 * The "5 runs in a row" loop uses `it.each([1..5])` so a single run
 * still produces a useful failure label ("run #3 failed retrieval")
 * rather than a hard-to-bisect blob. We loop on retrieval (not on
 * the model output) for the reason above.
 *
 * Run locally:
 *   ./scripts/test-rag.sh
 * or:
 *   docker compose -f docker/docker-compose.yml \
 *     -f docker/docker-compose.test.override.yml \
 *     up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud
 *   API_URL=http://localhost:3000 RUN_RAG_INTEGRATION=1 \
 *     npx vitest run tests/rag-end-to-end.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const REPO_ROOT = resolve(__dirname, "..");
const COMPOSE_BASE = `-f ${REPO_ROOT}/docker/docker-compose.yml`;
const COMPOSE_OVERRIDE = `-f ${REPO_ROOT}/docker/docker-compose.test.override.yml`;
const COMPOSE = `docker compose ${COMPOSE_BASE} ${COMPOSE_OVERRIDE}`;
const NC_DATA_DIR = "/var/www/html/data/admin/files";
const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";
const API_URL = process.env.API_URL ?? "http://localhost:3000";

// The PDF fixture contains the unique sentinel "alphahotel" (see
// services/file-indexer/tests/test_extractors_pdf.py). The PNG fixture
// contains "echofoxtrot" (see test_extractors_image.py). We re-use
// these so we don't have to ship new fixtures for the e2e lane.
const PDF_FIXTURE = resolve(
  REPO_ROOT,
  "services/file-indexer/tests/fixtures/sample.pdf",
);
const PNG_FIXTURE = resolve(
  REPO_ROOT,
  "services/file-indexer/tests/fixtures/sample.png",
);
const PDF_SENTINEL = "alphahotel";
const PNG_SENTINEL = "echofoxtrot";
const NC_SUBDIR = "test-rag-end-to-end";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function shSilent(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function dbQuery(sql: string): string {
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

async function pollNcChunkCount(
  pathLike: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT count(*) FROM "FileContentChunk" WHERE "path" LIKE '${pathLike}' AND "source" = 'nextcloud'`,
    );
    const n = Number.parseInt(out, 10);
    if (Number.isFinite(n) && n > 0) return n;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0;
}

async function pollBrainIndexed(
  itemId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT "indexedAt" FROM "BrainMemoryItem" WHERE "id" = '${itemId}'`,
    );
    if (out && out.length > 0) {
      // Also wait for the chunk rows. indexedAt flips before the chunk
      // commit on some race windows.
      const chunks = dbQuery(
        `SELECT count(*) FROM "FileContentChunk" WHERE "brainItemId" = '${itemId}' AND "source" = 'brain'`,
      );
      if (Number.parseInt(chunks, 10) > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

interface ChatResponse {
  message: { role: string; content: string };
  trace: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  iterations: number;
  stop_reason: string;
  error?: string;
}

interface SearchToolHit {
  path: string;
  score: number;
  text: string;
}

/**
 * Pull the search_content invocations out of an agent trace and
 * surface their results. Returns a flat list of {path, text} pairs
 * for citation assertions.
 */
function citationsFrom(resp: ChatResponse): SearchToolHit[] {
  const hits: SearchToolHit[] = [];
  for (const entry of resp.trace) {
    if (entry.tool !== "search_content") continue;
    const result = entry.result as
      | { ok?: boolean; data?: { results?: SearchToolHit[] }; results?: SearchToolHit[] }
      | undefined;
    // The MCP envelope unwraps to either {ok, data: {results}} (handler
    // shape) or {query, results} (server-formatted payload). Both have
    // appeared in the wild while WARP-202/203 were stacking — accept
    // either rather than coupling the test to one parse tree.
    const list =
      result?.data?.results ?? result?.results ?? [];
    for (const r of list) {
      if (r && typeof r.path === "string") {
        hits.push({
          path: r.path,
          score: typeof r.score === "number" ? r.score : 0,
          text: typeof r.text === "string" ? r.text : "",
        });
      }
    }
  }
  return hits;
}

async function chat(question: string): Promise<ChatResponse> {
  const res = await fetch(`${API_URL}/api/llm/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Use whatever model the gateway resolves by default — the test
      // assertions only depend on the agent calling search_content,
      // not on the prose the model returns.
      model: process.env.RAG_E2E_MODEL ?? "llama3.1",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. When the user asks about a document, you MUST call search_content to retrieve from the user's indexed files before answering. Never answer from memory.",
        },
        { role: "user", content: question },
      ],
      // Bound the loop so a confused model can't burn the budget.
      max_iter: 4,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`/api/llm/chat returned ${res.status}: ${body}`);
  }
  return (await res.json()) as ChatResponse;
}

describe.skipIf(!SHOULD_RUN)(
  "RAG end-to-end smoke — Nextcloud + brain → /api/llm/chat (WARP-206)",
  () => {
    let brainItemId: string | null = null;

    beforeAll(async () => {
      // Bring up the full chain. mcp-server is a sibling Compose
      // service on `main` — see docker/docker-compose.yml lines 130+.
      // It's the network-surface MCP transport; the orchestrator's
      // in-process agent uses the stdio child it spawns itself, but
      // the service still needs to be in the dependency graph so
      // `depends_on: db` waits hold.
      sh(
        `${COMPOSE} up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud`,
      );

      // Wait for DB.
      const dbDeadline = Date.now() + 60_000;
      while (Date.now() < dbDeadline) {
        try {
          dbQuery("SELECT 1");
          break;
        } catch {
          execSync("sleep 1");
        }
      }

      // Wait for Nextcloud's bootstrap (occ status returns 0). On a
      // cold boot this is the long pole — 2-3 minutes is normal.
      const ncDeadline = Date.now() + 240_000;
      while (Date.now() < ncDeadline) {
        try {
          sh(
            `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ status`,
          );
          break;
        } catch {
          execSync("sleep 2");
        }
      }

      // Wait for orchestrator's API health. Without this the first
      // fetch races the ExpressJS startup and 502s through the bridge.
      const orchDeadline = Date.now() + 90_000;
      while (Date.now() < orchDeadline) {
        try {
          const r = await fetch(`${API_URL}/api/orchestrator/health`);
          if (r.ok) break;
        } catch {
          /* connection refused while booting */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // ─── Step 1: drop a PDF into Nextcloud's admin user files dir ───
      sh(`${COMPOSE} exec -T nextcloud mkdir -p ${NC_DATA_DIR}/${NC_SUBDIR}`);
      sh(
        `${COMPOSE} exec -T nextcloud chown www-data:www-data ${NC_DATA_DIR}/${NC_SUBDIR}`,
      );
      sh(`${COMPOSE} cp ${PDF_FIXTURE} nextcloud:${NC_DATA_DIR}/${NC_SUBDIR}/`);
      sh(
        `${COMPOSE} exec -T nextcloud chown -R www-data:www-data ${NC_DATA_DIR}/${NC_SUBDIR}`,
      );
      sh(
        `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/${NC_SUBDIR} --quiet`,
      );

      // ─── Step 2: upload a PNG via the brain-upload API ───
      const pngBytes = readFileSync(PNG_FIXTURE);
      const form = new FormData();
      form.append(
        "file",
        new Blob([pngBytes], { type: "image/png" }),
        "warp206-image.png",
      );
      const upRes = await fetch(`${API_URL}/api/files/brain/upload`, {
        method: "POST",
        body: form,
      });
      if (upRes.status !== 202) {
        const body = await upRes.text().catch(() => "<no body>");
        throw new Error(`brain/upload returned ${upRes.status}: ${body}`);
      }
      const upJson = (await upRes.json()) as { itemId: string; status: string };
      brainItemId = upJson.itemId;

      // ─── Step 3: poll for indexedAt + chunk rows on both ───
      // Generous timeouts: cold-boot Tesseract OCR + pgvector embed +
      // chunk insert can take 30-60s under load.
      const ncOk = await pollNcChunkCount(
        `%${NC_SUBDIR}/sample.pdf`,
        180_000,
      );
      if (ncOk === 0) {
        throw new Error(
          "Nextcloud PDF never produced FileContentChunk rows — check file-indexer logs",
        );
      }
      const brainOk = await pollBrainIndexed(brainItemId, 180_000);
      if (!brainOk) {
        throw new Error(
          `Brain item ${brainItemId} never indexed — check file-indexer + ai-gateway logs`,
        );
      }
    }, 600_000); // 10 min ceiling — Nextcloud cold-boot + OCR + embed

    afterAll(async () => {
      try {
        sh(
          `${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/${NC_SUBDIR}`,
        );
      } catch {
        /* swallow */
      }
      // Don't `compose down` here — the runner / CI step owns
      // teardown so artifacts (logs) can be captured first.
    });

    it("agent retrieval reaches the Nextcloud-indexed PDF", async () => {
      const resp = await chat(
        `Search my documents for the unique token "${PDF_SENTINEL}". What does the document containing it say?`,
      );

      expect(resp.error).toBeUndefined();
      // The agent loop should produce some prose, even if the model
      // is off-line and the message is empty (iteration_limit). Don't
      // require a non-empty content string — the model's free-form
      // output isn't the contract this test enforces.
      expect(resp.message).toBeDefined();

      const hits = citationsFrom(resp);
      expect(hits.length).toBeGreaterThan(0);
      // PDF citation MUST point at the file we just indexed (prefix
      // match for the Nextcloud /admin/files/... layout).
      const pdfHit = hits.find(
        (h) =>
          h.path.includes(NC_SUBDIR) && h.path.toLowerCase().endsWith(".pdf"),
      );
      expect(pdfHit, `no citation for ${NC_SUBDIR}/sample.pdf`).toBeDefined();
      expect(pdfHit!.text.length).toBeGreaterThan(0);
      // The chunk's text should actually contain the sentinel — this
      // is the proof that retrieval (not just listing) worked.
      expect(pdfHit!.text.toLowerCase()).toContain(PDF_SENTINEL);
    }, 120_000);

    it("agent retrieval reaches the brain-uploaded PNG (OCR path)", async () => {
      const resp = await chat(
        `Search my documents for the token "${PNG_SENTINEL}" — it should be from an image. What does the image contain?`,
      );

      expect(resp.error).toBeUndefined();
      const hits = citationsFrom(resp);
      expect(hits.length).toBeGreaterThan(0);
      // Brain items live under a per-user path. The chat path doesn't
      // resolve to /admin/files/... — match the filename stem instead.
      const pngHit = hits.find((h) => h.path.toLowerCase().includes("warp206-image"));
      expect(pngHit, "no citation for warp206-image.png").toBeDefined();
      expect(pngHit!.text.length).toBeGreaterThan(0);
      expect(pngHit!.text.toLowerCase()).toContain(PNG_SENTINEL);
    }, 120_000);

    // Determinism harness — see header comment. We loop on retrieval
    // because that's the part the spec constrains. The model's prose
    // is allowed to vary across runs; it just has to keep calling
    // search_content and getting back the same chunks.
    it.each([1, 2, 3, 4, 5])(
      "retrieval stays deterministic across run #%i (PDF citation)",
      async (run) => {
        const resp = await chat(
          `Tell me about "${PDF_SENTINEL}" from my documents.`,
        );
        const hits = citationsFrom(resp);
        expect(
          hits.length,
          `run #${run}: agent did not call search_content or got no hits`,
        ).toBeGreaterThan(0);
        const pdfHit = hits.find(
          (h) =>
            h.path.includes(NC_SUBDIR) && h.path.toLowerCase().endsWith(".pdf"),
        );
        expect(
          pdfHit,
          `run #${run}: PDF citation missing — retrieval is flaky`,
        ).toBeDefined();
        expect(pdfHit!.text.toLowerCase()).toContain(PDF_SENTINEL);
      },
      120_000,
    );
  },
);
