/**
 * WARP-437 — private enhancement bundle for the `search_content` tool.
 *
 * Set by the orchestrator's LLM agent loop BEFORE dispatching the MCP
 * tool call; consumed by the mcp-server's `ctx.searchHybrid` shim and
 * threaded into `searchHybrid`'s queryEnhancement / overrides.
 *
 * NOT part of the LLM-visible `inputSchema` for `search_content` — the
 * LLM emits the tool call with `query` + optional `enhance`, then the
 * orchestrator hand-resolves `enhance` into pre-computed vectors and
 * attaches THIS field via the MCP `_meta` channel (which is reserved
 * for protocol metadata and is NOT schema-validated against the tool's
 * `inputSchema`). The leading underscore is the convention that tells
 * humans "orchestrator-injected, not LLM-controllable."
 *
 * Trust boundary: the only producer is the orchestrator's agent loop on
 * stdio (in-process, trusted). The HTTP transport path does NOT plumb
 * `_meta._enhancement` to handlers — that channel is stdio-only.
 */
export interface PrivateEnhancement {
  /** Pre-computed HyDE passage embedding (averaged with the raw query vector). */
  hydeVector?: number[];
  /** Pre-computed paraphrase embeddings for multi-query RRF fusion. */
  extraQueryVectors?: number[][];
  /** Soft metadata filter applied to vector + lexical arms. */
  metadataFilter?: { filenameContains?: string };
  /** Per-call overrides to `searchHybrid`'s default knobs. */
  searchOverrides?: {
    minSimilarity?: number;
    perArmK?: number;
    rerankCandidates?: number;
  };
}
