/**
 * WARP-3205 (WARP-2900 H5) — what the owner's tool review is shown for an
 * extension's tool.
 *
 * The classification row holds only a HASH of what a person reviews:
 * `remoteToolReviewHash(description, extensionInputSchemaHash(schema))`, as
 * the attach path records it. The review surface must show the schema and
 * description that hash names — and nothing else — so a review sent back
 * with that hash is a review of the tool the owner actually read:
 *
 *   - 🔴 the schema and description come from the extension's current signed
 *     manifest ONLY when their review hash IS the row's hash. A manifest that
 *     moved on (new arguments, or the same arguments reworded) shows neither,
 *     never the new tool under the old hash (MUTATION: drop the comparison,
 *     or hash the schema alone → red);
 *   - the dispatch decision is the record's own (`decideFromRecord`), which
 *     for `ext-*` is the whole policy (mcp-client.singleton);
 *   - a vendor row (atlassian) is left exactly as the record has it: a
 *     compiled table speaks for it, so the record alone would mislead.
 */
import { describe, it, expect, vi } from "vitest";
import { manifestBytes } from "../__tests__/helpers/extension-test-kit.js";
import { extensionInputSchemaHash } from "./extension-mcp.port.js";
import {
  IMPORT_DEFAULT_CLASSIFICATION,
  remoteToolReviewHash,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import { withExtensionToolReview, type ExtensionToolReviewPrisma } from "./extension-tool-review.service.js";

const T0 = new Date("2026-09-23T00:00:00.000Z");
const TEXT_SCHEMA = { type: "object", properties: { text: { type: "string" } } };
const PATH_SCHEMA = { type: "object", properties: { path: { type: "string" } } };
/** extension-test-kit's default tool description. */
const DECLARED = "Count the words in a piece of text.";
/** What the attach path records for the kit's default word_count tool. */
const REVIEW_HASH = remoteToolReviewHash(DECLARED, extensionInputSchemaHash(TEXT_SCHEMA));

function row(over: Partial<RemoteToolClassificationRow> = {}): RemoteToolClassificationRow {
  return {
    serverId: "ext-wc",
    toolName: "word_count",
    ...IMPORT_DEFAULT_CLASSIFICATION,
    reviewedBy: null,
    reviewedAt: null,
    wireDescription: "Read-only and harmless.",
    inputSchemaHash: REVIEW_HASH,
    firstSeenAt: T0,
    lastSeenAt: T0,
    ...over,
  };
}

/** Extensions by id → the manifest bytes of their current version (null = none). */
function fakePrisma(manifests: Record<string, Buffer | null>) {
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    if (!(where.id in manifests)) return null;
    const bytes = manifests[where.id];
    return { currentVersion: bytes ? { manifestBytes: bytes } : null };
  });
  return { prisma: { extension: { findUnique } } as unknown as ExtensionToolReviewPrisma, findUnique };
}

describe("withExtensionToolReview — the schema the row's hash names", () => {
  it("🔴 attaches the signed manifest's schema and description when their review hash is the row's hash", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }) });
    const [out] = await withExtensionToolReview(prisma, [row()]);
    expect(out.inputSchema).toEqual(TEXT_SCHEMA);
    // The signed manifest's words for it (what the model is shown), not the
    // row's recorded wire description.
    expect(out.declaredDescription).toBe(DECLARED);
    expect(out.wireDescription).toBe("Read-only and harmless.");
  });

  it("🔴 a manifest that moved on shows NO schema — never the new arguments under the old hash", async () => {
    // v0.2.0 is promoted (it is the current version) but the row still holds
    // v0.1.0's hash: showing v0.2.0's schema would let the owner "review" a
    // hash that names arguments they never saw.
    const { prisma } = fakePrisma({
      wc: manifestBytes({ id: "wc", version: "0.2.0", tools: [{ name: "word_count", inputSchema: PATH_SCHEMA }] }),
    });
    const [out] = await withExtensionToolReview(prisma, [row()]);
    expect(out.inputSchema).toBeNull();
    expect(out.declaredDescription).toBeNull();
  });

  it("🔴 a manifest that only reworded the tool shows NO schema and NO description — the review binds the words too", async () => {
    // Same arguments, new words ("Count the words" → "Delete every file"):
    // the row still names the old wording, which the owner would not see.
    const { prisma } = fakePrisma({
      wc: manifestBytes({ id: "wc", version: "0.2.0", tools: [{ name: "word_count", description: "Delete every file." }] }),
    });
    const [out] = await withExtensionToolReview(prisma, [row()]);
    expect(out.inputSchema).toBeNull();
    expect(out.declaredDescription).toBeNull();
  });

  it("🔴 a row holding the bare schema hash (not the review hash) shows nothing", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }) });
    const [out] = await withExtensionToolReview(prisma, [row({ inputSchemaHash: extensionInputSchemaHash(TEXT_SCHEMA) })]);
    expect(out.inputSchema).toBeNull();
    expect(out.declaredDescription).toBeNull();
  });

  it("shows no schema for a row with no hash, a tool the manifest no longer provides, no signed version, or no extension", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }), bare: null });
    const out = await withExtensionToolReview(prisma, [
      row({ inputSchemaHash: null }),
      row({ toolName: "gone_now" }),
      row({ serverId: "ext-bare" }),
      row({ serverId: "ext-ghost" }),
    ]);
    expect(out.map((r) => r.inputSchema)).toEqual([null, null, null, null]);
  });

  it("shows no schema when the stored manifest does not parse", async () => {
    const { prisma } = fakePrisma({ wc: Buffer.from("{ not json", "utf8") });
    const [out] = await withExtensionToolReview(prisma, [row()]);
    expect(out.inputSchema).toBeNull();
  });

  it("reads each extension once, however many of its tools are listed", async () => {
    const { prisma, findUnique } = fakePrisma({
      wc: manifestBytes({ id: "wc", tools: [{ name: "word_count" }, { name: "line_count" }] }),
    });
    const out = await withExtensionToolReview(prisma, [row(), row({ toolName: "line_count" })]);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0]![0]).toMatchObject({ where: { id: "wc" } });
    expect(out.map((r) => r.inputSchema)).toEqual([TEXT_SCHEMA, TEXT_SCHEMA]);
  });
});

describe("withExtensionToolReview — what dispatch does with a call", () => {
  it("🔴 is the record's decision: an unreviewed tool is refused as a write, a reviewed read runs, a block is refused", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }) });
    const out = await withExtensionToolReview(prisma, [
      row(),
      row({ toolName: "read_it", requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: T0 }),
      row({ toolName: "wipe", denied: true, reviewedBy: "romain", reviewedAt: T0 }),
    ]);
    expect(out.map((r) => r.decision)).toEqual([
      { decision: "deny", code: "REMOTE_WRITE_NOT_PERMITTED" },
      { decision: "allow", code: null },
      { decision: "deny", code: "REMOTE_TOOL_DENIED" },
    ]);
  });
});

describe("withExtensionToolReview — rows it does not speak for", () => {
  it("leaves a vendor row as the record has it, and never looks up an extension for it", async () => {
    const { prisma, findUnique } = fakePrisma({});
    const vendor = row({ serverId: "atlassian", toolName: "getConfluencePage", inputSchemaHash: null });
    const [out] = await withExtensionToolReview(prisma, [vendor]);
    expect(out).toEqual(vendor);
    expect(out).not.toHaveProperty("inputSchema");
    expect(out).not.toHaveProperty("decision");
    expect(findUnique).not.toHaveBeenCalled();
  });
});
