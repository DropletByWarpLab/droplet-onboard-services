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
  /** WARP-2556 — `priced` | `mixed_currencies` | `unpriced`. */
  valuation: string;
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
          // WARP-2556 — read the STATE, not the null.
          //
          // This branched on `s.currency === null`, which the server emitted
          // for BOTH "several currencies, cannot sum" and "nothing here is
          // priced". So an ordinary early-pipeline stage full of deals nobody
          // had put a number on yet was reported to the model as mixed
          // currencies — on essentially every new box, for the one question
          // this tool exists to answer.
          ...(s.valuation === "priced"
            ? { amount_minor: s.amountMinor, currency: s.currency }
            : s.valuation === "mixed_currencies"
              ? { total: null, total_note: "mixed currencies — not summed" }
              : { total: null, total_note: "no amounts entered yet" }),
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
    "Deal count and value per pipeline stage. `amount_minor` is a minor-units string; a stage with no total says why in `total_note`.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
