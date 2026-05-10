/**
 * Brain-memory export + delete + cascade — live integration test
 * (WARP-205).
 *
 * Boots the relevant Compose services (db, cache, broker, ai-gateway,
 * orchestrator, file-indexer) — same stack as
 * `rag-brain-upload.integration.test.ts`, which is the upstream
 * dependency for the test fixtures we generate here.
 *
 * Flow:
 *   1. Upload a text file via WARP-203's POST /api/files/brain/upload.
 *   2. Wait for the indexer to flip indexedAt → non-null and write
 *      FileContentChunk rows.
 *   3. GET /api/files/brain/export?all=1 → unzip → assert manifest.json
 *      + per-item original bytes are present and well-formed.
 *   4. DELETE /api/files/brain/:itemId → assert subsequent GET 404 +
 *      cascade-deleted chunks gone from FileContentChunk.
 *
 * Skip behavior: requires `RUN_RAG_INTEGRATION=1`. Without it the
 * suite skips so unit-only test runs stay fast. Set on a real device
 * or in the path-filtered GitHub Actions workflow.
 *
 * Run locally:
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker ai-gateway orchestrator file-indexer
 *   API_URL=http://localhost:3000 RUN_RAG_INTEGRATION=1 \
 *     npx vitest run tests/rag-brain-export.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import yauzl from "yauzl";
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

async function pollChunkCount(
  brainItemId: string,
  timeoutMs = 120_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT count(*) FROM "FileContentChunk" WHERE "brainItemId" = '${brainItemId}'`,
    );
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) return n;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0;
}

/**
 * Fetch a URL and return the response body as a Buffer. Used because
 * `res.arrayBuffer()` works fine for zip payloads.
 */
async function fetchBuffer(url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf, headers: res.headers };
}

interface ZipContents {
  files: Map<string, Buffer>;
}

async function unzipBuffer(buf: Buffer): Promise<ZipContents> {
  return new Promise((resolveP, rejectP) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return rejectP(err);
      const files = new Map<string, Buffer>();
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return rejectP(err2);
          const chunks: Buffer[] = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolveP({ files }));
    });
  });
}

describe.skipIf(!SHOULD_RUN)(
  "RAG brain-memory export + delete — live integration",
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

    it("upload → export → unzip; DELETE → 404 + cascade-deleted chunks", async () => {
      // ── 1. Upload a fixture so the export has something to find ──
      const sentinel = `kilolimaomega-WARP205-${Date.now()}`;
      const body = `Integration fixture for WARP-205. Sentinel: ${sentinel}.`;
      const form = new FormData();
      form.append(
        "file",
        new Blob([body], { type: "text/plain" }),
        "warp205.txt",
      );

      const upRes = await fetch(`${API_URL}/api/files/brain/upload`, {
        method: "POST",
        body: form,
      });
      expect(upRes.status).toBe(202);
      const upData = (await upRes.json()) as { itemId: string };
      const itemId = upData.itemId;
      expect(itemId).toBeTruthy();

      // Wait for the indexer to write chunks (export's manifest reports
      // chunkCount; we want a non-zero number so the assertion is real).
      const indexedAt = await pollIndexedAt(itemId);
      expect(indexedAt).not.toBe("");
      const chunkCount = await pollChunkCount(itemId);
      expect(chunkCount).toBeGreaterThan(0);

      // ── 2. Export ?all=1 → unzip, assert shape ──
      const exportRes = await fetchBuffer(
        `${API_URL}/api/files/brain/export?all=1`,
      );
      expect(exportRes.status).toBe(200);
      expect(exportRes.headers.get("content-type")).toBe("application/zip");
      expect(exportRes.headers.get("content-disposition")).toMatch(
        /attachment.*\.zip/,
      );

      const zip = await unzipBuffer(exportRes.body);
      const manifestEntry = zip.files.get("manifest.json");
      expect(manifestEntry).toBeTruthy();
      const manifest = JSON.parse(manifestEntry!.toString("utf8"));
      expect(manifest.userId).toBeTruthy();
      expect(Array.isArray(manifest.items)).toBe(true);
      const exported = manifest.items.find(
        (i: { id: string }) => i.id === itemId,
      );
      expect(exported).toBeTruthy();
      expect(exported.filename).toBe("warp205.txt");
      expect(exported.chunkCount).toBeGreaterThan(0);

      // The original bytes are inside the zip at <itemId>/<filename>.
      const payloadEntry = `${itemId}/warp205.txt`;
      const payload = zip.files.get(payloadEntry);
      expect(payload).toBeTruthy();
      expect(payload!.toString("utf8")).toContain(sentinel);

      // ── 3. DELETE → 204; subsequent GET → 404; chunks gone ──
      const delRes = await fetch(`${API_URL}/api/files/brain/${itemId}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(204);

      const getRes = await fetch(`${API_URL}/api/files/brain/${itemId}`);
      expect(getRes.status).toBe(404);

      // Cascade — FileContentChunk rows for this item are gone.
      const remaining = dbQuery(
        `SELECT count(*) FROM "FileContentChunk" WHERE "brainItemId" = '${itemId}'`,
      );
      expect(Number(remaining)).toBe(0);

      // Row itself is gone too.
      const rowRemaining = dbQuery(
        `SELECT count(*) FROM "BrainMemoryItem" WHERE "id" = '${itemId}'`,
      );
      expect(Number(rowRemaining)).toBe(0);
    }, 300_000);

    it("DELETE on a nonexistent itemId returns 404", async () => {
      const res = await fetch(
        `${API_URL}/api/files/brain/no-such-id-warp205`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it("export ?chatId=<id> scopes the manifest to that chat", async () => {
      // Two uploads tagged to different chats; the export must only
      // include the one matching ?chatId=.
      const chatA = `chat-205-A-${Date.now()}`;
      const chatB = `chat-205-B-${Date.now()}`;

      async function upload(chatId: string, marker: string): Promise<string> {
        const form = new FormData();
        form.append("chatId", chatId);
        form.append(
          "file",
          new Blob([`payload-${marker}`], { type: "text/plain" }),
          `${marker}.txt`,
        );
        const res = await fetch(`${API_URL}/api/files/brain/upload`, {
          method: "POST",
          body: form,
        });
        const data = (await res.json()) as { itemId: string };
        return data.itemId;
      }

      const idA = await upload(chatA, "chatA");
      const idB = await upload(chatB, "chatB");

      const exportRes = await fetchBuffer(
        `${API_URL}/api/files/brain/export?chatId=${encodeURIComponent(chatA)}`,
      );
      expect(exportRes.status).toBe(200);
      const zip = await unzipBuffer(exportRes.body);
      const manifest = JSON.parse(
        zip.files.get("manifest.json")!.toString("utf8"),
      );
      const ids = manifest.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(idA);
      expect(ids).not.toContain(idB);
      expect(manifest.scope).toEqual({ chatId: chatA });

      // Cleanup so the test doesn't leak fixtures into other suites.
      await fetch(`${API_URL}/api/files/brain/${idA}`, { method: "DELETE" });
      await fetch(`${API_URL}/api/files/brain/${idB}`, { method: "DELETE" });
    }, 180_000);
  },
);
