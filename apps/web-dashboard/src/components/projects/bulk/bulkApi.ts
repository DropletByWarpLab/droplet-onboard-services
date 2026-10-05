// WARP-3537 — the bulk-edit request: `POST /api/pm/work-items/bulk`.
//
// Its own small client, not a function in usePm.ts: the error carries the `ids` the
// orchestrator names (which items were forbidden, which did not fit), which the
// shared `send` helper drops, and the bulk surface should not have to widen the
// module every other Projects screen mocks.

import type { PmBulkPatch } from "@droplet/shared-types";
import { authFetch } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import type { PmWorkItem } from "../types";

/** A refusal from the bulk route. `code` is the wire `error`; `ids` the work items it is about. */
export class BulkRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly ids: string[];
  constructor(message: string, status: number, code: string | undefined, ids: string[]) {
    super(message);
    this.name = "BulkRequestError";
    this.status = status;
    this.code = code;
    this.ids = ids;
  }
}

export interface BulkResponse {
  /** Items that actually changed. */
  changed: number;
  work_items: PmWorkItem[];
}

export async function bulkEdit(req: { ids: string[]; patch: PmBulkPatch }): Promise<BulkResponse> {
  const res = await authFetch("/api/pm/work-items/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    throw new BulkRequestError(body.error ?? `Request failed (${res.status})`, res.status, body.error, ids);
  }
  return (await res.json()) as BulkResponse;
}

const items = (n: number) => (n === 1 ? "1 of these items" : `${n} of these items`);

/**
 * What to tell a person when a batch is refused. The batch is all-or-nothing, so
 * every one of these says that NOTHING was changed — the thing a person most needs
 * to know after a failure — and where it can, how many items were the reason.
 */
export function bulkErrorMessage(err: unknown): string {
  if (err instanceof BulkRequestError) {
    if (err.code === "work_items_forbidden") {
      const n = err.ids.length;
      return n > 0
        ? `You can't change ${items(n)}, so nothing was changed. Select fewer items and try again.`
        : "You can't change some of these items, so nothing was changed.";
    }
    if (err.code === "work_item_not_found") {
      return "Some of these items are gone, so nothing was changed. The list has been refreshed.";
    }
    if (err.code === "invalid_state" || err.code === "invalid_label" || err.code === "invalid_cycle") {
      return "Those items don't all belong to the same project, so nothing was changed. Select items from one project.";
    }
    if (err.code === "concurrent_mutation") {
      return "Someone else changed these items at the same time, so nothing was changed. Try again.";
    }
  }
  return translateError(err, "projects");
}
