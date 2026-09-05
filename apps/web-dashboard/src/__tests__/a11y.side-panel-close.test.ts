/**
 * WARP-1787 — every right-side panel owns a Close control.
 *
 * The phone layer drops the `max-w-md` cap from `.dlg-side-panel` below
 * 720px, so the panel fills the viewport and there is NO backdrop strip left
 * to tap. Between 448px and 720px — iPhone SE in landscape (667px), the
 * Galaxy Z Fold inner screen (~673px) — a drawer whose only dismissal was a
 * backdrop tap becomes a trap: nothing visible to press, and a phone has no
 * Escape key. Six of the eight default panels already shipped a close button;
 * the Sidebar "More" drawer (on every route) and the /chat history drawer did
 * not, which is what this pins.
 *
 * The check ENUMERATES rather than lists: a ninth `<Dialog placement="right">`
 * that forgets the control has to fail here. Source-level, matching
 * `a11y.icon-button-labels.test.tsx` — a render harness per consumer would
 * need eight different auth/SWR shims. The two drawers that were actually
 * trapped also carry behavioural tests, in `components/Sidebar.mobile.test.tsx`
 * and `chat-page.history-panel.test.tsx`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
// src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
const here = __dirname;
const SRC = path.resolve(here, "..");

/**
 * Consumers whose Close control is rendered by another module. The /chat
 * drawer hosts the shared conversation rail, and the rail owns the header row
 * the button belongs in — so the page threads `onClose` down instead of
 * floating a second button over it.
 */
const DELEGATES: Record<string, string> = {
  "app/chat/page.tsx": "components/chat/ChatHistoryPanel.tsx",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(abs, out);
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      out.push(abs);
    }
  }
  return out;
}

const consumers = walk(SRC)
  .filter((abs) => readFileSync(abs, "utf-8").includes('placement="right"'))
  .map((abs) => path.relative(SRC, abs).split(path.sep).join("/"))
  // The primitive documents the prop in its own JSDoc; it is not a consumer.
  .filter((rel) => rel !== "components/Dialog.tsx");

describe("WARP-1787 a right-side panel is dismissible with no backdrop to tap", () => {
  it("finds every side-panel consumer (guards the walker itself)", () => {
    // Eight default panels + the 520px Access & Roles sheet. A walker that
    // silently matched nothing would make every case below vacuously pass.
    expect(consumers.length).toBeGreaterThanOrEqual(9);
    expect(consumers).toContain("components/Sidebar.tsx");
    expect(consumers).toContain("app/chat/page.tsx");
  });

  it.each(consumers)("%s exposes a labelled Close control", (rel) => {
    const owner = DELEGATES[rel] ?? rel;
    const src = readFileSync(path.join(SRC, owner), "utf-8");
    // `Close\b` so the role builder's "Close role builder" counts — the
    // requirement is a labelled control, not one exact string.
    expect(
      src,
      `${owner} renders <Dialog placement="right"> with no aria-label="Close…" ` +
        `button. Below 720px the panel is full-width, so the backdrop is gone ` +
        `and this is the only way out.`,
    ).toMatch(/aria-label="Close\b/);
  });

  it("the /chat drawer actually hands its close down to the rail", () => {
    // The delegation above holds only while the page passes `onClose` INTO
    // the rail. The <Dialog>'s own `onClose` renders nothing, and the DESKTOP
    // rail mount must not get one — it has no dialog to leave.
    const src = readFileSync(path.join(SRC, "app/chat/page.tsx"), "utf-8");
    const drawer = src.slice(src.indexOf("mobile-history-heading"));
    const mount = drawer.slice(
      drawer.indexOf("<ChatHistoryPanel"),
      drawer.indexOf("/>", drawer.indexOf("<ChatHistoryPanel")),
    );
    expect(mount).toMatch(/onClose=\{/);
  });
});
