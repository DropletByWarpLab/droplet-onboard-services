// A stateful stand-in for the orchestrator's /api/pm time routes, for the time
// surface's component tests (WARP-3526).
//
// It behaves like the server where the UI depends on it — an entry created is
// listed next, a timer started is the one read back, starting on another item
// stops the first and reports the worklog it wrote — and records every request
// so a test can assert what was sent. It does NOT re-implement the server's
// rules (minutes bounds, who may edit what, the timezone arithmetic): those are
// proven where they live, in apps/orchestrator. What a test wants from it is
// "the right request went out and the answer came back".

import type { PmProject } from "@/components/projects/types";
import type {
  PmTimeItemRef,
  PmTimer,
  PmTimeReport,
  PmTimesheet,
  PmWorklog,
} from "@/components/projects/time/types";

export interface FakeCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

export interface FakeUser {
  id: string;
  userId: string;
  username: string;
  displayName: string;
}

export interface FakeTimeState {
  /** The signed-in person: whose entries a POST creates. */
  me: string;
  worklogs: PmWorklog[];
  /** What the list endpoint reports as the item's total; derived when left null. */
  totalEntriesOverride: number | null;
  timer: PmTimer | null;
  /** The minutes a stop (or a start that stops another timer) writes. */
  stopMinutes: number;
  stopCapped: boolean;
  timesheet: PmTimesheet | null;
  report: PmTimeReport | null;
  csv: string;
  users: FakeUser[];
  /** What `/api/pm/projects` lists — only the page-level tests need any. */
  projects: PmProject[];
  /** `"METHOD /path-regex"` → the error the next matching request gets. Sticky until cleared. */
  failures: Array<{ match: RegExp; method: string; status: number; error: string }>;
  calls: FakeCall[];
}

export const ITEM_1: PmTimeItemRef = { id: "w1", key: "INBOX-1", name: "First task", projectId: "p1", archived: false };
export const ITEM_9: PmTimeItemRef = { id: "w9", key: "INBOX-9", name: "Ninth task", projectId: "p1", archived: false };

export function worklog(over: Partial<PmWorklog> & Pick<PmWorklog, "id" | "minutes">): PmWorklog {
  return {
    workItemId: "w1",
    userId: "u-me",
    startedAt: "2026-10-02T15:00:00.000Z",
    note: "",
    createdAt: "2026-10-02T15:30:00.000Z",
    updatedAt: "2026-10-02T15:30:00.000Z",
    ...over,
  };
}

