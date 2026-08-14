/**
 * WARP-2008 — the six write tools that declared `requiresConfirmation: true`
 * and had NO gate at either layer.
 *
 * Strictly worse than the self-attestation WARP-2002 fixed: those at least
 * forced a second model turn and surfaced a chip a human could see. These
 * executed the side effect on the first model-emitted call — real outbound
 * mail, a device joined to the fabric, project writes.
 *
 * The load-bearing assertion in every first-call case is that the STUBBED
 * TRANSPORT recorded zero calls. Asserting only on the returned status passes
 * even if the side effect already fired and the handler merely reported a
 * confirmation afterwards.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import emailSend from "../../src/handlers/email/send.js";
import commissionDevice from "../../src/handlers/smart-home/commission-device.js";
import pmCreate from "../../src/handlers/pm/create-work-item.js";
import pmUpdate from "../../src/handlers/pm/update-work-item.js";
import pmTransition from "../../src/handlers/pm/transition-work-item.js";
import pmComment from "../../src/handlers/pm/add-work-item-comment.js";
import { __resetToolConfirmations } from "../../src/confirmation.js";
import type { Tool, ToolContext } from "../../src/types.js";

beforeEach(() => {
  __resetToolConfirmations();
});

/** Pull the minted token off a first-call confirmation prompt. */
function tokenOf(res: Awaited<ReturnType<Tool["handler"]>>): string {
  if (res.ok) throw new Error("expected confirmation_required");
  const details = res.error.details as { confirmationToken?: string } | undefined;
  if (typeof details?.confirmationToken !== "string") {
    throw new Error("first call minted no confirmation token");
  }
  return details.confirmationToken;
}

/* -------------------------------------------------------------------------- */
/* email_send                                                                 */
/* -------------------------------------------------------------------------- */

const DRAFT = {
  id: "draft-1",
  status: "draft",
  subject: "Q3 invoice",
  toAddrs: ["ana@example.com", "bo@example.com"],
  ccAddrs: ["cc@example.com"],
  bccAddrs: [],
};

function emailCtx(post: ReturnType<typeof vi.fn>): ToolContext {
  const get = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(DRAFT), { status: 200 }));
  return {
    http: {
      orchestrator: { get, post, patch: vi.fn(), delete: vi.fn() },
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    role: "owner",
    userId: "alice",
    signal: new AbortController().signal,
  } as ToolContext;
}

