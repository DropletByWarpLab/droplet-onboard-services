"use client";

// WARP-3452 — data layer for Settings → Coding tools: SWR reads and the
// mutations against /api/llm-access. The shapes below are the orchestrator
// route contract; they are defined here because only this page reads them.

import useSWR from "swr";

import { authFetch } from "@/lib/auth";

/** Explicit state, never derived from `revokedAt` being set. */
export type LlmTokenStatus = "active" | "revoked" | "expired";

export interface LlmTokenRow {
  id: string;
  label: string;
  /** The 8 characters after `dlk_`, for display only. */
  prefix: string;
  status: LlmTokenStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  usage30d: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    errors: number;
  };
}

export type LlmTokenWithUser = LlmTokenRow & {
  user: { id: string; displayName: string };
};

export interface LlmAccessState {
  enabled: boolean;
  canCreate: boolean;
  isAdmin: boolean;
  /** The runtime id coding tools must send, or null when no model is active. */
  activeModel: string | null;
  contextWindow: number | null;
  /** The caller's own tokens, any status, newest first. */
  tokens: LlmTokenRow[];
}

/** Carries the HTTP status and the `error` code: a 403 is a locked page, a
 *  409 `disabled` means an admin switched the feature off meanwhile. */
export class LlmAccessError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super(code ?? `Request failed (${status})`);
    this.name = "LlmAccessError";
    this.status = status;
    this.code = code;
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new LlmAccessError(res.status, body.error);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Pass `skip` for a viewer the box refuses outright (an external guest). */
export function useLlmAccess(skip: boolean) {
  const { data, error, isLoading, mutate } = useSWR<LlmAccessState, LlmAccessError>(
    skip ? null : "/api/llm-access",
    call,
    { shouldRetryOnError: false },
  );
  return { access: data, error, isLoading, mutate };
}

/** Every person's tokens. Owner/admin only, so nobody else asks. */
export function useAllLlmTokens(isAdmin: boolean) {
  const { data, error, mutate } = useSWR<{ tokens: LlmTokenWithUser[] }, LlmAccessError>(
    isAdmin ? "/api/llm-access/tokens/all" : null,
    call,
    { shouldRetryOnError: false },
  );
  return { tokens: data?.tokens, error, mutate };
}

export function setLlmAccessEnabled(enabled: boolean): Promise<LlmAccessState> {
  return call("/api/llm-access/settings", send("PUT", { enabled }));
}

/** The secret comes back once, here, and is never readable again. */
export function createLlmToken(label: string): Promise<{ token: string; row: LlmTokenRow }> {
  return call("/api/llm-access/tokens", send("POST", { label }));
}

export function renewLlmToken(id: string): Promise<LlmTokenRow> {
  return call(`/api/llm-access/tokens/${encodeURIComponent(id)}/renew`, send("POST"));
}

export function revokeLlmToken(id: string): Promise<void> {
  return call(`/api/llm-access/tokens/${encodeURIComponent(id)}`, send("DELETE"));
}
