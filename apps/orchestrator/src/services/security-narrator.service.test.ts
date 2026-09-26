/**
 * WARP-2979 (ADR-059 P4 §6.9, §6.11.2, D15–D20) — Droplet's incident
 * narrator over the in-memory fake (src/__tests__/security-incidents.fake.ts)
 * with the gateway mocked at its client. What is pinned here: the pick order,
 * the claim and write compare-and-sets, yielding to chat (not idle → no call;
 * a chat that starts aborts the call and releases the claim without counting
 * it), 30 calls an hour and 5 a tick, failures up to `failed`, expiry, no
 * local model → no call and no attempt, the `running` flag, the exact request,
 * the `summaries` health row and the registration (no lockKey). The local pin
 * itself has its own file (security-narrator.local-pin.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";

const gw = vi.hoisted(() => ({
  chat: vi.fn(),
  listModels: vi.fn(),
  models: [] as Array<{ id: string; name: string; provider: string }>,
}));
vi.mock("./ai-gateway.client.js", () => ({
  chat: gw.chat,
  listModels: gw.listModels,
  getModelProvider: async (model: string) => gw.models.find((m) => m.id === model)?.provider,
}));

import {
  NARRATOR_MAX_CALLS_PER_HOUR,
  NARRATOR_MAX_PER_TICK,
  NARRATOR_PRIORITY,
  NARRATOR_PROVIDER,
  SECURITY_NARRATOR_INTERVAL_MS,
  _resetNarratorForTests,
  narratorHealthRow,
  narratorHealthState,
  registerSecurityNarratorJobs,
  securitySummariesHealth,
  tickSecurityNarrator,
  type NarratorHealthState,
} from "./security-narrator.service.js";
import { _resetInteractiveInferenceForTests, trackInteractiveInference } from "./interactive-inference.service.js";
import { SECURITY_NARRATIVE_SYSTEM_PROMPT } from "../lib/security-narrative-prompt.js";
import { createFakeSecurityPrisma, officeHours, type FakeSecurityPrisma, type FakeWorld } from "../__tests__/security-incidents.fake.js";

/** 22:40 BST on Wednesday 23 September 2026 — an incident that sealed after 22:14. */
const NOW = new Date("2026-09-23T21:40:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const GOOD = "Someone was seen in the Stock room on the Back camera at 10:14 PM while the site was closed.";

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function incident(over: Record<string, unknown> = {}): Record<string, unknown> {
  const first = new Date("2026-09-23T21:14:00Z");
  return {
    id: uuid(),
    scope: "area",
    zoneId: "11111111-1111-4111-8111-111111111111",
    zoneName: "Stock room",
    zoneKind: "restricted",
    zoneLinkIds: [],
    openedInMode: "closed",
    grouping: "closed",
    closedAt: at(-10 * MIN),
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    notifyState: "done",
    alertedAt: first,
    rulesetVersion: 3,
    firstActivityAt: first,
    lastActivityAt: new Date(first.getTime() + 60_000),
    lastArrivalAt: new Date(first.getTime() + 61_000),
    eventCount: 1,
    countsByCamera: { back: { person: 1 } },
    cameras: ["back"],
    spanByCamera: {},
    narrativeState: "pending",
    ...over,
  };
}

function reasonFor(incidentId: string, eventId: bigint, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(),
    incidentId,
    code: "after_hours_presence",
    severity: "alert",
    rulesetVersion: 3,
    evidenceEventId: eventId,
    evidenceCamera: "back",
    evidenceSource: "frigate",
    evidenceKind: "detection",
    evidenceLabel: "person",
    evidenceAt: new Date("2026-09-23T21:14:00Z"),
    evidenceSummary: "Person seen by back",
    detail: { mode: "closed", modeSource: "schedule", nonOpenAt: "2026-09-23T16:00:00.000Z", zoneKind: "restricted" },
    ...over,
  };
}

let fake: FakeSecurityPrisma;
let prisma: PrismaClient;
let clock: Date;
const deps = () => ({ now: () => clock });

