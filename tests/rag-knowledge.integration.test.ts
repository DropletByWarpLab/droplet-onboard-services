/**
 * /knowledge dashboard backend — live integration test.
 *
 * Boots the relevant Compose services, seeds a couple of FileContentChunk
 * rows for two distinct usernames, then exercises both routes:
 *
 *   GET /api/files/knowledge/recent
 *   GET /api/files/knowledge/search
 *
 * The test asserts:
 *
 *   1. The /recent route returns the seeded items in indexedAt-desc
 *      order with the right shape (id, path, snippet, indexedAt).
 *   2. /recent respects the userId boundary — chunks seeded under
 *      `user-b` are NOT visible to `user-a`. (Spec §12: cross-user
 *      retrieval is disabled in v1.)
 *   3. /recent honours `?limit=` and `?before=<iso>` cursor pagination.
 *   4. /search either:
 *        a. Returns hits when WARP-202's file-search.service is
 *           merged (and a real embedding service is reachable), or
 *        b. Returns 503 with `error: search-not-yet-available` until
 *           that lands. The test accepts both — both are valid for
 *           the WARP-204 contract.
 *
 * Skip behavior: requires `RUN_RAG_INTEGRATION=1`. The default unit-
 * test runs stay fast.
 *
 *   docker compose -f docker/docker-compose.yml up -d db cache broker orchestrator
 *   RUN_RAG_INTEGRATION=1 npx vitest run tests/rag-knowledge.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(flat)}`
  );
}

/**
 * Seed two FileContentChunk rows: one for user-a (the test's authed
 * user) and one for user-b (used to assert RBAC). The route reads
 * `req.user.username` — in tests with `AUTH_ENABLED=false` that's the
 * fallback `"dev"` user. To keep the test independent of auth, we
 * seed both rows under the dev/admin usernames the orchestrator
 * actually surfaces, and rely on a separate user-b row to confirm
 * the where-userId filter is real.
 */
const USER_A = "dev"; // matches authMiddleware fallback when AUTH_ENABLED=false
const USER_B = "user-b-isolation-check";

const SEED_A = `
DELETE FROM "FileContentChunk" WHERE "userId" IN ('${USER_A}', '${USER_B}');
INSERT INTO "FileContentChunk" ("userId", "ncFileId", "path", "chunkIdx", "text", "embedding", "indexedAt")
VALUES
  ('${USER_A}', 9001, '/Knowledge/alpha.txt', 0, 'Alpha is the first letter.', array_fill(0::real, ARRAY[384])::vector, NOW() - interval '1 hour'),
  ('${USER_A}', 9002, '/Knowledge/beta.txt',  0, 'Beta is the second letter.', array_fill(0::real, ARRAY[384])::vector, NOW() - interval '2 hours'),
  ('${USER_A}', 9003, '/Knowledge/gamma.txt', 0, 'Gamma is the third letter.', array_fill(0::real, ARRAY[384])::vector, NOW() - interval '7 days'),
  ('${USER_B}', 9004, '/Knowledge/secret.txt', 0, 'Should never appear in user-a results.', array_fill(0::real, ARRAY[384])::vector, NOW() - interval '30 minutes');
`;

async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* tolerate non-JSON */
  }
  return { status: res.status, body };
}

describe.skipIf(!SHOULD_RUN)(
  "/knowledge dashboard backend — live integration",
  () => {
    beforeAll(() => {
      sh(`${COMPOSE} up -d db cache broker orchestrator`);
      // Wait for orchestrator + DB.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          dbQuery("SELECT 1");
          break;
        } catch {
          execSync("sleep 1");
        }
      }
      // Seed deterministic rows.
      dbQuery(SEED_A);
    }, 120_000);

    afterAll(() => {
      try {
        dbQuery(
          `DELETE FROM "FileContentChunk" WHERE "userId" IN ('${USER_A}', '${USER_B}');`
        );
      } catch {
        /* best-effort */
      }
    });

    it("GET /api/files/knowledge/recent returns the authed user's chunks newest-first", async () => {
      const { status, body } = await fetchJson(
        `${API_URL}/api/files/knowledge/recent?limit=10`
      );
      expect(status).toBe(200);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(3);

      const paths = body.items.map((i: any) => i.path);
      // The user-b row MUST NOT be reachable.
      expect(paths).not.toContain("/Knowledge/secret.txt");

      // The first three known seeded items appear, ordered newest-first.
      const indexedAts = body.items
        .filter((i: any) => i.path.startsWith("/Knowledge/"))
        .map((i: any) => new Date(i.indexedAt).getTime());
      const sorted = [...indexedAts].sort((a, b) => b - a);
      expect(indexedAts).toEqual(sorted);

      const sample = body.items.find(
        (i: any) => i.path === "/Knowledge/alpha.txt"
      );
      expect(sample).toBeTruthy();
      expect(sample.snippet).toContain("Alpha");
      expect(typeof sample.id).toBe("string");
      expect(typeof sample.indexedAt).toBe("string");
    });

    it("GET /api/files/knowledge/recent honours ?limit", async () => {
      const { status, body } = await fetchJson(
        `${API_URL}/api/files/knowledge/recent?limit=2`
      );
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(2);
    });

    it("GET /api/files/knowledge/recent honours ?before cursor", async () => {
      const beforeIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { status, body } = await fetchJson(
        `${API_URL}/api/files/knowledge/recent?before=${encodeURIComponent(
          beforeIso
        )}`
      );
      expect(status).toBe(200);
      // Every returned chunk's indexedAt is strictly older than the cursor.
      for (const item of body.items) {
        expect(new Date(item.indexedAt).getTime()).toBeLessThan(
          new Date(beforeIso).getTime()
        );
      }
    });

    it("GET /api/files/knowledge/search either returns hits or 503 search-not-yet-available", async () => {
      const { status, body } = await fetchJson(
        `${API_URL}/api/files/knowledge/search?q=alpha`
      );
      // Two valid responses depending on whether WARP-202's
      // file-search.service has merged into the running orchestrator.
      if (status === 200) {
        expect(Array.isArray(body.hits)).toBe(true);
        for (const hit of body.hits) {
          expect(hit).toHaveProperty("path");
          expect(hit).toHaveProperty("score");
          expect(hit).toHaveProperty("snippet");
        }
      } else {
        expect(status).toBe(503);
        expect(body.error).toMatch(/search-not-yet-available|unavailable/i);
      }
    });

    it("GET /api/files/knowledge/search rejects q < 2 chars with 400", async () => {
      const { status } = await fetchJson(
        `${API_URL}/api/files/knowledge/search?q=a`
      );
      expect(status).toBe(400);
    });
  }
);
