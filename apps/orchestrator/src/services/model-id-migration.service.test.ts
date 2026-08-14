/**
 * WARP-1749 — the model-id migration: plan, apply, roll back.
 *
 * The acceptance criteria this file exists to lock:
 *   - forward and backward are BOTH idempotent (run each twice, assert the
 *     second run is a no-op — not merely "doesn't crash");
 *   - a lossy forward map still round-trips, because rollback reads the journal
 *     rather than a reversed table (`gemma4:26b` and `gemma4:31b` both become
 *     `ai/gemma4` and must come back as the tier they started as);
 *   - unmapped ids are reported and LEFT ALONE;
 *   - a row somebody edited after the migration is skipped, never clobbered.
 */
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  applyForwardMigration,
  applyRollback,
  collectStoredModelIds,
  planEnvAdvisories,
  planForwardMigration,
  planRollback,
  type StoredModelId,
} from "./model-id-migration.service.js";
import { ACTIVE_CHAT_MODEL_KEY } from "./active-model.service.js";

// ── an in-memory Prisma good enough to exercise the real code paths ──────

interface FakeState {
  setting: { key: string; valueJson: unknown } | null;
  sessions: { id: string; model: string | null }[];
  messages: { id: string; model: string | null }[];
  batches: {
    id: string;
    direction: string;
    state: string;
    revertsBatchId: string | null;
    note: string | null;
    startedAt: Date;
  }[];
  entries: {
    id: string;
    batchId: string;
    site: string;
    rowKey: string;
    column: string;
    beforeValue: string;
    afterValue: string;
  }[];
}

function fakePrisma(initial: Partial<FakeState> = {}): {
  prisma: PrismaClient;
  state: FakeState;
} {
  const state: FakeState = {
    setting: initial.setting ?? null,
    sessions: initial.sessions ?? [],
    messages: initial.messages ?? [],
    batches: [],
    entries: [],
  };
  let seq = 0;
  const nextId = () => `id-${++seq}`;

  // Cursor paging identical in shape to Prisma's, so the bounded page loop in
  // collectChatTable is genuinely exercised rather than stubbed past.
  const pagedFindMany =
    (rows: { id: string; model: string | null }[]) =>
    (args: {
      take: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      const sorted = [...rows]
        .filter((r) => r.model != null)
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = args.cursor
        ? sorted.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0)
        : 0;
      return Promise.resolve(sorted.slice(start, start + args.take));
    };

  const prisma = {
    $transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(prisma)),
    workspaceSetting: {
      findUnique: ({ where }: { where: { key: string } }) =>
        Promise.resolve(state.setting && state.setting.key === where.key ? state.setting : null),
      update: ({ where, data }: { where: { key: string }; data: { valueJson: unknown } }) => {
        if (!state.setting || state.setting.key !== where.key) {
          return Promise.reject(new Error("no such setting"));
        }
        state.setting = { ...state.setting, valueJson: data.valueJson };
        return Promise.resolve(state.setting);
      },
    },
    chatSession: {
      findMany: pagedFindMany(state.sessions),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(state.sessions.find((s) => s.id === where.id) ?? null),
      update: ({ where, data }: { where: { id: string }; data: { model: string } }) => {
        const row = state.sessions.find((s) => s.id === where.id);
        if (!row) return Promise.reject(new Error("no such session"));
        row.model = data.model;
        return Promise.resolve(row);
      },
    },
    chatMessage: {
      findMany: pagedFindMany(state.messages),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(state.messages.find((m) => m.id === where.id) ?? null),
      update: ({ where, data }: { where: { id: string }; data: { model: string } }) => {
        const row = state.messages.find((m) => m.id === where.id);
        if (!row) return Promise.reject(new Error("no such message"));
        row.model = data.model;
        return Promise.resolve(row);
      },
    },
    modelIdMigrationBatch: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const batch = {
          id: nextId(),
          direction: data.direction as string,
          state: data.state as string,
          revertsBatchId: (data.revertsBatchId as string) ?? null,
          note: (data.note as string) ?? null,
          // Monotonic: the fake's clock must order batches deterministically or
          // "the most recent applied forward batch" becomes a coin flip.
          startedAt: new Date(2026, 0, 1, 0, 0, seq),
        };
        state.batches.push(batch);
        return Promise.resolve({ id: batch.id });
      },
      findFirst: ({ where }: { where: { direction: string; state: string } }) => {
        const hits = state.batches
          .filter((b) => b.direction === where.direction && b.state === where.state)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        return Promise.resolve(hits[0] ? { id: hits[0].id } : null);
      },
      update: ({ where, data }: { where: { id: string }; data: { state: string } }) => {
        const batch = state.batches.find((b) => b.id === where.id);
        if (!batch) return Promise.reject(new Error("no such batch"));
        batch.state = data.state;
        return Promise.resolve(batch);
      },
    },
    modelIdMigrationEntry: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const entry = { id: nextId(), ...(data as Record<string, string>) } as FakeState["entries"][number];
        state.entries.push(entry);
        return Promise.resolve(entry);
      },
      findMany: ({ where }: { where: { batchId: string } }) =>
        Promise.resolve(state.entries.filter((e) => e.batchId === where.batchId)),
    },
  } as unknown as PrismaClient;

  return { prisma, state };
}

