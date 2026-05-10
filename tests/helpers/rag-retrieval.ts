/**
 * Shared helpers for the RAG end-to-end retrieval flows.
 *
 * Extracted from rag-end-to-end.integration.test.ts when WARP-224
 * added 6 new flows; keeping the test file readable as flows
 * multiply.
 *
 * Skip-gated by RUN_RAG_INTEGRATION=1 like the rest of the suite.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const COMPOSE_BASE = `-f ${REPO_ROOT}/docker/docker-compose.yml`;
export const COMPOSE_OVERRIDE = `-f ${REPO_ROOT}/docker/docker-compose.test.override.yml`;
export const COMPOSE = `docker compose ${COMPOSE_BASE} ${COMPOSE_OVERRIDE}`;
export const NC_DATA_DIR = "/var/www/html/data/admin/files";
export const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";
export const API_URL = process.env.API_URL ?? "http://localhost:3000";

export function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

export function shSilent(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function dbQuery(sql: string): string {
  // Multi-line SQL doesn't survive JSON.stringify → bash double-quote
  // (newlines become literal \n that psql parses as syntax). Flatten
  // any whitespace runs to single spaces. WARP-227.
  const flat = sql.replace(/\s+/g, " ").trim();
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(flat)}`,
  );
}

export interface ChatResponse {
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

export interface SearchToolHit {
  path: string;
  score: number;
  text: string;
}

export function citationsFrom(resp: ChatResponse): SearchToolHit[] {
  const hits: SearchToolHit[] = [];
  for (const entry of resp.trace) {
    if (entry.tool !== "search_content") continue;
    const result = entry.result as
      | { ok?: boolean; data?: { results?: SearchToolHit[] }; results?: SearchToolHit[] }
      | undefined;
    const list = result?.data?.results ?? result?.results ?? [];
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

export async function chat(question: string): Promise<ChatResponse> {
  const res = await fetch(`${API_URL}/api/llm/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.RAG_E2E_MODEL ?? "llama3.1",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. When the user asks about a document, you MUST call search_content to retrieve from the user's indexed files before answering. Never answer from memory.",
        },
        { role: "user", content: question },
      ],
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

/**
 * Upload a file via POST /api/files/brain/upload. Returns the
 * BrainMemoryItem id and the synchronous response status string
 * ("indexing", "queued_for_transcription", etc.).
 */
export async function uploadBrainFile(
  filePath: string,
  uploadName: string,
  mimeType: string,
): Promise<{ itemId: string; status: string }> {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), uploadName);
  const res = await fetch(`${API_URL}/api/files/brain/upload`, {
    method: "POST",
    body: form,
  });
  if (res.status !== 202) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`brain/upload returned ${res.status}: ${body}`);
  }
  return (await res.json()) as { itemId: string; status: string };
}

/**
 * Drop a file into Nextcloud's admin user-files dir + run files:scan.
 * Returns once `occ files:scan` exits successfully — that is when the
 * file is queued for the file-indexer's filecache watcher.
 */
export async function uploadNextcloudFile(
  filePath: string,
  ncSubdir: string,
): Promise<void> {
  sh(`${COMPOSE} exec -T nextcloud mkdir -p ${NC_DATA_DIR}/${ncSubdir}`);
  sh(`${COMPOSE} exec -T nextcloud chown www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`);
  sh(`${COMPOSE} cp ${filePath} nextcloud:${NC_DATA_DIR}/${ncSubdir}/`);
  sh(`${COMPOSE} exec -T nextcloud chown -R www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`);
  sh(
    `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/${ncSubdir} --quiet`,
  );
}

/**
 * Poll until at least one FileContentChunk row exists for the given
 * brain item (source='brain'). Generous default timeout — cold-boot
 * Tesseract / faster-whisper / pgvector embeds can take 30-60s.
 */
export async function pollUntilBrainIndexed(
  itemId: string,
  timeoutMs = 180_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT "indexedAt" FROM "BrainMemoryItem" WHERE "id" = '${itemId}'`,
    );
    if (out && out.length > 0) {
      const chunks = dbQuery(
        `SELECT count(*) FROM "FileContentChunk" WHERE "brainItemId" = '${itemId}' AND "source" = 'brain'`,
      );
      if (Number.parseInt(chunks, 10) > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Poll until at least one FileContentChunk row exists for a
 * Nextcloud-scanned path. `pathLike` is a SQL LIKE pattern (escape
 * percent signs yourself if you need a literal one).
 */
export async function pollNcChunkCount(
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

/**
 * Read the BrainMemoryItem.status enum value for an item.
 * Returns null if the row doesn't exist.
 */
export function getBrainStatus(itemId: string): string | null {
  const out = dbQuery(
    `SELECT "status" FROM "BrainMemoryItem" WHERE "id" = '${itemId}'`,
  );
  return out.length > 0 ? out : null;
}

/**
 * Poll until BrainMemoryItem.status equals expected.
 * Used by the deferred-ASR flow.
 */
export async function pollUntilBrainStatus(
  itemId: string,
  expected: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = getBrainStatus(itemId);
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/**
 * POST /api/files/brain/:itemId/transcribe-now. Returns the response
 * status code so the caller can distinguish 202 (accepted) from 429
 * (retry-cap) / 409 (already indexing).
 */
export async function transcribeNow(itemId: string): Promise<number> {
  const res = await fetch(
    `${API_URL}/api/files/brain/${itemId}/transcribe-now`,
    { method: "POST" },
  );
  return res.status;
}

/**
 * Wait for orchestrator's API health endpoint to become reachable.
 * Used by the test's beforeAll.
 */
export async function waitForOrchestrator(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API_URL}/api/orchestrator/health`);
      if (r.ok) return;
    } catch {
      /* connection refused while booting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("orchestrator never came up within timeout");
}
