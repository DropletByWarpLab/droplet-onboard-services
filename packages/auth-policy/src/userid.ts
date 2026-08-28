export const RESERVED_USERNAMES = ["admin", "root"];
export const USERID_MIN = 2;
export const USERID_MAX = 64;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Pragmatic client-side check; the orchestrator's Zod `.email()` is the
// authority. Mirrors the shape the backend accepts closely enough to drive
// the live checklist without false greens.
//
// Shape: `<local>@<domain>`, no whitespace, exactly one `@`, and the domain
// has a `.` that is neither its first nor its last character. The dot rule
// is checked by index rather than as `[^\s@]+\.[^\s@]+` — that class also
// matches `.`, so a long dotted domain backtracks quadratically (CodeQL
// js/polynomial-redos). Accepts exactly the same strings as before.
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+$/;
export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!EMAIL_SHAPE_RE.test(normalized)) return false;
  const domain = normalized.slice(normalized.indexOf("@") + 1);
  const dot = domain.indexOf(".", 1);
  return dot > 0 && dot < domain.length - 1;
}

const SEPARATORS = new Set(["-", "_", "."]);

/** Trim leading/trailing separators by index. The anchored-run form
 *  (`[-_.]+$`) re-scans the run from every start offset, so a long
 *  separator-only local-part is quadratic (CodeQL js/polynomial-redos). */
function trimSeparators(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && SEPARATORS.has(s.charAt(start))) start++;
  while (end > start && SEPARATORS.has(s.charAt(end - 1))) end--;
  return s.slice(start, end);
}

/** Slugify the email local-part into the conservative Nextcloud-safe charset. */
export function baseUserIdFromEmail(email: string): string {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  let s = trimSeparators(
    local
      .replace(/[^a-z0-9._-]+/g, "-") // drop @, +, unicode, etc.
      .replace(/[-_.]{2,}/g, "-"), // collapse runs of separators
  );
  if (s.length < USERID_MIN) s = "user";
  if (s.length > USERID_MAX) s = s.slice(0, USERID_MAX);
  return s;
}

export function nthUserIdCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return base.slice(0, USERID_MAX - suffix.length) + suffix;
}

export function isReservedUserId(candidate: string): boolean {
  return RESERVED_USERNAMES.includes(candidate.toLowerCase());
}

/**
 * Pure derivation with a synchronous `isTaken` predicate — used in unit
 * tests and any in-memory caller. The orchestrator uses the building
 * blocks above with an async DB-backed loop (see auth.ts deriveUniqueUserId).
 */
export function deriveUserId(
  email: string,
  isTaken: (candidate: string) => boolean,
): string {
  const base = baseUserIdFromEmail(email);
  for (let n = 1; n < 100000; n += 1) {
    const candidate = nthUserIdCandidate(base, n);
    if (isReservedUserId(candidate)) continue;
    if (!isTaken(candidate)) return candidate;
  }
  // Unreachable in practice; satisfies the type checker.
  throw new Error("deriveUserId: exhausted candidate space");
}
