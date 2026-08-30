import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

interface ApiStageSummary {
  stageId: string;
  stageName: string;
  kind: string;
  sortOrder: number;
  dealCount: number;
  amountMinor: string;
  currency: string | null;
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const data = await callOrch<{ pipelineId: string; stages?: ApiStageSummary[] }>(
      ctx,
      "get",
      "/api/crm/summary",
    );
    return {
      ok: true,
      data: {
        stages: (data.stages ?? []).map((s) => ({
          stage: s.stageName,
          outcome: s.kind,
          deals: s.dealCount,
          // A stage holding more than one currency reports currency: null, and
          // the orchestrator does NOT sum across them. Passing the "0" through
          // would read as an empty stage, so the total is omitted entirely and
          // the reason is stated — the model can then say "mixed currencies"
          // instead of reporting a stage worth nothing.
          ...(s.currency === null
            ? { total: null, total_note: "mixed currencies — not summed" }
            : { amount_minor: s.amountMinor, currency: s.currency }),
        })),
      },
    };
  } catch (err) {
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_pipeline_summary",
  description:
    "Deal count and value per pipeline stage — 'how is the quarter looking'. `amount_minor` is a string of minor units; a mixed-currency stage reports `total: null` and is not summed. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
