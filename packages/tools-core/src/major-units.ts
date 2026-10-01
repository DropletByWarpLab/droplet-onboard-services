/**
 * WARP-3400 — money as a MODEL should read it: major units, never cents.
 *
 * The box stores and ships money as MINOR units (`CrmDeal.amountMinor` is a
 * decimal string of cents). That is right for storage and for the clients,
 * and wrong for the model: handed `amount_minor: "1000000"`, it read the
 * digits as dollars and quoted a $10,000.00 deal as "USD 1,000,000" — a
 * 100x overstatement in every answer, briefing and run summary that touched a
 * deal, and 1000x on a three-decimal currency. There is no field a model can
 * be told to "divide" reliably, so the tools stop handing it one: every
 * model-facing result carries `amount` (a major-unit decimal string,
 * "10000.00") and `amount_display` ("$10,000.00") instead.
 *
 * Both are produced by STRING surgery (`formatMinorUnits` in shared-types, the
 * same converter the brain block uses), never `Number()`: `JSON.parse` would
 * turn "9007199254740993" into …992, off by one, in a figure somebody is
 * about to quote to a customer. The exponent is per currency (JPY 0, KWD 3).
 *
 * Unknown means null, never a guess. A missing amount, a missing currency or
 * a code that is not ISO-4217 returns null for BOTH fields: an amount with no
 * denomination is the exact shape that caused this bug.
 */
import { formatMinorUnits, minorUnitExponent } from "@droplet/shared-types";

export interface MajorMoney {
  /** Decimal string in major units, e.g. "10000.00". */
  amount: string;
  /** Ready to quote, e.g. "$10,000.00" or "KWD 1,000.000". */
  display: string;
}

/**
 * A MAJOR-unit decimal string → "$10,000.00". Used directly for the ERP
 * documents, which already arrive in major units (`NUMERIC` → "4210.55").
 *
 * The fraction is padded to the currency's exponent and never truncated, so a
 * ledger that sends sub-unit precision is shown as sent. A symbol that ends in
 * a letter ("CHF", "KWD") gets a space; "$" and "¥" do not.
 */
export function displayMajor(amount: string, currency: string): string | null {
  const exponent = minorUnitExponent(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (exponent === null || match === null) return null;
  const [, sign, whole, fraction = ""] = match;
  const code = currency.trim().toUpperCase();
  const symbol =
    new Intl.NumberFormat("en-US", { style: "currency", currency: code })
      .formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? code;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = fraction.padEnd(exponent, "0");
  return `${sign}${symbol}${/[A-Za-z]$/.test(symbol) ? " " : ""}${grouped}${decimals ? `.${decimals}` : ""}`;
}

/** Minor units + currency → major-unit fields, or null when either is unknown. */
export function majorFromMinor(
  minor: string | bigint | null | undefined,
  currency: string | null | undefined,
): MajorMoney | null {
  if (minor === null || minor === undefined || !currency) return null;
  const amount = formatMinorUnits(minor, currency);
  const display = amount === null ? null : displayMajor(amount, currency);
  return amount === null || display === null ? null : { amount, display };
}
