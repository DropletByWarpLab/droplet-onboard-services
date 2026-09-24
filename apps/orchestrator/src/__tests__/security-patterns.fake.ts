/**
 * WARP-2980 (ADR-059 P5 §6.17, §7 routes 29–31) — an in-memory Prisma for
 * the read side of "what normal looks like": exactly the delegates and the
 * `where` shapes services/security-patterns-read.ts (and the P2b helpers it
 * reuses: loadActiveLinks, loadCameraLabels, visibleCameraNames,
 * resolveSecurityTimezone) ask for. A `where` key it does not understand
 * throws, so a query the fake cannot answer truthfully fails loudly instead
 * of matching everything.
 */
import { vi } from "vitest";

export interface FakeCell {
  id: bigint;
  buildId: string;
  zoneKey: string;
  keyKind: "area" | "camera";
  zoneId: string | null;
  camera: string | null;
  zoneVersion: number | null;
  cameras: string[];
  label: string;
  dayType: "weekday" | "weekend";
  hour: number;
  daysObserved: number;
  daysWithEvent: number;
  eventCount: number;
  observedMinutes: number;
  dwellSamples: number;
  durationP99Sec: number | null;
}

export interface PatternsWorld {
  hours: { state: "set" | "not_set"; timezone: string | null } | null;
  workspaceTz: string | null;
  cameras: Array<{ name: string; displayName: string }>;
  /** userId → granted camera names. */
  grants: Record<string, string[]>;
  zones: Array<{ id: string; name: string; kind: string; state: "active" | "archived"; version: number }>;
  links: Array<{ id: string; zoneId: string; sourceKind: "camera" | "camera_zone"; sourceRef: string; state: "active" | "removed" }>;
  sources: Array<{
    sourceKey: string;
    camera: string;
    state: "learning" | "active" | "stale";
    daysObserved: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
    stateChangedAt: Date;
  }>;
  builds: Array<{ id: string; state: string; timezone: string; windowFrom: string; windowTo: string; finishedAt: Date | null; startedAt: Date }>;
  cells: FakeCell[];
  /** Set to make every read reject (the 503 path). */
  failReads?: boolean;
}

export function newPatternsWorld(over: Partial<PatternsWorld> = {}): PatternsWorld {
  return {
    hours: null,
    workspaceTz: null,
    cameras: [],
    grants: {},
    zones: [],
    links: [],
    sources: [],
    builds: [],
    cells: [],
    ...over,
  };
}

type Where = Record<string, unknown>;

function test(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (k === "in") {
        if (!(c.in as unknown[]).includes(value)) return false;
      } else if (k === "not") {
        if (value === c.not) return false;
      } else {
        throw new Error(`patterns fake: unsupported operator ${k}`);
      }
    }
    return true;
  }
  if (cond instanceof Date && value instanceof Date) return cond.getTime() === value.getTime();
  return value === cond;
}

function matches(row: Record<string, unknown>, where: Where | undefined, allowed: readonly string[]): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (!allowed.includes(k)) throw new Error(`patterns fake: unsupported where key ${k}`);
    if (!test(row[k], cond)) return false;
  }
  return true;
}

function project<T extends Record<string, unknown>>(row: T, select: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
  return out;
}

