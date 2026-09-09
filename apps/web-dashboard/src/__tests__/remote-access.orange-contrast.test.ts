/**
 * WARP-1475 (UX send-back) — accessible orange once-only-token warning.
 *
 * The "shown once" warnings in the Link and Add device dialogs render
 * `text-system-orange` (#ff9500 ≈ 2.2:1 as 12px text) on their own
 * `bg-system-orange/10` tint — under WCAG AA 1.4.3's 4.5:1 floor. Mirroring
 * the WARP-633 red fix, globals.css must ship a darkened `--color-system-orange-text`
 * token and a compound-selector override that repoints ONLY the text color when
 * both utilities co-occur.
 *
 * jsdom does not apply the stylesheet, so this is a source-level guard on
 * globals.css (same approach as the WARP-1277 drift gate).
 *
 * Path resolution uses `__dirname`, the one anchoring idiom this package uses
 * (WARP-2654) — see `src/__tests__/helpers/test-paths.ts` for why it is
 * spelled this way here. It is NOT that `import.meta.url` is unsafe on
 * Windows: `fileURLToPath` converts it correctly, and only
 * `new URL(...).pathname` yields the `/C:/...` that `path.resolve` doubles.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalsCss = readFileSync(
  resolve(__dirname, "..", "app", "globals.css"),
  "utf8",
);

describe("WARP-1475 — orange once-only warning clears WCAG AA", () => {
  it("defines a darkened --color-system-orange-text token", () => {
    expect(globalsCss).toMatch(/--color-system-orange-text\s*:/);
  });

  it("repoints the compound text-system-orange + bg-system-orange/10 selector to the token", () => {
    // Escaped `/` in the Tailwind fractional-opacity class name.
    expect(globalsCss).toMatch(
      /\.text-system-orange\.bg-system-orange\\\/10\s*\{[^}]*color:\s*var\(--color-system-orange-text\)/,
    );
  });

  it("provides a distinct dark-mode value so the override is legible in both themes", () => {
    expect(globalsCss).toMatch(
      /\.dark\s+\.text-system-orange\.bg-system-orange\\\/10\s*\{/,
    );
  });
});
