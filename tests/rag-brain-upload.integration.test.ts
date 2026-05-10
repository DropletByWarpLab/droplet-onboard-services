/**
 * Brain-memory upload — live integration test against the Compose stack
 * (WARP-203).
 *
 * Boots the relevant services (db, cache, broker, ai-gateway,
 * orchestrator, file-indexer), POSTs a file at
 * `POST /api/files/brain/upload`, then polls until:
 *   - `BrainMemoryItem.indexedAt IS NOT NULL`
 *   - `FileContentChunk(source='brain', brainItemId=<id>)` has rows
 *   - the chunked text contains the unique sentinel from the upload
 *
 * Per-user RBAC is exercised at the row level via direct DB writes:
 * we insert a dummy BrainMemoryItem owned by user "bob" and confirm
 * the dev-user GET returns 404 (no leak), and the dev-user list
 * never includes the row. End-to-end auth (real Nextcloud user A vs
 * user B) is out of scope for this integration lane — `tests/api.integration.test.ts`
 * runs with AUTH_ENABLED=0 and a single dev user.
 *
 * Skip behavior: requires `RUN_RAG_INTEGRATION=1`. Without it the suite
 * skips so unit-only test runs stay fast. Set on a real device or in
 * the path-filtered GitHub Actions workflow.
 *
 * Run locally:
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker ai-gateway orchestrator file-indexer
 *   API_URL=http://localhost:3000 RUN_RAG_INTEGRATION=1 \
 *     npx vitest run tests/rag-brain-upload.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { COMPOSE } from "./helpers/rag-retrieval";
const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";
const API_URL = process.env.API_URL ?? "http://localhost:3000";

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
  // Multi-line SQL doesn't survive JSON.stringify → bash double-quote
  // (newlines become literal \n that psql parses as syntax). Flatten
  // any whitespace runs to single spaces. WARP-227.
  const flat = sql.replace(/\s+/g, " ").trim();
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(flat)}`,
  );
}

async function pollChunkText(
  brainItemId: string,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT string_agg("text", ' ') FROM "FileContentChunk"
       WHERE "brainItemId" = '${brainItemId}' AND "source" = 'brain'`,
    );
    if (out && out.length > 0 && out !== "") return out;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

async function pollIndexedAt(
  brainItemId: string,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT "indexedAt" FROM "BrainMemoryItem" WHERE "id" = '${brainItemId}'`,
    );
    if (out && out !== "") return out;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

describe.skipIf(!SHOULD_RUN)(
  "RAG brain-memory upload — live integration",
  () => {
    beforeAll(() => {
      sh(
        `${COMPOSE} up -d db cache broker ai-gateway orchestrator file-indexer`,
      );
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          dbQuery("SELECT 1");
          break;
        } catch {
          execSync("sleep 1");
        }
      }
    }, 180_000);

    it("uploads a text file → file-indexer ingest → chunk rows + indexedAt", async () => {
      const sentinel = "kilolimaomega-WARP203-brain";
      const body = `This integration fixture contains the unique token ${sentinel} so we can grep the chunks back out of pgvector.`;
      const form = new FormData();
      form.append(
        "file",
        new Blob([body], { type: "text/plain" }),
        "warp203.txt",
      );

      const res = await fetch(`${API_URL}/api/files/brain/upload`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(202);
      const data = (await res.json()) as { itemId: string; status: string };
      expect(data.status).toBe("indexing");
      expect(data.itemId).toBeTruthy();

      const indexedAt = await pollIndexedAt(data.itemId);
      expect(indexedAt).not.toBe("");

      const chunks = await pollChunkText(data.itemId);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks).toContain(sentinel);

      // The list endpoint surfaces the same row with `total >= 1`.
      const list = await fetch(`${API_URL}/api/files/brain?limit=100`);
      expect(list.status).toBe(200);
      const listJson = (await list.json()) as {
        items: Array<{ id: string; userId: string }>;
        total: number;
      };
      expect(listJson.total).toBeGreaterThanOrEqual(1);
      const found = listJson.items.find((i) => i.id === data.itemId);
      expect(found).toBeDefined();
      // Every row in the response belongs to the caller (RBAC).
      for (const it of listJson.items) {
        expect(it.userId).toBe(found!.userId);
      }
    }, 240_000);

    it("RBAC: another user's row is invisible to the dev-user list + 404 on get", async () => {
      // Insert a dummy row owned by "bob" directly via SQL — the route
      // can't impersonate cross-user without a real auth flow. We assert
      // the response shape: list excludes the row, GET returns 404.
      const otherId = `bmi-rbac-${Date.now()}`;
      dbQuery(
        `INSERT INTO "BrainMemoryItem"
           ("id", "userId", "filename", "bytes", "storagePath", "source")
         VALUES
           ('${otherId}', 'bob', 'rbac.txt', 12, '/tmp/rbac.txt', 'chat_attachment')`,
      );

      const list = await fetch(`${API_URL}/api/files/brain?limit=200`);
      const listJson = (await list.json()) as {
        items: Array<{ id: string; userId: string }>;
      };
      const leaked = listJson.items.find((i) => i.id === otherId);
      expect(leaked).toBeUndefined();
      for (const it of listJson.items) {
        expect(it.userId).not.toBe("bob");
      }

      const getRes = await fetch(`${API_URL}/api/files/brain/${otherId}`);
      expect(getRes.status).toBe(404);
    }, 60_000);
  },
);
