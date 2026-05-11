/**
 * WARP-288 — AttachmentChip smoke test.
 *
 * Pins the corrected design-system classes that replaced the silently-
 * dropped `border-warning` / `text-positive` / `text-warning` tokens in
 * the original audit (`docs/superpowers/audits/2026-05-08-web-dashboard-ux-audit.md`
 * §2.1 / §5.4):
 *   - failed border → `border-system-orange/60`
 *   - ready check icon → `text-system-green`
 *   - failed warning icon → `text-system-orange`
 *
 * The check is on the rendered `className` string so a future find-and-
 * replace regression (or an attempt to re-introduce an undefined token)
 * is caught directly in the chip's own test rather than only in the
 * cross-cutting `dashboard-classes-guard` test.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AttachmentChip } from "@/components/AttachmentChip";
import type { ChatAttachment } from "@/lib/types";

function makeAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    localId: "att-1",
    filename: "design-notes.pdf",
    bytes: 12_345,
    status: "ready",
    ...overrides,
  };
}

describe("AttachmentChip (WARP-288 token corrections)", () => {
  it("ready state renders the system-green check icon", () => {
    const { container } = render(
      <AttachmentChip attachment={makeAttachment({ status: "ready" })} />,
    );
    // The Check icon is the only SVG carrying the success token.
    const greenIcon = container.querySelector(".text-system-green");
    expect(greenIcon).not.toBeNull();
    // Belt-and-braces: no undefined `text-positive` slipped back in.
    expect(container.innerHTML).not.toContain("text-positive");
  });

  it("ready state does NOT carry the failed border token", () => {
    render(<AttachmentChip attachment={makeAttachment({ status: "ready" })} />);
    const chip = screen.getByTestId("attachment-chip");
    expect(chip.className).not.toMatch(/border-system-orange/);
    expect(chip.className).toMatch(/border-separator/);
  });

  it("failed state renders the system-orange border + warning icon", () => {
    const { container } = render(
      <AttachmentChip
        attachment={makeAttachment({
          status: "failed",
          error: "upload timed out",
        })}
      />,
    );
    const chip = screen.getByTestId("attachment-chip");
    expect(chip.className).toMatch(/border-system-orange/);
    // No undefined `border-warning` slipped back in.
    expect(chip.className).not.toMatch(/border-warning(?![-\w])/);

    // The AlertTriangle icon should carry the warning token.
    const warningIcon = container.querySelector(".text-system-orange");
    expect(warningIcon).not.toBeNull();
    expect(container.innerHTML).not.toContain("text-warning ");
  });
});
