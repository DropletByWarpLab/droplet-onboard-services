"use client";

// WARP-3504 (ADR-068) — data layer for Settings → What this Droplet sends:
// one SWR read of GET /api/telemetry/last. The shapes below are the
// orchestrator route contract (services/box-telemetry/contract.ts); they are
// defined here because only this page reads them.

import useSWR from "swr";

import { authFetch } from "@/lib/auth";

export type TelemetryKind = "heartbeat" | "events" | "logs";

/** Where the box is with Warp. Explicit on the wire, never inferred here. */
export type TelemetryLinkState =
  | "disabled"
  | "unconfigured"
  | "starting"
  | "ok"
  | "retrying"
  | "not_enrolled"
  | "revoked";

export interface TelemetrySentRecord {
  sentAt: string;
  /** The exact JSON that was sent. */
  payload: unknown;
}

export interface TelemetrySchemaDoc {
  schema: string;
  endpoint: string;
  summary: string;
  fields: Array<{ path: string; meaning: string }>;
}

export interface TelemetryLast {
  state: TelemetryLinkState;
  portalHost: string | null;
  heartbeatIntervalSec: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** A short code, never a message. */
  lastErrorCode: string | null;
  queued: Record<TelemetryKind, number>;
  dropped: number;
  last: Record<TelemetryKind, TelemetrySentRecord | null>;
  schemas: TelemetrySchemaDoc[];
  neverSent: string[];
  retention: { rawDays: number; dailySummaryMonths: number };
}

export class TelemetryLastError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Request failed (${status})`);
    this.name = "TelemetryLastError";
    this.status = status;
  }
}

async function fetchLast(url: string): Promise<TelemetryLast> {
  const res = await authFetch(url);
  if (!res.ok) throw new TelemetryLastError(res.status);
  return (await res.json()) as TelemetryLast;
}

/** Pass `skip` for a viewer who may not see it (anyone but owner or admin). */
export function useTelemetryLast(skip: boolean) {
  const { data, error, isLoading, mutate } = useSWR<TelemetryLast, TelemetryLastError>(
    skip ? null : "/api/telemetry/last",
    fetchLast,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );
  return { last: data, error, isLoading, mutate };
}
