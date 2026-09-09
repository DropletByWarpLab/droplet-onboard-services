// Shared path validation for Nextcloud-scoped tools.
//
// The LLM is driven by user-controlled prompt text (and any document the
// agent has read). A malicious prompt — or a poisoned doc — could try to
// coerce a write to '../etc/...' or '/' to delete the whole drive. WebDAV
// would reject most of these, but defense-in-depth at the tool boundary
// costs nothing and gives us a clean error the model can surface.

import path from "node:path";

export const MAX_PATH_LEN = 4096;
export const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB cap on LLM-driven writes

export type ValidatedPath =
  // `trailingSlash` records that the caller spelled the path as a directory
  // ("/Notes/"). The separator is normalized away from `path`; tools that
  // need a filename (write_file) use the flag to refuse rather than invent
  // one. Root is never reported as trailing.
  | { ok: true; path: string; trailingSlash: boolean }
  | { ok: false; error: string };

export function validateNcPath(input: unknown): ValidatedPath {
  if (typeof input !== "string") return { ok: false, error: "path must be a string" };
  if (input.length === 0) return { ok: false, error: "path is required" };
  if (input.length > MAX_PATH_LEN) return { ok: false, error: "path too long" };

  // Traversal is checked on every form a downstream decoder could reach.
  // Sabre/DAV (Nextcloud's WebDAV layer) percent-decodes before resolving a
  // path, and it decodes LENIENTLY — PHP's rawurldecode turns each
  // well-formed "%XX" into its byte and leaves a bare "%" alone — so
  // "/Notes/%2e%2e/%zz" reaches it as "/Notes/../%zz". The guard has to be
  // at least as willing to decode as the server is. Refusing the whole path
  // on the first malformed escape (what this did until PR #1985) rejected
  // "50% Off Report.pdf"; merely stopping at that escape would have let the
  // "%2e%2e" beside it through. Iterated to a fixed point so a
  // double-encoded "%252e%252e" is caught too.
  const forms = [input];
  for (let i = 0; i < 4; i++) {
    const next = decodePercentLeniently(forms[forms.length - 1]);
    if (next === forms[forms.length - 1]) break;
    forms.push(next);
  }

  // The path itself is decoded STRICTLY, and only as far as it stays
  // well-formed: from the first malformed escape on, the string is taken as
  // written. A bare "%" is a filename character, not an encoding error.
  let decoded = input;
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if ([...forms, decoded].some((f) => f.includes("\0"))) {
    return { ok: false, error: "null byte in path" };
  }
  for (const candidate of [...forms, decoded]) {
    if (candidate.split(/[\\/]/).some((seg) => seg === "..")) {
      return { ok: false, error: "path traversal not allowed" };
    }
  }

  // `path.posix.normalize` already collapses duplicate separators
  // ("/A//B" -> "/A/B") but preserves a trailing one ("/A/B/" stays
  // "/A/B/"), which then reads as an empty final segment. WARP-1373: the
  // model writes directory paths with a trailing slash constantly, so
  // strip it here — after the traversal guard above, which runs on the raw
  // and decoded input and is unaffected by this.
  const normalized = path.posix.normalize(decoded.startsWith("/") ? decoded : "/" + decoded);
  const trimmed = normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  if (trimmed === "/") return { ok: true, path: "/", trailingSlash: false };
  if (trimmed.split("/").slice(1).some((seg) => seg === "")) {
    return { ok: false, error: "empty path segment" };
  }
  return { ok: true, path: trimmed, trailingSlash: trimmed !== normalized };
}

/**
 * PHP `rawurldecode` semantics, which is what Sabre/DAV applies: each
 * well-formed "%XX" becomes its byte, anything else is left untouched. Only
 * the ASCII bytes matter to the traversal guard (".", "/" and the backslash)
 * and a byte-wise view is exact for those; a multi-byte UTF-8 sequence comes
 * out as mojibake here, which is why this form is only ever COMPARED and
 * never used as the path.
 */
function decodePercentLeniently(s: string): string {
  return s.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
