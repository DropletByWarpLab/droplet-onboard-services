/**
 * WARP-3965 — pure helpers over `ConnectorDirectoryEntry`, shared by the
 * Connectors directory, the detail page and the tests. Nothing here reads the
 * network or the DOM.
 */
import type { ConnectorDirectoryEntry, ToolGrade, ToolPermission } from "@/lib/api";

/** Statuses of a business system that count as "set up" for the Yours tab. */
const LIVE_SYSTEM = new Set([
  "CONNECTED",
  "CAPABILITY_LIMITED",
  "DEGRADED",
  "DRIFT_LOCKED",
  "NEEDS_RECONNECT",
]);

/**
 * Whether this entry is the viewer's own. An MCP server is the member's when
 * their sign-in or the Workspace's is CONNECTED; owners and admins also see a
 * server a colleague connected (the box's `anyoneConnected`), which a member
 * never does: a tick on someone else's sign-in would claim access they lack.
 */
export function isYours(e: ConnectorDirectoryEntry, canManage: boolean): boolean {
  const c = e.connection;
  if (c.kind === "system") return LIVE_SYSTEM.has(c.status);
  if (c.workspaceState === "DISABLED") return false;
  return (
    c.member?.state === "CONNECTED" ||
    c.workspace?.state === "CONNECTED" ||
    (canManage && c.anyoneConnected)
  );
}

export function matchesQuery(e: ConnectorDirectoryEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.name, e.vendor, e.tagline, ...e.categories].some((s) => s.toLowerCase().includes(needle));
}

export function allCategories(entries: readonly ConnectorDirectoryEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.categories))].sort((a, b) => a.localeCompare(b));
}

export const PERMISSION_LABEL: Record<ToolPermission, string> = {
  always: "Always allow",
  ask: "Ask first",
  block: "Blocked",
};

/**
 * The product contract, mirrored so a control can disable what the box would
 * refuse: reads take any of the three, writes ask or block, destructive
 * actions are blocked and nothing else. The box enforces it either way.
 */
export function legalPermissions(grade: ToolGrade): readonly ToolPermission[] {
  if (grade === "read") return ["always", "ask", "block"];
  if (grade === "write") return ["ask", "block"];
  return ["block"];
}

const STRICTNESS: Record<ToolPermission, number> = { always: 0, ask: 1, block: 2 };

/** An admin may only tighten (always, then ask, then block); the owner may do anything legal. */
export function isLoosening(from: ToolPermission, to: ToolPermission): boolean {
  return STRICTNESS[to] < STRICTNESS[from];
}

/** The sentence a card shows for the viewer's state. */
export function stateBadge(e: ConnectorDirectoryEntry): { label: string; tone: "ok" | "warn" | "muted" } | null {
  const c = e.connection;
  if (c.kind === "system") {
    if (c.status === "CONNECTED") return { label: "Connected", tone: "ok" };
    if (c.status === "NOT_CONFIGURED") return null;
    return LIVE_SYSTEM.has(c.status) ? { label: "Needs attention", tone: "warn" } : { label: "Off", tone: "muted" };
  }
  if (c.workspaceState === "DISABLED") return { label: "Off for the Workspace", tone: "muted" };
  const s = c.member?.state;
  if (s === "CONNECTED") return { label: "Connected", tone: "ok" };
  if (s === "NEEDS_RECONNECT" || s === "ERROR") return { label: "Sign in again", tone: "warn" };
  return null;
}
