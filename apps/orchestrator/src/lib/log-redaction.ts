/**
 * WARP-823 — secret redaction for the downloadable log bundle.
 *
 * The Settings → "Download diagnostics" log bundle ships journald + container
 * logs off the box to the operator. Those logs routinely echo secret material:
 * env dumps on boot, connection strings, `Authorization: Bearer` headers a
 * proxy logged, the occasional pasted PEM. This module is the MANDATORY scrub
 * applied to every byte before it can leave the appliance (architecture-guard
 * rule 19 — no secrets in anything that leaves the box).
 *
 * Design posture: FAIL CLOSED on shape, not on enumeration. We do not try to
 * know every secret value (impossible — values are random). Instead we match
 * the SHAPES secrets take in logs and replace the value with a fixed
 * placeholder, keeping the surrounding non-secret context (key name, log
 * prefix) so the bundle is still useful for debugging.
 *
 * The same scrub runs in two places for defense in depth:
 *   1. the repo-tracked host collector script (scripts/host/droplet-collect-logs.sh)
 *      redacts as it reads journald/docker on the host, and
 *   2. here, in the orchestrator, on every chunk before it is written into the
 *      zip — so even a collector that missed something (older host script, a
 *      novel log format) cannot leak past this gate.
 *
 * This module is pure + synchronous so the planted-secret unit test
 * (`log-redaction.test.ts`) is the authoritative proof that known secrets never
 * survive, independent of any host.
 */

/** The fixed marker that replaces any redacted secret value. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Env/key names whose VALUE is always a secret. Matched case-insensitively as a
 * whole word, so `JWT_SECRET`, `redis_password`, `service-token-display` etc.
 * all hit. We match on the generic suffixes (TOKEN/SECRET/KEY/PASSWORD/PASSWD/
 * PSK/CREDENTIAL) rather than enumerating every var so a NEW secret env added
 * later is redacted with no code change — the opposite of an allow-list that
 * silently leaks the next addition.
 */
const SENSITIVE_KEY_WORD =
  "[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY|PSK|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*";

/**
 * Carve-out: env keys that match {@link SENSITIVE_KEY_WORD} on `KEY` but are
 * NOT secret — a public key / key *id* is safe and is occasionally useful for
 * diagnosing a mismatch. Matched case-insensitively as a whole key. Anything
 * not on this list that ends in `KEY` is redacted (fail closed: over-redact a
 * log bundle rather than leak a private key the suffix heuristic didn't model).
 */
const SAFE_KEY_RE = /(?:PUBLIC[_-]?KEY|KEY[_-]?ID|KEYID|_PUBKEY)$/i;

/**
 * Ordered list of (pattern → replacement) rules. Each replacement keeps the
 * non-secret prefix it captured (`$1`) and substitutes the placeholder for the
 * secret value. Order matters: the multi-line PEM rule runs first so a key
 * body can't be partially matched by a later single-line rule.
 */
interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (substring: string, ...groups: string[]) => string;
}

const RULES: readonly RedactionRule[] = [
  {
    // PEM blocks: -----BEGIN [X] PRIVATE KEY----- ... -----END [X] PRIVATE KEY-----
    // Collapse the whole block (delimiters + body) to a single placeholder so no
    // base64 key material survives. `[\s\S]` so it spans newlines without the
    // `s` flag (kept off to stay explicit).
    name: "pem-private-key",
    pattern:
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    replace: () => `${REDACTION_PLACEHOLDER} (private key)`,
  },
  {
    // Credentials embedded in a URI userinfo: scheme://user:SECRET@host
    // Redacts only the password component, preserving scheme/user/host so the
    // line still tells you which service/db it was. The username class is `*`
    // (not `+`) so empty-username forms — `redis://:pw@host`, the exact shape
    // secrets.sh generates for REDIS_URL, and `postgresql://:pw@db/...` — are
    // also redacted. The trailing `@` anchor still prevents matching a plain
    // `host:port` with no userinfo.
    name: "uri-userinfo",
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/g,
    replace: (_m, pre: string, _secret: string, at: string) =>
      `${pre}${REDACTION_PLACEHOLDER}${at}`,
  },
  {
    // Authorization: Bearer <token>  (and bare "Bearer <token>")
    name: "bearer-token",
    pattern: /(\bBearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi,
    replace: (_m, pre: string) => `${pre}${REDACTION_PLACEHOLDER}`,
  },
  {
    // Custom auth headers carrying a raw token value:
    //   X-Droplet-Auth: <tok>, Authorization: <tok>, X-Api-Key: <tok>
    // The value alternation matches "scheme + credential" FIRST for the
    // 5-char schemes (`Basic`/`Token`) — the bare `{6,}` arm can't reach them
    // (5 < 6), so `Authorization: Basic <base64>` would otherwise keep its
    // credential: only the scheme word got redacted, by the fallback
    // assignment rule. Scheme + credential are collapsed together (fail
    // closed — over-redact rather than leak).
    name: "auth-header",
    pattern:
      /\b(X-Droplet-Auth|Authorization|X-Api-Key|X-Auth-Token|Proxy-Authorization)(\s*[:=]\s*)((?:Basic|Token)\s+[^\s",;]+|[^\s",;]{6,})/gi,
    replace: (_m, header: string, sep: string) =>
      `${header}${sep}${REDACTION_PLACEHOLDER}`,
  },
  {
    // Sensitive KEY=value or KEY: value (env dumps, structured logs). The value
    // may be bare, single- or double-quoted. We keep the key + the operator so
    // the line stays legible; only the value is replaced.
    name: "sensitive-assignment",
    pattern: new RegExp(
      `\\b(${SENSITIVE_KEY_WORD})(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s"',;]+)`,
      "gi",
    ),
    replace: (whole: string, key: string, sep: string) =>
      // A public key / key-id matched on the `KEY` suffix is not secret — leave
      // it intact. Everything else loses its value.
      SAFE_KEY_RE.test(key) ? whole : `${key}${sep}${REDACTION_PLACEHOLDER}`,
  },
];

/**
 * Scrub every known secret SHAPE out of `text`, returning a copy where each
 * secret value is replaced by {@link REDACTION_PLACEHOLDER}. Non-secret context
 * (log timestamps, request lines, key names) is preserved.
 *
 * Idempotent: running it again over already-redacted output is a no-op, because
 * the placeholder contains none of the shapes the rules match.
 *
 * Pure + synchronous + never throws (a malformed line is left as-is rather than
 * aborting the whole bundle — but the rules are written so the placeholder, not
 * the raw value, is what falls through on a partial match).
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as (...args: string[]) => string);
  }
  return out;
}
