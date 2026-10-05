// Data layer for the import wizard and the project export action (WARP-3527):
// thin calls to /api/pm/projects/:id/import, /api/pm/import-jobs/*, and the
// two export downloads. Errors become `ImportRequestError`s whose `message` is
// already plain language, so no snake_case code reaches a person (brief §6).

import { useEffect, useRef } from "react";
import { authFetch } from "@/lib/auth";
import type { ImportAnalysis, ImportJob, ImportMapping, ImportSource } from "./types";
import { ACTIVE_STATUSES } from "./types";

export class ImportRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problems: string[];
  constructor(message: string, status: number, code: string, problems: string[] = []) {
    super(message);
    this.name = "ImportRequestError";
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

const FALLBACK: Record<string, string> = {
  file_too_large: "That file is over 10 MB. Split it and import in parts.",
  too_many_rows: "That file has more than 20,000 rows. Split it and import in parts.",
  empty_file: "The file is empty.",
  not_text: "That doesn't look like a CSV or JSON file. Export from your tool as CSV and try again.",
  invalid_csv: "That file isn't valid CSV.",
  invalid_json: "That file isn't valid JSON.",
  not_a_trello_export: "That JSON isn't a Trello board export.",
  wrong_format: "That preset doesn't fit this file.",
  no_file: "Choose a file to import.",
  import_forbidden: "Only an owner, an admin or the project lead can import work items.",
  import_in_progress: "Another import is already running for this project. Wait for it to finish or cancel it.",
  import_not_editable: "This import has already started, so it can't be changed.",
  import_not_startable: "This import can't be started from where it is.",
  import_not_cancellable: "This import has already finished.",
  import_file_expired: "The uploaded file is no longer kept. Upload it again.",
  import_job_not_found: "That import no longer exists.",
  invalid_import_mapping: "Part of the mapping doesn't match this file or project.",
  project_not_found: "That project no longer exists.",
};

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; problems?: string[] };
  const code = body.error ?? `http_${res.status}`;
  const message =
    body.message ??
    FALLBACK[code] ??
    (res.status >= 500 ? "Something went wrong on the appliance. Try again." : "That didn't work. Try again.");
  throw new ImportRequestError(message, res.status, code, body.problems ?? []);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

const send = (url: string, method: string, body?: unknown): Promise<Response> =>
  authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const importApi = {
  async upload(projectId: string, file: File, source?: ImportSource) {
    const form = new FormData();
    if (source) form.append("source", source);
    form.append("file", file, file.name);
    // no Content-Type: the browser sets the multipart boundary
    return json<{ job: ImportJob; analysis: ImportAnalysis }>(
      await authFetch(`/api/pm/projects/${projectId}/import`, { method: "POST", body: form }),
    );
  },
  async patch(jobId: string, body: { source?: ImportSource; mapping?: ImportMapping }) {
    return json<{ job: ImportJob; analysis: ImportAnalysis }>(await send(`/api/pm/import-jobs/${jobId}`, "PATCH", body));
  },
  async run(jobId: string, mapping?: ImportMapping) {
    return json<{ job: ImportJob }>(await send(`/api/pm/import-jobs/${jobId}/run`, "POST", mapping ? { mapping } : {}));
  },
  async cancel(jobId: string) {
    return json<{ job: ImportJob }>(await send(`/api/pm/import-jobs/${jobId}/cancel`, "POST", {}));
  },
  async get(jobId: string) {
    return json<{ job: ImportJob }>(await authFetch(`/api/pm/import-jobs/${jobId}`));
  },
  async list(projectId: string) {
    return json<{ jobs: ImportJob[] }>(await authFetch(`/api/pm/projects/${projectId}/import-jobs`));
  },
};

/**
 * Poll a job once a second while it is waiting or running. A plain timeout
 * loop rather than SWR: it must stop the moment the job reaches a final status,
 * and a network blip must not end it (the next tick tries again).
 */
export function useJobPolling(
  jobId: string | null,
  status: ImportJob["status"] | null,
  onJob: (job: ImportJob) => void,
  intervalMs = 1000,
): void {
  const cb = useRef(onJob);
  cb.current = onJob;
  const active = jobId !== null && status !== null && ACTIVE_STATUSES.includes(status);
  useEffect(() => {
    if (!active || jobId === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const { job } = await importApi.get(jobId);
        if (!stopped) cb.current(job);
        if (stopped || !ACTIVE_STATUSES.includes(job.status)) return;
      } catch {
        // keep polling; a wedged request is not a failed import
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };
    timer = setTimeout(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, jobId, intervalMs]);
}

/** Save a Blob under a name, the way the audit page does. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The filename the server chose (`INBOX-work-items-2026-10-04.csv`), else a sane default. */
export function filenameFrom(res: Response, fallback: string): string {
  const header = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(header);
  return m ? m[1] : fallback;
}

export async function downloadExport(projectId: string, format: "csv" | "json"): Promise<void> {
  const res = await authFetch(`/api/pm/projects/${projectId}/export.${format}`);
  if (!res.ok) return fail(res);
  saveBlob(await res.blob(), filenameFrom(res, `project-export.${format}`));
}