describe("email_send", () => {
  it("first call sends NO mail and names every recipient", async () => {
    const post = vi.fn();
    const res = await emailSend.handler({ draftId: "draft-1" }, emailCtx(post));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("confirmation_required");
      // AC: the prompt names every address the draft will go to. "send draft
      // cl9x…" is not a confirmation.
      expect(res.error.message).toContain("ana@example.com");
      expect(res.error.message).toContain("bo@example.com");
      expect(res.error.message).toContain("cc@example.com");
      expect(res.error.message).toContain("Q3 invoice");
    }
    // The load-bearing assertion: nothing was dispatched.
    expect(post).not.toHaveBeenCalled();
  });

  it("executes exactly once with a valid token", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "draft-1", status: "queued" }), { status: 200 }),
    );
    const ctx = emailCtx(post);
    const token = tokenOf(await emailSend.handler({ draftId: "draft-1" }, ctx));

    const res = await emailSend.handler(
      { draftId: "draft-1", confirmation_token: token },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/api/email/drafts/draft-1/send",
      {},
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it("refuses a token minted for a DIFFERENT draft", async () => {
    const post = vi.fn();
    const ctx = emailCtx(post);
    const token = tokenOf(await emailSend.handler({ draftId: "draft-1" }, ctx));
    const res = await emailSend.handler(
      { draftId: "draft-2", confirmation_token: token },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a fabricated token", async () => {
    const post = vi.fn();
    const res = await emailSend.handler(
      { draftId: "draft-1", confirmation_token: "f".repeat(64) },
      emailCtx(post),
    );
    expect(res.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* commission_device                                                          */
/* -------------------------------------------------------------------------- */

const PAIRING_CODE = "MT:Y.K90SO527JA0648G00";

function matterCtx(commission: ReturnType<typeof vi.fn>): ToolContext {
  return {
    matter: {
      listDevices: vi.fn(),
      getDevice: vi.fn(),
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission,
      getAuditLog: vi.fn(),
    },
    prisma: {} as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    signal: new AbortController().signal,
  } as ToolContext;
}

describe("commission_device", () => {
  it("first call pairs NOTHING", async () => {
    const commission = vi.fn();
    const res = await commissionDevice.handler(
      { pairing_code: PAIRING_CODE },
      matterCtx(commission),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe("confirmation_required");
    expect(commission).not.toHaveBeenCalled();
  });

  it("NEVER echoes the pairing code — it is credential material", async () => {
    const res = await commissionDevice.handler(
      { pairing_code: PAIRING_CODE },
      matterCtx(vi.fn()),
    );
    // `error.details` is echoed into the SSE stream and persisted in the chat
    // transcript, so the whole serialized result is scanned — message included.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(PAIRING_CODE);
    // Not even a tail: any 4+ char run of the code is a leak.
    expect(serialized).not.toContain("G00");
    expect(serialized).not.toContain("MT:");
  });

  it("executes exactly once with a valid token", async () => {
    const commission = vi.fn().mockResolvedValue({ nodeId: "42" });
    const ctx = matterCtx(commission);
    const token = tokenOf(
      await commissionDevice.handler({ pairing_code: PAIRING_CODE }, ctx),
    );
    const res = await commissionDevice.handler(
      { pairing_code: PAIRING_CODE, confirmation_token: token },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(commission).toHaveBeenCalledTimes(1);
    expect(commission).toHaveBeenCalledWith(PAIRING_CODE);
  });

  it("refuses a token minted for a DIFFERENT pairing code", async () => {
    const commission = vi.fn();
    const ctx = matterCtx(commission);
    const token = tokenOf(
      await commissionDevice.handler({ pairing_code: PAIRING_CODE }, ctx),
    );
    const res = await commissionDevice.handler(
      { pairing_code: "MT:OTHERCODE00000000000", confirmation_token: token },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(commission).not.toHaveBeenCalled();
  });

  it("no longer claims a dashboard modal that does not exist", async () => {
    expect(commissionDevice.description).not.toMatch(/Tier 2 modal/i);
    expect(commissionDevice.description).not.toMatch(/in the Droplet dashboard/i);
  });
});

/* -------------------------------------------------------------------------- */
/* the four pm_* tools                                                        */
/* -------------------------------------------------------------------------- */

function pmCtx(post: ReturnType<typeof vi.fn>, patch: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      orchestrator: { get: vi.fn(), post, patch, delete: vi.fn() },
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    role: "owner",
    userId: "alice",
    signal: new AbortController().signal,
  } as ToolContext;
}

const PM_CASES: { tool: Tool; args: Record<string, unknown>; label: string }[] = [
  {
    label: "pm_create_work_item",
    tool: pmCreate,
    args: { workspace_slug: "ws", project_id: "p1", name: "Ship it" },
  },
  {
    label: "pm_update_work_item",
    tool: pmUpdate,
    args: { workspace_slug: "ws", project_id: "p1", work_item_id: "wi1", name: "Renamed" },
  },
  {
    label: "pm_transition_work_item",
    tool: pmTransition,
    args: { workspace_slug: "ws", project_id: "p1", work_item_id: "wi1", state_id: "done" },
  },
  {
    label: "pm_add_work_item_comment",
    tool: pmComment,
    args: {
      workspace_slug: "ws",
      project_id: "p1",
      work_item_id: "wi1",
      comment_html: "<p>hi</p>",
    },
  },
];

describe("pm_* write tools", () => {
  for (const { tool, args, label } of PM_CASES) {
    it(`${label}: first call writes NOTHING`, async () => {
      const post = vi.fn();
      const patch = vi.fn();
      const res = await tool.handler(args, pmCtx(post, patch));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe("confirmation_required");
      // Zero downstream calls — the assertion that actually catches a handler
      // which wrote first and confirmed afterwards.
      expect(post).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
    });

    it(`${label}: refuses a fabricated token`, async () => {
      const post = vi.fn();
      const patch = vi.fn();
      const res = await tool.handler(
        { ...args, confirmation_token: "f".repeat(64) },
        pmCtx(post, patch),
      );
      expect(res.ok).toBe(false);
      expect(post).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
    });

    it(`${label}: a token minted for this tool does not work on another`, async () => {
      const ctx = pmCtx(vi.fn(), vi.fn());
      const token = tokenOf(await tool.handler(args, ctx));
      const other = PM_CASES.find((c) => c.tool !== tool);
      if (!other) throw new Error("need a second pm tool");
      const post = vi.fn();
      const patch = vi.fn();
      const res = await other.tool.handler(
        { ...other.args, confirmation_token: token },
        pmCtx(post, patch),
      );
      expect(res.ok).toBe(false);
      expect(post).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
    });
  }
});
