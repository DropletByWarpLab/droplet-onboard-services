"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, MessageSquare, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { fetchModels, fetchPersona, patchPersona, sendChat } from "@/lib/api";
import type { PersonaPreset } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";
import { PRESET_TILES } from "@/lib/persona-preview";
import { CodeBlock } from "@/components/CodeBlock";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";
import { ReasoningDisclosure } from "@/components/chat/ReasoningDisclosure";
import { isLocalProvider } from "@/lib/provider";

// Module-level constants so ReactMarkdown receives stable references across
// re-renders (model-poll ticks, error state toggles). Inline object/array
// literals create new references on every render and cause full markdown
// re-parses on long AI responses (WARP-866 finding 2).
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
const MARKDOWN_COMPONENTS = {
  // WARP-295 parity: keep wide GFM tables from blowing out the answer card
  // on narrow viewports.
  table: ({ node, ...props }: any) => (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  ),
  // Hover copy button on every fenced code block — matches ChatMessage.tsx
  // so wizard AI responses are visually consistent with in-app chat (WARP-866).
  pre: ({ node, ...props }: any) => <CodeBlock {...props} />,
};

/**
 * Wizard step — show the customer their local AI works and what it
 * costs (in privacy terms: nothing leaves the box).
 *
 * Education-as-step. The Droplet's whole product wedge is "your AI,
 * your hardware, your data". This step proves the claim with a
 * concrete chat round-trip so the customer doesn't have to take our
 * word for it.
 *
 * Flow:
 *
 *   - Mount → GET /api/llm/models. Filter to locally-served models
 *     (Ollama provider OR a recognised local family prefix —
 *     llama/mistral/phi/qwen/gemma); default-select the first.
 *   - Customer picks one of three sample prompts (or types their own)
 *     and taps "Ask the AI".
 *   - POST /api/llm/chat with stream:false and that single user
 *     message. Non-streaming for wizard MVP; the main /chat page
 *     handles streaming for ongoing use.
 *   - Render the response inline (Markdown, in a scrollable region).
 *     "Continue" advances to the next step (team) — this is NOT the
 *     terminal step, so it must not claim to finish setup.
 *
 * Privacy callout is in the LearnMoreCard — explicit reassurance that
 * the prompt + conversation never leave the box, per ADR-002's
 * offline-first copy discipline.
 *
 * If no local models are available (Ollama still warming up after a
 * fresh boot, or the box is in a configuration with cloud-only
 * routing), the picker just shows what's there and the privacy text
 * adjusts. We never block the wizard on AI specifically.
 *
 * WARP-849 — first-boot model pull. After a factory reset the
 * configured model re-pulls on first boot (13 GB — minutes). A customer
 * reaching this step mid-pull used to hit a dead end: fetchModels()
 * returned empty, the picker said "No models available yet", and the
 * once-only load never re-fetched. Now an empty registry renders an
 * explicit "still downloading" state and the step re-polls fetchModels
 * on a bounded interval (setInterval with React cleanup — never a
 * while-true) until a model appears or the step unmounts. Skip stays
 * available throughout.
 */

/** WARP-849 — how often to re-poll /api/llm/models while the registry
 *  is empty (first-boot pull in progress). Bounded by React cleanup:
 *  the interval is cleared on unmount and as soon as a model appears. */
const MODEL_POLL_INTERVAL_MS = 8_000;

/** WARP-849 — completion budget for the sample probe. The configured
 *  local model (gpt-oss:20b) is a REASONING model: it spends completion
 *  tokens on a separate reasoning channel BEFORE any user-visible
 *  content, and an exhausted budget (finish_reason "length") returns
 *  EMPTY content — the old 400 false-failed the probe on a healthy box.
 *  Local inference is cost-free, so size for reasoning + answer. */
const SAMPLE_PROMPT_MAX_TOKENS = 2_000;

/** WARP-1041 — how long an in-flight ask stays silent before we explain
 *  the wait. Past ~8 s the silence is almost certainly the model loading
 *  into GPU memory (30-90 s cold, the first ask after a boot), not a
 *  hang — say so instead of leaving a frozen "Thinking…" button. */
