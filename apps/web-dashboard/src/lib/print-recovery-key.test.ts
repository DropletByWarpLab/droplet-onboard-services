/**
 * WARP-3515 — printing the one-time recovery key.
 *
 * The key is shown once, so a paper copy is the most reliable way for an owner
 * to keep it. The printable page is built in a throwaway iframe (so the dialog's
 * own chrome never prints) out of DOM text nodes — never an HTML string — so a
 * drive name the owner typed can't inject markup into it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { printRecoveryKey } from "./print-recovery-key";

afterEach(() => {
  document.querySelectorAll("iframe").forEach((f) => f.remove());
  vi.useRealTimers();
});

describe("printRecoveryKey", () => {
  it("prints a page naming the drive and carrying the key, then reports success", () => {
    let printedDoc: Document | null = null;
    const print = vi.fn((w: Window) => {
      printedDoc = w.document;
    });

    const ok = printRecoveryKey(
      { driveName: "Bay 2", recoveryKey: "AAAA-BBBB-CCCC" },
      { print, now: () => new Date("2026-10-03T12:00:00Z") },
    );

    expect(ok).toBe(true);
    expect(print).toHaveBeenCalledTimes(1);
    const text = printedDoc!.body.textContent ?? "";
    expect(text).toContain("Bay 2");
    expect(text).toContain("AAAA-BBBB-CCCC");
    expect(text).toMatch(/recovery key/i);
    expect(text).toMatch(/2026/);
    // The advice that matters on paper: keep it, and what it opens.
    expect(text).toMatch(/anyone with this key/i);
  });

  it("builds the page from text nodes — a hostile drive name stays inert text", () => {
    let printedDoc: Document | null = null;
    printRecoveryKey(
      { driveName: '<img src=x onerror="window.pwned=1">', recoveryKey: "K" },
      {
        print: (w) => {
          printedDoc = w.document;
        },
      },
    );
    expect(printedDoc!.body.querySelector("img")).toBeNull();
    expect(printedDoc!.body.textContent).toContain('<img src=x onerror="window.pwned=1">');
  });

  it("removes its iframe after printing, so the key does not linger in the page", () => {
    vi.useFakeTimers();
    printRecoveryKey({ driveName: "Bay 2", recoveryKey: "SECRET-KEY" }, { print: vi.fn() });
    // Present while the print dialog is up…
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    // …gone after the safety timeout even if `afterprint` never fires.
    vi.advanceTimersByTime(120_000);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SECRET-KEY");
  });

  it("removes its iframe on `afterprint`", () => {
    let win: Window | null = null;
    printRecoveryKey(
      { driveName: "Bay 2", recoveryKey: "K" },
      {
        print: (w) => {
          win = w;
        },
      },
    );
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    win!.dispatchEvent(new Event("afterprint"));
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("returns false (and leaves nothing behind) when printing throws", () => {
    const ok = printRecoveryKey(
      { driveName: "Bay 2", recoveryKey: "K" },
      {
        print: () => {
          throw new Error("blocked");
        },
      },
    );
    expect(ok).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
