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
  | { ok: true; path: string }
  | { ok: false; error: string };

export function validateNcPath(input: unknown): ValidatedPath {
  if (typeof input !== "string") return { ok: false, error: "path must be a string" };
  if (input.length === 0) return { ok: false, error: "path is required" };
  if (input.length > MAX_PATH_LEN) return { ok: false, error: "path too long" };
  if (input.includes("\0")) return { ok: false, error: "null byte in path" };

  // Iteratively percent-decode until a fixed point. Sabre/DAV (Nextcloud's
  // WebDAV layer) decodes percent escapes before resolving paths, so a
  // literal '%2e%2e' segment would slip past a naive '..' check and only
  // get treated as traversal once the server decoded it.
  let decoded = input;
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return { ok: false, error: "malformed percent-encoding in path" };
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("\0")) return { ok: false, error: "null byte in path" };
  for (const candidate of [input, decoded]) {
    if (candidate.split(/[\\/]/).some((seg) => seg === "..")) {
      return { ok: false, error: "path traversal not allowed" };
    }
  }

  const normalized = path.posix.normalize(decoded.startsWith("/") ? decoded : "/" + decoded);
  if (normalized === "/") return { ok: true, path: "/" };
  if (normalized.split("/").slice(1).some((seg) => seg === "")) {
    return { ok: false, error: "empty path segment" };
  }
  return { ok: true, path: normalized };
}