function distinctBy<T extends Record<string, unknown>>(rows: T[], keys: readonly string[] | undefined): T[] {
  if (!keys) return rows;
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = JSON.stringify(keys.map((x) => r[x]));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const CELL_WHERE = ["buildId", "zoneKey", "label", "dayType", "hour", "keyKind", "zoneId", "camera"] as const;

export function patternsPrisma(w: PatternsWorld) {
  const guard = <A extends unknown[], R>(fn: (...a: A) => R) =>
    vi.fn(async (...a: A) => {
      if (w.failReads) throw new Error("db down");
      return fn(...a);
    });
  return {
    securitySiteHours: {
      findUnique: guard(() => (w.hours ? { id: "singleton", version: 0, ...w.hours } : null)),
    },
    workspace: {
      findUnique: guard(() => (w.workspaceTz === null ? null : { tz: w.workspaceTz })),
    },
    camera: {
      findMany: guard(() => w.cameras.map((c) => ({ ...c }))),
    },
    cameraAccessGrant: {
      findMany: guard((a: { where: { userId: string } }) => (w.grants[a.where.userId] ?? []).map((name) => ({ camera: { name } }))),
    },
    user: {
      findUnique: guard(() => null),
    },
    securityZoneLink: {
      // loadActiveLinks: active links of active areas, with the area's name and kind.
      findMany: guard((a: { where: { state: string; zone: { state: string } } }) => {
        if (a.where.state !== "active" || a.where.zone?.state !== "active") throw new Error("patterns fake: unexpected link query");
        return w.links
          .filter((l) => l.state === "active" && w.zones.find((z) => z.id === l.zoneId)?.state === "active")
          .sort((x, y) => (x.zoneId < y.zoneId ? -1 : x.zoneId > y.zoneId ? 1 : x.sourceRef < y.sourceRef ? -1 : 1))
          .map((l) => {
            const z = w.zones.find((zz) => zz.id === l.zoneId)!;
            return { id: l.id, zoneId: l.zoneId, sourceKind: l.sourceKind, sourceRef: l.sourceRef, zone: { name: z.name, kind: z.kind } };
          });
      }),
    },
    securityZone: {
      findUnique: guard((a: { where: { id: string } }) => {
        const z = w.zones.find((zz) => zz.id === a.where.id);
        return z ? { ...z } : null;
      }),
    },
    securityBaselineSource: {
      findMany: guard((a?: { where?: Where }) =>
        w.sources.filter((s) => matches(s as unknown as Record<string, unknown>, a?.where, ["camera"])).map((s) => ({ ...s })),
      ),
    },
    securityBaselineBuild: {
      findFirst: guard((a: { where?: Where }) => {
        const b = w.builds.find((x) => matches(x as unknown as Record<string, unknown>, a.where, ["state"]));
        return b ? { ...b } : null;
      }),
    },
    securityBaselineCell: {
      findMany: guard((a: { where?: Where; distinct?: string[]; select?: Record<string, unknown> }) =>
        distinctBy(
          w.cells.map((c) => c as unknown as Record<string, unknown>).filter((c) => matches(c, a.where, CELL_WHERE)),
          a.distinct,
        ).map((c) => project(c, a.select)),
      ),
      findFirst: guard((a: { where?: Where; select?: Record<string, unknown> }) => {
        const c = w.cells.find((x) => matches(x as unknown as Record<string, unknown>, a.where, CELL_WHERE));
        return c ? project(c as unknown as Record<string, unknown>, a.select) : null;
      }),
      groupBy: guard((a: { by: string[]; where?: Where; _sum: Record<string, boolean> }) => {
        const groups = new Map<string, Record<string, unknown>>();
        for (const c of w.cells.filter((x) => matches(x as unknown as Record<string, unknown>, a.where, CELL_WHERE))) {
          const row = c as unknown as Record<string, unknown>;
          const k = JSON.stringify(a.by.map((b) => row[b]));
          const g = groups.get(k) ?? { ...Object.fromEntries(a.by.map((b) => [b, row[b]])), _sum: Object.fromEntries(Object.keys(a._sum).map((s) => [s, 0])) };
          for (const s of Object.keys(a._sum)) (g._sum as Record<string, number>)[s]! += row[s] as number;
          groups.set(k, g);
        }
        return [...groups.values()];
      }),
    },
  };
}

/** 48 cells for one key and label, every (dayType, hour), from a function of the hour. */
export function cellsFor(
  buildId: string,
  key: { zoneKey: string; keyKind: "area" | "camera"; zoneId?: string; camera?: string; zoneVersion?: number; cameras: string[] },
  label: string,
  at: (dayType: "weekday" | "weekend", hour: number) => Partial<FakeCell>,
  idStart = 1n,
): FakeCell[] {
  const out: FakeCell[] = [];
  let id = idStart;
  for (const dayType of ["weekday", "weekend"] as const) {
    for (let hour = 0; hour < 24; hour += 1) {
      const n = dayType === "weekday" ? 20 : 8;
      out.push({
        id: id++,
        buildId,
        zoneKey: key.zoneKey,
        keyKind: key.keyKind,
        zoneId: key.zoneId ?? null,
        camera: key.camera ?? null,
        zoneVersion: key.zoneVersion ?? null,
        cameras: key.cameras,
        label,
        dayType,
        hour,
        daysObserved: n,
        daysWithEvent: 0,
        eventCount: 0,
        observedMinutes: n * 60,
        dwellSamples: 0,
        durationP99Sec: null,
        ...at(dayType, hour),
      });
    }
  }
  return out;
}
