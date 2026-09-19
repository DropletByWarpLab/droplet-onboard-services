/**
 * WARP-298 — icon-only button aria-label sweep.
 *
 * This test is intentionally source-level (not behavioural): it reads each
 * file the audit flagged and asserts the icon-only `<button>` carries an
 * `aria-label` (literal string or template literal). A behavioural test
 * per file would require ten different render harnesses with auth/SWR
 * shims; the source assertion is sharper and catches regressions cleanly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
// src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
const here = __dirname;
const ROOT = path.resolve(here, "..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("WARP-298 icon-only button aria-labels", () => {
  it("login show/hide password button has dynamic aria-label", () => {
    // The aurora re-skin extracted the login form into SignInForm; the
    // toggle (and its label contract) lives there now.
    const src = read("components/auth/SignInForm.tsx");
    expect(src).toMatch(/aria-label=\{showPassword \? "Hide password" : "Show password"\}/);
  });

  it("setup show/hide password button has dynamic aria-label", () => {
    // The setup wizard's account form was extracted into AccountStep;
    // the toggle (and its label contract) lives there now.
    const src = read("components/setup/steps/AccountStep.tsx");
    expect(src).toMatch(/aria-label=\{showPassword \? "Hide password" : "Show password"\}/);
  });

  it("BreadcrumbNav root button has aria-label and icon is hidden", () => {
    const src = read("components/BreadcrumbNav.tsx");
    // WARP-1944 — the root crumb's label became dynamic (the active space's
    // display label, "My files" default); the aria-label tracks it.
    expect(src).toMatch(/aria-label=\{rootLabel\}/);
    expect(src).toMatch(/FolderOpen size=\{14\} aria-hidden="true"/);
  });

  it("camera detail page Maximize button has aria-label", () => {
    const src = read("app/cameras/[name]/page.tsx");
    expect(src).toMatch(/aria-label="Toggle fullscreen"/);
  });

  it("ClimateControl +/- buttons have aria-labels", () => {
    const src = read("components/smart-home/ClimateControl.tsx");
    expect(src).toMatch(/aria-label="Lower target temperature by 0\.5°C"/);
    expect(src).toMatch(/aria-label="Raise target temperature by 0\.5°C"/);
  });

  it("BrightnessSlider range input has aria-label + valuetext", () => {
    const src = read("components/smart-home/BrightnessSlider.tsx");
    expect(src).toMatch(/aria-label="Brightness"/);
    expect(src).toMatch(/aria-valuetext=\{`\$\{localPct\}%`\}/);
  });

  it("DiscoveryBanner dismiss button has aria-label", () => {
    const src = read("components/smart-home/DiscoveryBanner.tsx");
    expect(src).toMatch(/aria-label="Dismiss discovery banner"/);
  });

  it("devices/clients refresh button has aria-label", () => {
    const src = read("app/devices/clients/page.tsx");
    expect(src).toMatch(/aria-label="Refresh device list"/);
    expect(src).toMatch(/aria-label=\{`Revoke \$\{c\.deviceName\}`\}/);
  });

  it("DropletMark defaults to aria-hidden (decorative) when no aria-label passed", () => {
    const src = read("components/DropletMark.tsx");
    expect(src).toMatch(/aria-hidden=\{labeled \? undefined : true\}/);
  });
});
