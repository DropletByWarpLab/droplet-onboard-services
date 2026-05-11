/**
 * WARP-298 — hero textarea focus ring.
 *
 * Source-level: assert the chat-capsule wrapper carries
 * `focus-within:ring-*` utilities so keyboard users see focus.
 * Behavioural rendering of the home page requires SWR + auth shims that
 * outweigh the value of asserting Tailwind utility names.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const srcPath = path.resolve(here, "../app/page.tsx");

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