/** A world with `n` pending incidents (alerts unless said), each with one person event. */
function seed(rows: Array<Record<string, unknown>>, extra: Record<string, unknown[]> = {}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const triage: Array<Record<string, unknown>> = [];
  const reasons: Array<Record<string, unknown>> = [];
  let ev = 100n;
  for (const r of rows) {
    const id = ++ev;
    events.push({
      id,
      source: "frigate",
      kind: "detection",
      severity: "info",
      camera: "back",
      sourceRef: `back/1727000000.${id}-abc`,
      dedupeKey: `frigate:${id}`,
      labels: ["person"],
      cameraZones: [],
      score: 0.9,
      startedAt: new Date("2026-09-23T21:14:00Z"),
      endedAt: new Date("2026-09-23T21:15:00Z"),
      summary: "Person seen by back",
      createdAt: new Date("2026-09-23T21:15:01Z"),
    });
    triage.push({ eventId: id, outcome: "grouped", incidentId: r.id, matchedLinkIds: [], alsoZoneIds: [] });
    reasons.push(reasonFor(r.id as string, id, r.severity === "notice" ? { code: "camera_offline", severity: "notice", evidenceKind: "camera_offline", evidenceLabel: null, detail: { offlineForSec: 95, backAt: null } } : {}));
  }
  const hours = officeHours("Europe/London");
  fake = createFakeSecurityPrisma(
    {
      securityIncident: rows,
      securityIncidentReason: reasons,
      securityEvent: events,
      securityEventTriage: triage,
      camera: [{ id: "c1", name: "back", displayName: "Back camera" }],
      securitySiteHours: [hours.header],
      workspaceSetting: [{ key: "ai.model.chat", valueJson: "gpt-oss:20b" }],
      user: [
        { id: "u1", username: "stefan", displayName: "Stefan Cruceru", role: "owner", isActive: true },
        { id: "u2", username: "maria", displayName: "Maria Lopez", role: "family", isActive: true },
      ],
      ...(extra as unknown as Partial<FakeWorld>),
    },
    NOW,
  );
  prisma = fake.client as unknown as PrismaClient;
  return rows;
}

const incidents = () => fake.world.securityIncident as Array<Record<string, unknown>>;
const byId = (id: unknown) => incidents().find((i) => i.id === id)!;

function reply(content: string, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "r1",
      object: "chat.completion",
      model: "gpt-oss:20b",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 700, completion_tokens: 120, total_tokens: 820 },
      ...over,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetNarratorForTests();
  _resetInteractiveInferenceForTests();
  clock = NOW;
  gw.models = [{ id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" }];
  gw.listModels.mockImplementation(async () => ({ models: gw.models }));
  gw.chat.mockImplementation(async () => reply(GOOD));
});

afterEach(() => {
  _resetInteractiveInferenceForTests();
});

/** Start an interactive request (as the middleware does) and return its release. */
function startChat(): () => void {
  const handlers = new Map<string, () => void>();
  trackInteractiveInference({ method: "POST" } as Request, { on: (ev: string, fn: () => void) => void handlers.set(ev, fn) } as unknown as Response, () => undefined);
  return () => handlers.get("finish")!();
}

