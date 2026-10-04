/**
 * WARP-3625 — outbound bearer for first-party internal APIs that fail closed
 * on a shared service token (voice-io, rag-eval, file-indexer).
 *
 * Reads process.env at call time (like internal-tls.ts) so a recreate with a
 * rotated token needs no code path of its own. An unset token sends no header:
 * the peer then answers 503/401 itself, which the callers already relay as
 * "unavailable" — the orchestrator never invents a credential.
 */
export const VOICE_IO_TOKEN_ENV = "VOICE_IO_SERVICE_TOKEN";
export const RAG_EVAL_TOKEN_ENV = "RAG_EVAL_SERVICE_TOKEN";
export const FILE_INDEXER_TOKEN_ENV = "FILE_INDEXER_SERVICE_TOKEN";

export function serviceBearerHeader(envName: string): Record<string, string> {
  const token = (process.env[envName] ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