const WAKING_NOTICE_DELAY_MS = 8_000;
export function AiStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedPrompt, setSelectedPrompt] = useState<number>(0);
  const [customPrompt, setCustomPrompt] = useState<string>("");
  const [response, setResponse] = useState<string>("");
  // WARP-934 — the model's reasoning ("thinking") trace for this answer, when
  // it returns one. Rendered as the same collapsed "Thought process" disclosure
  // the in-app /chat uses, so the wizard shows thinking too (gpt-oss is a
  // reasoning model). Null when the answer carries no trace.
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WARP-849 — soft, retryable "warming up" state: the model answered
  // with reasoning but ran out of budget before any visible content.
  // Kept separate from `error` so it renders as a neutral note, not
  // the red failure box.
  const [notice, setNotice] = useState<string | null>(null);
  // WARP-1041 — honest in-flight state: true once an ask has been silent
  // for WAKING_NOTICE_DELAY_MS. Kept separate from `notice` (a settled,
  // retryable outcome) so the two soft states can't clobber each other.
  const [wakingNotice, setWakingNotice] = useState(false);
  // WARP-1284 — the models response said `degraded: true`: the orchestrator
  // couldn't reach the ai-gateway, or the gateway's Ollama provider errored
  // during listing. An empty picker in this state means "can't reach the AI
  // service", NOT "model still downloading" — the two render differently.
  const [degraded, setDegraded] = useState(false);
  // WARP-1287 — the last fetchModels() REJECTED (orchestrator down, 5xx,
  // auth blip): the server never answered, so it couldn't stamp `degraded`
  // (WARP-1284 covers answered-but-degraded only) and the client must
  // track the failure itself. An empty picker in this state means "can't
  // reach your Droplet", NOT "model still downloading". Cleared by any
  // settled fetch — success wins, whatever it reports.
  const [fetchFailed, setFetchFailed] = useState(false);
  // WARP-1119 — optional persona preset picker (architecture brief §7.3).
  // null = hidden: the fetch failed (persona API unavailable, or the
  // caller's role can't read it) and the wizard must never block — or even
  // visibly error — on personality. Settings owns the full card; this is
  // a preselect convenience only, with no setup-state semantics.
  const [personaPreset, setPersonaPreset] = useState<PersonaPreset | null>(
    null,
  );
  const [personaNote, setPersonaNote] = useState<string | null>(null);

  // Three curated prompts tuned to the home-user persona — short,
  // sensible, demonstrate that the AI knows what it's running on.
  const SAMPLE_PROMPTS = [
    "What can you help me with on this Droplet?",
    "Write a short welcome message for my new file vault.",
    "What kinds of files might I want to back up here?",
  ];

  // Re-entrancy guard: the 8s poll must not stack a second fetch on a
  // slow one (the gateway can be sluggish exactly when this step shows —
  // Ollama busy with a first-boot pull). Without it, out-of-order
  // resolutions could overwrite a discovered model list with a stale
  // empty one.
  const loadInFlight = useRef(false);
  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      const resp = await fetchModels();
      const list = resp.models ?? [];
      setModels(list);
      // WARP-1284 — mirror the server's honesty flag; each poll tick
      // re-evaluates it so the note self-heals the moment the AI service
      // is reachable again (the 8s WARP-849 poll keeps running either way).
      setDegraded(resp.degraded === true);
      // WARP-1287 — the backend answered; whatever it said, the fetch
      // itself is healthy again.
      setFetchFailed(false);
      const local = pickDefaultLocalModel(list);
      if (local) setSelectedModel(local.id);
    } catch {
      // WARP-1287 — the request never got an answer (orchestrator down,
      // 5xx, auth blip). The step stays renderable with an empty picker +
      // a skip option, but it must NOT fall through to the WARP-849
      // "still downloading" copy: track the failure so the empty state
      // renders honestly. The 8s poll keeps running, so this self-heals.
      setFetchFailed(true);
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // WARP-1119 — load the live preset once; any failure keeps the control
  // hidden (see personaPreset above). Cancelled-flag cleanup so a mid-skip
  // unmount can't land a late setState.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await fetchPersona();
        if (!cancelled) setPersonaPreset(p.preset);
      } catch {
        // Persona unavailable — the wizard renders without the picker.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // WARP-1119 — optimistic preset change; a failed PATCH reverts and says
  // so in the step's soft-notice styling (personality is never a wizard
  // failure, so the red error box is off-limits here).
  async function handlePresetChange(next: PersonaPreset) {
    const prev = personaPreset;
    setPersonaPreset(next);
    setPersonaNote(null);
    try {
      await patchPersona({ preset: next });
    } catch {
      setPersonaPreset(prev);
      setPersonaNote(
        "Couldn't save that personality just now — you can set it anytime from Settings.",
      );
    }
  }

  // WARP-849 — while the initial load came back empty (model still
  // pulling on first boot, or the gateway still waking), re-poll on a
  // bounded interval. The dependency on `models.length` clears the
  // interval automatically the moment a model appears; unmount cleanup
  // stops it when the customer skips ahead.
  useEffect(() => {
    if (loading || models.length > 0) return;
    const timer = setInterval(() => {
      void load();
    }, MODEL_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loading, models.length, load]);

  // WARP-1041 — arm the waking-notice timer while an ask is in flight;
  // clear it (and the notice) the moment the request settles. The
  // cleanup runs on settle AND unmount, so StrictMode's double-mount and
  // a mid-ask skip can never leak a late setState.
  useEffect(() => {
    if (!submitting) {
      setWakingNotice(false);
      return;
    }
    const timer = setTimeout(
      () => setWakingNotice(true),
      WAKING_NOTICE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [submitting]);

  const localModels = useMemo(
    () => models.filter(isLocalModel),
    [models],
  );

  // Prefer local in the dropdown; show cloud below in a subdued group
  // if the operator has wired any BYOK keys.
  const cloudModels = useMemo(
    () => models.filter((m) => !isLocalModel(m)),
    [models],
  );

  const promptToSend =
    selectedPrompt === SAMPLE_PROMPTS.length
      ? customPrompt.trim()
      : SAMPLE_PROMPTS[selectedPrompt];

  async function handleAsk() {
    if (!selectedModel) {
      // WARP-1284 — degraded-aware: when the AI service is unreachable, the
      // old "still warming up — give it a moment" copy would reintroduce the
      // exact false framing this ticket removes. WARP-1287 extends the same
      // honesty to a rejected fetch (the backend never answered at all).
      setError(
        degraded || fetchFailed
          ? "We can't reach your AI service right now — you can skip this step and try from the Chat page later."
          : "Pick a model first. If the dropdown is empty, your AI is still warming up — give it a moment and try again.",
      );
      return;
    }
    if (!promptToSend) {
      setError("Pick a question or type one of your own.");
      return;
    }
    setError(null);
    setNotice(null);
    setResponse("");
    setReasoning(null);
    setSubmitting(true);
    // WARP-1041 — the three CURATED samples need zero tools (the identity
    // prompt answers all of them), and every advertised tool schema is
    // prefill the customer waits on (~11k tokens for the full registry).
    // An explicit [] tells the agent loop to advertise none. A CUSTOM
    // question keeps today's payload byte-identical — no allowed_tools
    // key — so "list my devices" still gets the role-default registry.
    const isSamplePrompt = selectedPrompt !== SAMPLE_PROMPTS.length;
    try {
      const res = await sendChat({
        model: selectedModel,
        messages: [{ role: "user", content: promptToSend }],
        stream: false,
        // WARP-849: reasoning-sized budget — see SAMPLE_PROMPT_MAX_TOKENS.
        max_tokens: SAMPLE_PROMPT_MAX_TOKENS,
        ...(isSamplePrompt ? { allowed_tools: [] } : {}),
        // WARP-174: the wizard's sample prompt is a throwaway "does
        // local AI work on this box" check. Without this flag every
        // first-run customer ends up with the wizard's probe at the
        // top of their /chat history sidebar — confusing first-run
        // UX. The orchestrator's /api/llm/chat skips
        // ensureConversation + createTurnRows when ephemeral=true.
        ephemeral: true,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error || `Request failed (HTTP ${res.status}). Try again.`,
        );
      }
      const data = await res.json();
      const content = data?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        // WARP-849 — reasoning models (gpt-oss) can exhaust the budget
        // on the reasoning channel and return EMPTY content while the
        // message still carries a non-empty `reasoning` trace. That's a
        // healthy box mid-thought, not a failure: surface a soft
        // retryable note. The raw reasoning text is NEVER rendered as
        // the answer.
        const trace = data?.message?.reasoning;
        if (typeof trace === "string" && trace.trim()) {
          setNotice(
            "The model is still warming up its answer — try once more.",
          );
          return;
        }
        throw new Error(
          "Got an empty response. The model may need to load — try again in a moment.",
        );
      }
      setResponse(content);
      // WARP-934 — surface the reasoning trace alongside the answer (same
      // collapsed disclosure as /chat) when the model returns one.
      const trace = data?.message?.reasoning;
      setReasoning(
        typeof trace === "string" && trace.trim() ? trace : null,
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Something went wrong asking the AI. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const localSelected = useMemo(
    () => models.find((m) => m.id === selectedModel),
    [models, selectedModel],
  );
  const selectedIsLocal = localSelected ? isLocalModel(localSelected) : true;

  return (
    <StepShell current="ai"
      title="Your private AI is ready"
      subtitle="Try it — it runs entirely on your hardware."
      primary={{
        label: response ? "Continue" : "Ask the AI",
        loadingLabel: "Thinking…",
        onClick: response ? onComplete : handleAsk,
        isLoading: submitting,
        showArrow: !!response,
        disabled: loading,
      }}
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      <div className="space-y-5">
        <div>
          <label
            htmlFor="ai-step-model"
            className="type-subheadline text-label-secondary block mb-1.5"
          >
            Model
          </label>
          <select
            id="ai-step-model"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="dp-input"
            disabled={loading || submitting}
          >
            {loading && <option>Loading…</option>}
            {/* WARP-1284 — degraded-aware placeholder: "available yet"
                reads download-flavored, which is wrong when the service
                is unreachable. WARP-1287 — same when the fetch itself
                rejected (the backend never answered). */}
            {!loading && models.length === 0 && (
              <option>
                {degraded || fetchFailed
                  ? "Models unavailable right now"
                  : "No models available yet"}
              </option>
            )}
            {localModels.length > 0 && (
              <optgroup label="On your Droplet (private)">
                {localModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
            {cloudModels.length > 0 && (
              <optgroup label="Cloud (uses internet)">
                {cloudModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {/* WARP-1284 — the server flagged the response degraded: the AI
              service (ai-gateway / Ollama) can't be reached, so an empty
              picker is NOT a download in progress. Distinct, honest copy in
              the same soft-notice styling; the WARP-849 poll keeps running
              so this self-heals without any customer action. */}
          {/* WARP-1287 — the fetch itself rejected: the backend never
              answered, so neither the WARP-849 downloading copy nor the
              WARP-1284 degraded copy (which needs a server-stamped flag)
              is honest. Same soft-notice styling; the WARP-849 poll keeps
              running so this self-heals without any customer action. */}
          {!loading && models.length === 0 && fetchFailed && (
            <div
              data-testid="model-fetch-failed"
              role="status"
              className="mt-2 flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 flex-shrink-0 text-label-tertiary"
                aria-hidden="true"
              />
              <span>
                We can&rsquo;t reach your Droplet right now — it may be
                restarting. We&rsquo;ll keep trying, or you can skip and
                come back from the Chat page later.
              </span>
            </div>
          )}

          {!loading && models.length === 0 && degraded && !fetchFailed && (
            <div
              data-testid="model-degraded"
              role="status"
              className="mt-2 flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 flex-shrink-0 text-label-tertiary"
                aria-hidden="true"
              />
              <span>
                We can&rsquo;t reach your AI service right now — it may be
                restarting. We&rsquo;ll keep checking, or you can skip and
                come back from the Chat page later.
              </span>
            </div>
          )}

          {/* WARP-849 — empty registry = the first-boot pull is still
              running. Say so explicitly (the bare "No models available
              yet" read as "the GPT model doesn't link anymore") and
              keep checking in the background. Neutral note styling —
              this is expected behavior, not an error. */}
          {!loading && models.length === 0 && !degraded && !fetchFailed && (
            <div
              data-testid="model-downloading"
              role="status"
              className="mt-2 flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
            >
              <Loader2
                size={14}
                className="mt-0.5 flex-shrink-0 text-label-tertiary motion-safe:animate-spin"
                aria-hidden="true"
              />
              <span>
                Your AI model is still downloading — this can take a few
                minutes on first boot. We&rsquo;ll keep checking, or you can
                skip and come back from the Chat page later.
              </span>
            </div>
          )}
        </div>

        {/* WARP-1119 — optional preset preselect (brief §7.3). Hidden unless
            the persona loaded; the full card (verbosity, first names, custom
            instructions, preview) lives in Settings → AI personality. */}
        {personaPreset !== null && (
          <div>
            <label
              htmlFor="ai-step-persona"
              className="type-subheadline text-label-secondary block mb-1.5"
            >
              Personality
            </label>
            <select
              id="ai-step-persona"
              value={personaPreset}
              onChange={(e) =>
                handlePresetChange(e.target.value as PersonaPreset)
              }
              className="dp-input"
              disabled={submitting}
            >
              {PRESET_TILES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 type-footnote text-label-tertiary">
              How your AI talks — fine-tune it anytime in Settings.
            </p>
            {personaNote && (
              <div
                data-testid="persona-save-note"
                role="status"
                className="mt-2 flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
              >
                <AlertCircle
                  size={14}
                  className="mt-0.5 flex-shrink-0 text-label-tertiary"
                  aria-hidden="true"
                />
                <span>{personaNote}</span>
              </div>
            )}
          </div>
        )}

        <div>
          <p className="type-subheadline text-label-secondary mb-2">
            Try asking
          </p>
          <div className="space-y-2">
            {SAMPLE_PROMPTS.map((p, i) => (
              <label
                key={i}
                className={`flex items-start gap-3 dp-card px-4 !py-3 cursor-pointer transition-colors ${
                  selectedPrompt === i
                    ? "ring-2 ring-accent"
                    : "hover:bg-surface-secondary"
                }`}
              >
                <input
                  type="radio"
                  name="sample-prompt"
                  className="mt-0.5"
                  checked={selectedPrompt === i}
                  onChange={() => setSelectedPrompt(i)}
                  disabled={submitting}
                />
                <span className="type-subheadline text-label-primary flex-1">
                  {p}
                </span>
              </label>
            ))}
            <label
              className={`flex items-start gap-3 dp-card px-4 !py-3 cursor-pointer transition-colors ${
                selectedPrompt === SAMPLE_PROMPTS.length
                  ? "ring-2 ring-accent"
                  : "hover:bg-surface-secondary"
              }`}
            >
              <input
                type="radio"
                name="sample-prompt"
                className="mt-0.5"
                checked={selectedPrompt === SAMPLE_PROMPTS.length}
                onChange={() => setSelectedPrompt(SAMPLE_PROMPTS.length)}
                disabled={submitting}
              />
              <div className="flex-1">
                <input
                  type="text"
                  value={customPrompt}
                  onFocus={() => setSelectedPrompt(SAMPLE_PROMPTS.length)}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Or type your own…"
                  className="dp-input"
                  maxLength={512}
                  disabled={submitting}
                />
              </div>
            </label>
          </div>
        </div>

        {response && (
          <div
            className="dp-card !p-4"
            data-testid="ai-response"
          >
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={14} className="text-accent" />
              <span className="type-caption-1 text-label-tertiary">
                {localSelected?.name ?? selectedModel}
              </span>
            </div>
            {/* WARP-934 — the model's "thinking", collapsed by default, above
                the answer; identical to the in-app chat. */}
            {reasoning && <ReasoningDisclosure trace={reasoning} />}
            <div className="chat-markdown type-body text-label-primary max-h-[40vh] overflow-y-auto">
              {/* Same plugin set as ChatMessage so the wizard answer renders
                  identically to the in-app chat (GFM tables, code highlight,
                  per-block copy button). Stable module-level refs avoid
                  full re-parses on poll ticks. */}
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={MARKDOWN_COMPONENTS}
              >
                {response}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* WARP-1041 — the ask has been in flight for 8+ s: almost
            certainly the first inference after a restart, i.e. the model
            loading into GPU memory. Explain the wait honestly instead of
            a frozen "Thinking…" button. Same soft-notice styling as the
            WARP-849 states below — expected behavior, not an error. */}
        {wakingNotice && (
          <div
            data-testid="ai-waking-notice"
            role="status"
            className="flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
          >
            <Loader2
              size={14}
              className="mt-0.5 flex-shrink-0 text-label-tertiary motion-safe:animate-spin"
              aria-hidden="true"
            />
            <span>
              Waking your AI — the first question after a restart takes up
              to a minute while the model loads into memory.
            </span>
          </div>
        )}

        {/* WARP-849 — soft retryable state (reasoning spent the budget
            before any visible answer). Neutral note styling, mirroring
            the StorageStep pattern — deliberately NOT the red error. */}
        {notice && (
          <div
            data-testid="ai-warming-up"
            role="status"
            className="flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
          >
            <AlertCircle
              size={14}
              className="mt-0.5 flex-shrink-0 text-label-tertiary"
              aria-hidden="true"
            />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <LearnMoreCard helpAnchor="ai">
        <p>
          {selectedIsLocal ? (
            <>
              Your conversations stay on this Droplet — your questions,
              the AI&rsquo;s answers, the whole history. No OpenAI, no
              Anthropic, no cloud anything. The model runs on the GPU
              inside your box.
            </>
          ) : (
            <>
              This model runs in the cloud — your message is sent to the
              provider you configured. To keep things on this Droplet
              only, switch to a local model from the &ldquo;On your
              Droplet&rdquo; group above.
            </>
          )}
        </p>
        <p>
          You can pick a different model and have longer conversations
          from the <MessageSquare size={12} className="inline" /> Chat page
          anytime.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}

// ──────────────────────────────────────────────────────────────────
// Model selection helpers — exported only for tests.
// ──────────────────────────────────────────────────────────────────

/** Models the orchestrator routes to the local Ollama instance stay
 *  on-device; everything else is a BYOK cloud route. We treat the
 *  Ollama provider OR a recognised local family prefix as local. */
export function isLocalModel(m: ModelInfo): boolean {
  if (!m) return false;
  const provider = (m.provider || "").toLowerCase();
  if (isLocalProvider(provider)) return true;
  if (provider === "openai" || provider === "anthropic" || provider === "azure")
    return false;
  // No provider field? Treat name-prefix matches as local — these are
  // the families the AI gateway routes to Ollama per
  // `services/ai-gateway/router.py`. `gpt-oss` (WARP-1284) mirrors
  // router.py's documented gpt-oss/gpt collision: OpenAI's OPEN-WEIGHTS
  // family is served locally by Ollama, so a missing provider field must
  // never file the configured local model under "Cloud (uses internet)".
  // Bare `gpt` (gpt-4o, …) intentionally stays non-local.
  const id = (m.id || m.name || "").toLowerCase();
  return /^(llama|mistral|phi|qwen|gemma|tinyllama|gpt-oss)/.test(id);
}

export function pickDefaultLocalModel(list: ModelInfo[]): ModelInfo | null {
  const local = list.find(isLocalModel);
  return local ?? list[0] ?? null;
}
