/**
 * DASH-09 — the PWA `themeColor` metadata must stay in lockstep with the
 * design-system accent token.
 *
 * `app/layout.tsx` can't read CSS custom properties at build time (metadata is
 * server-evaluated), so the anchor accent lives in `lib/brand.ts`. This guard
 * pins that constant to the canonical `--color-accent` value declared for the
 * light/default theme in `app/globals.css`. If the accent token is re-pointed
 * without updating `lib/brand.ts`, this test fails — preventing the PWA chrome
 * color from silently drifting out of sync.
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
import { ACCENT_HEX, THEME_COLOR } from "@/lib/brand";

const SRC_ROOT = resolve(__dirname, "..");

describe("DASH-09 themeColor is driven from the accent token", () => {
  it("brand THEME_COLOR equals the brand ACCENT_HEX", () => {
    expect(THEME_COLOR).toBe(ACCENT_HEX);
  });

  it("ACCENT_HEX matches the light-theme --color-accent in globals.css", () => {
    const css = readFileSync(resolve(SRC_ROOT, "app", "globals.css"), "utf8");
    // First declaration is the :root (light / default) accent; the dark-theme
    // override appears later in the file. We pin to the light anchor.
    const match = css.match(/--color-accent:\s*(#[0-9a-fA-F]{3,8})\s*;/);
    expect(match, "expected a --color-accent hex declaration in globals.css").toBeTruthy();
    expect(match![1].toLowerCase()).toBe(ACCENT_HEX.toLowerCase());
  });

  it("layout.tsx sources themeColor from the brand token, not a raw hex", () => {
    const layout = readFileSync(resolve(SRC_ROOT, "app", "layout.tsx"), "utf8");
    // The metadata must reference the imported constant, and must NOT inline
    // the hex literal anymore.
    expect(layout).toMatch(/themeColor:\s*THEME_COLOR/);
    expect(layout).not.toMatch(/themeColor:\s*["']#/);
  });

  it("manifest.json theme_color matches ACCENT_HEX (installed PWA chrome color)", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(SRC_ROOT, "..", "public", "manifest.json"), "utf8"),
    ) as { theme_color?: string };
    expect(manifest.theme_color?.toLowerCase()).toBe(ACCENT_HEX.toLowerCase());
  });
});
