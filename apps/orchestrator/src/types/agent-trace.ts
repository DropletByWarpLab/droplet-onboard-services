/** One tool dispatch recorded in an agent turn's trace (`runAgent`). */
export interface AgentTraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  /**
   * WARP-3348 — the dispatch reported failure. Set only when true. The parsed
   * `result` alone cannot say so for a remote tool's plain text (`{raw}`).
   */
  isError?: true;
}
