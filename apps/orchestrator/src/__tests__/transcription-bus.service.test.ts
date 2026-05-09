import { describe, it, expect, vi } from "vitest";
import {
  publishRunOne,
  type TranscriptionPublisher,
} from "../services/transcription-bus.service.js";

describe("transcription-bus.service", () => {
  it("publishes droplet/transcription/run-one with itemId + userId", () => {
    const calls: Array<{ topic: string; payload: unknown }> = [];
    const publisher: TranscriptionPublisher = {
      publish: (topic, payload) => calls.push({ topic, payload }),
    };

    publishRunOne(publisher, { itemId: "bmi-1", userId: "alice" });

    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe("droplet/transcription/run-one");
    expect(calls[0].payload).toEqual({ itemId: "bmi-1", userId: "alice" });
  });

  it("throws when itemId is empty", () => {
    const publisher: TranscriptionPublisher = { publish: vi.fn() };
    expect(() =>
      publishRunOne(publisher, { itemId: "", userId: "alice" }),
    ).toThrow(/itemId required/);
  });

  it("throws when userId is empty", () => {
    const publisher: TranscriptionPublisher = { publish: vi.fn() };
    expect(() =>
      publishRunOne(publisher, { itemId: "bmi-1", userId: "" }),
    ).toThrow(/userId required/);
  });
});
