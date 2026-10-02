/**
 * WARP-2972 (follow-up to #2531) — a scheduled ToolSpec run is FOR its owner,
 * so the module gate's PERSON axis applies to it.
 *
 * The gap. #2531 made the mcp-server refuse a tool whose module is off for the
 * box (BOX axis) or for the acting person (PERSON axis). Over stdio it learns
 * the person only from `_meta.userId`. The scheduler's dispatcher
 * (`index.ts`) called `mcpClient.callTool(tool, args)` with no `_meta`, so a
 * scheduled run was the box to the server: an owner who had lost a module (or
 * held a deny exception on it) still ran that module's tools every morning.
 *
 * Nothing between the ticker and the gate is stubbed:
 *
 *   tickToolSchedules
 *     -> runToolSpec                          (the shipped walker)
 *     -> createMcpStepDispatcher              (the dispatcher index.ts uses)
 *     -> McpClientService.callTool            (the real `context` -> `_meta`)
 *     -> SDK Client <-in-memory-> createServer (the real stdio handler + gate)
 *     -> createModuleVerdictResolver          (the real orchestrator verdict)
 *
 * Only Prisma, the tool's own HTTP hop and the audit sink are doubles.
 *
 * Mutations this file is written to catch:
 *   - the dispatcher stops forwarding `context`     -> the person axis vanishes,
 *     "an owner without the module" RUNS and the verdict is never asked for them
 *   - the ticker stops passing `callContext`        -> same
 *   - the ticker dispatches when the resolved owner has no handle -> the "no
 *     handle" case fires an unattributed run
 *   - the ticker reads the owner's row a second time for the handle (or ignores
 *     the one the access gate returned) -> the "read ONCE" case fails
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModuleId } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ContextDeps } from "@droplet/mcp-server";
import { TOOL_CATALOG } from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

// Everything the orchestrator says about a failure, so "no personal data" is
// asserted against the whole record rather than against one call site.
const logged = vi.hoisted(() => [] as Array<{ level: string; obj: unknown; msg: string }>);
vi.mock("../lib/logger.js", () => {
  const noop = () => {};
  const at = (level: string) => (obj: unknown, msg?: string) => {
    logged.push({ level, obj, msg: msg ?? (typeof obj === "string" ? obj : "") });
  };
  const stub = {
    warn: at("warn"),
    error: at("error"),
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    child: () => stub,
  };
  return { createLogger: () => stub };
});

import { McpClientService } from "../services/mcp-client.service.js";
import { createMcpStepDispatcher } from "../services/mcp-step-dispatcher.js";
import { tickToolSchedules } from "../services/tool-schedule-ticker.service.js";
import { createModuleVerdictResolver } from "../services/tool-module-verdict.service.js";
import { GATEABLE_MODULE_IDS, OWNERS_BY_DOMAIN } from "../services/access-catalog.js";

// A network tool whose handler hops to the orchestrator, so "the handler ran"
// is observable as a call on `hop`. Read-only, so no tier or confirmation gate
// stands between the ticker and the module gate.
const NETWORK_TOOL = "get_network_status";
const NETWORK_MODULE = OWNERS_BY_DOMAIN.get("network")![0]!;
const ALL: ModuleId[] = ["chat", ...GATEABLE_MODULE_IDS];
const without = (...off: ModuleId[]) => new Set(ALL.filter((m) => !off.includes(m)));

it("the fixtures name a real network tool and the module that owns its domain", () => {
  expect(TOOL_CATALOG.find((t) => t.name === NETWORK_TOOL)).toMatchObject({
    domain: "network",
    requiresWrite: false,
  });
  expect(NETWORK_MODULE).toBeTruthy();
});

type Row = {
  id: string;
  username: string;
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
};
const ALICE: Row = { id: "u-alice", username: "alice", role: "admin", directoryStatus: "ACTIVE" };
const OLIVE: Row = { id: "u-olive", username: "olive", role: "owner", directoryStatus: "ACTIVE" };

interface Scenario {
  /** Who `ToolSpec.ownerId` names. */
  owner: Row | null;
  /** The rows the ticker can read. Defaults to `[owner]`. */
  directory?: Row[];
  /** The rows the verdict resolver can find. Defaults to the ticker's. */
  verdictDirectory?: Row[];
  /** Modules the box has switched on. */
  box?: ReadonlySet<ModuleId>;
  /** Modules the owner holds. */
  held?: ReadonlySet<ModuleId>;
  /** The owner's row carries a blank `username`. */
  blankHandle?: boolean;
}