// ── planning ─────────────────────────────────────────────────────────────

function stored(value: string, site: StoredModelId["site"] = "chat_session"): StoredModelId {
  return {
    site,
    rowKey: `row-${value}`,
    column: site === "workspace_setting" ? "valueJson" : "model",
    value,
  };
}

describe("planForwardMigration", () => {
  it("buckets every class and rewrites only the mapped ones", () => {
    const plan = planForwardMigration([
      stored("gpt-oss:20b"),
      stored("ai/gpt-oss"),
      stored("llava:7b"),
      stored("deepseek-coder-v2:16b"),
      stored(""),
    ]);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ before: "gpt-oss:20b", after: "ai/gpt-oss" });
    expect(plan.alreadyMigrated).toHaveLength(1);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.unknown).toHaveLength(1);
    expect(plan.skipped).toBe(1);
  });

  it("is pure — planning the same input twice gives the same plan", () => {
    const input = [stored("gpt-oss:20b"), stored("qwen2.5:3b-instruct")];
    expect(planForwardMigration(input)).toEqual(planForwardMigration(input));
  });

  it("plans nothing once every value is already OCI (idempotence, at plan level)", () => {
    const plan = planForwardMigration([stored("ai/gpt-oss"), stored("docker.io/ai/gemma4:latest")]);
    expect(plan.changes).toHaveLength(0);
  });
});

describe("planEnvAdvisories", () => {
  it("reports what .env would become, and reports the vision model as blocked", () => {
    const advisories = planEnvAdvisories({
      LLM_MODEL: "gpt-oss:20b",
      VISION_MODEL: "llama3.2-vision:11b",
    } as NodeJS.ProcessEnv);
    expect(advisories).toHaveLength(2);
    expect(advisories[0]!.classification).toMatchObject({ kind: "rewrite", oci: "ai/gpt-oss" });
    expect(advisories[1]!.classification.kind).toBe("blocked");
  });

  it("ignores unset variables rather than inventing an empty advisory", () => {
    expect(planEnvAdvisories({} as NodeJS.ProcessEnv)).toHaveLength(0);
  });
});

// ── collection ───────────────────────────────────────────────────────────

describe("collectStoredModelIds", () => {
  it("reads all three sites and skips null model columns", async () => {
    const { prisma } = fakePrisma({
      setting: { key: ACTIVE_CHAT_MODEL_KEY, valueJson: "Gpt-oss 20B" },
      sessions: [
        { id: "s1", model: "gpt-oss:20b" },
        { id: "s2", model: null },
      ],
      messages: [{ id: "m1", model: "gemma4:26b" }],
    });
    const rows = await collectStoredModelIds(prisma);
    expect(rows.map((r) => r.site).sort()).toEqual([
      "chat_message",
      "chat_session",
      "workspace_setting",
    ]);
    expect(rows.find((r) => r.site === "workspace_setting")!.value).toBe("Gpt-oss 20B");
  });

  it("ignores a non-string valueJson instead of coercing it", async () => {
    const { prisma } = fakePrisma({
      setting: { key: ACTIVE_CHAT_MODEL_KEY, valueJson: { not: "a model id" } },
    });
    expect(await collectStoredModelIds(prisma)).toHaveLength(0);
  });
});

// ── apply / rollback ─────────────────────────────────────────────────────

async function runForward(prisma: PrismaClient, note?: string) {
  const plan = planForwardMigration(await collectStoredModelIds(prisma));
  return applyForwardMigration(prisma, plan, note);
}

