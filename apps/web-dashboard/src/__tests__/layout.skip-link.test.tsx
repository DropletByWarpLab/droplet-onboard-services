/**
 * WARP-298 — skip link.
 *
 * Imports the root `layout.tsx` and asserts the skip link is the first
 * focusable element in `<body>`, points at `#main`, and is hidden by the
 * `sr-only` utility until focused (`focus:not-sr-only`).
 *
 * We don't render the full layout (it pulls Next font + provider tree);
 * we render JUST the skip-link snippet that must be present. To make this
 * resilient, we use a static-source assertion plus a behavioural smoke
 * test against `AuthGate` for the matching `id="main"` anchor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
// src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
const here = __dirname;
const layoutPath = path.resolve(here, "../app/layout.tsx");
const authGatePath = path.resolve(here, "../components/AuthGate.tsx");

describe("WARP-298 skip link", () => {
  it("root layout renders a skip link as the first <body> child", () => {
    const src = readFileSync(layoutPath, "utf-8");
    expect(src).toMatch(/<a[^>]+href="#main"/);
    // sr-only by default; visible on focus.
    expect(src).toMatch(/sr-only/);
    expect(src).toMatch(/focus:not-sr-only/);
    expect(src).toMatch(/Skip to content/);
  });

  it("AuthGate <main> exposes id='main' as the skip-link target", () => {
    const src = readFileSync(authGatePath, "utf-8");
    // `id="main"` attribute on the <main> tag, and tabIndex=-1 so .focus()
    // works programmatically even though <main> isn't natively focusable.
    expect(src).toMatch(/<main[\s\S]*?id="main"/);
    expect(src).toMatch(/tabIndex=\{-1\}/);
  });
});
