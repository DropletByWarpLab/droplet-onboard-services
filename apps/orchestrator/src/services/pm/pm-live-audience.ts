/**
 * Who hears that a work item changed (WARP-3536, Work Suite WS-19).
 *
 * Everyone who can READ the item, and nobody else. The mounted `/api/pm`
 * policy has a workspace Projects switch and a tier floor; Projects is
 * deliberately not per-person feature-gated. Guests have one narrow exception:
 *
 *   BOX     the `projects` module is effective: available and switched on. The
 *           set the module gate reads (`getEffectiveModuleIds`), so a toggle
 *           silences this on the tick it 404s the routes (give or take the TTL).
 *   ROLE    `requireModuleTierFloor("projects")` admits owner/admin/family;
 *           Projects is deliberately absent from `FEATURE_GATED_MODULES`, so
 *           individual feature grants do not narrow this PM route.
 *   GUEST   `requireModuleTierFloor` 404s the whole prefix for them, with one
 *           exception (WARP-3369): a
 *           work item ASSIGNED to them is shared with them. So a guest hears
 *           about exactly the items assigned to them.
 *
 * Deactivated people (`directoryStatus`) and the service principal are never in
 * the audience. The role query is current for each roster refresh.
 *
 * "In batch, not per row": the roster (every active person, who passes the role floor,
 * which of them are guests) is built once per `PM_LIVE_ROSTER_TTL_MS` and shared
 * by every row in between, with usernames read in the same query as the roles.
 * Per row the only lookup is ONE query for which of the box's guests the item is
 * assigned to, and none at all on a box without guests.
 *
 * The TTL bounds how long a deactivated or role-changed user keeps hearing
 * "something changed": the frame carries ids only and the client re-reads through the
 * authorized API, so the exposure of a stale roster is a timestamp, not data.
 * It matches the 5-10 s the module gate and the tool verdict already accept.
 * Deletion delivery always rebuilds the roster, so a stale live-row roster
 * cannot expose deleted IDs to a person who lost access or was deactivated.
 *
 * Service desk: `PmProject.kind` is checked by the consumer before this
 * audience is asked. Service-desk items and deletion tombstones never enter
 * the Projects audience; this roster is not a Support audience.
 */
import type { ModuleId, PrismaClient } from "@prisma/client";
import { isGateableModuleId, maxLevelFor } from "../access-catalog.js";
import type { Role } from "../jwt.service.js";

/** How long a resolved roster is reused. */
export const PM_LIVE_ROSTER_TTL_MS = 10_000;

/** People who can be told anything. `service` has no browser to tell. */
const PROJECTS: ModuleId = "projects";
const READER_ROLES = ["owner", "admin", "family", "guest"] as const;

/** A username is an MQTT topic level: no separator, no wildcard, no NUL, not empty. */
const TOPIC_SAFE = /^[^/+#\u0000]+$/;

type AudiencePrisma = Pick<PrismaClient, "user" | "pmWorkItemAssignee">;

export interface PmLiveAudienceDeps {
  prisma: AudiencePrisma;
  /** The box's EFFECTIVE module ids — `getEffectiveModuleIds(prisma, config)`. */
  boxModuleIds: () => Promise<ReadonlySet<ModuleId>>;
  ttlMs?: number;
  /** Clock seam (milliseconds); defaults to the real one. */
  now?: () => number;
}

export interface PmLiveAudience {
  /** Usernames of everyone who can read `workItemId`. */
  usernamesFor(workItemId: string): Promise<string[]>;
  /** Readers of a deleted item; guests are restricted to its deletion-time assignee snapshot. */
  usernamesForDeleted(guestUserIds: readonly string[]): Promise<string[]>;
}

interface Roster {
  at: number;
  /** Usernames of everyone who can read any project item. */
  readers: readonly string[];
  /** Active guests, `User.id` → username: they hear only about what is assigned to them. */
  guests: ReadonlyMap<string, string>;
}

export function createPmLiveAudience(deps: PmLiveAudienceDeps): PmLiveAudience {
  const { prisma } = deps;
  const ttlMs = deps.ttlMs ?? PM_LIVE_ROSTER_TTL_MS;
  const now = deps.now ?? Date.now;
  let cached: Roster | null = null;
  let inflight: Promise<Roster> | null = null;

  async function build(): Promise<Roster> {
    const box = await deps.boxModuleIds();
    if (!box.has("projects")) return { at: now(), readers: [], guests: new Map() };

    const people = await prisma.user.findMany({
      where: { directoryStatus: "ACTIVE", role: { in: [...READER_ROLES] } },
      select: { id: true, username: true, role: true },
    });

    const readers: string[] = [];
    const guests = new Map<string, string>();
    for (const person of people) {
      if (!TOPIC_SAFE.test(person.username)) continue;
      if (person.role === "guest") {
        guests.set(person.id, person.username);
        continue;
      }
      if (!isGateableModuleId(PROJECTS) || maxLevelFor(person.role as Role, PROJECTS) !== null) {
        readers.push(person.username);
      }
    }
    return { at: now(), readers, guests };
  }

  /** The roster, reused for the TTL; callers that arrive mid-refresh share it. */
  function roster(): Promise<Roster> {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached);
    inflight ??= build()
      .then((r) => {
        cached = r;
        return r;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async usernamesFor(workItemId) {
      const { readers, guests } = await roster();
      if (guests.size === 0) return [...readers];
      const assigned = await prisma.pmWorkItemAssignee.findMany({
        where: { workItemId, userId: { in: [...guests.keys()] } },
        select: { userId: true },
      });
      const heardAsGuest: string[] = [];
      for (const { userId } of assigned) {
        const username = guests.get(userId);
        if (username) heardAsGuest.push(username);
      }
      return [...readers, ...heardAsGuest];
    },
    async usernamesForDeleted(guestUserIds) {
      // A tombstone's assignees are historical; access and directory status
      // must be current when intersecting that snapshot with its audience.
      const { readers, guests } = await build();
      const heardAsGuest = new Set<string>();
      for (const userId of guestUserIds) {
        const username = guests.get(userId);
        if (username) heardAsGuest.add(username);
      }
      return [...readers, ...heardAsGuest];
    },
  };
}