describe("applyForwardMigration", () => {
  it("rewrites the mapped rows and journals every one", async () => {
    const { prisma, state } = fakePrisma({
      setting: { key: ACTIVE_CHAT_MODEL_KEY, valueJson: "gpt-oss:20b" },
      sessions: [{ id: "s1", model: "gemma4:26b" }],
      messages: [{ id: "m1", model: "deepseek-coder-v2:16b" }],
    });

    const result = await runForward(prisma, "flip soak");
    expect(result.changed).toBe(2);
    expect(state.setting!.valueJson).toBe("ai/gpt-oss");
    expect(state.sessions[0]!.model).toBe("ai/gemma4");
    // Unmapped survives untouched — the whole point.
    expect(state.messages[0]!.model).toBe("deepseek-coder-v2:16b");
    expect(state.entries).toHaveLength(2);
    expect(state.batches[0]).toMatchObject({ direction: "forward", state: "applied", note: "flip soak" });
  });

  it("is idempotent — a second run writes nothing and records no batch", async () => {
    const { prisma, state } = fakePrisma({
      sessions: [{ id: "s1", model: "gpt-oss:20b" }],
    });
    const first = await runForward(prisma);
    expect(first.changed).toBe(1);

    const second = await runForward(prisma);
    expect(second.changed).toBe(0);
    expect(second.batchId).toBeNull();
    expect(state.batches).toHaveLength(1);
    expect(state.entries).toHaveLength(1);
    expect(state.sessions[0]!.model).toBe("ai/gpt-oss");
  });

  it("records no batch at all when there is nothing to do", async () => {
    const { prisma, state } = fakePrisma({ sessions: [{ id: "s1", model: "mystery:1b" }] });
    const result = await runForward(prisma);
    expect(result).toEqual({ batchId: null, changed: 0 });
    expect(state.batches).toHaveLength(0);
  });
});

describe("applyRollback", () => {
  it("round-trips a LOSSY mapping — both gemma4 tiers return to their own tag", async () => {
    // ai/gemma4 alone cannot say which tier a row held. The journal can.
    const { prisma, state } = fakePrisma({
      sessions: [
        { id: "s26", model: "gemma4:26b" },
        { id: "s31", model: "gemma4:31b" },
      ],
    });
    await runForward(prisma);
    expect(state.sessions.map((s) => s.model)).toEqual(["ai/gemma4", "ai/gemma4"]);

    const result = await applyRollback(prisma, await planRollback(prisma));
    expect(result.restored).toBe(2);
    expect(state.sessions.find((s) => s.id === "s26")!.model).toBe("gemma4:26b");
    expect(state.sessions.find((s) => s.id === "s31")!.model).toBe("gemma4:31b");
  });

  it("is idempotent — a second rollback is a no-op", async () => {
    const { prisma, state } = fakePrisma({ sessions: [{ id: "s1", model: "gpt-oss:20b" }] });
    await runForward(prisma);
    const first = await applyRollback(prisma, await planRollback(prisma));
    expect(first.restored).toBe(1);

    const secondPlan = await planRollback(prisma);
    expect(secondPlan.forwardBatchId).toBeNull();
    const second = await applyRollback(prisma, secondPlan);
    expect(second).toEqual({ batchId: null, restored: 0, skippedDrifted: [] });
    expect(state.sessions[0]!.model).toBe("gpt-oss:20b");
  });

  it("flips the forward batch to the explicit `reverted` state", async () => {
    const { prisma, state } = fakePrisma({ sessions: [{ id: "s1", model: "gpt-oss:20b" }] });
    await runForward(prisma);
    await applyRollback(prisma, await planRollback(prisma));
    const forward = state.batches.find((b) => b.direction === "forward")!;
    expect(forward.state).toBe("reverted");
    const backward = state.batches.find((b) => b.direction === "backward")!;
    expect(backward).toMatchObject({ state: "applied", revertsBatchId: forward.id });
  });

  it("skips — never clobbers — a row somebody changed after the migration", async () => {
    const { prisma, state } = fakePrisma({
      sessions: [
        { id: "s1", model: "gpt-oss:20b" },
        { id: "s2", model: "llama3.2:3b" },
      ],
    });
    await runForward(prisma);
    // Operator re-points s1 by hand after the migration.
    state.sessions.find((s) => s.id === "s1")!.model = "ai/qwen3-vl";

    const result = await applyRollback(prisma, await planRollback(prisma));
    expect(result.restored).toBe(1);
    expect(result.skippedDrifted).toHaveLength(1);
    expect(result.skippedDrifted[0]!.rowKey).toBe("s1");
    // Their edit survives; the untouched row is restored.
    expect(state.sessions.find((s) => s.id === "s1")!.model).toBe("ai/qwen3-vl");
    expect(state.sessions.find((s) => s.id === "s2")!.model).toBe("llama3.2:3b");
  });

  it("re-applying after a rollback works and creates a fresh forward batch", async () => {
    const { prisma, state } = fakePrisma({ sessions: [{ id: "s1", model: "gpt-oss:20b" }] });
    await runForward(prisma);
    await applyRollback(prisma, await planRollback(prisma));
    const again = await runForward(prisma);
    expect(again.changed).toBe(1);
    expect(state.sessions[0]!.model).toBe("ai/gpt-oss");
    expect(state.batches.filter((b) => b.direction === "forward")).toHaveLength(2);
  });
});
