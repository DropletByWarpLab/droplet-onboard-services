/**
 * WARP-3071 — Kev triage shadow mode on brain finding delivery.
 *
 * The contract under test: the flag off means Kev is never asked; the flag on
 * means Kev is asked once per final verdict with the triage questions; and in
 * every case — Kev ok, unavailable, invalid, or the hook throwing — what
 * brain-notify sends and returns is exactly what it is without the hook.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendNotification, logged } = vi.hoisted(() => ({
  sendNotification: vi.fn(async () => ({ id: "n1", channels: ["toast"], delivered: true })),
  logged: [] as Array<{ level: string; obj: Record<string, unknown>; msg: string }>,
}));
vi.mock("../services/notifications.service.js", () => ({ sendNotification }));
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = { warn: push("warn"), debug: push("debug"), info: push("info"), error: push("error") };
  return { createLogger: () => stub, logger: stub };
});

import { notifyFindings } from "../services/brain/brain-notify.service";
import { createTriageShadow, TRIAGE_QUESTIONS, type ShadowItem } from "../services/brain/brain-triage-shadow";
import type { DecideResult } from "../services/decision-model.client";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const TITLE = "Acme is 90 days past due";
const RATIONALE = "An invoice fell due 90 days ago.";

function finding(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    kind: "loss",
    title: TITLE,
    rationale: RATIONALE,
    impactMinor: 4_000_000n,
    currency: "USD",
    firstSeenAt: NOW,
    scope: "company",
    ...over,
  };
}

function db(pending: unknown[], lastDigestAt: string | null = null) {
  return {
    user: { findFirst: vi.fn(async () => ({ id: "u-owner", username: "owner" })) },
    brainFinding: {
      findMany: vi.fn(async () => pending),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: pending.length })),
    },
    systemFlag: {
      findUnique: vi.fn(async () => (lastDigestAt ? { valueJson: { at: lastDigestAt } } : null)),
      upsert: vi.fn(async () => ({})),
    },
  } as never;
}

const OK: DecideResult = {
  status: "ok",
  latencyMs: 812,
  model: "kev",
  answers: { needs_attention_today: { type: "noul", noul: 0.91 } },
};

/** Lets the fire-and-forget shadow run finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** What brain-notify did, in a comparable shape. */
async function runDelivery(pending: unknown[], onTriaged?: (items: ShadowItem[]) => void, lastDigestAt?: string) {
  sendNotification.mockClear();
  const prisma = db(pending, lastDigestAt ?? null) as unknown as {
    brainFinding: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
  const out = await notifyFindings(prisma as never, { now: NOW, onTriaged });
  await settle();
  return {
    out,
    sent: sendNotification.mock.calls.map((c) => (c as unknown[])[1]), // [0] is the per-run fake prisma
    stamped: [...prisma.brainFinding.update.mock.calls],
    stampedMany: [...prisma.brainFinding.updateMany.mock.calls],
  };
}

const MIXED = () => [finding(), finding({ id: "f2", kind: "risk", impactMinor: null, currency: null })];

beforeEach(() => {
  logged.length = 0;
});

describe("brain triage shadow — flag off (WARP-3071)", () => {
  it("returns no hook, so decide is never called and delivery is today's", async () => {
    const decide = vi.fn(async () => OK);
    const hook = createTriageShadow({ enabled: false, decide });
    expect(hook).toBeUndefined();
    await runDelivery(MIXED(), hook);
    expect(decide).not.toHaveBeenCalled();
    expect(logged.filter((l) => l.msg.startsWith("brain.triage_shadow"))).toEqual([]);
  });
});

describe("brain triage shadow — flag on (WARP-3071)", () => {
  it("asks Kev once per final verdict with the triage questions, and delivery is unchanged", async () => {
    const baseline = await runDelivery(MIXED());
    const decide = vi.fn(async () => OK);
    const shadowed = await runDelivery(MIXED(), createTriageShadow({ enabled: true, decide }));

    expect(shadowed).toEqual(baseline);
    expect(decide).toHaveBeenCalledTimes(2);
    for (const [args] of decide.mock.calls as unknown as Array<[{ state: string; questions: unknown }]>) {
      expect(args.questions).toBe(TRIAGE_QUESTIONS);
      expect(args.state).toContain(RATIONALE);
    }
    expect(Object.keys(TRIAGE_QUESTIONS)).toEqual(["needs_attention_today", "urgency", "category"]);

    const lines = logged.filter((l) => l.msg === "brain.triage_shadow");
    expect(lines.map((l) => [l.obj.findingId, l.obj.todayTier, l.obj.status])).toEqual([
      ["f1", "immediate", "ok"],
      ["f2", "digest", "ok"],
    ]);
    expect(lines[0].obj).toMatchObject({ latencyMs: 812, kev: (OK as Extract<DecideResult, { status: "ok" }>).answers });
    // Ids, labels, probabilities — never the finding's text.
    expect(JSON.stringify(lines)).not.toContain(TITLE);
    expect(JSON.stringify(lines)).not.toContain(RATIONALE);
  });

  it("does not ask about a digest finding that is held (no final verdict yet)", async () => {
    const decide = vi.fn(async () => OK);
    const small = finding({ id: "f2", impactMinor: 1n });
    const held = await runDelivery([small], createTriageShadow({ enabled: true, decide }), NOW.toISOString());
    expect(held.out).toEqual({ immediate: 0, digested: 0, digestSent: false });
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "invalid"] as const)(
    "Kev %s: delivery unchanged, one warn line per finding",
    async (status) => {
      const baseline = await runDelivery([finding()]);
      const decide = vi.fn(async (): Promise<DecideResult> => ({ status, detail: "sidecar down" }));
      const shadowed = await runDelivery([finding()], createTriageShadow({ enabled: true, decide }));

      expect(shadowed).toEqual(baseline);
      const lines = logged.filter((l) => l.msg === "brain.triage_shadow");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "warn", obj: { findingId: "f1", todayTier: "immediate", status } });
    },
  );

  it("a decide that throws, or a hook that throws, never changes delivery", async () => {
    const baseline = await runDelivery(MIXED());
    const throwingDecide = vi.fn(async (): Promise<DecideResult> => {
      throw new Error("boom");
    });
    expect(await runDelivery(MIXED(), createTriageShadow({ enabled: true, decide: throwingDecide }))).toEqual(
      baseline,
    );
    expect(await runDelivery(MIXED(), () => {
      throw new Error("hook");
    })).toEqual(baseline);
  });
});
