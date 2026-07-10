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

export interface EaglesoftScheduleResponse {
  date: string;
  entries: EaglesoftDetail["schedule"];
}

export function fetchEaglesoftSchedule(
  date: string,
  init?: ApiFetchOptions,
): Promise<EaglesoftScheduleResponse> {
  return apiFetch<EaglesoftScheduleResponse>(
    `/api/erp/schedule?date=${encodeURIComponent(date)}`,
    init,
  );
}

export function searchPatients(
  query: string,
  init?: ApiFetchOptions,
): Promise<PatientResult[]> {
  return apiFetch<PatientResult[]>(
    `/api/erp/patients?query=${encodeURIComponent(query)}`,
    init,
  );
}

export function fetchPatientSummary(
  id: string,
  init?: ApiFetchOptions,
): Promise<PatientSummary> {
  return apiFetch<PatientSummary>(
    `/api/erp/patient/${encodeURIComponent(id)}`,
    init,
  );
}

export interface ConnectionTestResult {
  reachable: boolean;
  serverName?: string;
  version?: string;
  /** Human message on failure ("Nothing answered there — …"). */
  message?: string;
}

/** Non-destructive reachability probe against host:port. */
export function testEaglesoftConnection(
  input: Pick<EaglesoftConnectInput, "host" | "port">,
): Promise<ConnectionTestResult> {
  return apiFetch<ConnectionTestResult>("/api/integrations/eaglesoft/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
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
