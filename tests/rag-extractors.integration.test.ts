/**
 * RAG extractors — live integration test against the Compose stack.
 *
 * Boots the relevant services (db, cache, broker, nextcloud, ai-gateway,
 * file-indexer), drops each fixture into the watched Nextcloud data dir,
 * triggers a Nextcloud filecache scan, then polls the `FileContentChunk`
 * table for rows matching the fixture. Asserts the extracted text contains
 * the expected snippet for each MIME family.
 *
 * Architectural note: the file-indexer watches `/data/nextcloud/data` (the
 * `nextcloud-data` Docker volume bind-mounted read-only). It only writes
 * chunks for files that have a corresponding `oc_filecache` row in the
 * Nextcloud DB — that's how it resolves an `ncFileId`. So the test:
 *   1. `docker cp` the fixture into nextcloud:/var/www/html/data/admin/files/
 *   2. `docker exec nextcloud occ files:scan admin` to populate filecache
 *   3. Poll the orchestrator DB for chunks
 *
 * Skip behavior: this test requires `RUN_RAG_INTEGRATION=1`. Without it the
 * suite skips so unit-only test runs (the default for CI on PRs that don't
 * touch RAG) stay fast. Set on a real device or in the path-filtered
 * GitHub Actions workflow added by WARP-206.
 *
 * Run locally:
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker nextcloud ai-gateway file-indexer
 *   RUN_RAG_INTEGRATION=1 npx vitest run tests/rag-extractors.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { COMPOSE } from "./helpers/rag-retrieval";

const REPO_ROOT = resolve(__dirname, "..");
const NC_DATA_DIR = "/var/www/html/data/admin/files";
const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function shSilent(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Run a query in the orchestrator DB via `docker exec` on the `db` container,
 * sidestepping the need for a `pg` client dependency in tests/package.json.
 */
function dbQuery(sql: string): string {
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

/**
 * Drop a fixture into Nextcloud's admin user dir + scan, returning when the
 * file is visible to the watcher. Throws on non-zero exit from any step.
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
  // Populate oc_filecache so the indexer can resolve an ncFileId.
  sh(
    `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/${ncSubdir} --quiet`,
  );
}

async function pollForChunks(pathLike: string, timeoutMs = 90_000): Promise<string> {
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

describe.skipIf(!SHOULD_RUN)("RAG extractors — live integration", () => {
  beforeAll(() => {
    sh(
      `${COMPOSE} up -d db cache broker nextcloud ai-gateway file-indexer`,
    );
    // Wait for the orchestrator DB to be reachable.
    const dbDeadline = Date.now() + 60_000;
    while (Date.now() < dbDeadline) {
      try {
        dbQuery("SELECT 1");
        break;
      } catch {
        execSync("sleep 1");
      }
    }
    // Wait for Nextcloud's bootstrap to finish (the `occ` binary needs to exist
    // and the admin user must be installed). The container's healthcheck handles
    // most of this; we additionally probe `occ status`.
    const ncDeadline = Date.now() + 240_000;
    while (Date.now() < ncDeadline) {
      try {
        sh(`${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ status`);
        break;
      } catch {
        execSync("sleep 2");
      }
    }
  }, 300_000);

  afterAll(() => {
    // Best-effort cleanup of the fixtures we dropped.
    try {
      sh(
        `${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/test-rag-pdf ${NC_DATA_DIR}/test-rag-docx ${NC_DATA_DIR}/test-rag-png ${NC_DATA_DIR}/test-rag-txt`,
      );
    } catch {
      /* swallow */
    }
  });

  it("indexes a PDF and produces FileContentChunk rows", async () => {
    dropFixtureAndScan(
      "services/file-indexer/tests/fixtures/sample.pdf",
      "test-rag-pdf",
    );
    const text = await pollForChunks("%test-rag-pdf/sample.pdf");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("Hello from page one");
    expect(text).toContain("alphahotel");
  }, 180_000);

  it("indexes a DOCX and produces FileContentChunk rows", async () => {
    dropFixtureAndScan(
      "services/file-indexer/tests/fixtures/sample.docx",
      "test-rag-docx",
    );
    const text = await pollForChunks("%test-rag-docx/sample.docx");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("bravoindigo");
  }, 180_000);

  it("indexes an image (OCR) and produces FileContentChunk rows", async () => {
    dropFixtureAndScan(
      "services/file-indexer/tests/fixtures/sample.png",
      "test-rag-png",
    );
    const text = await pollForChunks("%test-rag-png/sample.png");
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("echofoxtrot");
  }, 180_000);

  it("indexes a plain text file and produces FileContentChunk rows", async () => {
    // Plain-text doesn't ship as a fixture; create one ad-hoc.
    const txt = "deltaecho is a unique token used by the integration test.";
    sh(
      `${COMPOSE} exec -T nextcloud bash -lc 'mkdir -p ${NC_DATA_DIR}/test-rag-txt && printf "%s" ${JSON.stringify(txt)} > ${NC_DATA_DIR}/test-rag-txt/sample.txt && chown -R www-data:www-data ${NC_DATA_DIR}/test-rag-txt'`,
    );
    sh(
      `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/test-rag-txt --quiet`,
    );
    const text = await pollForChunks("%test-rag-txt/sample.txt");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("deltaecho");
  }, 180_000);
});
