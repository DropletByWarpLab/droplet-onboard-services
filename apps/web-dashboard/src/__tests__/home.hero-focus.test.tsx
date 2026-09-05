/**
 * WARP-298 — hero textarea focus ring.
 *
 * Source-level: assert the chat-capsule wrapper carries
 * `focus-within:ring-*` utilities so keyboard users see focus.
 * Behavioural rendering of the home page requires SWR + auth shims that
 * outweigh the value of asserting Tailwind utility names.
 *
 * Asserted against `components/home/widgets.tsx` (ChatWidget) — the file that
 * actually renders the capsule — so a refactor of the home page entry point
 * can't false-pass (or false-break) the contract via a stale comment anchor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
// src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
const here = __dirname;
const srcPath = path.resolve(here, "../components/home/widgets.tsx");

describe("WARP-298 home hero focus ring", () => {
  it("chat capsule has focus-within ring utilities", () => {
    const src = readFileSync(srcPath, "utf-8");
    expect(src).toMatch(/focus-within:ring-2/);
    expect(src).toMatch(/focus-within:ring-accent\/40/);
  });

  it("textarea has aria-label for screen readers", () => {
    const src = readFileSync(srcPath, "utf-8");
    expect(src).toMatch(/aria-label="Ask Droplet"/);
  });
});
