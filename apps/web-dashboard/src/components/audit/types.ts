/**
 * WARP-246 — wire types for the admin audit viewer.
 *
 * Mirrors the orchestrator's WARP-456 activity surface:
 *   GET /api/activity           (list; id serialized as string)
 *   GET /api/activity/verify    (server-side hash-chain walk)
 *
 * TODO(WARP-1009/#789): actor filter once actorType/actorId land on
 * the ActivityRow shape — the filter bar is built around what the API
 * has today (kind, time range, free-text q over what/sub).
 */

export const ACTIVITY_KINDS = [
  "chat",
  "tool_call",
  "file",
  "camera",
  "network",
  "smart_home",
  "email",
  "auth",
  "tool_run",
  "system",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivitySeverity = "ok" | "warn" | "err" | "info";

/** Home-user labels for the wire enum. */
export const KIND_LABELS: Record<ActivityKind, string> = {
  chat: "Chat",
  tool_call: "Tool call",
  file: "Files",
  camera: "Cameras",
  network: "Network",
  smart_home: "Smart home",
  email: "Email",
  auth: "Sign-in & accounts",
  tool_run: "Tool run",
  system: "System",
};

export interface ActivityItem {
  id: string;
  at: string;
  severity: ActivitySeverity;
  sourceIcon: string;
  what: string;
  sub: string | null;
  kind: ActivityKind;
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
}

export interface ActivityListResponse {
  items: ActivityItem[];
  nextCursor: string | null;
}

/** GET /api/activity/verify result. */
export interface VerifyResult {
  ok: boolean;
  rowsChecked: number;
  brokenAtId?: string;
  verifiedAt: string;
}

/** Client-side badge state machine. */
export type VerifyState =
  | { phase: "checking" }
  | { phase: "ok"; rowsChecked: number; verifiedAt: string }
  | { phase: "broken"; rowsChecked: number; brokenAtId: string; verifiedAt: string }
  | { phase: "error"; message: string };
