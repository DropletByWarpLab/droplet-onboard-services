/**
 * Email extractor — live integration test against the Compose stack
 * (WARP-199).
 *
 * Boots the relevant services (db, cache, broker, ai-gateway,
 * orchestrator, file-indexer), POSTs the
 * `services/file-indexer/tests/fixtures/with-pdf-attachment.eml` fixture
 * at `POST /api/files/brain/upload`, then polls the FileContentChunk
 * table until the chunked text contains BOTH the email body and the
 * `--- Attachment: proposal.pdf ---` separator that proves the recursive
 * dispatcher walked into the PDF.
 *
 * Skip behavior: requires `RUN_RAG_INTEGRATION=1`. Without it the suite
 * skips so unit-only test runs stay fast. Set on a real device or in
 * the path-filtered GitHub Actions workflow.
 *
 * Run locally:
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker ai-gateway orchestrator file-indexer
 *   API_URL=http://localhost:3000 RUN_RAG_INTEGRATION=1 \
 *     npx vitest run tests/rag-email.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const COMPOSE = `docker compose -f ${REPO_ROOT}/docker/docker-compose.yml`;
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
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

async function pollChunkText(
  brainItemId: string,
  timeoutMs = 180_000,
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

describe.skipIf(!SHOULD_RUN)(
  "WARP-199 email extraction — live integration",
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

    it("indexes both email body and PDF attachment text", async () => {
      const fixturePath = path.resolve(
        __dirname,
        "../services/file-indexer/tests/fixtures/with-pdf-attachment.eml",
      );
      const bytes = fs.readFileSync(fixturePath);
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: "message/rfc822" }),
        "march.eml",
      );

      const res = await fetch(`${API_URL}/api/files/brain/upload`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(202);
      const data = (await res.json()) as { itemId: string; status: string };
      expect(data.itemId).toBeTruthy();

      const combined = await pollChunkText(data.itemId);
      expect(combined.length).toBeGreaterThan(0);
      // Email body bled through.
      expect(combined).toContain("Bob, see the attached PDF");
      // Attachment separator proves recursive dispatch ran.
      expect(combined).toContain("--- Attachment: proposal.pdf ---");
    }, 240_000);
  },
);
