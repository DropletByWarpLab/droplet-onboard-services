import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage } from "@/components/ChatMessage";

describe("ChatMessage", () => {
  it("renders user message content", () => {
    render(
      <ChatMessage
        message={{ id: "1", role: "user", content: "Hello!" }}
      />
    );
    expect(screen.getByText("Hello!")).toBeInTheDocument();
  });

  it("renders assistant message content", () => {
    render(
      <ChatMessage
        message={{ id: "2", role: "assistant", content: "Hi there!" }}
      />
    );
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("shows streaming cursor for assistant messages when streaming", () => {
    const { container } = render(
      <ChatMessage
        message={{ id: "3", role: "assistant", content: "Thinking..." }}
        isStreaming={true}
      />
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeInTheDocument();
  });

  it("does not show streaming cursor for user messages", () => {
    const { container } = render(
      <ChatMessage
        message={{ id: "4", role: "user", content: "Hello" }}
        isStreaming={true}
      />
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).not.toBeInTheDocument();
  });

  it("does not show cursor when not streaming", () => {
    const { container } = render(
      <ChatMessage
        message={{ id: "5", role: "assistant", content: "Done" }}
        isStreaming={false}
      />
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).not.toBeInTheDocument();
  });
});