export function createFakeTimeApi(initial: Partial<FakeTimeState> = {}) {
  const state: FakeTimeState = {
    me: "u-me",
    worklogs: [],
    totalEntriesOverride: null,
    timer: null,
    stopMinutes: 25,
    stopCapped: false,
    timesheet: null,
    report: null,
    csv: "User,Minutes,Hours,Entries\r\n",
    users: [
      { id: "me", userId: "u-me", username: "me", displayName: "Mia Member" },
      { id: "sam", userId: "u-sam", username: "sam", displayName: "Sam Admin" },
    ],
    projects: [],
    failures: [],
    calls: [],
    ...initial,
  };
  let seq = 0;

  const reply = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      blob: () => Promise.resolve(new Blob([typeof body === "string" ? body : JSON.stringify(body)])),
      headers: new Headers(),
    }) as unknown as Response;

  const csvReply = (): Response =>
    ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      blob: () => Promise.resolve(new Blob([state.csv], { type: "text/csv" })),
      headers: new Headers({ "Content-Disposition": 'attachment; filename="droplet-time-user-2026-10-01-to-2026-10-04.csv"' }),
    }) as unknown as Response;

  const total = (): number => state.worklogs.reduce((n, w) => n + w.minutes, 0);

  async function handler(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    state.calls.push({ url, method, body });
    const path = url.split("?")[0];

    for (const f of state.failures) {
      if (f.method === method && f.match.test(path)) return reply(f.status, { error: f.error });
    }

    // ── worklogs ──
    let m = /^\/api\/pm\/work-items\/([^/]+)\/worklogs$/.exec(path);
    if (m && method === "GET") {
      const mine = state.worklogs.filter((w) => w.workItemId === m![1]);
      return reply(200, {
        worklogs: [...mine].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        total_minutes: mine.reduce((n, w) => n + w.minutes, 0),
        total_entries: state.totalEntriesOverride ?? mine.length,
      });
    }
    if (m && method === "POST") {
      const row = worklog({
        id: `wl-new-${++seq}`,
        workItemId: m[1],
        userId: (body?.user_id as string | undefined) ?? state.me,
        minutes: body?.minutes as number,
        note: (body?.note as string | undefined) ?? "",
        startedAt: (body?.started_at as string | undefined) ?? new Date().toISOString(),
      });
      state.worklogs.push(row);
      return reply(201, { worklog: row });
    }
    m = /^\/api\/pm\/worklogs\/([^/]+)$/.exec(path);
    if (m && method === "PATCH") {
      const row = state.worklogs.find((w) => w.id === m![1]);
      if (!row) return reply(404, { error: "worklog_not_found" });
      if (body?.minutes !== undefined) row.minutes = body.minutes as number;
      if (body?.started_at !== undefined) row.startedAt = body.started_at as string;
      if (body?.note !== undefined) row.note = body.note as string;
      return reply(200, { worklog: row });
    }
    if (m && method === "DELETE") {
      state.worklogs = state.worklogs.filter((w) => w.id !== m![1]);
      return reply(200, { deleted: m[1] });
    }

    // ── timer ──
    if (path === "/api/pm/timer" && method === "GET") return reply(200, { timer: state.timer });
    if (path === "/api/pm/timer/start" && method === "POST") {
      const itemId = body?.work_item_id as string;
      let stopped: PmWorklog | null = null;
      if (state.timer && state.timer.workItemId !== itemId) {
        stopped = worklog({
          id: `wl-new-${++seq}`,
          workItemId: state.timer.workItemId,
          userId: state.me,
          minutes: state.stopMinutes,
          startedAt: state.timer.startedAt,
        });
        state.worklogs.push(stopped);
      }
      if (!state.timer || state.timer.workItemId !== itemId) {
        const item = itemId === ITEM_9.id ? ITEM_9 : { ...ITEM_1, id: itemId };
        state.timer = { userId: state.me, workItemId: itemId, startedAt: new Date().toISOString(), workItem: item };
      }
      return reply(200, { timer: state.timer, stopped });
    }
    if (path === "/api/pm/timer/stop" && method === "POST") {
      if (!state.timer) return reply(404, { error: "timer_not_found" });
      const row = worklog({
        id: `wl-new-${++seq}`,
        workItemId: state.timer.workItemId,
        userId: state.me,
        minutes: state.stopMinutes,
        startedAt: state.timer.startedAt,
      });
      state.worklogs.push(row);
      state.timer = null;
      return reply(200, { worklog: row, capped: state.stopCapped });
    }

    // ── timesheet + report ──
    if (path === "/api/pm/timesheet" && method === "GET") {
      return state.timesheet ? reply(200, { timesheet: state.timesheet }) : reply(500, { error: "no_fixture" });
    }
    if (path === "/api/pm/time/report" && method === "GET") {
      if (url.includes("format=csv")) return csvReply();
      return state.report ? reply(200, { report: state.report }) : reply(500, { error: "no_fixture" });
    }

    // ── the people directory + everything else the drawer and the page read ──
    if (path === "/api/auth/users") return reply(200, { users: state.users });
    if (path === "/api/pm/people") return reply(200, { people: state.users.filter((u) => u.userId).map((u) => ({ id: u.userId, displayName: u.displayName, avatarUrl: null })) });
    if (path === "/api/pm/projects") return reply(200, { projects: state.projects });
    if (path === "/api/pm/work-items/query" && method === "POST") return reply(200, { work_items: [], total: 0, nextCursor: null, counts: { all: 0 } });
    if (path.endsWith("/cycles")) return reply(200, { cycles: [] });
    if (path === "/api/pm/summary") {
      return reply(200, { summary: { activeProjects: state.projects.length, itemsOpen: 0, doneThisWeek: 0, overdue: 0 } });
    }
    if (path === "/api/departments") return reply(200, { departments: [] });
    if (path.endsWith("/states")) return reply(200, { states: [] });
    if (path.endsWith("/comments")) return reply(200, { comments: [] });
    if (path.endsWith("/activity")) return reply(200, { activity: [] });
    if (path.endsWith("/labels")) return reply(200, { labels: [] });
    if (path.endsWith("/work-items") || path.includes("/work-items?")) return reply(200, { work_items: [] });
    return reply(200, {});
  }

  return { state, handler, total };
}
