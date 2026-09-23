/**
 * WARP-2897 — the extracted routine-draft service (tool-spec-draft.service.ts).
 *
 * The POST /api/tools route suites (tools.routes, tool-spec-mcp-principal,
 * tool-spec-transform.routes, tool-step-outputs) keep proving the route's
 * behaviour is unchanged. These specs pin what the service adds for slice
 * I-1's seeded drafts: optional runtime tool sets, the explicit draft
 * status, and a slug collision as a refusal rather than a throw.
 */
import { describe, it, expect, vi } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";
import {
  createDraftSpecTx,
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

  it("a slug collision is a 409 refusal, not a throw", async () => {
    const tx = fakeTx(
      vi.fn(async (_args: { data: Record<string, unknown> }) => {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }),
    );
    const out = await createDraftSpecTx(tx as never, input(), "u1");
    expect(out).toEqual({
      ok: false,
      refusal: { status: 409, body: { error: "Slug already in use", slug: "morning-slots" } },
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
