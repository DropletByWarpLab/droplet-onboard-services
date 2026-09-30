/**
 * The `StepDispatcher` a ToolSpec run dispatches through: one MCP tool call,
 * its result parsed, a tool-reported failure thrown.
 *
 * WARP-2972 — `context` is forwarded to `callTool`, which puts it in MCP
 * `_meta` for the stdio child. That is the ONLY channel by which the
 * mcp-server learns who a call is for: over stdio the person is
 * `_meta.userId`, and the module gate's person axis (`module_disabled`) reads
 * it there. A dispatcher that drops `context` makes every call the box's, so
 * the person's own grants stop applying to it. The scheduled-run dispatcher in
 * `index.ts` was exactly that, which is why it is built here, where a test can
 * reach it, instead of inline in the boot file.
 */
import type { McpClientPort } from "./mcp-client.port.js";
import type { StepDispatcher } from "./tool-spec-runner.service.js";

export function createMcpStepDispatcher(mcp: Pick<McpClientPort, "callTool">): StepDispatcher {
  return {
    async call(tool, args, context) {
      const result = await mcp.callTool(tool, args, context);
      if (result.isError) {
        const detail = result.content?.[0]?.text ?? "tool reported error";
        throw new Error(typeof detail === "string" ? detail : String(detail));
      }
      const text = result.content?.[0]?.text;
      if (typeof text === "string" && text.length > 0) {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }
      return null;
    },
  };
}
