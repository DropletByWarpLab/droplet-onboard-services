/**
 * WARP-2887 — shared SSH-login validation.
 *
 * The SSH access card (Network → System) lets the owner choose the username
 * and password of the troubleshooting login. The DASHBOARD validates as the
 * owner types (so the Save button only lights up for input the server will
 * take) and the ORCHESTRATOR re-validates before it mints a Tier-3 token —
 * and the root applier on the host validates the username a third time with
 * the same grammar, as a sed capture group. All three must agree, so the
 * rules live here, in the package both apps already depend on (the
 * `box-name.ts` pattern), and the applier's grammar is pinned to these by the
 * host-script guard test.
 *
 * Username: a POSIX portable name — lowercase letters, digits, `_`, `-`,
 * starting with a letter, 3–32 characters. Password: length only; the
 * orchestrator hashes it, so no charset rule is needed or wanted.
 */

/** 3..32 chars, `[a-z][a-z0-9_-]*`. Mirrored verbatim in the host applier. */
export const SSH_LOGIN_USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

/**
 * Names the host applier will refuse to manage no matter what: it only ever
 * touches accounts it created (members of `droplet-ssh`), and these are the
 * ones a caller might plausibly try. Refused up front so the dashboard and
 * the route give a clear reason rather than a silent host-side `refused`.
 */
export const SSH_LOGIN_RESERVED: ReadonlySet<string> = new Set([
  "root",
  "droplet",
  "nobody",
  "sshd",
  "daemon",
  "sync",
]);

export const SSH_LOGIN_PASSWORD_MIN = 12;
export const SSH_LOGIN_PASSWORD_MAX = 128;

/** True when `username` is a name the login may use. */
export function isValidSshLoginUsername(username: string): boolean {
  return SSH_LOGIN_USERNAME_RE.test(username) && !SSH_LOGIN_RESERVED.has(username);
}

/** True when `password` is within the accepted length and single-line. */
export function isValidSshLoginPassword(password: string): boolean {
  return (
    password.length >= SSH_LOGIN_PASSWORD_MIN &&
    password.length <= SSH_LOGIN_PASSWORD_MAX &&
    !/[\r\n]/.test(password)
  );
}
