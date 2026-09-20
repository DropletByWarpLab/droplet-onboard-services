/**
 * WARP-466 (D2) — email thread analysis via the agent loop.
 *
 * Builds a chat-shaped prompt around the EmailThread + its messages
 * and asks the configured LLM to return a strict JSON shape matching
 * `EmailAnalysis` (`{summary, callouts, suggestedActions, related}`).
 *
 * The shape is enforced post-hoc — we parse the model's output and
 * coerce missing fields to safe defaults rather than re-prompting. A
 * malformed reply degrades to "no analysis available" so the dashboard
 * always renders a placeholder card instead of erroring.
 *
 * NO retrieval is duplicated here. The model gets only the thread
 * subject + per-message body excerpts (capped at 8 KB per message in
 * the route layer before calling). If the model wants to enrich with
 * file references it can call `search_content` etc. via the same MCP
 * registry the chat loop uses; the route doesn't force a search.
 */
import type { McpClientPort } from "./mcp-client.port.js";
import { runAgent } from "./llm-agent.service.js";
import { extractJson } from "./llm-json.js";
import { contentToText } from "../types/index.js";
import * as aiGateway from "./ai-gateway.client.js";
import type {
  EmailAnalysis,
  EmailAnalysisFn,
  EmailAnalysisInput,
} from "../routes/email.js";

const DEFAULT_ANALYSIS: EmailAnalysis = {
  summary: "No analysis available.",
  callouts: [],
  suggestedActions: [],
  related: { files: [], threads: [], cameras: [], tools: [] },
};

const SYSTEM_PROMPT =
  "You are Droplet's email triage assistant. Given an email thread, return ONLY a JSON object with the following keys:\n" +
  "  - summary: 1-3 sentence overview of what the thread is about and what's being asked.\n" +
  "  - callouts: array of {label: string} for named entities, dates, deadlines, money amounts, or explicit asks.\n" +
  "  - suggestedActions: array of {label: string, safety: \"Read\" | \"Write · confirm\"} for next-step actions.\n" +
  "  - related: { files: string[], threads: string[], cameras: string[], tools: string[] } — references that look relevant.\n" +
  "Do not include any text outside the JSON object. Keep callouts and suggestedActions arrays short (≤5 items each).";

function buildUserPrompt(input: EmailAnalysisInput): string {
  const header = `Thread subject: ${input.subject}\n\n`;
  const body = input.messages
    .map(
      (m, i) =>
        `--- Message ${i + 1} (${m.from}, ${m.receivedAt}) ---\n${m.bodyText}`,
    )
    .join("\n\n");
  return `${header}${body}`;
}

function coerceAnalysis(raw: unknown): EmailAnalysis {
  if (typeof raw !== "object" || raw === null) return DEFAULT_ANALYSIS;
  const obj = raw as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" && obj.summary.length > 0
      ? obj.summary.slice(0, 2_000)
      : DEFAULT_ANALYSIS.summary;
  const callouts = Array.isArray(obj.callouts)
    ? obj.callouts
        .filter(
          (c): c is { label: string } =>
            typeof c === "object" &&
            c !== null &&
            typeof (c as { label?: unknown }).label === "string",
        )
        .slice(0, 10)
    : [];
  const suggestedActions = Array.isArray(obj.suggestedActions)
    ? obj.suggestedActions
        .filter(
          (a): a is { label: string; safety: "Read" | "Write · confirm" } =>
            typeof a === "object" &&
            a !== null &&
            typeof (a as { label?: unknown }).label === "string" &&
            ((a as { safety?: unknown }).safety === "Read" ||
              (a as { safety?: unknown }).safety === "Write · confirm"),
        )
        .slice(0, 10)
    : [];
  const related =
    typeof obj.related === "object" && obj.related !== null
      ? (obj.related as Record<string, unknown>)
      : {};
  const relatedArr = (k: string): string[] =>
    Array.isArray(related[k])
      ? (related[k] as unknown[])
          .filter((v): v is string => typeof v === "string")
          .slice(0, 20)
      : [];
  return {
    summary,
    callouts,
    suggestedActions,
    related: {
      files: relatedArr("files"),
      threads: relatedArr("threads"),
      cameras: relatedArr("cameras"),
      tools: relatedArr("tools"),
    },
  };
}

export function createEmailAnalysisFn(
  // WARP-2391 — the port, so this caller sees the same MCP surface the
  // agent loop does (the multiplexer in production).
  mcp: McpClientPort,
): EmailAnalysisFn {
  // LLM_MODEL is the model the box actually hosts (single-box.sh writes
  // it to .env); the historic mistral fallback is not pulled in
  // production and would 404 upstream — every analysis would silently
  // degrade to DEFAULT_ANALYSIS.
  const defaultModel =
    process.env.DEFAULT_MODEL ??
    process.env.LLM_MODEL ??
    "mistral:7b-instruct";
  return async (input: EmailAnalysisInput): Promise<EmailAnalysis> => {
    try {
      const result = await runAgent(
        { mcp, aiGateway: { chat: aiGateway.chat } },
        {
          model: defaultModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(input) },
          ],
          // The analysis is one-shot — no tool calls expected. `none`
          // suppresses the registry to keep the trace clean and the
          // model focused on the JSON shape.
          tool_choice: "none",
          max_iter: 1,
        },
      );
      const text = contentToText(result.message.content);
      const parsed = extractJson(text);
      return coerceAnalysis(parsed);
    } catch {
      return DEFAULT_ANALYSIS;
    }
  };
}
