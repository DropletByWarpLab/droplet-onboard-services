"use client";

// WARP-3533 — data layer for Settings -> Developer: SWR reads and the mutations
// against /api/developer. The shapes below are the orchestrator route contract
// (routes/developer.ts); they are defined here because only this page reads them.

import useSWR from "swr";

import { authFetch } from "@/lib/auth";

/** Explicit state, never derived from `revokedAt` being set. */
export type DevTokenStatus = "active" | "revoked" | "expired";

export interface DevTokenRow {
  id: string;
  name: string;
  /** The 8 characters after `dpm_`, for display only. */
  prefix: string;
  scopes: string[];
  status: DevTokenStatus;
  createdAt: string;
  /** `null` = the holder chose no expiry. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type DevTokenWithUser = DevTokenRow & {
  user: { id: string; displayName: string };
};

/** A scope this box can grant, with the words to show for it. */
export interface DevScope {
  id: string;
  label: string;
  description: string;
}

export interface DeveloperState {
  /** The workspace switch. Off by default; an owner or admin turns it on. */
  enabled: boolean;
  canCreate: boolean;
  isAdmin: boolean;
  /** Only the scopes of the modules that are on; empty when there is nothing to reach. */
  scopes: DevScope[];
  /** The caller's own tokens, any status, newest first. */
  tokens: DevTokenRow[];
  /** Where the OpenAPI document is served. */
  openapiPath: string;
}

export interface FeedRow {
  kind: "my_work" | "project";
  projectId: string | null;
  name: string;
  identifier: string | null;
  state: "active" | "none";
  createdAt: string | null;
  expiresAt: string | null;
}

/** What a feed link is for: "my work", or one project. */
export type FeedTarget = { kind: "my_work" } | { kind: "project"; projectId: string };

/** Carries the HTTP status and the `error` code: a 403 is a locked page, a
 *  409 `disabled` means an admin switched tokens off meanwhile, a 404
 *  `module_disabled` means Projects is off. */
export class DeveloperError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super(code ?? `Request failed (${status})`);
    this.name = "DeveloperError";
    this.status = status;
    this.code = code;
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new DeveloperError(res.status, body.error);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Pass `skip` for a viewer the box refuses outright (an external guest). */
export function useDeveloper(skip: boolean) {
  const { data, error, isLoading, mutate } = useSWR<DeveloperState, DeveloperError>(
    skip ? null : "/api/developer",
    call,
    { shouldRetryOnError: false },
  );
  return { state: data, error, isLoading, mutate };
}

/** Every person's tokens. Owner/admin only, so nobody else asks. */
export function useAllDevTokens(isAdmin: boolean) {
  const { data, error, mutate } = useSWR<{ tokens: DevTokenWithUser[] }, DeveloperError>(
    isAdmin ? "/api/developer/tokens/all" : null,
    call,
    { shouldRetryOnError: false },
  );
  return { tokens: data?.tokens, error, mutate };
}

/** The caller's calendar links. A 404 `module_disabled` means Projects is off. */
export function useFeeds(skip: boolean) {
  const { data, error, isLoading, mutate } = useSWR<{ feeds: FeedRow[] }, DeveloperError>(
    skip ? null : "/api/developer/feeds",
    call,
    { shouldRetryOnError: false },
  );
  return { feeds: data?.feeds, error, isLoading, mutate };
}

export function setApiTokensEnabled(enabled: boolean): Promise<DeveloperState> {
  return call("/api/developer/settings", send("PUT", { enabled }));
}

/** The secret comes back once, here, and is never readable again. */
export function createApiToken(input: {
  name: string;
  scopes: string[];
  expiresAt: string | null;
}): Promise<{ token: string; row: DevTokenRow }> {
  return call("/api/developer/tokens", send("POST", input));
}

export function revokeApiToken(id: string): Promise<void> {
  return call(`/api/developer/tokens/${encodeURIComponent(id)}`, send("DELETE"));
}

/** The link comes back once, here (a path; the page adds the origin). */
export function rotateFeed(target: FeedTarget): Promise<{ url: string; expiresAt: string }> {
  return call("/api/developer/feeds/rotate", send("POST", target));
}

export function revokeFeed(target: FeedTarget): Promise<{ revoked: number }> {
  return call("/api/developer/feeds/revoke", send("POST", target));
}

/**
 * Fetch the OpenAPI document with the session (a plain link would carry a cookie
 * that may have expired since the page loaded) and hand it to the browser as a
 * file download.
 */
export async function downloadOpenApi(path: string): Promise<void> {
  const res = await authFetch(path);
  if (!res.ok) throw new DeveloperError(res.status, undefined);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "droplet-projects.openapi.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
