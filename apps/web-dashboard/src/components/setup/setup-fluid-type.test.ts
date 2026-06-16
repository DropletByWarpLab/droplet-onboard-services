/**
 * WARP-820 — the wizard's fluid type is SCOPED and its accessibility floors are
 * enforced in CSS.
 *
 * jsdom can't compute `clamp()` against a viewport, so this asserts the SOURCE
 * contract instead: under `.setup-shell` the `type-*` sizes are `clamp()`s, and
 * the hard MIN floors hold —
 *   • body / subheadline ≥ 13px
 *   • caption ≥ 11px
 * and the BASE (unscoped) tokens stay fixed-px so the rest of the dashboard is
 * untouched.
 *
 * The file is read via `fs` from `process.cwd()` (the dashboard package root) —
 * NOT `new URL(import.meta.url)`, which yields a `C:\C:\…` ENOENT on Windows
 * (see the pre-existing a11y source-scrape suites).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** Pull the first px value out of a `clamp(MIN, …)` declaration. */
function clampMinPx(decl: string): number {
  const m = decl.match(/clamp\(\s*([\d.]+)px/);
  if (!m) throw new Error(`no clamp() min in: ${decl}`);
  return parseFloat(m[1]);
}

/** Grab the `font-size:` line for a `.setup-shell .type-X` rule. */
function fluidFontSize(token: string): string {
  const re = new RegExp(
    `\\.setup-shell\\s+\\.${token}\\s*\\{[^}]*?font-size:\\s*([^;]+);`,
    "s",
  );
  const m = css.match(re);
  if (!m) throw new Error(`no scoped font-size for .${token}`);
  return m[1].trim();
}

describe("setup-shell fluid type — scope + a11y floors (WARP-820)", () => {
  it("scopes every fluid override under .setup-shell (not the bare token)", () => {
    // The override block exists and is namespaced.
    expect(css).toMatch(/\.setup-shell\s+\.type-title-1\s*\{/);
    expect(css).toMatch(/\.setup-shell\s+\.type-body\s*\{/);
    expect(css).toMatch(/\.setup-shell\s+\.type-caption-1\s*\{/);
  });

  it("uses viewport-height-aware clamp() for the title (scales to viewport)", () => {
    const size = fluidFontSize("type-title-1");
    expect(size).toContain("clamp(");
    expect(size).toContain("vh");
  });

  it("enforces the body floor ≥ 13px", () => {
    expect(clampMinPx(fluidFontSize("type-body"))).toBeGreaterThanOrEqual(13);
  });

  it("enforces the subheadline floor ≥ 13px", () => {
    expect(clampMinPx(fluidFontSize("type-subheadline"))).toBeGreaterThanOrEqual(
      13,
    );
  });

  it("enforces the caption floor ≥ 11px (caption-1 clamp, caption-2 pinned)", () => {
    expect(clampMinPx(fluidFontSize("type-caption-1"))).toBeGreaterThanOrEqual(
      11,
    );
    // caption-2 is already at the 11px floor → pinned, must NOT be < 11px.
    const cap2 = fluidFontSize("type-caption-2");
    const px = cap2.includes("clamp(")
      ? clampMinPx(cap2)
      : parseFloat(cap2.match(/([\d.]+)px/)?.[1] ?? "0");
    expect(px).toBeGreaterThanOrEqual(11);
  });

  it("keeps the BASE (unscoped) tokens fixed-px — rest of the dashboard untouched", () => {
    // The base type-body is still the fixed 17px @apply; no clamp leaked in.
    expect(css).toMatch(/\.type-body\s*\{\s*@apply\s+text-\[17px\]/);
    expect(css).toMatch(/\.type-caption-1\s*\{\s*@apply\s+text-\[12px\]/);
  });
});
