/**
 * WARP-1578 — the chat surface's `off_lan_blocked` state copy.
 *
 * T6 (WARP-1530) put a PER-PERSON cloud gate in front of `POST /api/llm/chat`
 * (`services/cloud-access.service.ts`): a turn that would reach a cloud
 * provider for someone whose role — or whose box — does not permit cloud
 * models is refused with **451 `off_lan_blocked`** before anything leaves the
 * LAN. The dashboard never learned that code, so the refusal fell through
 * `friendlyPreStreamError`'s default and rendered "Something went wrong on
 * this turn. Try again." — which is both untrue (nothing went wrong; a
 * sovereignty control did exactly its job) and unactionable (trying again
 * produces the identical refusal, forever).
 *
 * The copy follows `sendDraft`'s off-LAN precedent on the email surface: name
 * the off-box moment, say it's turned off, point at the remedy. It must NOT
 * guess WHICH limb of the AND-gate closed — the resolver returns one boolean
 * by design, and naming the wrong one sends someone to the wrong settings
 * page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({ messages: hook.messages, sendMessage: hook.sendMessage });
  return null;
}

/** The orchestrator's `CloudRefusalBody`, verbatim in shape. */
function refusal(status: number, error: string): Response {
  return new Response(
    JSON.stringify({
      error,
      channel: "cloud_model_escape",
      provider: "openai",
      scope: "per_person",
      message: "…the server's long operator-facing explanation…",
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function sendAndReadError(response: Response): Promise<string | undefined> {
  let value: ProbeValue | null = null;
  mockSendChat.mockResolvedValueOnce(response);
  render(<Probe onValue={(v) => (value = v)} />);
  await act(async () => {
    await value!.sendMessage("summarise this with the big cloud model", "gpt-5");
  });
  let message: string | undefined;
  await waitFor(() => {
    const assistant = value!.messages.filter((m) => m.role === "assistant").at(-1);
    expect(assistant?.error?.message).toBeTruthy();
    message = assistant?.error?.message;
  });
  return message;
}

describe("useChat — the per-person cloud gate's 451 (WARP-1578)", () => {
  beforeEach(() => {
    mockSendChat.mockReset();
  });

  it("renders honest, actionable copy for off_lan_blocked — not 'something went wrong'", async () => {
    const message = await sendAndReadError(refusal(451, "off_lan_blocked"));

    expect(message).not.toMatch(/something went wrong/i);
    // Names the off-box moment, so the refusal reads as a boundary the
    // Droplet defended rather than a fault.
    expect(message).toMatch(/cloud/i);
    // Actionable, and points at the two real remedies.
    expect(message).toMatch(/on your droplet|on-box|admin/i);
  });

  it("does not blame the person's role OR the box — the resolver returns one boolean", async () => {
    const message = await sendAndReadError(refusal(451, "off_lan_blocked"));

    // Cloud access needs BOTH the box's off-LAN channel AND a permitting
    // role. Claiming either limb specifically would send someone to the
    // wrong settings page half the time.
    expect(message).not.toMatch(/off-LAN allowlist|cloud_model_escape/i);
    expect(message).not.toMatch(/your role/i);
  });

  it("keeps the reply retryable — nothing was sent, so re-picking a model is the fix", async () => {
    let value: ProbeValue | null = null;
    mockSendChat.mockResolvedValueOnce(refusal(451, "off_lan_blocked"));
    render(<Probe onValue={(v) => (value = v)} />);
    await act(async () => {
      await value!.sendMessage("hello", "gpt-5");
    });
    await waitFor(() => {
      const assistant = value!.messages.filter((m) => m.role === "assistant").at(-1);
      expect(assistant?.error?.retryPrompt).toBe("hello");
    });
  });

  it("leaves the 503 access_gate_unavailable on the generic retry copy — it IS transient", async () => {
    // Deliberately not given its own string: "try again" is the correct
    // advice when the gate could not be READ, and the 451 is the one that
    // was actively misleading.
    const message = await sendAndReadError(refusal(503, "access_gate_unavailable"));
    expect(message).toMatch(/try again/i);
  });
});