describe("tickSecurityNarrator — writing one summary", () => {
  it("pending → written: the checked text, the model, prompt v1, when, and the audience; never the incident version, never an ActivityRow", async () => {
    const [i] = seed([incident({ version: 4 })]);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(1);
    expect(byId(i!.id)).toMatchObject({
      narrativeState: "written",
      narrative: GOOD,
      narrativeModel: "gpt-oss:20b",
      narrativePromptVersion: 1,
      narratedAt: NOW,
      narrativeAudience: { cameras: ["back"], threats: false, locks: false },
      narrativeAttemptAt: NOW,
      narrativeAttempts: 0,
      narrativeError: null,
      version: 4,
    });
    expect(fake.world.activityRow).toEqual([]);
    expect(narratorHealthState()).toMatchObject({ lastOkAt: NOW, lastWrittenAt: NOW, lastTotalTokens: 820 });
  });

  it("the request: provider local, the resolved model, priority 10, not streamed, temperature 0, 700 tokens, reasoning low, the v1 prompt and exactly JSON.stringify(input) — with no person's name", async () => {
    seed([incident()], {
      securityIncidentAck: [{ id: uuid(), incidentId: "x", action: "acknowledge", byUserId: "u2", byName: "Maria Lopez", at: NOW, note: "" }],
    });
    await tickSecurityNarrator(prisma, deps());
    const [request, signal, userId, opts] = gw.chat.mock.calls[0]!;
    expect(request).toMatchObject({
      model: "gpt-oss:20b",
      provider: NARRATOR_PROVIDER,
      stream: false,
      temperature: 0,
      max_tokens: 700,
      reasoning_effort: "low",
    });
    expect(NARRATOR_PROVIDER).toBe("local");
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual({ role: "system", content: SECURITY_NARRATIVE_SYSTEM_PROMPT });
    const input = JSON.parse(request.messages[1].content);
    expect(request.messages[1].content).toBe(JSON.stringify(input));
    expect(input).toMatchObject({ v: 1, place: { name: "Stock room", kind: "staff only" }, day: "Wednesday 23 September", events: [{ at: "10:14 PM", source: "Back camera" }] });
    expect(request.messages[1].content).not.toMatch(/maria|stefan|lopez|cruceru|u1|u2/i);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(userId).toBeUndefined();
    expect(opts).toEqual({ priority: NARRATOR_PRIORITY });
    expect(NARRATOR_PRIORITY).toBe(10);
  });

  it("the model name stored is the response's when it is a sane string, else the requested local id", async () => {
    const [i] = seed([incident()]);
    gw.chat.mockImplementation(async () => reply(GOOD, { model: "" }));
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id).narrativeModel).toBe("gpt-oss:20b");
  });
});

describe("the pick and the claim", () => {
  it("alert before notice, never-tried before retried (oldest attempt first), newest activity first — at most 5 a tick", async () => {
    const base = new Date("2026-09-23T21:15:00Z").getTime();
    const rows = [
      incident({ severity: "notice", reasonCodes: ["camera_offline"], notifyState: "not_needed", alertedAt: null, lastActivityAt: new Date(base + 9 * MIN), lastArrivalAt: new Date(base + 9 * MIN) }),
      incident({ lastActivityAt: new Date(base + 1 * MIN), narrativeAttemptAt: at(-20 * MIN), narrativeAttempts: 1, narrativeError: "MODEL_ERROR" }),
      incident({ lastActivityAt: new Date(base + 2 * MIN), narrativeAttemptAt: at(-30 * MIN), narrativeAttempts: 1, narrativeError: "MODEL_ERROR" }),
      incident({ lastActivityAt: new Date(base + 3 * MIN) }),
      incident({ lastActivityAt: new Date(base + 4 * MIN) }),
      incident({ lastActivityAt: new Date(base + 5 * MIN), narrativeAttemptAt: at(-2 * MIN), narrativeAttempts: 1, narrativeError: "MODEL_ERROR" }), // leased: not yet
      incident({ severity: "notice", reasonCodes: ["camera_offline"], notifyState: "not_needed", alertedAt: null, lastActivityAt: new Date(base + 8 * MIN), lastArrivalAt: new Date(base + 8 * MIN) }),
    ];
    seed(rows);
    const order: string[] = [];
    gw.chat.mockImplementation(async () => {
      const claimed = incidents().filter((r) => r.narrativeState === "pending" && (r.narrativeAttemptAt as Date | null)?.getTime() === NOW.getTime());
      order.push(...claimed.map((r) => r.id as string).filter((id) => !order.includes(id)));
      return reply(GOOD);
    });
    await tickSecurityNarrator(prisma, deps());
    expect(order).toEqual([rows[4]!.id, rows[3]!.id, rows[2]!.id, rows[1]!.id, rows[0]!.id]);
    expect(gw.chat).toHaveBeenCalledTimes(NARRATOR_MAX_PER_TICK);
    expect(byId(rows[5]!.id).narrativeState).toBe("pending");
    expect(byId(rows[6]!.id).narrativeState).toBe("pending");
  });

  it("a claim that loses its compare-and-set (someone moved the lease between the read and the claim) is skipped", async () => {
    const [a, b] = seed([incident(), incident({ lastActivityAt: new Date("2026-09-23T21:14:30Z") })]);
    // The expire step's updateMany, then the first claim: another narrator claims `a` just before.
    fake.onCall("securityIncident", "updateMany", () => undefined);
    fake.onCall("securityIncident", "updateMany", (w) => {
      const row = (w.securityIncident as Array<Record<string, unknown>>).find((r) => r.id === a!.id)!;
      row.narrativeAttemptAt = at(-1);
    });
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(1);
    expect(byId(a!.id)).toMatchObject({ narrativeState: "pending", narrative: null });
    expect(byId(b!.id).narrativeState).toBe("written");
  });

  it("🔴 a lost WRITE compare-and-set discards the text: the incident sealed (or was regenerated) while the model wrote", async () => {
    const [i] = seed([incident()]);
    gw.chat.mockImplementation(async () => {
      byId(i!.id).narrativeAttemptAt = null; // what the seal and a Regenerate write
      return reply(GOOD);
    });
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id)).toMatchObject({ narrativeState: "pending", narrative: null, narrativeAttempts: 0 });
  });
});

