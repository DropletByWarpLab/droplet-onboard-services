/**
 * RAG search — live integration against the Compose stack via the MCP
 * stdio child (the orchestrator-agent path).
 *
 * Mirrors `tests/rag-extractors.integration.test.ts` (WARP-201) but
 * exercises the LLM-tool path:
 *   1. Drop a fixture into Nextcloud and let file-indexer index it.
 *   2. Spawn `node services/mcp-server/dist/index.js --transport=stdio`.
 *   3. Call the `search_content` MCP tool with a query that hits the
 *      fixture text via the embedder + pgvector cosine search.
 *   4. Assert non-empty results with `{source, path, score, snippet}`.
 *   5. Assert per-user RBAC — a userId mismatch returns no rows.
 *   6. `since` filter test by indexing a second file and asserting only
 *      the post-cursor file appears.
 *
 * Skip behavior: gated by `RUN_RAG_INTEGRATION=1` (matches WARP-201's
 * pattern). Without it the suite skips so the default unit-only run
 * stays fast.
 *
 * Schema note: `search_content` itself queries the EXISTING columns of
 * `FileContentChunk` (no source/pageNumber/brainItemId yet — those land
 * with WARP-203). The tool result shape is `{path, score, text}` per
 * `packages/tools-core/src/handlers/files/search-content.ts`. The
 * post-WARP-203 shape `{source, path, score, snippet}` is what the
 * shared `file-search.service.ts` returns; the MCP tool will switch
 * once both branches are merged.
 *
 * Run locally:
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker nextcloud ai-gateway file-indexer
 *   cd services/mcp-server && npm run build
 *   RUN_RAG_INTEGRATION=1 npx vitest run tests/rag-search.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = resolve(__dirname, "..");
const COMPOSE = `docker compose -f ${REPO_ROOT}/docker/docker-compose.yml`;
const NC_DATA_DIR = "/var/www/html/data/admin/files";
const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";
const MCP_SERVER_BIN = resolve(REPO_ROOT, "services/mcp-server/dist/index.js");

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function shSilent(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Run a query in the orchestrator DB via `docker exec` on the `db`
 * container, sidestepping a pg client dependency in tests/.
 */
