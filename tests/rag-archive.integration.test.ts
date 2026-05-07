/**
 * RAG archive extraction — live integration test against the Compose stack
 * (WARP-200).
 *
 * Drops `simple.zip` into the watched Nextcloud data dir, triggers a
 * filecache scan, and polls the orchestrator DB for FileContentChunk rows
 * matching the fixture. Asserts that:
 *   - The archive's text member ("the budget for q4 is one hundred thousand")
 *     bled through into chunked text.
 *   - The "--- Member: note.txt ---" separator survived chunking, so an
 *     operator looking at retrieved chunks can see which archive member
 *     a span came from.
 *
 * Same Compose + filecache pattern as `rag-extractors.integration.test.ts`
 * — see that file for the architectural rationale.
 *
 * Skip behavior: requires `RUN_RAG_INTEGRATION=1`. Without it the suite
 * skips so PR-time CI stays fast. Run locally:
 *
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker nextcloud ai-gateway file-indexer
 *   RUN_RAG_INTEGRATION=1 npx vitest run tests/rag-archive.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const COMPOSE = `docker compose -f ${REPO_ROOT}/docker/docker-compose.yml`;
const NC_DATA_DIR = "/var/www/html/data/admin/files";
const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function shSilent(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Run a query in the orchestrator DB via `docker exec` on the `db` container. */
function dbQuery(sql: string): string {
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

/**
 * Drop a fixture into Nextcloud's admin user dir + scan, returning when the
 * file is visible to the watcher.
 */
function dropFixtureAndScan(fixtureRel: string, ncSubdir: string): void {
  const fixtureAbs = resolve(REPO_ROOT, fixtureRel);
  sh(`${COMPOSE} exec -T nextcloud mkdir -p ${NC_DATA_DIR}/${ncSubdir}`);
  sh(
    `${COMPOSE} exec -T nextcloud chown www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`,
  );
  sh(`${COMPOSE} cp ${fixtureAbs} nextcloud:${NC_DATA_DIR}/${ncSubdir}/`);
  sh(
    `${COMPOSE} exec -T nextcloud chown -R www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`,
  );
  sh(
    `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/${ncSubdir} --quiet`,
  );
}

async function pollForChunks(
  pathLike: string,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT "text" FROM "FileContentChunk" WHERE "path" LIKE '${pathLike}'`,
    );
    if (out && out.length > 0) return out;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

describe.skipIf(!SHOULD_RUN)(
  "WARP-200 archive extraction — live integration",
  () => {
    beforeAll(() => {
      sh(
        `${COMPOSE} up -d db cache broker nextcloud ai-gateway file-indexer`,
      );
      const dbDeadline = Date.now() + 60_000;
      while (Date.now() < dbDeadline) {
        try {
          dbQuery("SELECT 1");
          break;
        } catch {
          execSync("sleep 1");
        }
      }
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
    }, 300_000);

    afterAll(() => {
      try {
        sh(
          `${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/test-rag-zip`,
        );
      } catch {
        /* swallow */
      }
    });

    it("indexes member files of a zip and emits the member separator", async () => {
      dropFixtureAndScan(
        "services/file-indexer/tests/fixtures/simple.zip",
        "test-rag-zip",
      );
      const text = await pollForChunks("%test-rag-zip/simple.zip");
      expect(text.length).toBeGreaterThan(0);
      // Member text bleeds through (note.txt body was the budget sentence).
      expect(text).toContain("one hundred thousand");
      // Member separator survives chunking — operator can see provenance.
      expect(text).toContain("--- Member: note.txt ---");
    }, 240_000);
  },
);
