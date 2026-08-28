/**
 * Typed API client for the Integrations / ERP surfaces (WARP-1101).
 *
 * Wraps the shared {@link apiFetch} helper against the orchestrator endpoints
 * defined in the architecture brief (§13): /api/integrations/* and /api/erp/*.
 * The backend lands in Phases 1–4 (WARP-1095/1097/1098); until then these
 * resolve to a 404 and the hooks translate that into the honest
 * "Not connected" state — no crash, no fake data.
 */

import { apiFetch, type ApiFetchOptions } from "./hooks/apiFetch";
import type {
  EaglesoftDetail,
  LanConnectInput,
  IntegrationConnection,
  PatientResult,
  PatientSummary,
  ScheduleEntry,
  AppointmentWriteRequest,
} from "./erp-types";

/** Hub: every provider's live connection status (the catalog is client-side). */
export function fetchIntegrations(): Promise<IntegrationConnection[]> {
  return apiFetch<IntegrationConnection[]>("/api/integrations");
}

/** ERP detail: connection + (when connected) the at-a-glance snapshot. */
export function fetchEaglesoft(): Promise<EaglesoftDetail> {
  return apiFetch<EaglesoftDetail>("/api/integrations/eaglesoft");
}

interface ScheduleEnvelope {
  connected: boolean;
  reason?: string;
  date: string;
  items: ScheduleEntry[];
}

export interface EaglesoftScheduleResponse {
  date: string;
  entries: ScheduleEntry[];
}

/** GET /api/erp/schedule → the backend's { connected, reason, date, items }
 *  envelope, adapted to the { date, entries } the surface renders. */
export async function fetchEaglesoftSchedule(
  date: string,
  init?: ApiFetchOptions,
): Promise<EaglesoftScheduleResponse> {
  const r = await apiFetch<ScheduleEnvelope>(
    `/api/erp/schedule?date=${encodeURIComponent(date)}`,
    init,
  );
  return { date: r.date ?? date, entries: r.items ?? [] };
}

export async function searchPatients(
  query: string,
  init?: ApiFetchOptions,
): Promise<PatientResult[]> {
  // Backend returns { connected, reason, items } — unwrap to the list.
  const r = await apiFetch<{ connected: boolean; reason?: string; items: PatientResult[] }>(
    `/api/erp/patients?query=${encodeURIComponent(query)}`,
    init,
  );
  return r.items ?? [];
}

export async function fetchPatientSummary(
  id: string,
  init?: ApiFetchOptions,
): Promise<PatientSummary | null> {
  // Backend returns { connected, reason, patient } — unwrap (null when
  // not-connected / not-found).
  const r = await apiFetch<{ connected: boolean; reason?: string; patient: PatientSummary | null }>(
    `/api/erp/patient/${encodeURIComponent(id)}`,
    init,
  );
  return r.patient ?? null;
}

export interface ConnectionTestResult {
  reachable: boolean;
  serverName?: string;
  version?: string;
  /** Human message on failure ("Nothing answered there — …"). */
  message?: string;
}

/**
 * Non-destructive reachability probe against host:port, for ANY LAN-database
 * track (WARP-2451).
 *
 * The provider key is a PARAMETER rather than a literal in the path. It was a
 * literal while exactly one LAN provider existed, which made the connect
 * wizard un-generalisable without also rewriting its network calls — and a
 * wizard that renders a second vendor's fields but posts to the first vendor's
 * endpoint is worse than one that refuses. `encodeURIComponent` because the
 * key is free-text TEXT on the row, not a closed union.
 */
export async function testLanConnection(
  provider: string,
  input: Pick<LanConnectInput, "host" | "port">,
): Promise<ConnectionTestResult> {
  // Backend returns { ok, reason, message } — adapt to { reachable, message }.
  const r = await apiFetch<{ ok: boolean; reason?: string; message?: string }>(
    `/api/integrations/${encodeURIComponent(provider)}/test`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return { reachable: r.ok, message: r.message };
}

/** Runs provisioning + verification and lands the connection CONNECTED. */
export function connectLanProvider(
  provider: string,
  input: LanConnectInput,
): Promise<EaglesoftDetail> {
  return apiFetch<EaglesoftDetail>(
    `/api/integrations/${encodeURIComponent(provider)}/connect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

/** The write kill-switch / opt-in. */
export function setEaglesoftWrites(
  enabled: boolean,
): Promise<IntegrationConnection> {
  return apiFetch<IntegrationConnection>(
    `/api/integrations/eaglesoft/${enabled ? "write-enable" : "write-disable"}`,
    { method: "POST" },
  );
}

/** Disconnect the integration — stops Droplet reading; Eaglesoft data untouched. */
export function disconnectEaglesoft(): Promise<IntegrationConnection> {
  return apiFetch<IntegrationConnection>("/api/integrations/eaglesoft/disconnect", {
    method: "POST",
  });
}

/** Stage a write (outbox) — never writes to Eaglesoft directly. */
export function createAppointmentWriteRequest(
  req: AppointmentWriteRequest,
): Promise<AppointmentWriteRequest> {
  return apiFetch<AppointmentWriteRequest>("/api/erp/write-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

/** Human-confirm a staged write → apply → verify (server-side). */
export function confirmWriteRequest(
  id: string,
): Promise<AppointmentWriteRequest> {
  return apiFetch<AppointmentWriteRequest>(
    `/api/erp/write-requests/${encodeURIComponent(id)}/confirm`,
    { method: "POST" },
  );
}
