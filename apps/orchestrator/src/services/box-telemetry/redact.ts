/**
 * WARP-3504 (ADR-068) — box-side redaction of a log message before it can be
 * queued for the portal (`logs.v1`, `msg`). Defense in depth: the portal masks
 * the same shapes again and stores only the masked text.
 *
 * Order matters and is pinned by redact.test.ts:
 *   1. the existing secret scrub (lib/log-redaction.ts: PEMs, bearer tokens,
 *      `KEY=value`, URI passwords, provider tokens, JWTs);
 *   2. web addresses, emails, MACs, IPv6, IPv4, Windows and POSIX paths;
 *   3. quoted fragments (a name in quotes is the usual way a value lands in a
 *      message), host names and file names (anything dotted ending in letters),
 *      and long tokens (24+ token characters containing a digit: ids, hashes,
 *      UUIDs);
 *   4. control characters collapsed, then the 500-character cut, AFTER masking
 *      so a mask is never cut in half by the limit and a secret never survives
 *      at the cut.
 *
 * Over-masking is the right failure here: a message that lost a word still
 * has its code; a message that kept a customer's file name broke the contract.
 * Pure and synchronous; every pattern is linear (the input is bounded first).
 */
import { redactSecrets } from "../../lib/log-redaction.js";
import { MSG_MAX_CHARS } from "./contract.js";

const INPUT_BOUND = 4_000;

const to = (mask: string) => (): string => mask;

const RULES: ReadonlyArray<readonly [RegExp, (m: string) => string]> = [
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>)]+/gi, to("[url]")],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to("[email]")],
  [/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, to("[mac]")],
  // IPv6: any run with a `::`, or the full eight groups. A bare `12:30:45` is a time, not an address.
  [/(?<![\w:])[0-9a-f:]*::[0-9a-f:]*(?![\w:])/gi, to("[ip]")],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, to("[ip]")],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, to("[ip]")],
  [/\b[A-Za-z]:\\[^\s"']*/g, to("[path]")],
  [/(?<![\w/.:~-])\/[\w.@+~%=-]+(?:\/[\w.@+~%=-]*)*/g, to("[path]")],
  [/"[^"\n]{1,80}"/g, to('"[x]"')],
  [/(?<![A-Za-z])'[^'\n]{1,80}'(?![A-Za-z])/g, to("'[x]'")],
  [/`[^`\n]{1,80}`/g, to("`[x]`")],
  [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi, to("[host]")],
  [/[A-Za-z0-9_+=-]{24,}/g, (m) => (/\d/.test(m) ? "[token]" : m)],
];

/** Mask `raw`, collapse whitespace and cut to 500 characters. Never throws. */
export function redactMessage(raw: string): string {
  let out = redactSecrets(raw.slice(0, INPUT_BOUND));
  for (const [pattern, mask] of RULES) out = out.replace(pattern, mask);
  return out
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MSG_MAX_CHARS);
}
