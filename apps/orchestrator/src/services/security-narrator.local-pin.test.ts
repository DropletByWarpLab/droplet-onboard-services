/**
 * 🔴 WARP-2979 (ADR-059 P4 §6.10, DS-007, D19, D20) — Droplet's incident
 * summaries are written on THIS box, never by a cloud model. Security events
 * are location and presence data about people.
 *
 * The gateway client is mocked at `chat` and `listModels`; everything between
 * them and the narrator is real (the local-only resolver, the catalogue
 * checks, the prefix mirror). The cases:
 *   A  a local model: every call says provider "local", names an installed
 *      LOCAL model, runs at priority 10 and is not streamed;
 *   B  the active chat model is a cloud one (listed under anthropic, cloud
 *      access switched on): ZERO calls — with or without a local model also
 *      installed — the incident stays pending, health says Paused;
 *   C  no local model installed: zero calls;
 *   D  a degraded listing: zero calls;
 *   E  static: one `aiGateway.chat(` in the narrator, no other model path,
 *      every `provider:` is NARRATOR_PROVIDER, and no other security service
 *      reaches a model at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

const gw = vi.hoisted(() => ({
  chat: vi.fn(),
  listModels: vi.fn(),
  models: [] as Array<{ id: string; name: string; provider: string }>,
  degraded: false,
}));
vi.mock("./ai-gateway.client.js", () => ({
  chat: gw.chat,
  listModels: gw.listModels,
  getModelProvider: async (model: string) => gw.models.find((m) => m.id === model)?.provider,
}));

import {
  NARRATOR_PROVIDER,
  _resetNarratorForTests,
  registerSecurityNarratorJobs,
  securitySummariesHealth,
  tickSecurityNarrator,
} from "./security-narrator.service.js";
import { _resetInteractiveInferenceForTests } from "./interactive-inference.service.js";
import { createFakeSecurityPrisma, officeHours, type FakeSecurityPrisma } from "../__tests__/security-incidents.fake.js";

const NOW = new Date("2026-09-23T21:40:00Z");
const ID = "00000000-0000-4000-8000-00000000abcd";
const GOOD = "Someone was seen in the Stock room on the Back camera at 10:14 PM while the site was closed.";

let fake: FakeSecurityPrisma;
let prisma: PrismaClient;

function world(active: string, settings: Array<{ key: string; valueJson: unknown }> = []): void {
  const first = new Date("2026-09-23T21:14:00Z");
  fake = createFakeSecurityPrisma(
    {
      securityIncident: [
        {
          id: ID,
          scope: "area",
          zoneId: "11111111-1111-4111-8111-111111111111",
          zoneName: "Stock room",
          zoneKind: "restricted",
          zoneLinkIds: [],
          openedInMode: "closed",
          grouping: "closed",
          closedAt: NOW,
          state: "open",
          severity: "alert",
          reasonCodes: ["after_hours_presence"],
          notifyState: "done",
          alertedAt: first,
          rulesetVersion: 3,
          firstActivityAt: first,
          lastActivityAt: first,
          lastArrivalAt: first,
          eventCount: 1,
          countsByCamera: { back: { person: 1 } },
          cameras: ["back"],
          spanByCamera: {},
          narrativeState: "pending",
        },
      ],
      securityIncidentReason: [
        {
          id: "r1",
          incidentId: ID,
          code: "after_hours_presence",
          severity: "alert",
          rulesetVersion: 3,
          evidenceEventId: 7n,
          evidenceCamera: "back",
          evidenceSource: "frigate",
          evidenceKind: "detection",
          evidenceLabel: "person",
          evidenceAt: first,
          evidenceSummary: "Person seen by back",
          detail: { mode: "closed", modeSource: "schedule" },
        },
      ],
      camera: [{ id: "c1", name: "back", displayName: "Back camera" }],
      securitySiteHours: [officeHours("Europe/London").header],
      workspaceSetting: [{ key: "ai.model.chat", valueJson: active }, ...settings],
    },
    NOW,
  );
  prisma = fake.client as unknown as PrismaClient;
}

const pending = () => (fake.world.securityIncident as Array<Record<string, unknown>>)[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  _resetNarratorForTests();
  _resetInteractiveInferenceForTests();
  gw.degraded = false;
  gw.listModels.mockImplementation(async () => ({ models: gw.models, ...(gw.degraded ? { degraded_providers: ["local"] } : {}) }));
  gw.chat.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ model: "gpt-oss:20b", choices: [{ index: 0, message: { role: "assistant", content: GOOD }, finish_reason: "stop" }], usage: { total_tokens: 800 } }),
  }));
});

describe("🔴 the local pin (DS-007)", () => {
  it("A — a local model: provider local, an installed LOCAL model, priority 10, not streamed — on the first call and the retry", async () => {
    gw.models = [
      { id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
    ];
    world("gpt-oss:20b");
    // First answer fails the check, so the retry path is exercised too.
    gw.chat.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ model: "gpt-oss:20b", choices: [{ index: 0, message: { role: "assistant", content: "An intruder was seen." }, finish_reason: "stop" }] }),
    }));
    await tickSecurityNarrator(prisma, { now: () => NOW });
    expect(gw.chat).toHaveBeenCalledTimes(2);
    const localIds = gw.models.filter((m) => m.provider === "local").map((m) => m.id);
    for (const [request, , userId, opts] of gw.chat.mock.calls) {
      expect(request.provider).toBe("local");
      expect(request.provider).toBe(NARRATOR_PROVIDER);
      expect(localIds).toContain(request.model);
      expect(request.stream).toBe(false);
      expect(opts).toEqual({ priority: 10 });
      expect(userId).toBeUndefined();
    }
    expect(pending().narrativeState).toBe("written");
  });

  it.each([
    ["only the cloud model listed", [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" }]],
    [
      "a local model installed as well",
      [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" },
      ],
    ],
  ])("B — the active chat model is a cloud one (cloud access on), %s: ZERO calls, still pending, health Paused", async (_l, models) => {
    gw.models = models;
    world("claude-sonnet-4", [{ key: "cloud_model_escape", valueJson: true }]);
    registerSecurityNarratorJobs({ scheduleInterval: vi.fn() }, prisma);
    await tickSecurityNarrator(prisma, { now: () => NOW });
    await tickSecurityNarrator(prisma, { now: () => new Date(NOW.getTime() + 61_000) });
    expect(gw.chat).not.toHaveBeenCalled();
    expect(pending()).toMatchObject({ narrativeState: "pending", narrativeAttempts: 0, narrativeAttemptAt: null, narrative: null });
    expect(await securitySummariesHealth(prisma, NOW)).toMatchObject({ state: "down", detail: "Paused: the AI model on this Droplet isn't available" });
  });

  it("C — no local model installed: zero calls", async () => {
    gw.models = [];
    world("gpt-oss:20b");
    await tickSecurityNarrator(prisma, { now: () => NOW });
    expect(gw.chat).not.toHaveBeenCalled();
    expect(pending().narrativeAttempts).toBe(0);
  });

  it("D — a degraded listing: zero calls", async () => {
    gw.models = [{ id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" }];
    gw.degraded = true;
    world("gpt-oss:20b");
    await tickSecurityNarrator(prisma, { now: () => NOW });
    expect(gw.chat).not.toHaveBeenCalled();
  });
});

describe("🔴 E — there is no other path (static)", () => {
  const dir = resolve(__dirname);
  const narrator = readFileSync(resolve(dir, "security-narrator.service.ts"), "utf8");

  it("the narrator makes exactly one gateway call, and names no other way to reach a model", () => {
    expect(narrator.match(/aiGateway\.chat\(/g)).toHaveLength(1);
    for (const other of ["completeOnce", "runAgent", "decideCloudTurn", "readActiveChatModel", "llm-complete", "chatStream", "streamChat"]) {
      expect(narrator, other).not.toContain(other);
    }
  });

  it("every `provider:` in it is NARRATOR_PROVIDER, which is the literal \"local\"", () => {
    const providers = [...narrator.matchAll(/provider:\s*([^,\n}]+)/g)].map((m) => m[1]!.trim());
    expect(providers.length).toBeGreaterThan(0);
    expect(new Set(providers)).toEqual(new Set(["NARRATOR_PROVIDER"]));
    expect(narrator).toMatch(/export const NARRATOR_PROVIDER = "local" as const;/);
    // The model comes from the local-only resolver, asked to refuse a cloud active model.
    expect(narrator).toMatch(/resolveLocalBackgroundModel\(prisma, \{ refuseCloudActive: true \}\)/);
  });

  it("no other security service imports the gateway client or the completion helper", () => {
    const offenders = readdirSync(dir)
      .filter((f) => /^security-.*\.ts$/.test(f) && !f.endsWith(".test.ts") && f !== "security-narrator.service.ts")
      .filter((f) => /ai-gateway\.client|llm-complete/.test(readFileSync(resolve(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