async function fire(s: Scenario) {
  const directory = s.directory ?? (s.owner ? [s.owner] : []);
  const verdictDirectory = s.verdictDirectory ?? directory;

  // ── the orchestrator side: the real verdict resolver over a row double ──
  const asked: Array<string | null | undefined> = [];
  const verdictPrisma = {
    user: {
      findMany: vi.fn(async ({ where }: { where: { OR: Array<Record<string, string>> } }) =>
        verdictDirectory
          .filter((r) =>
            where.OR.some((c) =>
              Object.entries(c).every(([k, v]) => (r as unknown as Record<string, string>)[k] === v),
            ),
          )
          .map((r) => ({ ...r, displayName: r.username, email: null })),
      ),
    },
  };
  const resolver = createModuleVerdictResolver({
    prisma: verdictPrisma as never,
    boxModuleIds: async () => s.box ?? without(),
    personModuleIds: async () => s.held ?? without(),
    ttlMs: 0,
  });

  // ── the mcp-server side: the real stdio handler, asking that resolver ──
  const hop = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  const deps: ContextDeps = {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({ get: hop, post: hop, patch: hop, delete: hop }) as never,
  };
  const server = createServer(
    deps,
    { kind: "local-trusted" },
    {
      moduleVerdict: async (asserted) => {
        asked.push(asserted);
        return resolver(asserted);
      },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sdkClient = new Client({ name: "scheduler-test", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), sdkClient.connect(clientTransport)]);

  // The orchestrator's REAL client (its `context` -> `_meta` translation is
  // what is under test), with the in-memory SDK client where the stdio child
  // would be. `client` is private; this is the seam.
  const mcp = new McpClientService({ command: "unused" });
  (mcp as unknown as { client: Client }).client = sdkClient;
  const dispatcher = createMcpStepDispatcher(mcp);

  // ── the ticker side ──
  const now = new Date("2026-09-30T09:30:00Z");
  const runs: Array<{ status: string; error: string | null }> = [];
  const schedule = {
    id: "sched-1",
    specId: "spec-1",
    rrule: "FREQ=DAILY;BYHOUR=9",
    timezone: "UTC",
    nextFireAt: new Date("2026-09-30T09:00:00Z"),
    enabled: true,
  };
  const spec = {
    id: "spec-1",
    slug: "network-check",
    name: "Network check",
    status: "live" as const,
    ownerId: s.owner?.id ?? "u-nobody",
    writes: false,
    reversible: true,
    steps: [{ id: "st-0", idx: 0, kind: "call", args: { tool: NETWORK_TOOL, args: {} } }],
  };
  let userReads = 0;
  const prisma = {
    toolSchedule: {
      findMany: vi.fn(async () => [schedule]),
      update: vi.fn(async ({ data }: { data: { nextFireAt?: Date; enabled?: boolean } }) =>
        Object.assign(schedule, data),
      ),
    },
    toolSpec: { findUnique: vi.fn(async () => spec) },
    toolRun: {
      create: vi.fn(async ({ data }: { data: { status: string; error: string | null } }) => {
        runs.push(data);
        return { id: `run-${runs.length}` };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        userReads += 1;
        const row = directory.find((r) => r.id === where.id);
        if (!row) return null;
        // Only the FIRST read is the row the ticker decided on. Any later read
        // answers a different person and a deactivated row, so a ticker that
        // reads twice (or takes its handle from a second read) is visible in
        // what it sends and in `userReads`.
        return userReads === 1
          ? {
              username: s.blankHandle ? "" : row.username,
              role: row.role,
              directoryStatus: row.directoryStatus,
              accessRoleId: null,
              accessRole: null,
            }
          : {
              username: "someone-else",
              role: row.role,
              directoryStatus: "DEACTIVATED",
              accessRoleId: null,
              accessRole: null,
            };
      }),
    },
  };

  const result = await tickToolSchedules(prisma as never, dispatcher, now);
  await Promise.all([sdkClient.close(), server.close()]);
  return { result, runs, hop, asked, schedule, now, userReads: () => userReads };
}

const skipReason = (): unknown =>
  recordActivityMock.mock.calls
    .map(([a]) => a)
    .find((a) => a.what === "Scheduled run skipped (access)")?.refs?.reason;

beforeEach(() => {
  recordActivityMock.mockClear();
  logged.length = 0;
});

describe("a scheduled run is refused for the module gate's person axis", () => {
  it("owner HOLDS the module: the run goes ahead, and the gate was asked about them", async () => {
    const { result, runs, hop, asked } = await fire({ owner: ALICE });

    expect(result).toEqual({ inspected: 1, fired: 1, skipped: 0, disabled: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "ok", error: null });
    expect(hop).toHaveBeenCalled();
    // THE discriminator against dropping `_meta`: the server was told WHO. With
    // no `_meta` this is `[undefined]`, the box, and the next test fails.
    expect(asked).toEqual(["alice"]);
  });

  it("owner LACKS the module: the call is refused as module_disabled and the handler never runs", async () => {
    const { runs, hop, asked } = await fire({ owner: ALICE, held: without(NETWORK_MODULE) });

    expect(hop, "the tool's handler must not run for a person who lost the module").not.toHaveBeenCalled();
    expect(asked).toEqual(["alice"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    // The same refusal #2531 gives a withheld tool, not a role refusal.
    expect(runs[0]!.error).toContain("module_disabled");
  });

  it("module OFF ON THE BOX: refused for a person who holds it, and for the owner tier", async () => {
    for (const owner of [ALICE, OLIVE]) {
      recordActivityMock.mockClear();
      const { runs, hop } = await fire({
        owner,
        box: without(NETWORK_MODULE),
        held: without(),
      });
      expect(hop, `${owner.role}: the box axis still applies`).not.toHaveBeenCalled();
      expect(runs[0]!.status).toBe("failed");
      expect(runs[0]!.error).toContain("module_disabled");
    }
  });

  it("owner TIER holds every module the box has: the run goes ahead (owner bypass of the person axis)", async () => {
    const { result, hop } = await fire({ owner: OLIVE, held: without(NETWORK_MODULE) });
    expect(result.fired).toBe(1);
    expect(hop).toHaveBeenCalled();
  });

  it("owner DELETED: the fire is skipped before any call, and the schedule advances", async () => {
    const { result, hop, asked, schedule, now } = await fire({ owner: null });

    expect(result).toEqual({ inspected: 1, fired: 0, skipped: 1, disabled: 0 });
    expect(hop).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(skipReason()).toBe("user_missing");
    expect(schedule.nextFireAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("owner DEACTIVATED: the fire is skipped before any call", async () => {
    const { result, hop, asked } = await fire({
      owner: { ...ALICE, directoryStatus: "DEACTIVATED" },
    });

    expect(result.skipped).toBe(1);
    expect(hop).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(skipReason()).toBe("user_deactivated");
  });

  it("owner removed AFTER the ticker's read: the server still refuses, and the log names no one", async () => {
    // The ticker saw an active owner; by the time the call reaches the server
    // the directory no longer has them. The `_meta` path fails closed on its own.
    const { runs, hop } = await fire({ owner: ALICE, verdictDirectory: [] });

    expect(hop).not.toHaveBeenCalled();
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toContain("module_disabled");
    expect(logged.map((l) => l.msg)).toContain("module_verdict_person_unresolved");
    expect(logged.find((l) => l.msg === "module_verdict_person_unresolved")!.obj).toEqual({
      reason: "not_found",
    });
    expect(JSON.stringify(logged)).not.toMatch(/alice|u-alice/);
  });

  it("owner deactivated AFTER the ticker's read: the server still refuses", async () => {
    const { hop, runs } = await fire({
      owner: ALICE,
      verdictDirectory: [{ ...ALICE, directoryStatus: "DEACTIVATED" }],
    });
    expect(hop).not.toHaveBeenCalled();
    expect(runs[0]!.error).toContain("module_disabled");
    expect(logged.find((l) => l.msg === "module_verdict_person_unresolved")!.obj).toEqual({
      reason: "deactivated",
    });
  });
});

describe("the owner's handle comes from the access gate's own row", () => {
  it("reads the owner's row ONCE per fire, and sends the handle from that read", async () => {
    // Tier, deactivation and the handle are one snapshot. A second read is a
    // gap in which an owner deactivated after the access decision is still
    // dispatched for (and, being unclaimed-domain tools, not stopped by the
    // server's fail-closed verdict either).
    const { result, asked, userReads } = await fire({ owner: ALICE });

    expect(userReads()).toBe(1);
    expect(result.fired).toBe(1);
    expect(asked).toEqual(["alice"]);
  });

  it("a resolved owner with NO handle does not run: never an unattributed call", async () => {
    const { result, hop, asked, schedule, now } = await fire({ owner: ALICE, blankHandle: true });

    expect(result).toEqual({ inspected: 1, fired: 0, skipped: 1, disabled: 0 });
    expect(hop).not.toHaveBeenCalled();
    // Not even asked: an unattributed call would have got the BOX verdict and run.
    expect(asked).toEqual([]);
    expect(skipReason()).toBe("user_missing");
    expect(schedule.nextFireAt.getTime()).toBeGreaterThan(now.getTime());
    expect(schedule.enabled).toBe(true);
  });

  it("logs only a closed vocabulary: no person, no id", async () => {
    await fire({ owner: ALICE, blankHandle: true });

    const line = logged.find((l) => l.msg === "scheduled_run_owner_unresolved");
    expect(line).toBeDefined();
    expect(line!.level).toBe("warn");
    expect(line!.obj).toEqual({ specId: "spec-1", scheduleId: "sched-1", reason: "user_missing" });
    expect(JSON.stringify(logged)).not.toMatch(/alice|u-alice/);
    const audited = recordActivityMock.mock.calls
      .map(([a]) => a)
      .find((a) => a.what === "Scheduled run skipped (access)");
    expect(JSON.stringify(audited)).not.toMatch(/alice|u-alice/);
  });
});
