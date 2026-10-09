import { describe, expect, it } from "vitest";
import { CONNECT_TURN_TTL_MS, connectTurnStep, type PendingConnectTurn } from "./connect-turn";

const NOW = 1_800_000_000_000;

function pending(over: Partial<PendingConnectTurn> = {}): PendingConnectTurn {
  return { turn: "Google is connected now.", conversationId: "c-1", at: NOW, ...over };
}

describe("connectTurnStep", () => {
  it("sends a fresh turn into the conversation it belongs to", () => {
    expect(connectTurnStep(pending(), "c-1", NOW + 1_000)).toBe("send");
  });

  it("sends a fresh turn queued for the open conversation (no id) into whichever conversation is open", () => {
    expect(connectTurnStep(pending({ conversationId: null }), "c-9", NOW + 1_000)).toBe("send");
    expect(connectTurnStep(pending({ conversationId: null }), null, NOW + 1_000)).toBe("send");
  });

  it("waits while the conversation it belongs to is still opening", () => {
    expect(connectTurnStep(pending(), null, NOW + 1_000)).toBe("wait");
    expect(connectTurnStep(pending(), "c-2", NOW + 1_000)).toBe("wait");
  });

  it("drops a turn that has outlived its moment, whichever conversation is open", () => {
    const late = NOW + CONNECT_TURN_TTL_MS + 1;
    expect(connectTurnStep(pending(), "c-1", late)).toBe("drop");
    expect(connectTurnStep(pending(), "c-2", late)).toBe("drop");
    expect(connectTurnStep(pending({ conversationId: null }), "c-1", late)).toBe("drop");
  });

  it("treats the last moment of the window as still fresh", () => {
    expect(connectTurnStep(pending(), "c-1", NOW + CONNECT_TURN_TTL_MS)).toBe("send");
    expect(connectTurnStep(pending(), "c-2", NOW + CONNECT_TURN_TTL_MS)).toBe("wait");
  });
});