describe("yielding to chat", () => {
  it("not idle (a chat in flight, or one that ended under 30 s ago) → no call, nothing claimed, the yield noted", async () => {
    const [i] = seed([incident()]);
    const release = startChat();
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).not.toHaveBeenCalled();
    expect(byId(i!.id)).toMatchObject({ narrativeState: "pending", narrativeAttemptAt: null });
    release();
    // Ended just now: still not quiet for 30 s.
    clock = new Date(Date.now() + 29_000);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).not.toHaveBeenCalled();
    expect(narratorHealthState().lastYieldAt).toEqual(clock);
    clock = new Date(Date.now() + 31_000);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(1);
  });

  it("🔴 a chat that starts mid-call aborts the call; the claim is released and NOT counted as an attempt; the batch stops", async () => {
    const [a, b] = seed([incident(), incident({ lastActivityAt: new Date("2026-09-23T21:14:30Z") })]);
    gw.chat.mockImplementation(
      (_req: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          startChat(); // someone sends a message while the summary is being written
        }),
    );
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(1);
    const first = [a, b].map((r) => byId(r!.id));
    for (const r of first) expect(r).toMatchObject({ narrativeState: "pending", narrativeAttemptAt: null, narrativeAttempts: 0, narrativeError: null });
    expect(narratorHealthState().lastYieldAt).toEqual(NOW);
  });
});

describe("rate limits", () => {
  it(`at most ${NARRATOR_MAX_CALLS_PER_HOUR} model calls in any rolling hour; the window moves on`, async () => {
    seed(Array.from({ length: 40 }, (_, n) => incident({ lastActivityAt: new Date(new Date("2026-09-23T21:15:00Z").getTime() + n * 1000) })));
    for (let t = 0; t < 10; t++) {
      clock = at(t * MIN);
      await tickSecurityNarrator(prisma, deps());
    }
    expect(gw.chat).toHaveBeenCalledTimes(NARRATOR_MAX_CALLS_PER_HOUR);
    clock = at(60 * MIN + 1);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(NARRATOR_MAX_CALLS_PER_HOUR + NARRATOR_MAX_PER_TICK);
  });

  it("a check retry counts toward the hour too", async () => {
    seed(Array.from({ length: 20 }, (_, n) => incident({ lastActivityAt: new Date(new Date("2026-09-23T21:15:00Z").getTime() + n * 1000) })));
    gw.chat.mockImplementation(async () => reply("Stefan was seen in the Stock room.")); // NAMES, every time
    for (let t = 0; t < 10; t++) {
      clock = at(t * 6 * MIN);
      await tickSecurityNarrator(prisma, deps());
    }
    expect(gw.chat).toHaveBeenCalledTimes(NARRATOR_MAX_CALLS_PER_HOUR);
  });
});

