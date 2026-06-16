/**
 * WARP-287 — end-to-end anchor surfacing.
 *
 * Drops fixture files into Nextcloud's mount, waits for the file-indexer
 * to pick them up, then queries via /api/files/knowledge/search and
 * asserts the citations carry the expected anchor shape per kind.
 *
 * Also asserts that a manually-inserted legacy chunk (metadata without
 * `anchor`) comes back with anchor:null and is not dropped.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const NC_DROP_DIR = process.env.NEXTCLOUD_TEST_DROP_DIR ?? "/tmp/nc-test-drop";

async function waitForChunks(fileName: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`http://localhost:3000/api/files/knowledge/search?q=${encodeURIComponent(fileName)}`);
    if (resp.ok) {
      const body = await resp.json();
      if (Array.isArray(body.hits) && body.hits.length > 0) return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for chunks for ${fileName}`);
}

describe("WARP-287 anchor surfacing — end-to-end", () => {
  beforeAll(() => {
    mkdirSync(NC_DROP_DIR, { recursive: true });
  });

  it("PDF citation carries pdf-page anchor", async () => {
    const pdfPath = join(NC_DROP_DIR, "anchor-test.pdf");
    spawnSync("python3", ["-c", `
from reportlab.pdfgen import canvas
c = canvas.Canvas("${pdfPath}")
c.drawString(72, 720, "first page content")
c.showPage()
c.drawString(72, 720, "anchor target text")
c.showPage()
c.drawString(72, 720, "third page content")
c.showPage()
c.save()
`], { stdio: "inherit" });

    await waitForChunks("anchor-test.pdf");

    const resp = await fetch(`http://localhost:3000/api/files/knowledge/search?q=anchor+target+text`);
    const body = await resp.json();
    const hit = body.hits.find((h: any) => h.path?.includes("anchor-test.pdf"));
    expect(hit).toBeDefined();
    expect(hit.anchor).toEqual({ kind: "pdf-page", page: 2 });
  }, 120_000);

  it("legacy chunk (metadata without anchor) comes back with anchor:null", async () => {
    // Insert a legacy chunk directly via psql exec.
    spawnSync("docker", [
      "compose",
      "-f", "docker/docker-compose.yml",
      "-f", "docker/docker-compose.test.override.yml",
      "exec", "-T", "db",
      "psql", "-U", "postgres", "-d", "droplet",
      "-c",
      `INSERT INTO "FileContentChunk" ("ncFileId", "chunkIdx", "userId", path, source, "chunkText", "embeddingF32", metadata, "pageNumber", "brainItemId")
       VALUES ('legacy-test-1', 0, 'u-test', '/legacy.txt', 'brain', 'legacy chunk text', '[0,0,0]'::vector(3), '{}'::jsonb, NULL, 'bi-legacy-1');`,
    ], { stdio: "inherit" });

    const resp = await fetch(`http://localhost:3000/api/files/knowledge/search?q=legacy+chunk+text`);
    const body = await resp.json();
    const hit = body.hits.find((h: any) => h.path === "/legacy.txt");
    expect(hit).toBeDefined();
    expect(hit.anchor).toBeNull();
  });
});
