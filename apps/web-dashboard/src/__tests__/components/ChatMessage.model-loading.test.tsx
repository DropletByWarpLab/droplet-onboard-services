/**
 * WARP-903 — visible cold-load state on the chat surface.
 *
 * While the orchestrator reports the selected model is cold-loading
 * (`message.modelLoading`, set from the `model_loading` SSE event), the
 * pre-first-token thinking indicator swaps its label from "Droplet is
 * thinking" to "Loading <model> (<size> GB)…" so a 30-60 s first-token
 * gap is never silent. Same indicator, same motion, same tokens — only
 * the copy changes (restraint-first).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChatMessage } from "@/components/ChatMessage";

describe("ChatMessage — model-loading state (WARP-903)", () => {
  it("renders the loading label with model + size during the pre-token window", () => {
    render(
      <ChatMessage
        message={{
          id: "a1",
          role: "assistant",
          content: "",
          modelLoading: { model: "gpt-oss:20b", sizeGb: 13.8 },
        }}
        isStreaming
      />,
    );
    expect(
      screen.getByText("Loading gpt-oss:20b (13.8 GB)…"),
    ).toBeInTheDocument();
    // Announced once for screen readers (role=status lives on the
    // indicator wrapper, same as the thinking state).
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("omits the size suffix when the orchestrator couldn't report one", () => {
    render(
      <ChatMessage
        message={{
          id: "a2",
          role: "assistant",
          content: "",
          modelLoading: { model: "qwen3", sizeGb: null },
        }}
        isStreaming
      />,
    );
    expect(screen.getByText("Loading qwen3…")).toBeInTheDocument();
  });

  it("keeps the default thinking label when no model_loading arrived", () => {
    render(
      <ChatMessage
        message={{ id: "a3", role: "assistant", content: "" }}
        isStreaming
      />,
    );
    expect(screen.getByText("Droplet is thinking")).toBeInTheDocument();
    expect(screen.queryByText(/^Loading /)).not.toBeInTheDocument();
  });

  it("drops the loading state once content streams (normal bubble wins)", () => {
    render(
      <ChatMessage
        message={{
          id: "a4",
          role: "assistant",
          content: "First tokens.",
          // Defensive: even if a stale modelLoading survived on the
          // message, content ends the pre-token window.
          modelLoading: { model: "gpt-oss:20b", sizeGb: 13.8 },
        }}
        isStreaming
      />,
    );
    expect(screen.getByText("First tokens.")).toBeInTheDocument();
    expect(screen.queryByText(/^Loading /)).not.toBeInTheDocument();
  });

  it("does not render the loading indicator when the turn is not streaming", () => {
    render(
      <ChatMessage
        message={{
          id: "a5",
          role: "assistant",
          content: "",
          modelLoading: { model: "gpt-oss:20b", sizeGb: 13.8 },
        }}
      />,
    );
    expect(screen.queryByText(/^Loading /)).not.toBeInTheDocument();
  });
});
