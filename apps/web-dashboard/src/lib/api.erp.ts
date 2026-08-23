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
  EaglesoftConnectInput,
  EaglesoftDetail,
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
  /**
   * WARP-2135 — carried, not dropped. The orchestrator distinguishes three
   * states and this adapter used to flatten the last two into one:
   *   connected: true                              → a real answer
   *   connected: true,  reason: DATASET_NOT_SERVED → connector is healthy,
   *     it just does not serve this dataset
   *   connected: false, reason: ERP_NOT_CONNECTED  → nothing is connected
   * With both fields gone, an empty `entries` was the only signal left, so a
   * served-but-not-for-this-dataset vendor was indistinguishable from a box
   * with no practice system at all — and got told it had none.
   */
  connected: boolean;
  reason?: string;
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
  return {
    date: r.date ?? date,
    entries: r.items ?? [],
    // Absent `connected` means the not-yet-wired 404 path (see the module
    // banner) — that is "not connected", never an optimistic true.
    connected: r.connected === true,
    reason: r.reason,
  };
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

/** Non-destructive reachability probe against host:port. */
export async function testEaglesoftConnection(
  input: Pick<EaglesoftConnectInput, "host" | "port">,
): Promise<ConnectionTestResult> {
  // Backend returns { ok, reason, message } — adapt to { reachable, message }.
  const r = await apiFetch<{ ok: boolean; reason?: string; message?: string }>(
    "/api/integrations/eaglesoft/test",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return { reachable: r.ok, message: r.message };
}

/** Runs provisioning + verification and lands the connection CONNECTED. */
export function connectEaglesoft(
  input: EaglesoftConnectInput,
): Promise<EaglesoftDetail> {
  return apiFetch<EaglesoftDetail>("/api/integrations/eaglesoft/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
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
