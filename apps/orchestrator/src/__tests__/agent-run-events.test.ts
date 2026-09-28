/**
 * WARP-3301 — live background-run events: topic, payload, queue position and
 * what a run waits for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { published } = vi.hoisted(() => ({
  published: [] as Array<{ topic: string; payload: Record<string, unknown> }>,
}));
vi.mock("../services/mqtt.service.js", () => ({
  publish: (topic: string, payload: Record<string, unknown>) => published.push({ topic, payload }),
}));

import {
  AGENT_RUN_EVENTS_TOPIC,
  noteAgentRunTool,
  publishAgentRunEvent,
  queuePositions,
  waitingForOf,
} from "../services/agent-run-events.service.js";

interface Row {
  id: string;
  userId: string;
  sessionId: string | null;
  status: string;
  iteration: number;
  maxIter: number;
  title: string;
  summary: string | null;
  queueWait: string;
  runAfter: Date;
  createdAt: Date;
}

function fakePrisma(rows: Row[], users: Record<string, string> = { u1: "alice" }) {
  return {
    agentRun: {
      count: async ({ where }: { where: { status: string } }) => rows.filter((r) => r.status === where.status).length,
      findMany: async ({ where }: { where: { status: string } }) =>
        rows
          .filter((r) => r.status === where.status)
          .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
          .map((r) => ({ id: r.id })),
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users[where.id] ? { username: users[where.id] } : null,
    },
  } as never;
}

const t = (s: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, s));
const row = (over: Partial<Row>): Row => ({
  id: "r1",
  userId: "u1",
  sessionId: "chat-1",
  status: "queued",
  iteration: 0,
  maxIter: 30,
  title: "Supplier price check",
  summary: null,
  queueWait: "queue",
  runAfter: t(0),
  createdAt: t(0),
  ...over,
});

beforeEach(() => {
  published.length = 0;
});

describe("waitingForOf", () => {
  it("only a queued run waits, for the reason its column records", () => {
    expect(waitingForOf("queued", "queue")).toBe("queue");
    expect(waitingForOf("queued", "chat")).toBe("chat");
    expect(waitingForOf("running", "chat")).toBe("none");
    expect(waitingForOf("awaiting_confirmation", "queue")).toBe("none");
    expect(waitingForOf("succeeded", "chat")).toBe("none");
  });
});

describe("queuePositions", () => {
  it("counts running runs as ahead and orders queued runs by runAfter, then createdAt", async () => {
    const prisma = fakePrisma([
      row({ id: "running", status: "running" }),
      row({ id: "yielded", runAfter: t(60), createdAt: t(0) }),
      row({ id: "b", runAfter: t(5), createdAt: t(2) }),
      row({ id: "a", runAfter: t(5), createdAt: t(1) }),
      row({ id: "done", status: "succeeded" }),
    ]);
    const pos = await queuePositions(prisma);
    expect([...pos.entries()]).toEqual([
      ["a", 2],
      ["b", 3],
      ["yielded", 4],
    ]);
  });
});

describe("publishAgentRunEvent", () => {
  it("publishes on the owner's topic with position, wait reason and the last tool name", async () => {
    const prisma = fakePrisma([row({ id: "r1", queueWait: "chat" })]);
    noteAgentRunTool("r1", "search_content");
    await publishAgentRunEvent(prisma, "r1");
    expect(published).toEqual([
      {
        topic: AGENT_RUN_EVENTS_TOPIC("alice"),
        payload: {
          runId: "r1",
          sessionId: "chat-1",
          status: "queued",
          iteration: 0,
          maxIter: 30,
          lastTool: "search_content",
          queuePosition: 1,
          waitingFor: "chat",
          title: "Supplier price check",
        },
      },
    ]);
    expect(AGENT_RUN_EVENTS_TOPIC("alice")).toBe("droplet/agent-runs/alice");
  });

  it("adds the summary only once the run is terminal, then forgets its last tool", async () => {
    const prisma = fakePrisma([row({ id: "r2", status: "succeeded", iteration: 7, summary: "Brightline is cheapest." })]);
    noteAgentRunTool("r2", "read_file");
    await publishAgentRunEvent(prisma, "r2");
    await publishAgentRunEvent(prisma, "r2");
    expect(published[0]!.payload).toMatchObject({
      status: "succeeded",
      summary: "Brightline is cheapest.",
      queuePosition: null,
      waitingFor: "none",
      lastTool: "read_file",
    });
    expect(published[1]!.payload.lastTool).toBeNull();
    expect(published.every((p) => !("args" in p.payload))).toBe(true);
  });

  it("never throws: a missing run, a missing owner or a failing read publish nothing", async () => {
    await publishAgentRunEvent(fakePrisma([]), "nope");
    await publishAgentRunEvent(fakePrisma([row({ userId: "ghost" })]), "r1");
    const broken = { agentRun: { findUnique: async () => { throw new Error("db down"); } } } as never;
    await expect(publishAgentRunEvent(broken, "r1")).resolves.toBeUndefined();
    expect(published).toEqual([]);
  });
});
