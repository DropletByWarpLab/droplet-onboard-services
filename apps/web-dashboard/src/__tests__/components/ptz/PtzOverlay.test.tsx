import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PtzOverlay } from "@/components/ptz/PtzOverlay";
import type { PtzCapabilities } from "@/lib/types";

// Mock the network layer. ptzMove returns a resolved promise so the
// component's `await ptzMove(...)` settles inside startMove() and
// activeRef flips back to null after STOP — that matters for the
// repeat-key test, where a re-issued MOVE must be guarded by the
// in-flight check.
const ptzMove = vi.fn().mockResolvedValue(undefined);
const ptzGoToPreset = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/api", () => ({
  ptzMove: (cameraName: string, action: string) => ptzMove(cameraName, action),
  ptzGoToPreset: (cameraName: string, preset: string) =>
    ptzGoToPreset(cameraName, preset),
}));

const fullCaps: PtzCapabilities = {
  supportsPanTilt: true,
  supportsZoom: true,
  presets: [],
};

function renderOverlay(overrides: Partial<PtzCapabilities> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <PtzOverlay
      cameraName="cam-1"
      caps={{ ...fullCaps, ...overrides }}
      onClose={onClose}
    />,
  );
  return { ...utils, onClose };
}

describe("PtzOverlay — keyboard control (WARP-296)", () => {
  beforeEach(() => {
    ptzMove.mockClear();
    ptzGoToPreset.mockClear();
  });

  it("ArrowRight keydown on the overlay fires MOVE_RIGHT", () => {
    renderOverlay();
    const overlay = screen.getByTestId("ptz-overlay");
    fireEvent.keyDown(overlay, { key: "ArrowRight" });
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "MOVE_RIGHT");
  });

  it("ArrowRight keyup on the overlay fires STOP", async () => {
    renderOverlay();
    const overlay = screen.getByTestId("ptz-overlay");
    fireEvent.keyDown(overlay, { key: "ArrowRight" });
    // Flush the in-flight ptzMove("MOVE_RIGHT") so activeRef is set.
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.keyUp(overlay, { key: "ArrowRight" });
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "STOP");
  });

  it("ArrowRight with e.repeat=true does NOT re-fire MOVE_RIGHT", () => {
    renderOverlay();
    const overlay = screen.getByTestId("ptz-overlay");
    fireEvent.keyDown(overlay, { key: "ArrowRight", repeat: true });
    expect(ptzMove).not.toHaveBeenCalled();
  });

  it("ArrowUp / ArrowDown / ArrowLeft keydown fire the matching MOVE", () => {
    renderOverlay();
    const overlay = screen.getByTestId("ptz-overlay");
    fireEvent.keyDown(overlay, { key: "ArrowUp" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "MOVE_UP");

    ptzMove.mockClear();
    fireEvent.keyUp(overlay, { key: "ArrowUp" });

    ptzMove.mockClear();
    fireEvent.keyDown(overlay, { key: "ArrowDown" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "MOVE_DOWN");

    ptzMove.mockClear();
    fireEvent.keyUp(overlay, { key: "ArrowDown" });

    ptzMove.mockClear();
    fireEvent.keyDown(overlay, { key: "ArrowLeft" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "MOVE_LEFT");
  });

  it("'+' and '=' keydown fire ZOOM_IN", () => {
    renderOverlay();
    const overlay = screen.getByTestId("ptz-overlay");

    fireEvent.keyDown(overlay, { key: "+" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "ZOOM_IN");

    ptzMove.mockClear();
    fireEvent.keyUp(overlay, { key: "+" });
    ptzMove.mockClear();

    fireEvent.keyDown(overlay, { key: "=" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "ZOOM_IN");
  });

  it("'-' and '_' keydown fire ZOOM_OUT", () => {
    renderOverlay();
    const overlay = screen.getByTestId("ptz-overlay");

    fireEvent.keyDown(overlay, { key: "-" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "ZOOM_OUT");

    ptzMove.mockClear();
    fireEvent.keyUp(overlay, { key: "-" });
    ptzMove.mockClear();

    fireEvent.keyDown(overlay, { key: "_" });
    expect(ptzMove).toHaveBeenLastCalledWith("cam-1", "ZOOM_OUT");
  });

  it("Enter keydown on a focused direction button fires MOVE for that direction", () => {
    renderOverlay();
    const btn = screen.getByLabelText("Pan up");
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "MOVE_UP");
  });

  it("Space keydown on a focused direction button fires MOVE for that direction", () => {
    renderOverlay();
    const btn = screen.getByLabelText("Pan left");
    fireEvent.keyDown(btn, { key: " " });
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "MOVE_LEFT");
  });

  it("Enter keyup on a focused direction button fires STOP", async () => {
    renderOverlay();
    const btn = screen.getByLabelText("Pan up");
    fireEvent.keyDown(btn, { key: "Enter" });
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.keyUp(btn, { key: "Enter" });
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "STOP");
  });

  it("Escape keydown fires STOP and closes (preserves existing behavior)", async () => {
    const { onClose } = renderOverlay();
    // Issue a move first so there is something to stop.
    const overlay = screen.getByTestId("ptz-overlay");
    fireEvent.keyDown(overlay, { key: "ArrowRight" });
    await Promise.resolve();
    await Promise.resolve();

    // Escape is bound at the window level by the existing useEffect.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "STOP");
    expect(onClose).toHaveBeenCalled();
  });

  it("each directional button is 44 px (w-11 h-11)", () => {
    renderOverlay();
    const labels = [
      "Pan up",
      "Pan down",
      "Pan left",
      "Pan right",
      "Zoom in",
      "Zoom out",
    ];
    for (const label of labels) {
      const btn = screen.getByLabelText(label);
      const cls = btn.className;
      expect(cls).toMatch(/\bw-11\b/);
      expect(cls).toMatch(/\bh-11\b/);
    }
  });

  it("preserves existing pointer semantics: pointerDown fires MOVE, pointerLeave fires STOP", async () => {
    renderOverlay();
    const btn = screen.getByLabelText("Pan right");
    fireEvent.pointerDown(btn);
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "MOVE_RIGHT");
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.pointerLeave(btn);
    expect(ptzMove).toHaveBeenCalledWith("cam-1", "STOP");
  });
});