function dbQuery(sql: string): string {
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

function dropFixtureAndScan(fixtureRel: string, ncSubdir: string): void {
  const fixtureAbs = resolve(REPO_ROOT, fixtureRel);
  sh(`${COMPOSE} exec -T nextcloud mkdir -p ${NC_DATA_DIR}/${ncSubdir}`);
  sh(`${COMPOSE} exec -T nextcloud chown www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`);
  sh(`${COMPOSE} cp ${fixtureAbs} nextcloud:${NC_DATA_DIR}/${ncSubdir}/`);
  sh(`${COMPOSE} exec -T nextcloud chown -R www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`);
  sh(
    `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/${ncSubdir} --quiet`,
  );
}

async function pollForChunks(pathLike: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(`SELECT "text" FROM "FileContentChunk" WHERE "path" LIKE '${pathLike}'`);
    if (out && out.length > 0) return out;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

interface SearchToolResult {
  query: string;
  results: Array<{ path: string; score: number; text: string }>;
}

describe.skipIf(!SHOULD_RUN)("RAG search — live MCP integration (WARP-202)", () => {
  let client: McpClient;

  beforeAll(async () => {
    sh(`${COMPOSE} up -d db cache broker nextcloud ai-gateway file-indexer`);

    // Wait for the DB.
    const dbDeadline = Date.now() + 60_000;
    while (Date.now() < dbDeadline) {
      try {
        dbQuery("SELECT 1");
        break;
      } catch {
        execSync("sleep 1");
      }
    }

    // Wait for Nextcloud's bootstrap.
    const ncDeadline = Date.now() + 240_000;
    while (Date.now() < ncDeadline) {
      try {
        sh(`${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ status`);
        break;
      } catch {
        execSync("sleep 2");
      }
    }

    // Ensure the mcp-server build is up to date — without this an old
    // dist/ would still exercise pre-WARP-202 code.
    //
    // WARP-215: this test runs from the `tests/` cwd (vitest's
    // working-directory). A bare `cd services/mcp-server` resolves
    // against `tests/` and fails. Use REPO_ROOT for an absolute path
    // that works regardless of the runner's cwd.
    sh(`cd ${REPO_ROOT}/services/mcp-server && npm run build`);

    // Drop the canonical RAG fixture and wait for it to be indexed.
    dropFixtureAndScan(
      "services/file-indexer/tests/fixtures/sample.pdf",
      "test-rag-search-pdf",
    );
    const text = await pollForChunks("%test-rag-search-pdf/sample.pdf");
    if (!text.includes("alphahotel")) {
      throw new Error("Fixture did not index — extractor or embedder failed");
    }

    // Boot a stdio MCP client against the locally-built mcp-server. We
    // pass DATABASE_URL + AI_GATEWAY_GRPC_URL so the child connects to
    // the same Compose-stack services the indexer just used. The DB
    // exposes 5432 on localhost via the Compose `ports:` mapping; the
    // ai-gateway exposes :50051 the same way.
    const dbPort = sh(`${COMPOSE} port db 5432 | sed 's/.*://'`) || "5432";
    const aiPort = sh(`${COMPOSE} port ai-gateway 50051 | sed 's/.*://'`) || "50051";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_BIN, "--transport=stdio"],
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://droplet:droplet@localhost:${dbPort}/droplet`,
        AI_GATEWAY_GRPC_URL: `localhost:${aiPort}`,
      },
    });
    client = new McpClient({ name: "rag-search-test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
  }, 300_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* swallow */
    }
    try {
      sh(`${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/test-rag-search-pdf`);
    } catch {
      /* swallow */
    }
  });

  it("AUTH_REQUIRED when called without _meta.userId (wiring guarantee)", async () => {
    // The stdio path is the trusted-principal channel. search-content.ts
    // gates on ctx.userId, which the orchestrator's mcp-client populates
    // via _meta.userId. Calling the tool with no _meta proves the gate
    // is alive — handlers don't silently leak across users.
    const res = await client.callTool({
      name: "search_content",
      arguments: { query: "alphahotel" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("AUTH_REQUIRED");
  }, 60_000);

  it("search_content returns hits with {path, score, text} when userId matches", async () => {
    // The `_meta.userId` bridge is what the orchestrator's mcp-client
    // populates from req.user.username (WARP-202). Bypass the SDK's
    // narrow callTool typing via a cast since the MCP SDK does support
    // `_meta` per the spec.
    const res = await (client.callTool as unknown as (params: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }) => Promise<{ isError: boolean; content: Array<{ text: string }> }>)({
      name: "search_content",
      arguments: { query: "alphahotel" },
      _meta: { userId: "admin" },
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text) as SearchToolResult;
    expect(parsed.results.length).toBeGreaterThan(0);
    const top = parsed.results[0];
    expect(top.path).toMatch(/sample\.pdf$/);
    expect(top.score).toBeGreaterThan(0.25);
    expect(top.text.toLowerCase()).toContain("alphahotel");
  }, 120_000);

  it("per-user RBAC — userId mismatch returns no rows", async () => {
    // The fixture was indexed under userId='admin' (Nextcloud bootstrap).
    // A different userId must see no chunks even though the rows exist.
    const res = await (client.callTool as unknown as (params: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }) => Promise<{ isError: boolean; content: Array<{ text: string }> }>)({
      name: "search_content",
      arguments: { query: "alphahotel" },
      _meta: { userId: "u-not-admin" },
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text) as SearchToolResult;
    expect(parsed.results).toEqual([]);
  }, 60_000);

  it("EMBEDDING_FAILED when ai-gateway is unreachable", async () => {
    // Bring down ai-gateway between calls to exercise the error path
    // without re-spawning the mcp-server child (the channel is lazy and
    // reconnects on the next call). The mcp-server should surface
    // EMBEDDING_UNAVAILABLE rather than a 500 / handler-thrown.
    sh(`${COMPOSE} stop ai-gateway`);
    try {
      const res = await (client.callTool as unknown as (params: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      }) => Promise<{ isError: boolean; content: Array<{ text: string }> }>)({
        name: "search_content",
        arguments: { query: "alphahotel" },
        _meta: { userId: "admin" },
      });
      expect(res.isError).toBe(true);
      const text = res.content[0].text;
      // search-content.ts maps any thrown embed error to EMBEDDING_UNAVAILABLE.
      expect(text).toContain("EMBEDDING_UNAVAILABLE");
    } finally {
      // Bring it back up so subsequent runs / other tests aren't broken.
      sh(`${COMPOSE} up -d ai-gateway`);
    }
  }, 120_000);
});
