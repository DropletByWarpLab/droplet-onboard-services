/**
 * WARP-246 — wire types for the admin audit viewer.
 *
 * Mirrors the orchestrator's WARP-456 activity surface:
 *   GET /api/activity           (list; id serialized as string)
 *   GET /api/activity/verify    (server-side hash-chain walk)
 *   POST /api/activity/export   (sealed NDJSON bundle, same filters)
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

/** Customer-facing labels for the wire enum. */
export const KIND_LABELS: Record<ActivityKind, string> = {
  chat: "Chat",
  tool_call: "Tool call",
  file: "Files",
  camera: "Cameras",
  network: "Network",
  smart_home: "Smart devices",
  email: "Email",
  auth: "Sign-in & accounts",
  tool_run: "Tool run",
  system: "System",
};

/** WARP-181: who performed the action (null on pre-upgrade v1 rows). */
export const ACTIVITY_ACTOR_TYPES = ["user", "ai", "system", "anonymous"] as const;

export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

/** Home-user labels for the actor enum (filter dropdown vocabulary). */
export const ACTOR_TYPE_LABELS: Record<ActivityActorType, string> = {
  user: "A person",
  ai: "Droplet AI",
  system: "The system",
  anonymous: "Anonymous",
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
  /** WARP-181 actor attribution — present on the wire since #789,
   *  nulled on v1 rows (their actor columns are outside the signature,
   *  so the API refuses to serve them as truth). Rendered per row and
   *  filterable since WARP-1009. */
  actorType?: ActivityActorType | null;
  actorId?: string | null;
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
  /** `message` is homeowner-calm copy; `detail` carries the raw cause
   *  (HTTP status etc.) for a title-attribute tooltip only. */
  | { phase: "error"; message: string; detail?: string };
