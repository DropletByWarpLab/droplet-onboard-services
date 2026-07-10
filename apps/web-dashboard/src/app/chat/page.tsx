"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { SessionHeader } from "@/components/chat/SessionHeader";
import { ChatHistoryPanel, type ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";
import { ContextPinsPopover } from "@/components/chat/ContextPinsPopover";
import { MemoryPanel } from "@/components/chat/MemoryPanel";
import {
  InterviewIntroCard,
  InterviewProgress,
  InterviewResumeBanner,
} from "@/components/chat/InterviewSurfaces";
import { ReviewCard } from "@/components/chat/ReviewCard";
import {
  INTERVIEW_COPY,
  TOPIC_CHIPS,
  containsProposalFenceStart,
  parseProposal,
  parseTopicMarker,
  stripTopicMarkers,
} from "@/lib/interview";
import {
  commitBusinessOnboarding,
  fetchBusinessProfile,
  skipBusinessOnboarding,
  startBusinessOnboarding,
  type BusinessProfileView,
} from "@/lib/api";
import { Dialog } from "@/components/Dialog";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";
import { useStickyScroll } from "@/lib/hooks/useStickyScroll";
import { useToolCatalog } from "@/lib/hooks/useToolCatalog";
import { useAuth } from "@/lib/auth";
import {
  PENDING_COMPOSER_KEY,
  type PendingComposerPayload,
  type ToolCatalogEntry,
} from "@/lib/types";
import type { ChatProject } from "@/lib/api";
// WARP-855 — Ask AI indigo re-skin (Claude Design handoff). Tokens are the
// shared shell set; chat-indigo.css carries the chat-specific surface.
import "@/components/shell/indigo-tokens.css";
import "@/components/chat/chat-indigo.css";

export default function ChatPage() {
  // WARP-331: history panel imperative handle + mobile drawer state.
  const router = useRouter();
  const historyHandleRef = useRef<ChatHistoryPanelHandle | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);

  // WARP-104 dropped server-side persistence. WARP-304 restored it: every
  // turn now hits `ChatSession` / `ChatMessage` and the server hands back
  // the conversation id via the `X-Conversation-Id` response header.
  //
  // WARP-203's `chatId` (the brain-memory originating-chat tag) lives on
  // alongside; consolidating with `conversationId` is left as a follow-up.
  const [chatId, setChatId] = useState(() => `chat-${Date.now()}`);
  // DASH-04: gate the chat WS bridge on an authenticated user so it doesn't
  // open + reconnect-with-backoff against `/api/ws/events` before auth
  // resolves (or after the session expires). AuthGate only renders this
  // page when `user` is set, but passing it explicitly keeps the gate
  // correct if that ever changes and mirrors NotificationToaster.
  const { user } = useAuth();
  // Model persisted on a just-loaded conversation, pending application to
  // the picker. Held in state (not applied inline) because the models list
  // may still be fetching on a cold deep-link — the effect below applies
  // it once both sides are ready, then clears.
  const [pendingRestoredModel, setPendingRestoredModel] = useState<string | null>(null);
  // WARP-845 — the project the NEXT new chat is filed under (set by the
  // sidebar's per-project "+"). Ref-mirrored so the URL-clear reset
  // effect can seed the project persona without dep churn.
  const [activeProject, setActiveProject] = useState<ChatProject | null>(null);
  const activeProjectRef = useRef<ChatProject | null>(null);
  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  // WARP-1121 — the onboarding-interview overlay. The profile fetch is
  // owner/admin-gated server-side (others get {}); a fetch failure renders
  // plain chat (fail-open, never blocks the surface).
  const [bizProfile, setBizProfile] = useState<
    (BusinessProfileView & { workspaceType?: string }) | null
  >(null);
  const refreshBizProfile = useCallback(() => {
    fetchBusinessProfile()
      .then((p) => setBizProfile(p))
      .catch(() => setBizProfile(null));
  }, []);
  useEffect(() => {
    if (user) refreshBizProfile();
  }, [user, refreshBizProfile]);

  const isPrivileged = user?.role === "owner" || user?.role === "admin";
  const isBusinessBox = bizProfile?.workspaceType === "BUSINESS";
  // Send the canonical wrap-up turn once the interview session finishes
  // loading (Resume-banner "Skip the rest" defers it through navigation).
  const pendingWrapUpRef = useRef(false);
  const {
    messages,
    isStreaming,
    sendMessage,
    stop,
    retryMessage,
    regenerate,
    editMessage,
    rateMessage,
    approveScene,
    clearMessages,
    attachments,
    sessionAttachments,
    attach,
    removeAttachment,
    clearAttachments,
    conversationId,
    loadConversation,
    messagesEpoch,
  } = useChat({
    chatId,
    historyHandleRef,
    authReady: Boolean(user),
    projectId: activeProject?.id ?? null,
    onConversationLoaded: ({ model, systemPrompt: persistedPrompt }) => {
      if (model) setPendingRestoredModel(model);
      // WARP-844 — restore the persona this conversation is held under.
      setSystemPrompt(persistedPrompt ?? "");
    },
  });

  // WARP-1121 — is the open conversation the live onboarding interview?
  const interviewActive =
    Boolean(conversationId) &&
    bizProfile?.interviewChatId === conversationId &&
    (bizProfile?.onboardingState === "in_progress" ||
      bizProfile?.onboardingState === "re_running");

  // WARP-304 + WARP-331: keep the URL hash and the live conversationId in
  // sync, both directions. The history panel calls router.push("/chat?c=X")
  // when the user clicks a row; we react to that by loading the thread.
  // Conversely, when conversationId changes for any other reason (new chat
  // minted server-side, message sent, clearMessages), we mirror it into the
  // URL so a refresh restores the same thread.
  const searchParams = useSearchParams();
  const urlConversationId = searchParams?.get("c") ?? null;

  // URL → state: when ?c=<id> changes (sidebar click, deep link, browser
  // back/forward), rehydrate that conversation. When `c` is removed (e.g.
  // "+ New chat" pushed "/chat"), reset to a fresh empty chat. The
  // in-flight stream (if any) is NOT aborted — the orchestrator continues
  // to persist the assistant turn server-side, so the answer is saved
  // even when the user navigates away. `useChat` decouples the visible
  // `isStreaming` lock from the underlying stream by tagging each stream
  // with its conversationId, so the new chat's input unlocks immediately.
  useEffect(() => {
    if (urlConversationId) {
      if (urlConversationId === conversationId) return; // already loaded
      // An existing conversation belongs to whatever project it's already
      // in — the pending new-chat project no longer applies.
      setActiveProject(null);
      void loadConversation(urlConversationId).then((ok) => {
        if (!ok && typeof window !== "undefined") {
          // Stale or revoked id — strip from URL so we don't keep
          // trying to load it on every reload / re-render.
          const next = new URL(window.location.href);
          next.searchParams.delete("c");
          window.history.replaceState(null, "", next.toString());
        }
      });
    } else if (conversationId !== null) {
      // URL cleared — reset the in-memory chat so the right column
      // doesn't keep showing the messages of a now-orphaned id.
      clearMessages();
      clearAttachments();
      // WARP-845: a project-scoped new chat seeds the project's persona;
      // a plain new chat starts blank.
      setSystemPrompt(activeProjectRef.current?.systemPrompt ?? "");
      setChatId(`chat-${Date.now()}`);
    }
    // Intentionally only depend on urlConversationId. Including
    // conversationId / loadConversation / clearMessages would re-fire
    // this effect after every load (those callbacks are stable, the
    // conversationId comparison handles dedup via the early return).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlConversationId]);

  // state → URL: when the hook updates conversationId for any reason
  // (server response after a send, clearMessages, etc.), mirror it into
  // the URL via replaceState so the panel and a refresh both stay aligned.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = new URL(window.location.href);
    if (conversationId) {
      if (next.searchParams.get("c") === conversationId) return;
      next.searchParams.set("c", conversationId);
    } else {
      if (!next.searchParams.has("c")) return;
      next.searchParams.delete("c");
    }
    window.history.replaceState(null, "", next.toString());
  }, [conversationId]);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const { models } = useModels();
  // The chat composer's "/" slash menu lists these tools; picking one seeds
  // the composer + pins the "Ready to use X" indicator (same as /tools).
  const { tools: slashTools } = useToolCatalog();
  const [selectedModel, setSelectedModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  // WARP-829: the tool the composer was primed for via the /tools "Use in
  // chat" hand-off (null when the chat wasn't opened from a tool).
  const [activeTool, setActiveTool] = useState<PendingComposerPayload | null>(null);
  // WARP-295: sticky-bottom auto-scroll + Jump-to-latest pill. The hook
  // owns the detach detection so the page just wires onScroll +
  // stickyScrollToBottom through.
  const {
    scrollRef,
    isDetached,
    scrollToBottom,
    onScroll,
    stickyScrollToBottom,
  } = useStickyScroll();

  // Auto-select the first available model
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      const local = models.find((m) => m.provider === "ollama");
      setSelectedModel(local?.id ?? models[0].id);
    }
  }, [models, selectedModel]);

  // Restore the model a loaded conversation was held in — but only when
  // that model is still available on the gateway (an old chat may name a
  // model that's since been removed; keep the current selection then).
  // One-shot per load: clear pending either way so a later manual model
  // switch isn't overridden when the models list refetches.
  useEffect(() => {
    if (!pendingRestoredModel || models.length === 0) return;
    if (models.some((m) => m.id === pendingRestoredModel)) {
      setSelectedModel(pendingRestoredModel);
    }
    setPendingRestoredModel(null);
  }, [pendingRestoredModel, models]);

  // If the home-page hero handed off a prompt, send it once a model is ready.
  //
  // DASH-02: only consume the hero prompt for a genuinely fresh chat. If the
  // user landed on a deep-linked thread (`/chat?c=<id>`) — or any conversation
  // already has messages — a stale `pendingPrompt` left in sessionStorage from
  // an earlier, interrupted hero hand-off must NOT be appended to that existing
  // conversation. We still clear the stored prompt so it can't fire later, but
  // we drop it instead of sending it into a non-empty / deep-linked thread.
  useEffect(() => {
    if (!selectedModel) return;
    let pending: string | null = null;
    try {
      pending = window.sessionStorage.getItem("droplet.pendingPrompt");
    } catch {
      pending = null;
    }
    if (!pending) return;
    // One-shot: always remove it so a stale hero prompt can't resurface.
    try {
      window.sessionStorage.removeItem("droplet.pendingPrompt");
    } catch {
      /* ignore */
    }
    // Gate the auto-send on a fresh chat: no `?c=` deep link in the URL and no
    // messages already present (a loaded/hydrated thread). Otherwise discard.
    if (urlConversationId || messages.length > 0) return;
    sendMessage(pending, selectedModel, systemPrompt || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);

  // WARP-829: the /tools "Use in chat" hand-off. Unlike the hero pendingPrompt
  // above (which auto-SENDS), this SEEDS the composer with a starter line and
  // pins an "acting on <tool>" indicator — it never sends. Execution still
  // requires the user to edit + submit, and any write/build the model then
  // invokes still hits the in-chat confirmation gate. Consume once, on a fresh
  // chat only (no `?c=` deep link, no existing messages); otherwise leave the
  // payload untouched so a deep-linked / populated thread isn't hijacked.
  useEffect(() => {
    let payload: PendingComposerPayload | null = null;
    try {
      const raw = window.sessionStorage.getItem(PENDING_COMPOSER_KEY);
      if (raw) payload = JSON.parse(raw) as PendingComposerPayload;
    } catch {
      payload = null;
    }
    if (!payload || payload.kind !== "tool") return;
    if (urlConversationId || messages.length > 0) return;
    // One-shot: clear before seeding so it can't resurface on a later mount.
    try {
      window.sessionStorage.removeItem(PENDING_COMPOSER_KEY);
    } catch {
      /* ignore */
    }
    setActiveTool(payload);
    chatInputRef.current?.seed(payload.seedText);
    // Mount-only: the fresh-chat guard reads the initial url/messages, matching
    // the pendingPrompt effect's one-shot semantics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WARP-295: sticky auto-scroll. The hook scrolls only when the user is
  // attached (within ~80px of the bottom). When they've scrolled up to
  // re-read a citation mid-stream, fresh tokens for the SAME assistant
  // message land off-screen and the Jump-to-latest pill below appears
  // as the affordance to catch up. Length-grow and discrete refreshes
  // are handled by the two effects below — they unconditionally snap to
  // the bottom regardless of where the user is.
  useEffect(() => {
    stickyScrollToBottom();
  }, [messages, stickyScrollToBottom]);

  // WARP-331: force-scroll to the bottom on discrete refresh events —
  // conversation switched, persisted thread reloaded (manual or via the
  // MQTT turn-completed auto-refresh), or "+ New chat" cleared the list.
  useEffect(() => {
    scrollToBottom();
  }, [messagesEpoch, scrollToBottom]);

  // WARP-331: also force-scroll whenever a new message appears in the
  // array (user submits a turn, assistant placeholder is appended, a
  // second turn lands, etc.). Sticky-scroll above would skip the snap
  // if the user happened to be scrolled up at the moment the message
  // arrived — that's the wrong default the user explicitly asked us to
  // override. Per-token deltas don't grow the array, so they keep
  // following the sticky rule.
  const prevMessagesLengthRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current) {
      scrollToBottom();
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages, scrollToBottom]);

  // WARP-1121 — interview lifecycle handlers.
  const handleInterviewStart = useCallback(async () => {
    try {
      const r = await startBusinessOnboarding();
      refreshBizProfile();
      router.push(`/chat?c=${encodeURIComponent(r.conversationId)}`);
    } catch {
      refreshBizProfile(); // 409 = another admin moved it — re-sync.
    }
  }, [refreshBizProfile, router]);

  const handleInterviewSkip = useCallback(async () => {
    try {
      await skipBusinessOnboarding();
    } catch {
      /* 409 → state already moved; the refresh below reconciles */
    }
    refreshBizProfile();
  }, [refreshBizProfile]);

  const handleSend = useCallback(
    (content: string) => {
      if (!selectedModel) return;
      sendMessage(content, selectedModel, systemPrompt || undefined);
    },
    [selectedModel, sendMessage, systemPrompt]
  );

  // WARP-1121 — "Skip the rest" = the canonical wrap-up turn, everywhere it
  // appears (design §4.3). It never abandons the interview.
  const handleWrapUp = useCallback(() => {
    handleSend(INTERVIEW_COPY.wrapUpTurn);
  }, [handleSend]);

  // Resume-banner "Skip the rest": open the interview session, then send
  // the wrap-up once its messages have loaded.
  const handleResumeWrapUp = useCallback(() => {
    pendingWrapUpRef.current = true;
    if (bizProfile?.interviewChatId) {
      router.push(`/chat?c=${encodeURIComponent(bizProfile.interviewChatId)}`);
    }
  }, [bizProfile, router]);
  useEffect(() => {
    if (
      pendingWrapUpRef.current &&
      interviewActive &&
      messages.length > 0 &&
      !isStreaming &&
      selectedModel
    ) {
      pendingWrapUpRef.current = false;
      handleSend(INTERVIEW_COPY.wrapUpTurn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewActive, messages.length, isStreaming, selectedModel]);

  // Latest parsed topic marker across the transcript — the dots hold on
  // turns without a marker (never guess).
  const interviewTopic = useMemo(() => {
    if (!interviewActive) return null;
    let topic: number | null = null;
    for (const m of messages) {
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      const t = parseTopicMarker(m.content);
      if (t !== null) topic = t;
    }
    return topic;
  }, [interviewActive, messages]);

  const handleNewChat = useCallback(() => {
    setActiveProject(null);
    clearMessages();
    clearAttachments();
    setSystemPrompt("");
    setChatId(`chat-${Date.now()}`);
  }, [clearMessages, clearAttachments]);

  // WARP-331: history panel interaction handlers.
  const handleSelectConversation = useCallback(
    (id: string) => {
      setMobileHistoryOpen(false);
      router.push(`/chat?c=${encodeURIComponent(id)}`);
    },
    [router],
  );
  const handleNewChatFromPanel = useCallback(() => {
    setMobileHistoryOpen(false);
    setActiveProject(null);
    // Clear the draft persona synchronously: when no conversation is
    // loaded, router.push("/chat") is a URL no-op and the ?c effect
    // never fires — without this a just-seeded project persona would
    // silently ride into a plain "New chat".
    setSystemPrompt("");
    router.push("/chat");
  }, [router]);

  // WARP-845 — start a new chat filed under a project: seed the project's
  // persona and send projectId on the first turn.
  const handleNewChatInProject = useCallback(
    (project: ChatProject) => {
      setMobileHistoryOpen(false);
      setActiveProject(project);
      setSystemPrompt(project.systemPrompt ?? "");
      router.push("/chat");
    },
    [router],
  );

  const handleRetry = useCallback(
    (messageId: string) => {
      if (!selectedModel) return;
      retryMessage(messageId, selectedModel, systemPrompt || undefined);
    },
    [retryMessage, selectedModel, systemPrompt],
  );

  // WARP-295: message-actions (Copy / Quote / Regenerate). Copy is
  // delegated to the Clipboard API; Quote feeds the composer through
  // ChatInputHandle.insertQuote; Regenerate threads through to
  // useChat.regenerate() which owns the drop-and-resend slice surgery.
  const handleCopy = useCallback(async (text: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API rejects in unfocused tabs / cross-origin frames —
      // silently no-op; the toolbar still flips its transient "Copied"
      // state so the UI doesn't get stuck.
    }
  }, []);

  const handleQuote = useCallback((text: string) => {
    chatInputRef.current?.insertQuote(text);
  }, []);

  // "/" slash menu → pick a tool. Mirrors the WARP-829 /tools "Use in chat"
  // hand-off: pin the "Ready to use X" indicator and hand the user an empty
  // composer (no auto-send; any write/build still hits the in-chat confirm
  // gate). Seeding "" replaces the "/query" so the menu closes.
  const handleToolCommand = useCallback((tool: ToolCatalogEntry) => {
    const label = tool.name
      .replace(/_/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
    setActiveTool({
      kind: "tool",
      toolName: tool.name,
      label,
      requiresWrite: tool.requiresWrite,
      requiresConfirmation: tool.requiresConfirmation,
      seedText: "",
    });
    chatInputRef.current?.seed("");
  }, []);

  const handleRegenerate = useCallback(
    (messageId: string) => {
      if (!selectedModel) return;
      regenerate(messageId, selectedModel, systemPrompt || undefined);
    },
    [regenerate, selectedModel, systemPrompt],
  );

  // WARP-844: edit & resend. Withheld while a stream is in flight (the
  // ChatMessage pencil is gated on the prop being present).
  const handleEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!selectedModel) return;
      void editMessage(messageId, newContent, selectedModel, systemPrompt || undefined);
    },
    [editMessage, selectedModel, systemPrompt],
  );

  // Index of the last assistant message — the page passes
  // `isLastAssistant` to each ChatMessage so the Regenerate button
  // only surfaces on that one row.
  const lastAssistantIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  // WARP-855 — design-handoff header: conversation title (first user
  // message, clamped) or "New chat", plus the "local · on-device" privacy
  // tag whenever the selected model runs on the box (ollama provider).
  const headerTitle = useMemo(() => {
    const first = messages.find((m) => m.role === "user")?.content.trim();
    if (!first) return "New chat";
    const flat = first.replace(/\s+/g, " ");
    return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
  }, [messages]);
  const isLocalModel = useMemo(
    () => models.find((m) => m.id === selectedModel)?.provider === "ollama",
    [models, selectedModel],
  );

  return (
    // Mobile: subtract the bottom-nav height (56px + safe-area) so the input
    // pins just above the tab bar with no gap. Matches AuthGate main's padding.
    // Desktop: fill dynamic viewport (lg:pb-0 on main).
    // dvh (not vh) absorbs iOS Safari's collapsing URL bar.
    // overflow-x-hidden: guard against horizontal overflow on narrow phones.
    // Underscores inside calc() are Tailwind's whitespace marker (CSS spec requires spaces around -).
    <div className="droplet-shell chat-app h-[calc(100dvh_-_56px_-_env(safe-area-inset-bottom))] lg:h-dvh overflow-x-hidden">
      {/* WARP-331: desktop chat history panel — the design's conversation
          rail (276px, glass) between the app sidebar and the chat column. */}
      <aside className="conv-rail hidden lg:flex" aria-label="Chat history">
        <ChatHistoryPanel
          activeConversationId={conversationId}
          onSelect={handleSelectConversation}
          onNewChat={handleNewChatFromPanel}
          onNewChatInProject={handleNewChatInProject}
          handleRef={historyHandleRef}
        />
      </aside>

      {/* Main chat area */}
      <div className="chat-main">
        {/* Header */}
        <header className="chat-head">
          {/* WARP-331: mobile-only history-drawer trigger. */}
          <button
            ref={historyTriggerRef}
            type="button"
            onClick={() => setMobileHistoryOpen(true)}
            aria-label="Open chat history"
            aria-haspopup="dialog"
            aria-expanded={mobileHistoryOpen}
            className="chat-iconbtn lg:hidden"
            title="Chat history"
          >
            <PanelLeftOpen size={18} aria-hidden="true" />
          </button>
          <div className="chat-head-title" title={headerTitle}>
            {headerTitle}
            {activeProject && !conversationId && (
              <span
                className="ml-2 inline-flex items-center h-6 px-2 rounded-full
                  type-caption-2 font-medium bg-accent-subtle text-accent align-middle"
                title={`New chat in ${activeProject.name}`}
              >
                {activeProject.name}
              </span>
            )}
          </div>
          <ModelSelector value={selectedModel} onChange={setSelectedModel} />
          {isLocalModel && <span className="chat-tag">local · on-device</span>}
          {/* WARP-461: workspace-global memory — always available. */}
          <MemoryPanel />
          {/* WARP-460: pins are per-session — the popover appears once
              the first turn has minted a conversationId. */}
          {conversationId && <ContextPinsPopover sessionId={conversationId} />}
          <button
            onClick={() => setShowSystemPrompt(!showSystemPrompt)}
            className={`chat-iconbtn ${systemPrompt ? "is-on" : ""}`}
            title="System prompt"
            aria-label={
              showSystemPrompt ? "Hide system prompt" : "Show system prompt"
            }
            aria-pressed={showSystemPrompt}
          >
            <Settings2 size={16} aria-hidden="true" />
          </button>
          <button
            onClick={handleNewChat}
            disabled={messages.length === 0}
            className="chat-new"
            aria-label="Start a new chat"
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>New chat</span>
          </button>
        </header>

        {/* WARP-205: per-chat brain memory export affordance.
            Hidden when no items are attached to this chat — the
            component itself returns null in that case. */}
        {/* WARP-859 — SessionHeader reflects the whole conversation's
            attachments (composer chips clear on send). */}
        <SessionHeader chatId={conversationId ?? chatId} attachments={sessionAttachments} />

        {/* System prompt */}
        {showSystemPrompt && (
          <div className="chat-subpanel">
            <div className="flex items-center justify-between mb-1.5">
              <label className="chat-subpanel-label">System prompt</label>
              {systemPrompt && (
                <button
                  onClick={() => setSystemPrompt("")}
                  className="type-caption-1 text-accent hover:text-accent-hover"
                >
                  Clear
                </button>
              )}
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a helpful cooking assistant..."
              rows={2}
            />
          </div>
        )}

        {/* WARP-1121 §4 — pinned interview progress (marker-driven). */}
        {interviewActive && (
          <InterviewProgress
            topic={interviewTopic}
            onSkipTheRest={handleWrapUp}
            onPause={() => router.push("/chat")}
          />
        )}
        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="chat-scroll"
          className="chat-scroll relative"
        >
          {/* WARP-1121 §9.1 — the interview intro card replaces the standard
              empty-state hint for owner/admin on an untouched BUSINESS box.
              Typing normally still works (composer stays live); the card
              returns on the next empty visit until started or skipped. */}
          {messages.length === 0 &&
            isPrivileged &&
            isBusinessBox &&
            bizProfile?.onboardingState === "not_started" && (
              <InterviewIntroCard
                onStart={() => void handleInterviewStart()}
                onSkip={() => void handleInterviewSkip()}
                modelReady={Boolean(selectedModel)}
              />
            )}
          {/* Resume banner on the empty new-chat view while an interview is
              parked mid-flight elsewhere. */}
          {messages.length === 0 &&
            isPrivileged &&
            !interviewActive &&
            (bizProfile?.onboardingState === "in_progress" ||
              bizProfile?.onboardingState === "re_running") && (
              <div className="max-w-[640px] mx-auto px-4 pt-4">
                <InterviewResumeBanner
                  onResume={() => {
                    if (bizProfile?.interviewChatId) {
                      router.push(
                        `/chat?c=${encodeURIComponent(bizProfile.interviewChatId)}`,
                      );
                    }
                  }}
                  onSkipTheRest={handleResumeWrapUp}
                />
              </div>
            )}
          {messages.length === 0 &&
            !(
              isPrivileged &&
              isBusinessBox &&
              bizProfile?.onboardingState === "not_started"
            ) && (
            <div className="chat-empty">
              <div className="ico" aria-hidden="true">
                <Sparkles size={26} />
              </div>
              <p className="h">Ask Droplet anything</p>
              <p className="s">
                {selectedModel
                  ? "Your local AI is ready — nothing leaves the device."
                  : "Select a model above to get started."}
              </p>
              {!isPrivileged && isBusinessBox && (
                <p className="type-caption-1 text-label-quaternary mt-1">
                  {INTERVIEW_COPY.nonOwnerHint}
                </p>
              )}
              {selectedModel && (
                <div className="chat-suggs">
                  {[
                    "What's using the most storage?",
                    "Summarize the files I uploaded today",
                    "Dim the living-room lights to 30%",
                    "What joined the network this week?",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => handleSend(prompt)}
                      className="chat-sugg"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="chat-wrap">
            {messages.map((msg, idx) => {
              // WARP-1121 §9.3 — interview turn shaping: markers are
              // stripped before render; a proposal fence suppresses raw
              // token paint (ChatMessage's own thinking indicator shows via
              // empty streaming content) and renders as the review card on
              // done. Reopening the session re-renders the stored proposal
              // as the card, never as text.
              if (
                interviewActive &&
                msg.role === "assistant" &&
                typeof msg.content === "string"
              ) {
                const streamingThis =
                  isStreaming && idx === messages.length - 1;
                if (containsProposalFenceStart(msg.content)) {
                  if (streamingThis) {
                    return (
                      <ChatMessage
                        key={msg.id}
                        message={{ ...msg, content: "" }}
                        isStreaming
                        isLastAssistant={idx === lastAssistantIdx}
                        onRetry={handleRetry}
                        onCopy={handleCopy}
                        onQuote={handleQuote}
                        onRegenerate={handleRegenerate}
                        onApproveScene={approveScene}
                        onFeedback={(id, fb) => void rateMessage(id, fb)}
                      />
                    );
                  }
                  const proposal = parseProposal(msg.content);
                  if (proposal) {
                    return (
                      <div key={msg.id} className="my-3">
                        <ReviewCard
                          proposal={proposal}
                          onApply={async (payload) => {
                            await commitBusinessOnboarding(payload);
                            refreshBizProfile();
                            // Pull the server-authored closing turn into view.
                            if (conversationId) loadConversation(conversationId);
                          }}
                          onNotYet={() => {
                            /* card stays; conversation stays open (§5) */
                          }}
                          onViewSaved={() => router.push("/settings")}
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={msg.id}
                      data-testid="proposal-parse-failure"
                      className="my-3 rounded-2xl border border-system-red/30 px-5 py-4 flex items-center gap-3"
                    >
                      <span className="type-body text-label-primary">
                        {INTERVIEW_COPY.parseFailure}
                      </span>
                      <button
                        type="button"
                        onClick={handleWrapUp}
                        className="type-subheadline text-accent hover:text-accent-hover ml-auto shrink-0"
                      >
                        {INTERVIEW_COPY.tryAgain}
                      </button>
                    </div>
                  );
                }
                const stripped = stripTopicMarkers(msg.content);
                if (stripped !== msg.content) {
                  msg = { ...msg, content: stripped };
                }
              }
              return (
              <ChatMessage
                key={msg.id}
                message={msg}
                isStreaming={
                  isStreaming && idx === messages.length - 1 && msg.role === "assistant"
                }
                isLastAssistant={idx === lastAssistantIdx}
                onRetry={handleRetry}
                onCopy={handleCopy}
                onQuote={handleQuote}
                onRegenerate={handleRegenerate}
                onApproveScene={approveScene}
                onEdit={isStreaming ? undefined : handleEdit}
                onFeedback={(id, fb) => void rateMessage(id, fb)}
              />
              );
            })}
          </div>
        </div>
        {/* WARP-295: Jump-to-latest pill — visible only when the user
            scrolled up off the live tail. Sits absolutely above the
            ChatInput so it floats over the last message without
            stealing layout space when hidden. The container is always
            rendered (only the pill's opacity toggles) so we get a soft
            fade on both appear and disappear instead of a hard pop.
            `pointer-events-none` while hidden keeps the invisible pill
            from intercepting clicks; reduced-motion users still get a
            usable pill — the global `prefers-reduced-motion` block in
            globals.css collapses Tailwind transitions to ~0ms. */}
        {messages.length > 0 ? (
          <div className="relative" aria-hidden={!isDetached}>
            <button
              type="button"
              onClick={scrollToBottom}
              data-testid="jump-to-latest"
              tabIndex={isDetached ? 0 : -1}
              className={`
                absolute left-1/2 -translate-x-1/2 -top-12 z-10
                inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full
                bg-accent text-white shadow-md
                type-caption-1 hover:bg-accent-hover
                focus:outline-none focus:ring-2 focus:ring-accent/40
                transition-opacity duration-150
                ${isDetached ? "opacity-100" : "opacity-0 pointer-events-none"}
              `}
              aria-label="Jump to latest message"
            >
              <ArrowDown size={12} strokeWidth={2.5} aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        ) : null}

        {/* WARP-829: "Use in chat" hand-off indicator. The composer was seeded
            for this tool; the user still edits + sends (no auto-run), and any
            write/build the model invokes still hits the in-chat confirm gate. */}
        {activeTool && (
          <div className="px-4 pt-3">
            <div
              role="status"
              className="flex items-center gap-2 flex-wrap rounded-lg border border-separator bg-surface-secondary px-3 py-2"
            >
              <Wrench size={14} className="flex-none text-accent" aria-hidden="true" />
              <span className="type-footnote text-label-secondary">
                Ready to use{" "}
                <span className="text-label-primary font-medium">{activeTool.label}</span>
              </span>
              {activeTool.requiresWrite && (
                <span className="inline-flex items-center gap-1 h-6 px-2 rounded-full type-caption-2 font-medium text-label-primary bg-system-orange/15">
                  <Pencil size={11} aria-hidden="true" className="text-system-orange" />
                  Writes
                </span>
              )}
              {activeTool.requiresConfirmation && (
                <span className="inline-flex items-center gap-1 h-6 px-2 rounded-full type-caption-2 font-medium text-label-primary bg-system-blue/15">
                  <ShieldCheck size={11} aria-hidden="true" className="text-system-blue" />
                  Asks first
                </span>
              )}
              <button
                type="button"
                onClick={() => setActiveTool(null)}
                aria-label="Dismiss tool"
                className="ml-auto flex-none p-2 rounded-sm text-label-tertiary hover:text-label-primary hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-colors"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        {/* WARP-1121 §4.2 — canned per-topic suggestion chips (never
            model-generated); shortcuts that submit their label. */}
        {interviewActive &&
          interviewTopic !== null &&
          TOPIC_CHIPS[interviewTopic] &&
          !isStreaming && (
            <div
              data-testid="interview-chips"
              className="flex flex-wrap gap-2 px-4 pb-2 max-w-[720px] mx-auto w-full"
            >
              {TOPIC_CHIPS[interviewTopic].map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => handleSend(chip)}
                  className="px-3.5 py-1.5 rounded-full border border-separator type-footnote text-label-primary hover:bg-surface-secondary"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          disabled={isStreaming || !selectedModel}
          attachments={attachments}
          onAttach={attach}
          onRemoveAttachment={removeAttachment}
          isStreaming={isStreaming}
          onStop={stop}
          slashTools={slashTools}
          onToolCommand={handleToolCommand}
        />
      </div>

      {/* WARP-331: mobile drawer — same ChatHistoryPanel, hosted in the
          Dialog placement=right primitive. No handleRef here: useChat
          only needs one consumer (the desktop panel), and both writing
          the ref would race. Rename / delete / loadMore still work
          because they don't depend on the handle. */}
      <Dialog
        open={mobileHistoryOpen}
        onClose={() => setMobileHistoryOpen(false)}
        triggerRef={historyTriggerRef}
        labelledBy="mobile-history-heading"
        placement="right"
      >
        <div className="flex flex-col h-full w-[320px] max-w-[85vw]">
          <h2 id="mobile-history-heading" className="sr-only">
            Chat history
          </h2>
          <ChatHistoryPanel
            activeConversationId={conversationId}
            onSelect={handleSelectConversation}
            onNewChat={handleNewChatFromPanel}
          onNewChatInProject={handleNewChatInProject}
          />
        </div>
      </Dialog>
    </div>
  );
}
