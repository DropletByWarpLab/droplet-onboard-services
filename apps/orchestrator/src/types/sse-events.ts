/**
 * Typed SSE event surface emitted by `/api/llm/chat` when `stream=true`.
 *
 * The orchestrator agent loop (`runAgent` in `services/llm-agent.service.ts`)
 * pushes one of these events per phase: token deltas from the model
 * (`content_delta`), each tool dispatch (`tool_call`/`tool_result`), and
 * a terminating `done`. The shape is the contract spec §8.2 promises to
 * MCP-aware downstream clients (dashboard chat, droplet-local-LLM, future
 * external CLIs).
 */
/**
 * The in-chat confirmation handle carried on a `confirmation_required`
 * tool result — and persisted with the tool call so a reload keeps it.
 *
 * TWO KINDS, and `kind` is the discriminator:
 *
 *  - WARP-640 (`"scene_run"`, `"generic"`, …) — the tool minted its own
 *    single-use token for a dedicated REST route, and the chip re-POSTs
 *    with it. Those carry `confirmationToken`.
 *
 *  - WARP-2469 (`"tool_confirmation"`) — the WARP-2305 interceptor
 *    challenged the call. These carry a `challengeId` and NEVER a token:
 *    the interceptor's secret stays in the orchestrator, because a token
 *    on the wire would make the approval authenticated by whoever holds
 *    the stream rather than by a role-gated user. The client redeems the
 *    challenge through `POST /api/llm/confirm/:challengeId`.
 *
 * Declared as ONE optional-field type rather than a discriminated union
 * so the persisted shape (`PersistedToolCall.confirmation`) and the wire
 * shape cannot drift; read `confirmationToken` only after checking
 * `kind`.
 */
export interface ToolConfirmationHandle {
  kind: string;
  sceneId?: string;
  confirmationToken?: string;
  /** WARP-2469 — opaque handle; authorises nothing on its own. */
  challengeId?: string;
  tool?: string;
  status?: string;
  /** Epoch ms. Past this the prompt renders as expired. */
  expiresAt?: number;
  /** PHI-free argument summary — see `confirmation-summary.ts`. */
  summary?: {
    tool: string;
    fields: { key: string; kind: string; detail: string; value?: boolean }[];
    truncatedFields: number;
  };
}

export type SSEEvent =
  | { type: "content_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      ok: boolean;
      data?: unknown;
      status?: string;
      message?: string;
      /**
       * WARP-640 — when `status === "confirmation_required"` and the tool
       * supports a one-click re-issue (e.g. `run_scene`), the single-use
       * confirmation token + target so the dashboard chip can render an
       * "Approve & run" button that completes the action without leaving
       * chat. Absent for tools whose confirmation is resolved on a dedicated
       * dashboard surface.
       */
      /**
       * WARP-2469 — `kind: "tool_confirmation"` is the WARP-2305
       * interceptor's challenge, surfaced for in-chat approval. It carries
       * a `challengeId` and NO token: the interceptor's secret stays in the
       * orchestrator, and the client redeems the challenge through
       * `POST /api/llm/confirm/:challengeId`, which is role-gated. Every
       * other `kind` is the pre-existing WARP-640 shape and still carries
       * its own `confirmationToken`, so `confirmationToken` is optional on
       * this union rather than required — read it only after checking
       * `kind`.
       */
      confirmation?: ToolConfirmationHandle;
    }
  /**
   * WARP-458 — one step of the assistant's deep-reasoning trace. Emitted
   * BEFORE any `content_delta` block on the same turn, in arrival order
   * (one event per `<reasoning>…</reasoning>` segment, plus an extra
   * leading step for the provider-native reasoning field when present).
   * The dashboard renders these as a collapsible "thinking" timeline
   * above the answer; the orchestrator persists the concatenated trace
   * to `ChatMessage.reasoning` so a refresh / rehydrate can re-render
   * them without re-running inference.
   *
   * Gated on the per-request `captureReasoning` flag (default false).
   * When the flag is false the agent loop still parses + persists, but
   * suppresses these events on the wire. See WARP-458 AC §4.
   */
  | { type: "reasoning_step"; text: string }
  /**
   * WARP-903 — emitted at most once, BEFORE the agent loop begins, when
   * the selected local model is installed in Ollama but not currently
   * loaded in memory (cold). The dashboard swaps its pre-first-token
   * thinking indicator to an explicit "Loading <model> (<sizeGb> GB)…"
   * state so the 30-60 s cold load is never a silent gap. `sizeGb` is
   * decimal gigabytes (one decimal) from Ollama's tags listing, or null
   * when Ollama didn't report a size. Best-effort: the coldness probe
   * is budgeted and non-fatal, so the ABSENCE of this event does not
   * prove the model was warm.
   */
  | { type: "model_loading"; model: string; sizeGb: number | null }
  /**
   * WARP-2544 — the answer claims a completed action that the tool trace does
   * not support. Emitted at most once per turn, immediately before `done`,
   * and ONLY when the check does not pass.
   *
   * `unsupported`  the answer claims an action on a turn that dispatched
   *                nothing at all.
   * `contradicted` it dispatched, and every dispatch failed.
   *
   * The loop guards the INPUT side of tool use thoroughly (WARP-1529 RBAC,
   * WARP-642 hallucinated names, WARP-1480 error logging) and had nothing on
   * the output side: terminal content was returned verbatim, and `trace` was
   * never compared against it. On this product the tools are physical, so a
   * false "done" about a door or a firewall rule is a safety failure rather
   * than a cosmetic one.
   *
   * ⚠ ADVISORY, NOT A RETRACTION. On the streaming path the answer has
   * already reached the client as `content_delta` frames before terminal
   * content exists, so this cannot un-send it. A client should surface it
   * beside the answer ("this may not have actually happened"), never treat
   * it as a correction of what was already rendered.
   */
  | {
      type: "tool_use_validation";
      status: "unsupported" | "contradicted";
      /** The model's own sentences that triggered it. Capped, log-safe. */
      claims: string[];
      /** Tool names dispatched this turn (may be empty for `unsupported`). */
      tools: string[];
    }
  | {
      type: "done";
      iterations: number;
      stop_reason:
        | "model_done"
        | "iteration_limit"
        | "error"
        | "context_budget"
        | "repetition";
      error?: string;
    };

/**
 * Encode an `SSEEvent` as a single SSE frame, terminated by the canonical
 * blank line that delimits frames. The `event:` line lets browser
 * `EventSource` consumers route to per-type handlers.
 */
export function encodeSSE(event: SSEEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}
