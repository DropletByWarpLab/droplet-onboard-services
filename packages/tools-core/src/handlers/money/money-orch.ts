/**
 * Error mapping for the `money_*` tools (WARP-2581).
 *
 * Mirrors `crm-orch.ts`'s `crmError` in SHAPE and deliberately not in
 * VOCABULARY. The money tool borrowed `crmError` at first, so a ledger that
 * could not be read told the model "CRM_NOT_FOUND" — a customer-record
 * problem, about a question nobody asked. A model handed the wrong domain in
 * the code says the wrong thing to the person who asked, and the code is the
 * part it reasons over.
 *
 * The 404 mapping is where the two domains actually differ. `/api/money/*` is
 * gated by the `money` module's `routePrefixes`, so a 404 here is "this box
 * does not keep its books on this appliance" — a whole surface that is ABSENT,
 * not a record that is missing. `MONEY_NOT_AVAILABLE` says that, and a model
 * reading it will not offer to look the invoice up again.
 */
import type { ToolResult } from "../../types.js";
import { OrchPmError } from "../pm/pm-orch.js";

export type MoneyErrorCode =
  /** The `money` module is off — there is no ledger on this box to read. */
  | "MONEY_NOT_AVAILABLE"
  /** The calling principal may not read the business's ledger. */
  | "MONEY_FORBIDDEN"
  /** A fixable mistake in the request; the orchestrator's message names it. */
  | "MONEY_INVALID_REQUEST"
  /** Anything else, including the 504 `callOrch` raises on its own deadline. */
  | "MONEY_API_ERROR";

export function moneyErrorCode(status: number): MoneyErrorCode {
  if (status === 404) return "MONEY_NOT_AVAILABLE";
  if (status === 403) return "MONEY_FORBIDDEN";
  if (status === 422) return "MONEY_INVALID_REQUEST";
  return "MONEY_API_ERROR";
}

/** One error mapping for every `money_*` handler. */
export function moneyError(err: unknown): ToolResult {
  if (err instanceof OrchPmError) {
    return {
      ok: false,
      status: "error",
      error: { code: moneyErrorCode(err.status), message: err.message },
    };
  }
  // Not a transport error — let the agent loop see it rather than flattening a
  // programming mistake into a tidy tool failure.
  throw err;
}
