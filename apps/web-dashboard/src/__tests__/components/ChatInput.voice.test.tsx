import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  transcribe: vi.fn(),
}));
vi.mock("@/lib/audio-capture", () => ({
  canCaptureAudio: () => true,
  MAX_RECORD_SECONDS: 30,
  PcmRecorder: class {
    start = mocks.start;
    stop = mocks.stop;
  },
}));
vi.mock("@/lib/api", () => ({
  transcribeAudio: mocks.transcribe,
  SttUnavailable: class SttUnavailable extends Error {},
}));

import { ChatInput } from "@/components/ChatInput";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue({ pcm: new ArrayBuffer(32), rate: 16000 });
  mocks.transcribe.mockResolvedValue({ text: "a dictated request" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function startRecording() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Dictate a message"));
  });
}

describe("ChatInput voice capture", () => {
  it("stops and transcribes once at the 30-second limit", async () => {
    render(<ChatInput onSend={vi.fn()} />);
    await startRecording();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText("Ask Droplet anything…")).toHaveValue("a dictated request");
  });

  it("cancels automatic stop after manually stopping", async () => {
    render(<ChatInput onSend={vi.fn()} />);
    await startRecording();
    await act(async () => fireEvent.click(screen.getByLabelText("Stop recording")));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
  });

  it("releases the microphone and cancels transcription on unmount", async () => {
    const view = render(<ChatInput onSend={vi.fn()} />);
    await startRecording();
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
