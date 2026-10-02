/**
 * WARP-2897 — the extracted routine-draft service (tool-spec-draft.service.ts).
 *
 * The POST /api/tools route suites (tools.routes, tool-spec-mcp-principal,
 * tool-spec-transform.routes, tool-step-outputs) keep proving the route's
 * behaviour is unchanged. These specs pin what the service adds for slice
 * I-1's seeded drafts: optional runtime tool sets, the explicit draft
 * status, and a slug collision as a TYPED THROW (the transaction is aborted
 * by then, so the caller must unwind rather than carry on).
 */
import { describe, it, expect, vi } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";
import {
  createDraftSpecTx,
  DraftSlugTakenError,
  randomSlugSuffix,
  SLUG_RE,
  suffixedSlug,
  validateDraftSpec,
  type CreateSpecInput,
} from "./tool-spec-draft.service.js";

const READ_TOOL = TOOL_CATALOG.find((t) => !t.requiresWrite)!.name;
const RUNTIME = "bookings__list_slots";

function input(over: Partial<CreateSpecInput> = {}): CreateSpecInput {
  return {
    slug: "morning-slots",
    name: "Morning slots",
    steps: [{ kind: "call", tool: READ_TOOL, args: {} }],
    ...over,
  } as CreateSpecInput;
}

function fakeTx(create = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "s1", ...args.data }))) {
  return { toolSpec: { create } };
}

describe("validateDraftSpec — runtime tool sets", () => {
  const withRuntime = input({
    steps: [
      { kind: "call", tool: READ_TOOL, args: {} },
      { kind: "call", tool: RUNTIME, args: {} },
    ],
  } as Partial<CreateSpecInput>);

  it("with no runtime sets a runtime tool is unknown (the route's compiled-only answer)", () => {
    const out = validateDraftSpec(withRuntime);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal.body).toMatchObject({ error: "unknown_tools", tools: [RUNTIME] });
  });

  /**
   * MUTATION: stop passing `runtime.known` to `unknownToolsIn` -> red.
   */
  it("a runtime tool passed as known is accepted", () => {
    expect(validateDraftSpec(withRuntime, { known: new Set([RUNTIME]) }).ok).toBe(true);
  });

  /**
   * MUTATION: stop passing `runtime.writes` to `writeToolNamesIn` -> red (the
   * draft would claim writes:false while calling an unclassified tool).
   */
  it("an unclassified runtime tool makes the draft a WRITE; a read-classified one does not", () => {
    const unclassified = validateDraftSpec(withRuntime, {
      known: new Set([RUNTIME]),
      writes: new Set([RUNTIME]),
    });
    expect(unclassified).toEqual({ ok: true, writes: true });
    const reviewedRead = validateDraftSpec(withRuntime, { known: new Set([RUNTIME]) });
    expect(reviewedRead).toEqual({ ok: true, writes: false });
  });

  it("writes:false declared over an unclassified runtime tool is refused", () => {
    const out = validateDraftSpec(
      { ...withRuntime, writes: false },
      { known: new Set([RUNTIME]), writes: new Set([RUNTIME]) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal.body).toMatchObject({ writeTools: [RUNTIME] });
  });
});

describe("createDraftSpecTx", () => {
  /**
   * MUTATION: write `status: "live"` -> red.
   */
  it("creates the row as status 'draft', owned by the given User.id", async () => {
    const tx = fakeTx();
    const out = await createDraftSpecTx(tx as never, input(), "user-uuid-1");
    expect(out.ok).toBe(true);
    const data = tx.toolSpec.create.mock.calls[0]![0].data;
    expect(data.status).toBe("draft");
    expect(data.ownerId).toBe("user-uuid-1");
    expect(data.writes).toBe(false);
  });

  /**
   * WARP-3354. MUTATION: write `visibility: "WORKSPACE"` -> red. A routine the
   * assistant drafts for one person must not appear in front of the company.
   */
  it("creates the row PRIVATE — sharing with the Workspace is its own act", async () => {
    const tx = fakeTx();
    await createDraftSpecTx(tx as never, input(), "user-uuid-1");
    expect(tx.toolSpec.create.mock.calls[0]![0].data.visibility).toBe("PRIVATE");
  });

  it("a refused spec creates nothing", async () => {
    const tx = fakeTx();
    const out = await createDraftSpecTx(
      tx as never,
      input({ steps: [{ kind: "call", tool: "not_a_tool", args: {} }] } as Partial<CreateSpecInput>),
      "u1",
    );
    expect(out.ok).toBe(false);
    expect(tx.toolSpec.create).not.toHaveBeenCalled();
  });

  /**
   * On Postgres a unique violation ABORTS an interactive transaction: any
   * further statement fails with 25P02, and returning normally from the
   * `$transaction` callback turns the commit into a silent ROLLBACK. So a
   * collision must not come back as an ordinary `{ok:false}` a multi-draft
   * caller (slice I-1) could "handle" and carry on from. It throws a typed
   * error that carries the 409 body; the route maps it, a transaction
   * unwinds.
   *
   * MUTATION: return the refusal instead of throwing -> red.
   */
  it("a slug collision throws DraftSlugTakenError carrying the 409 body", async () => {
    const tx = fakeTx(
      vi.fn(async (_args: { data: Record<string, unknown> }) => {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }),
    );
    const err = await createDraftSpecTx(tx as never, input(), "u1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftSlugTakenError);
    expect((err as DraftSlugTakenError).refusal).toEqual({
      status: 409,
      body: { error: "Slug already in use", slug: "morning-slots" },
    });
  });

  it("any other failure propagates (the caller's transaction rolls back)", async () => {
    const tx = fakeTx(
      vi.fn(async (_args: { data: Record<string, unknown> }) => {
        throw new Error("db down");
      }),
    );
    await expect(createDraftSpecTx(tx as never, input(), "u1")).rejects.toThrow("db down");
  });
});

/** WARP-3354 — a member's new routine is stored as `<slug>-<random>`. */
describe("suffixedSlug / randomSlugSuffix", () => {
  it("appends -<suffix>", () => {
    expect(suffixedSlug("q3-export", "7f3a")).toBe("q3-export-7f3a");
  });

  it("randomSlugSuffix is 4 lowercase hex chars and varies", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomSlugSuffix()));
    for (const v of seen) expect(v).toMatch(/^[0-9a-f]{4}$/);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("stays inside the 80-char cap and never leaves a double or trailing hyphen", () => {
    const out = suffixedSlug("a".repeat(80), "7f3a");
    expect(out).toHaveLength(80);
    expect(out.endsWith("-7f3a")).toBe(true);
    // The trim lands right after a hyphen: `aaa…a-bc` cut at 75 ends on `-`.
    const edge = "a".repeat(74) + "-bcdef";
    const trimmed = suffixedSlug(edge, "7f3a");
    expect(trimmed).toBe("a".repeat(74) + "-7f3a");
    for (const slug of [out, trimmed, suffixedSlug("ab", "7f3a")]) {
      expect(slug).toMatch(SLUG_RE);
      expect(slug.length).toBeLessThanOrEqual(80);
    }
  });
});
