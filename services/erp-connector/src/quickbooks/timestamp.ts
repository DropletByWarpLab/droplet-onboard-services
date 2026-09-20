/**
 * WARP-2475 — the vendor modification timestamp, normalised to a UTC instant.
 *
 * Both QuickBooks tracks carry one, and both print the SAME shape: a local
 * wall-clock time with a UTC offset.
 *
 * * QuickBooks Online — `MetaData.LastUpdatedTime` on every entity, ISO-8601
 *   with an offset (`2026-07-15T11:17:56-07:00`).
 * * QuickBooks Desktop — `TimeModified`, a REQUIRED `DATETIMETYPE` element of
 *   `InvoiceRet` and `BillRet` in qbXML. Same shape, and SOMETIMES NAIVE:
 *   older QuickBooks releases print no offset at all.
 *
 * Shared by both rather than written twice because the rule they need is the
 * same one, and a rule about time that exists in two copies drifts into two
 * rules. The QBO track has no naive case today, but it is held to the same
 * refusal so a future Intuit minor version cannot introduce one quietly.
 *
 * ## Why a naive timestamp is REFUSED rather than assumed
 *
 * There is no honest way to resolve one here. `parseResponse` is documented
 * pure — no clock, no I/O — and nothing in the Desktop track declares the
 * QuickBooks host's UTC offset: not `QbwcCredentials`, not `QbwcSessionDeps`,
 * not `QbdSnapshot`. The two available guesses are both wrong:
 *
 * * **Assume UTC.** Wrong by the host's offset, up to a day either way.
 * * **Assume the reading process's zone.** `new Date("2026-07-06T08:30:00")`
 *   silently does this, which additionally makes the result depend on the
 *   machine — green in a UTC CI runner, wrong on a box in Costa Mesa.
 *
 * A watermark TRUSTS this value (WARP-2464). A timestamp guessed forward skips
 * real edits on the next incremental pass with nothing anywhere reporting a
 * fault — the precise failure the canonical column exists to prevent. So an
 * unresolvable timestamp becomes `undefined`, which is what tells the
 * incremental path to fall back to its ordering key and leaves the mandatory
 * sweep as the thing that catches the edit.
 *
 * If a host offset ever becomes available — declared by the operator at
 * connection time, or read from a qbXML `HostQueryRs` — this is the one place
 * that has to change, and the naive branch becomes a conversion rather than a
 * refusal.
 *
 * PURE: no clock, no I/O, no locale.
 */

/**
 * An ISO-8601 instant that states its own offset.
 *
 * The trailing `Z|[+-]HH:MM` group is the load-bearing part: it is what makes
 * a naive timestamp fail the gate rather than fall through to `Date.parse`,
 * which would resolve it in the running process's zone. Both spellings are
 * accepted — a host that prints `Z` is already unambiguous, and rejecting it
 * would blank the column on that host for no reason.
 *
 * Matched against the whole string, so trailing junk cannot ride along on an
 * otherwise well-formed prefix.
 */
const OFFSET_QUALIFIED_ISO =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A vendor modification timestamp as a UTC ISO instant, or `undefined`.
 *
 * `undefined` for every input this cannot resolve honestly: an absent field, a
 * non-string, a naive timestamp, a malformed one, and a well-formed-but-
 * impossible one. Never throws — a single odd row must not take a practice's
 * whole payables read with it.
 */
export function utcInstant(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  const parts = OFFSET_QUALIFIED_ISO.exec(text);
  if (!parts) return undefined;

  // An impossible CALENDAR DAY has to be rejected explicitly, because
  // `Date.parse` does not reject it — it ROLLS OVER. `2026-02-30T00:00:00Z`
  // parses happily to March 2nd, so the gate below is the difference between
  // refusing a malformed timestamp and silently reporting one two days late.
  // (An impossible month or offset — `2026-13-01`, `+25:00` — does yield NaN,
  // so only the day needs this.)
  const [, y, mo, d] = parts.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }

  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}