describe("failures, expiry and the model", () => {
  it("a model error counts an attempt and keeps the lease; the third makes it `failed` with its reason", async () => {
    const [i] = seed([incident()]);
    gw.chat.mockRejectedValue(new Error("AI Gateway error 500: boom"));
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id)).toMatchObject({ narrativeState: "pending", narrativeAttempts: 1, narrativeError: "MODEL_ERROR", narrativeAttemptAt: NOW });
    // Leased for 5 minutes.
    clock = at(4 * MIN);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(1);
    clock = at(5 * MIN + 1);
    await tickSecurityNarrator(prisma, deps());
    clock = at(11 * MIN);
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id)).toMatchObject({ narrativeState: "failed", narrativeAttempts: 3, narrativeError: "MODEL_ERROR" });
    clock = at(30 * MIN);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(3);
  });

  it("a check failure retries once at temperature 0.2 with a line naming the rule, never the text; a second → CHECK_FAILED:<rule>", async () => {
    const [i] = seed([incident()]);
    gw.chat.mockImplementation(async () => reply("Stefan was seen in the Stock room at 10:14 PM."));
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(2);
    const retry = gw.chat.mock.calls[1]![0];
    expect(retry.temperature).toBe(0.2);
    expect(retry.messages[0].content.startsWith(SECURITY_NARRATIVE_SYSTEM_PROMPT)).toBe(true);
    expect(retry.messages[0].content).toMatch(/named a person/i);
    expect(retry.messages[0].content).not.toMatch(/stefan/i);
    expect(retry.messages[1]).toEqual(gw.chat.mock.calls[0]![0].messages[1]);
    expect(byId(i!.id)).toMatchObject({ narrativeAttempts: 1, narrativeError: "CHECK_FAILED:NAMES", narrative: null });
  });

  it("a retry that passes is written", async () => {
    const [i] = seed([incident()]);
    gw.chat.mockImplementationOnce(async () => reply("An intruder was seen at 10:14 PM.")).mockImplementationOnce(async () => reply(GOOD));
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id)).toMatchObject({ narrativeState: "written", narrative: GOOD });
  });

  it.each([
    ["a cut-off answer", () => reply(GOOD, { choices: [{ index: 0, message: { role: "assistant", content: GOOD }, finish_reason: "length" }] }), "LENGTH"],
    ["an empty answer", () => reply("   "), "EMPTY"],
  ])("%s is a failed attempt (%s)", async (_l, make, code) => {
    const [i] = seed([incident()]);
    gw.chat.mockImplementation(async () => make());
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id)).toMatchObject({ narrativeAttempts: 1, narrativeError: code });
  });

  it("pending 7 days after the last activity → expired, never narrated", async () => {
    const old = new Date(NOW.getTime() - 7 * 86_400_000 - 1);
    const [i, j] = seed([incident({ firstActivityAt: old, lastActivityAt: old, lastArrivalAt: old, alertedAt: old }), incident()]);
    await tickSecurityNarrator(prisma, deps());
    expect(byId(i!.id).narrativeState).toBe("expired");
    expect(byId(j!.id).narrativeState).toBe("written");
    expect(gw.chat).toHaveBeenCalledTimes(1);
  });

  it("no local model → zero calls, zero attempts, still pending, health Paused", async () => {
    const [i] = seed([incident()]);
    registerSecurityNarratorJobs({ scheduleInterval: vi.fn() }, prisma);
    gw.models = [];
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).not.toHaveBeenCalled();
    expect(byId(i!.id)).toMatchObject({ narrativeState: "pending", narrativeAttempts: 0, narrativeAttemptAt: null });
    expect((await securitySummariesHealth(prisma, NOW)).detail).toBe("Paused: the AI model on this Droplet isn't available");
  });

  it("summaries off → no call at all", async () => {
    seed([incident()], { securityAiSettings: [{ id: "singleton", summaries: "off" }] });
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).not.toHaveBeenCalled();
    expect(gw.listModels).not.toHaveBeenCalled();
  });

  it("nothing pending → the model is not even listed", async () => {
    seed([incident({ narrativeState: "written", narrative: GOOD, narrativeModel: "m", narrativePromptVersion: 1, narratedAt: NOW, narrativeAudience: { cameras: ["back"], threats: false, locks: false } })]);
    await tickSecurityNarrator(prisma, deps());
    expect(gw.listModels).not.toHaveBeenCalled();
  });

  it("the running flag: a second tick while one runs does nothing", async () => {
    seed([incident()]);
    let release!: () => void;
    gw.chat.mockImplementation(() => new Promise((r) => (release = () => r(reply(GOOD)))));
    const first = tickSecurityNarrator(prisma, deps());
    await vi.waitFor(() => expect(gw.chat).toHaveBeenCalledTimes(1));
    await tickSecurityNarrator(prisma, deps());
    expect(gw.chat).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe("registration and health", () => {
  it("every minute, with NO lockKey (a model call outlives the lock's transaction); registeredAt is the boot assertion", () => {
    const scheduleInterval = vi.fn();
    expect(narratorHealthState().registeredAt).toBeNull();
    registerSecurityNarratorJobs({ scheduleInterval }, {} as PrismaClient);
    expect(scheduleInterval).toHaveBeenCalledTimes(1);
    expect(scheduleInterval.mock.calls[0]![0]).toBe(SECURITY_NARRATOR_INTERVAL_MS);
    expect(SECURITY_NARRATOR_INTERVAL_MS).toBe(60_000);
    expect(scheduleInterval.mock.calls[0]![2]).toBeUndefined();
    expect(narratorHealthState().registeredAt).not.toBeNull();
  });

  const state = (over: Partial<NarratorHealthState> = {}): NarratorHealthState => ({
    registeredAt: at(-10 * MIN),
    lastOkAt: at(-1 * MIN),
    lastError: null,
    lastYieldAt: null,
    unavailable: null,
    lastWrittenAt: null,
    failedLastDay: 0,
    pending: 0,
    lastTotalTokens: null,
    tokenSamples: [],
    lastCallMs: null,
    ...over,
  });
  const on = { summaries: "on" as const };

  it("every state of the `summaries` row", () => {
    expect(narratorHealthRow(state({ registeredAt: null, lastOkAt: null }), on, NOW)).toEqual({ id: "summaries", state: "down", detail: "Not running", lastSeenAt: null });
    expect(narratorHealthRow(state(), { summaries: "off" }, NOW)).toMatchObject({ state: "not_configured", detail: "Turned off in Security settings" });
    expect(narratorHealthRow(state({ lastError: { at: NOW, message: "the database didn't answer" } }), on, NOW)).toMatchObject({
      state: "down",
      detail: "Couldn't check for summaries to write: the database didn't answer",
    });
    expect(narratorHealthRow(state({ unavailable: { reason: "model_unreachable", at: NOW } }), on, NOW)).toMatchObject({
      state: "down",
      detail: "Paused: the AI model on this Droplet isn't available",
    });
    // A summary written after the model came back clears it.
    expect(narratorHealthRow(state({ unavailable: { reason: "model_unreachable", at: at(-5 * MIN) }, lastWrittenAt: at(-1 * MIN) }), on, NOW).state).toBe("ok");
    expect(narratorHealthRow(state({ failedLastDay: 2 }), on, NOW)).toMatchObject({ state: "down", detail: "Couldn't write 2 summaries in the last day" });
    expect(narratorHealthRow(state({ failedLastDay: 1 }), on, NOW).detail).toBe("Couldn't write 1 summary in the last day");
    expect(narratorHealthRow(state(), on, NOW)).toEqual({ id: "summaries", state: "ok", detail: "Written on this Droplet, never in the cloud", lastSeenAt: at(-1 * MIN).toISOString() });
    // Waiting while chat is busy is normal: still ok.
    expect(narratorHealthRow(state({ pending: 3, lastYieldAt: NOW }), on, NOW)).toMatchObject({ state: "ok", detail: "Written on this Droplet, never in the cloud; 3 waiting" });
  });

  it("securitySummariesHealth never throws: unreadable settings read as on (what the job would do)", async () => {
    seed([]);
    expect((await securitySummariesHealth(prisma, NOW)).detail).toBe("Not running");
    registerSecurityNarratorJobs({ scheduleInterval: vi.fn() }, prisma);
    fake.failOn("securityAiSettings", "findUnique", undefined, { always: true });
    expect(await securitySummariesHealth(prisma, NOW)).toMatchObject({ id: "summaries", state: "ok", detail: "Written on this Droplet, never in the cloud" });
  });
});
