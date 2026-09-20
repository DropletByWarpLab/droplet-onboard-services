/**
 * Money, as minor units, without ever touching a float.
 *
 * WARP-2549. The CRM already settled the shape money takes on this box: an
 * integer of MINOR units in `CrmDeal.amountMinor` (a Postgres `BigInt`),
 * carried across every boundary as a decimal STRING, because `Number()`
 * silently rounds above 2^53 — which for a currency figure is a wrong number
 * rather than an error.
 *
 * What was missing is the other direction. Every cloud vendor serves money in
 * MAJOR units as a decimal string (`"1234.50"`), and until something converts
 * that into minor units nothing a connector reads can be landed. Two facts
 * make the conversion less obvious than "multiply by 100":
 *
 *   • **The exponent is per currency, not universal.** JPY and KRW have no
 *     minor unit at all (¥1000 is 1000 minor units, not 100000), and BHD, JOD,
 *     KWD, OMR and TND have three (1.500 KWD is 1500 fils). A hardcoded 100
 *     is wrong by a factor of 100 on a yen figure and by 10 on a dinar one,
 *     silently, in the direction that overstates.
 *   • **Multiplication is where the float creeps back in.** `1234.56 * 100` is
 *     `123455.99999999999` in IEEE-754. So this module never multiplies: it
 *     moves the decimal point by string surgery and hands the digits to
 *     `BigInt`, which is exact by construction.
 *
 * The refusals are as load-bearing as the conversions. A value this module
 * cannot represent exactly returns `null` rather than a rounded number, and
 * the caller lands no amount at all. An amount that is wrong by a hundredth is
 * indistinguishable, on the page, from one that is right — an ABSENT amount is
 * at least honest about not knowing.
 *
 * ⚠ No `BigInt` LITERALS in this file. `apps/web-dashboard` compiles
 * `packages/shared-types` from SOURCE against a pre-ES2020 target, where `0n`
 * is a syntax error rather than a fallback. `BigInt(0)` compiles everywhere.
 */

/** The default ISO-4217 exponent. Two applies to the large majority of codes. */
export const DEFAULT_MINOR_UNIT_EXPONENT = 2;

/**
 * Every ISO-4217 code whose exponent is NOT 2, and nothing else.
 *
 * Listing only the exceptions is deliberate: a table of all ~180 codes would
 * be a table to keep current, and its stale rows would be indistinguishable
 * from its correct ones. The exception set changes on the order of once a
 * decade (the last move was ISK to 0), and a code missing from it takes the
 * correct default rather than no answer.
 *
 * Source: ISO 4217:2015 Table A.1 minor-unit column.
 */
export const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  // — no minor unit —
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // — three —
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // — four —
  CLF: 4,
  UYW: 4,
};

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * How many decimal places this currency's minor unit has, or `null` when the
 * argument is not an ISO-4217 alpha-3 code at all.
 *
 * `null` and `0` are different answers and the caller must not conflate them:
 * `0` is "yen, and the whole number IS the minor amount", `null` is "I do not
 * know what this is". Returning `2` for an unrecognised string would invent a
 * denomination for a currency nobody identified.
 */
export function minorUnitExponent(currency: string): number | null {
  const code = currency.trim().toUpperCase();
  if (!CURRENCY_CODE.test(code)) return null;
  const exponent = MINOR_UNIT_EXPONENTS[code];
  return exponent === undefined ? DEFAULT_MINOR_UNIT_EXPONENT : exponent;
}

/** Digits, one optional point, optional sign. No exponent notation, no separators. */
const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Convert a MAJOR-unit decimal string into minor units for `currency`.
 *
 * Returns `null` — never a guess — when the value cannot be represented
 * exactly:
 *
 *   • not a plain decimal (`"1,234.50"`, `"1.2e3"`, `"USD 12"`, `""`, `"."`)
 *   • an unrecognised currency code
 *   • more fraction digits than the currency has, unless the surplus digits
 *     are all zeros. `"1.500"` in USD is 150 minor units and is accepted;
 *     `"1.505"` in USD is not, because the only ways to land it are to round
 *     (a different amount) or to truncate (a different amount).
 *
 * The vendor sending sub-unit precision is the case worth naming: Stripe's
 * `unit_amount_decimal` and several billing systems price in thousandths. The
 * right answer there is a column that can hold it, not a rounded copy of it in
 * one that cannot.
 */
export function toMinorUnits(major: string, currency: string): bigint | null {
  const exponent = minorUnitExponent(currency);
  if (exponent === null) return null;

  const match = DECIMAL.exec(major.trim());
  if (!match) return null;

  const [, sign, whole = "", fraction = ""] = match;
  // `"."`, `"-"` and `""` all reach here with no digits at all. A number with
  // no digits is not a zero, it is an absent value wearing a zero's clothes.
  if (whole.length === 0 && fraction.length === 0) return null;

  let digits = fraction;
  if (digits.length > exponent) {
    const surplus = digits.slice(exponent);
    if (!/^0*$/.test(surplus)) return null;
    digits = digits.slice(0, exponent);
  }
  const padded = digits.padEnd(exponent, "0");

  // BigInt parses "007" and "-0" correctly, so leading zeros need no surgery.
  // `sign` is "+" at most once and BigInt rejects it, so normalise it away.
  const negative = sign === "-";
  const value = BigInt(`${whole === "" ? "0" : whole}${padded}`);
  return negative ? -value : value;
}

/**
 * Render minor units back as a MAJOR-unit decimal string.
 *
 * Deliberately not localised and deliberately not symbolised: this is the
 * value, and how a surface presents it (grouping, symbol placement, the
 * customer's locale) is that surface's decision. `null` for an unrecognised
 * currency, on the same reasoning as `minorUnitExponent`.
 */
export function formatMinorUnits(minor: bigint | string, currency: string): string | null {
  const exponent = minorUnitExponent(currency);
  if (exponent === null) return null;

  let value: bigint;
  try {
    value = typeof minor === "bigint" ? minor : BigInt(minor.trim());
  } catch {
    return null;
  }

  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, "0");
  if (exponent === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
