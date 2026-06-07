"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, MessageSquare, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { fetchModels, sendChat } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

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
 */
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Three curated prompts tuned to the home-user persona — short,
  // sensible, demonstrate that the AI knows what it's running on.
  const SAMPLE_PROMPTS = [
    "What can you help me with on this Droplet?",
    "Write a short welcome message for my new file vault.",
    "What kinds of files might I want to back up here?",
  ];

  const load = useCallback(async () => {
    try {
      const resp = await fetchModels();
      const list = resp.models ?? [];
      setModels(list);
      const local = pickDefaultLocalModel(list);
      if (local) setSelectedModel(local.id);
    } catch {
      // Ollama may still be warming up after a fresh boot. The step
      // stays renderable with an empty picker + a skip option.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      setError(
        "Pick a model first. If the dropdown is empty, your AI is still warming up — give it a moment and try again.",
      );
      return;
    }
    if (!promptToSend) {
      setError("Pick a question or type one of your own.");
      return;
    }
    setError(null);
    setResponse("");
    setSubmitting(true);
    try {
      const res = await sendChat({
        model: selectedModel,
        messages: [{ role: "user", content: promptToSend }],
        stream: false,
        max_tokens: 400,
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
        throw new Error(
          "Got an empty response. The model may need to load — try again in a moment.",
        );
      }
      setResponse(content);
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
            {!loading && models.length === 0 && (
              <option>No models available yet</option>
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
        </div>

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
            <div className="chat-markdown type-body text-label-primary max-h-[40vh] overflow-y-auto">
              <ReactMarkdown>{response}</ReactMarkdown>
            </div>
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
  if (provider === "ollama" || provider === "local") return true;
  if (provider === "openai" || provider === "anthropic" || provider === "azure")
    return false;
  // No provider field? Treat name-prefix matches as local — these are
  // the families the AI gateway routes to Ollama per
  // `services/ai-gateway/router.py`.
  const id = (m.id || m.name || "").toLowerCase();
  return /^(llama|mistral|phi|qwen|gemma|tinyllama)/.test(id);
}

export function pickDefaultLocalModel(list: ModelInfo[]): ModelInfo | null {
  const local = list.find(isLocalModel);
  return local ?? list[0] ?? null;
}
