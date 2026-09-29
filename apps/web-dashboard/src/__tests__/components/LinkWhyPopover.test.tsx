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

describe("LinkWhyPopover — Keep and Undo in flight (review #2418)", () => {
  it("in flight: Keep and Undo aria-disabled, never disabled; a second press is refused", async () => {
    let release!: () => void;
    const onClose = vi.fn();
    const onKeep = vi.fn(() => new Promise<undefined>((r) => (release = () => r(undefined))));
    const onUndo = vi.fn(async () => undefined);
    render(
      <LinkWhyPopover open link={LINK} zoneKind="interior" canManage tz="Europe/London" now={new Date("2026-09-23T22:00:00Z")} onClose={onClose} onKeep={onKeep} onUndo={onUndo} />,
    );
    const keep = screen.getByRole("button", { name: "Keep" });
    fireEvent.click(keep);
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
    for (const name of ["Keep", "Undo"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name })).not.toBeDisabled();
    }
    release();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("a refused Keep (409) keeps the panel open and focus on Keep, inside it", async () => {
    const onClose = vi.fn();
    const onKeep = vi.fn(async () => {
      throw Object.assign(new Error("x"), { code: "LINK_NOT_DECIDABLE", status: 409 });
    });
    render(
      <LinkWhyPopover open link={LINK} zoneKind="interior" canManage tz="Europe/London" now={new Date("2026-09-23T22:00:00Z")} onClose={onClose} onKeep={onKeep} onUndo={vi.fn()} />,
    );
    const keep = screen.getByRole("button", { name: "Keep" });
    // Let the dialog's own initial focus (a timer on open) land first, then press Keep from the keyboard's place.
    await vi.waitFor(() => expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement));
    keep.focus();
    fireEvent.click(keep);
    await vi.waitFor(() => expect(onKeep).toHaveBeenCalled());
    await vi.waitFor(() => expect(keep).not.toHaveAttribute("aria-disabled"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(keep);
  });
});
