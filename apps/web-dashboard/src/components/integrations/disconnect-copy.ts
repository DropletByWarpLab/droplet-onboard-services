/**
 * WARP-3375 — the words the Disconnect confirm uses, per connector.
 *
 * Kept out of the component so a test can pin every sentence for every
 * connector shape without rendering anything. What the sentences claim is
 * derived from `landedRecords()` in `@droplet/shared-types`, the same lists the
 * box's landing seam copies with, so the copy cannot promise a removal the box
 * does not perform or hide one it does.
 *
 * Three shapes, all real today:
 *
 *  • copies nothing — read-through connectors (Eaglesoft, Cal.com, GitHub,
 *    GitLab, Todoist, Atlassian) and the connectors whose datasets are polled
 *    and discarded (Mailchimp, Shopify, Loyverse, Square). There is no choice
 *    to offer, and the confirm says so instead of implying a removal.
 *  • CRM records — HubSpot, Pipedrive, Brevo, Klaviyo and Xero's contacts land
 *    in Customers. Keep detaches them into ordinary records; Delete removes
 *    them, archiving any that carry a note a person wrote.
 *  • ledger documents — QuickBooks, Stripe and Xero's invoices and bills land
 *    in Money as read-only copies. They cannot be turned into ordinary
 *    records, so Keep leaves them where they are and Delete removes them.
 *
 * "Not revoked at the vendor" is said in every shape: the box cannot revoke a
 * key it did not mint (ADR-042 §6), and the old "your data is untouched" said
 * nothing about that.
 */
import type { LandedRecords } from "@droplet/shared-types";

const CRM_NOUN = { company: "companies", contact: "contacts", deal: "deals" } as const;
const LEDGER_NOUN = { invoice: "invoices", bill: "bills" } as const;

/** "a", "a and b", "a, b and c". */
function joined(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface DisconnectCopy {
  /** True when the connector copied nothing, so there is no choice to offer. */
  readonly copiesNothing: boolean;
  /** The opening statement, shown in every shape. */
  readonly intro: string;
  /** What "Keep the records" does. Empty when the connector copied nothing. */
  readonly keep: string;
  /** What "Delete the records" does. Empty when the connector copied nothing. */
  readonly remove: string;
  /** The heading of the second, red confirmation. */
  readonly confirmDeleteTitle: string;
  /** The body of the second, red confirmation. */
  readonly confirmDeleteBody: string;
}

export function disconnectCopy(name: string, landed: LandedRecords): DisconnectCopy {
  const crm = joined(landed.crm.map((d) => CRM_NOUN[d]));
  const ledger = joined(landed.ledger.map((d) => LEDGER_NOUN[d]));
  const copiesNothing = landed.crm.length === 0 && landed.ledger.length === 0;

  const base =
    `Disconnect ${name}? Droplet stops reading it and removes the stored credential. ` +
    `Nothing in your ${name} account changes, and the key is not revoked there.`;

  if (copiesNothing) {
    return {
      copiesNothing,
      intro: `${base} Droplet keeps no copy of your ${name} data, so no records on this box are affected.`,
      keep: "",
      remove: "",
      confirmDeleteTitle: "",
      confirmDeleteBody: "",
    };
  }

  const keep = [
    landed.crm.length > 0 &&
      `The ${crm} copied from ${name} stay in Customers as ordinary records your team can edit. They stop syncing.`,
    landed.ledger.length > 0 &&
      `The ${ledger} copied from ${name} stay in Money as read-only copies. They stop updating.`,
  ].filter(Boolean);

  const remove = [
    landed.crm.length > 0 &&
      `The ${crm} copied from ${name} are deleted from Customers. Any that carry a note your team wrote are archived instead, so the note is kept.`,
    landed.ledger.length > 0 &&
      `The ${ledger} copied from ${name} are deleted from Money, with their balance history.`,
  ].filter(Boolean);

  const everything = joined([
    ...landed.crm.map((d) => CRM_NOUN[d]),
    ...landed.ledger.map((d) => LEDGER_NOUN[d]),
  ]);

  return {
    copiesNothing,
    intro: `${base} Droplet copied some of your ${name} data onto this box. Choose what happens to it.`,
    keep: keep.join(" "),
    remove: remove.join(" "),
    confirmDeleteTitle: `Delete the ${everything} copied from ${name}?`,
    confirmDeleteBody:
      `This deletes them from this box and cannot be undone. ` +
      (landed.crm.length > 0
        ? `Records with a note your team wrote are archived, not deleted. `
        : "") +
      `Your ${name} account is not changed.`,
  };
}
