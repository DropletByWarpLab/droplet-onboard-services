import { redactCredentials } from "../lib/log-redaction.js";

/** Screen locally before forwarding even to the untrusted edge boundary. */
export function webInputRefusal(value: string, isUrl = false): string | null {
  let decoded = value;
  try {
    for (let i = 0; i < 3; i++) {
      // Preserve a literal percent in ordinary research questions.
      decoded = decodeURIComponent(decoded.replace(/%(?![0-9a-f]{2})/gi, "%25"));
    }
  } catch { return "invalid_input"; }
  if (/%[0-9a-f]{2}/i.test(decoded)) return "invalid_input";
  if (/[\x00-\x1f\x7f]/.test(decoded)) return "invalid_input";
  if (redactCredentials(decoded).count > 0 ||
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(decoded) ||
      /\b\d{3}-\d{2}-\d{4}\b|\b(?:dob|date of birth|patient id|mrn)\s*[:=]\s*\S+/i.test(decoded) ||
      /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*[^\s&]{4,}/i.test(decoded)) {
    return "sensitive_outbound_content";
  }
  if (isUrl) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || value.includes("\\")) return "invalid_url";
      for (const key of url.searchParams.keys()) {
        if (/passw|secret|token|api.?key|auth|credential|session|email|ssn/i.test(key)) return "sensitive_outbound_content";
      }
    } catch { return "invalid_url"; }
  }
  return null;
}
