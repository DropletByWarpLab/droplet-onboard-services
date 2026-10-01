/**
 * WARP-3375 — WHAT a connector copies onto the box, so the Disconnect confirm
 * can say exactly what each choice does.
 *
 * The orchestrator's landing seam (`erp-sync/land.ts`, `land-money.ts`) and the
 * dashboard's disconnect copy both need this answer, and a sentence in a
 * confirm that disagrees with what the box actually copies is the lie this
 * ticket removes. So the two dataset lists live HERE and the box re-exports
 * them; nothing restates them.
 *
 *  • CRM datasets land in Customers (`CrmCompany`, `Contact`, `CrmDeal`).
 *  • Ledger datasets land as `ErpDocument` rows (invoices and bills), and only
 *    from a track that declares them — a LAN practice-management track's
 *    receivables are a patient ledger and are never landed.
 *
 * Everything else a connector serves is read-through (asked for when needed,
 * nothing kept) or polled and discarded today.
 */
import type { ProviderDescriptor } from "./provider-descriptor";

/** Datasets that land in the CRM. */
export const LANDED_CRM_DATASETS = ["company", "contact", "deal"] as const;

/** Datasets that land as ledger documents. */
export const LANDED_LEDGER_DATASETS = ["invoice", "bill"] as const;

export interface LandedRecords {
  /** The CRM datasets this provider copies into Customers, in canonical order. */
  readonly crm: readonly (typeof LANDED_CRM_DATASETS)[number][];
  /** The ledger datasets this provider copies into Money, in canonical order. */
  readonly ledger: readonly (typeof LANDED_LEDGER_DATASETS)[number][];
}

/**
 * What this provider copies onto the box. A provider with no descriptor
 * (the open `<vendor>-export` family) declares nothing and lands nothing.
 */
export function landedRecords(
  descriptor: Pick<ProviderDescriptor, "track" | "datasets"> | undefined,
): LandedRecords {
  if (!descriptor) return { crm: [], ledger: [] };
  // Widened first: the `mcp` variant's `datasets` is the empty tuple, and a
  // method call on a union of array types would not type its callback.
  const datasets: readonly string[] = descriptor.datasets;
  return {
    crm: LANDED_CRM_DATASETS.filter((d) => datasets.includes(d)),
    // Mirrors the `not-cloud` refusal in `land-money.ts`: `cloud` and `rest`
    // are the tracks that declare their datasets and hold a vendor ledger.
    ledger:
      descriptor.track === "cloud" || descriptor.track === "rest"
        ? LANDED_LEDGER_DATASETS.filter((d) => datasets.includes(d))
        : [],
  };
}
