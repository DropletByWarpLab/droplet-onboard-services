import { authFetch } from "@/lib/auth";
import type { ExtensionStatus } from "@/lib/types";

export interface HostedApp {
  id: string;
  slug: string;
  workspaceId?: string;
  name: string;
  version: string | null;
  status: ExtensionStatus;
  url: string;
  memoryMb: number;
  lastHealthAt: string | null;
  grants: string[];
}
export interface HostedApps { apps: HostedApp[]; supervisionEnabled: boolean; nextCursor?: string | null }
export interface HostedLogs {
  output: string;
  startSequence: number;
  nextSequence: number;
  retainedBytes: number;
  droppedBytes: number;
  truncated: boolean;
  note?: string;
}

export class HostedAppError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(code ?? `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    throw new HostedAppError(res.status, typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : null);
  }
  return res.json() as Promise<T>;
}

export function hostedErrorCopy(error: unknown): string {
  if (error instanceof HostedAppError) {
    if (error.code === "supervision_off") return "Apps are turned off on this Droplet.";
    if (error.code === "MFA_ENROLLMENT_REQUIRED") return "Turn on two-factor sign-in in Settings first, then try again.";
    if (error.code === "mfa_required" || error.code === "mfa_stale") return "Confirm it's you to continue.";
    if (error.code === "STEP_UP_PASSWORD_REQUIRED" || error.code === "INVALID_PASSWORD") return "Confirm your current password to continue.";
    if (error.status === 403) return "You do not have access to this app. Ask the owner.";
    if (error.status === 404) return "This app is no longer available.";
    if (error.status === 409) return "This app is not running yet. Ask the owner to check it.";
  }
  return "The Droplet could not complete that. Try again in a moment.";
}

export const fetchHostedApps = (options: { cursor?: string; workspaceId?: string } = {}): Promise<HostedApps> => {
  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.workspaceId) query.set("workspaceId", options.workspaceId);
  return request(`/api/hosted${query.size ? `?${query}` : ""}`);
};
export const mintHostedAppSession = (slug: string, signal?: AbortSignal): Promise<{ url: string }> => request(
  `/api/hosted/${encodeURIComponent(slug)}/session`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", ...(signal ? { signal } : {}) },
);
export const fetchHostedAppLogs = (slug: string): Promise<HostedLogs> => request(
  `/api/hosted/${encodeURIComponent(slug)}/logs?limit=200`,
);
export const fetchHostedAppGrants = (slug: string): Promise<{ roles: string[] }> => request(
  `/api/extensions/${encodeURIComponent(slug)}/grants`,
);
export const updateHostedAppGrants = (slug: string, roles: string[], currentPassword?: string): Promise<{ roles: string[] }> => request(
  `/api/extensions/${encodeURIComponent(slug)}/grants`,
  { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles, ...(currentPassword ? { currentPassword } : {}) }) },
);

/** Create a saved chat before starting its run, so it can be watched there. */
export class HostedSetupError extends Error {
  constructor(readonly sessionId: string, readonly cause: unknown) { super("Could not start app setup"); }
}
export async function startHostedAppSetup(workspaceId: string, name: string, existingSessionId?: string,
  options: { signal?: AbortSignal; isCurrent?: () => boolean } = {}): Promise<string> {
  const requireCurrent = () => {
    if (options.signal?.aborted || options.isCurrent?.() === false) throw new DOMException("App setup retired", "AbortError");
  };
  requireCurrent();
  const conversation = existingSessionId ? { id: existingSessionId } : await request<{ id: string }>("/api/llm/conversations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `Set up ${name}` }), signal: options.signal,
  });
  // The first request may finish after navigation or an account replacement.
  requireCurrent();
  try { await request("/api/agent-runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "app-setup", workspaceId, sessionId: conversation.id,
      goal: `Set up the hosted app in workspace ${workspaceId}. Read its files, build and check it, then propose a version for the owner to review.` }), signal: options.signal,
  }); } catch (error) { throw new HostedSetupError(conversation.id, error); }
  requireCurrent();
  return `/chat?c=${encodeURIComponent(conversation.id)}`;
}
