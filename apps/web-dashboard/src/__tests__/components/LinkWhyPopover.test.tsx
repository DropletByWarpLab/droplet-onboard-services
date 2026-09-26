/**
 * WARP-2979 (ADR-059 P4 §8) × WARP-1787 — "Why Droplet linked …" is a
 * right-side panel. Below 720px it fills the screen, so there is no backdrop
 * left to tap and a phone has no Escape key: its labelled Close control is the
 * only way out, for every level (a family viewer opens it too, to read the
 * evidence). The source-level guard (a11y.side-panel-close.test.ts) checks the
 * label is there; this checks the control works.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LinkWhyPopover } from "@/components/security/LinkWhyPopover";
import type { SecurityZoneLinkView } from "@/lib/types";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const LINK = {
  id: "l1",
  sourceKind: "camera",
  sourceRef: "back",
  sourceLabel: "Back camera",
  origin: "droplet",
  setBy: "droplet",
  evidence: null,
  stateChangedAt: "2026-09-23T21:14:00.000Z",
} as unknown as SecurityZoneLinkView;

function renderPanel(canManage: boolean) {
  const onClose = vi.fn();
  const onKeep = vi.fn(async () => undefined);
  const onUndo = vi.fn(async () => undefined);
  render(
    <LinkWhyPopover
      open
      link={LINK}
      zoneKind="interior"
      canManage={canManage}
      tz="Europe/London"
      now={new Date("2026-09-23T22:00:00Z")}
      onClose={onClose}
      onKeep={onKeep}
      onUndo={onUndo}
    />,
  );
  return { onClose, onKeep, onUndo };
}

describe("LinkWhyPopover — the Close control (WARP-1787)", () => {
  it.each([
    ["at manage", true],
    ["below manage (no Keep or Undo)", false],
  ])("%s: a button named Close closes the panel, and nothing else happens", (_l, canManage) => {
    const { onClose, onKeep, onUndo } = renderPanel(canManage);
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
  });
});
