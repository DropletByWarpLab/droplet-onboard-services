/** One tool dispatch recorded in an agent turn's trace (`runAgent`). */
export interface AgentTraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}
