/**
 * WARP-1876 review — the page-entrance stagger must not reach the drag-over
 * overlay.
 *
 * `.page-dropzone` re-emits the shell's staggered page entrance to its own
 * children so a page that wraps everything in one drop target still enters
 * block by block. The drop overlay is the LAST child of that wrapper, so an
 * `:nth-child(N)` rule without the `:not([data-dropzone-overlay])` guard
 * hands it an entrance delay of up to 380ms — the feedback for a gesture
 * the user is already making arrives a third of a second late, and only on
 * pages whose block count happens to hit the rule.
 *
 * jsdom loads no stylesheet and computes no cascade, so this is a
 * source-level guard, in the style of shell/display-utility-contract.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SHELL_CSS = readFileSync(
  path.resolve(__dirname, "../../components/shell/droplet-shell.css"),
  "utf8",
);

/** Every `.page-dropzone > …` selector in the sheet, comments stripped. */
function dropzoneChildSelectors(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*(\.[^{}\n]*\.page-dropzone > [^{}\n]*?)\s*\{/gm)].map(
    (m) => m[1],
  );
}

describe(".page-dropzone entrance animation", () => {
  it("excludes the drop overlay from every child rule, not just the first", () => {
    const selectors = dropzoneChildSelectors(SHELL_CSS);
    // The base rise + eight delays. An empty match would silently pass.
    expect(selectors.length).toBeGreaterThanOrEqual(9);
    for (const selector of selectors) {
      expect(selector, `${selector} would animate the drop overlay`).toContain(
        ":not([data-dropzone-overlay])",
      );
    }
  });

  it("keeps the delays in the shipped order", () => {
    // The guard has to be an addition to the stagger, not a replacement for
    // it — the page entrance is what these rules exist for.
    for (const [n, delay] of [
      [1, 30],
      [4, 180],
      [8, 380],
    ] as const) {
      expect(SHELL_CSS).toContain(
        `.droplet-shell .page-dropzone > *:not([data-dropzone-overlay]):nth-child(${n}) { animation-delay: ${delay}ms; }`,
      );
    }
  });
});
