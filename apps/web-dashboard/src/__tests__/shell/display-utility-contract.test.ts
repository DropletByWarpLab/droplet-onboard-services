/**
 * WARP-1792 — `.droplet-shell X { display: … }` silently defeats the
 * components' own display utilities.
 *
 * A `.droplet-shell <class>` selector is specificity (0,2,0). Tailwind's
 * `.hidden` / `.lg:flex` are (0,1,0), and the UA's `[hidden] { display: none }`
 * is an origin-level default that loses to ANY author declaration. So a
 * `display` in this stylesheet beats what the component asked for, and does it
 * silently — the JSX still reads `hidden lg:flex`, which is exactly why this
 * shipped: the source looks correct at every call site.
 *
 * Measured cost on /chat at 375px before the fix: the rail rendered at 277px
 * and left the conversation 98px, 26% of the viewport, with the WARP-331
 * mobile drawer ALSO live — two history UIs at once.
 *
 * jsdom has no cascade resolution across stylesheets and no layout, so this is
 * a source-level guard. It is narrow on purpose: it pins the two elements whose
 * display is owned by a utility, not the whole stylesheet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule } from "postcss";
import { classNameSites, TAILWIND_DISPLAY_RE } from "../helpers/class-names";

const SRC = path.resolve(__dirname, "../..");

const SHELL_CSS = readFileSync(
  path.resolve(__dirname, "../../components/shell/droplet-shell.css"),
  "utf8",
);
const CHAT_CSS = readFileSync(
  path.resolve(__dirname, "../../components/chat/chat-indigo.css"),
  "utf8",
);

/** Body of the first rule whose selector matches, comments stripped. */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `rule "${selector}" not found`).toBeGreaterThan(-1);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("display ownership vs. Tailwind utilities", () => {
  it("`.conv-rail` does not declare display — `hidden lg:flex` owns it", () => {
    // chat/page.tsx:618 renders `className="conv-rail hidden lg:flex"`. Any
    // `display` here outranks `.hidden` and puts the desktop rail back on
    // phones alongside the mobile drawer.
    const body = ruleBody(CHAT_CSS, ".droplet-shell .conv-rail");
    expect(body).not.toMatch(/(^|;)\s*display\s*:/);
    // The rest of the rule must still apply on desktop, where `lg:flex`
    // supplies the display.
    expect(body).toMatch(/width:\s*276px/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it("`.tabstrip[hidden]` restores the meaning of the hidden attribute", () => {
    // network/page.tsx:495 renders `hidden={mode === "simple"}` on a
    // `.tabstrip`, whose author `display: flex` beats the UA's
    // `[hidden] { display: none }`.
    expect(SHELL_CSS).toMatch(
      /\.droplet-shell \.tabstrip\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    // ...and it must come after the base rule, or source order drops it.
    expect(SHELL_CSS.indexOf(".droplet-shell .tabstrip[hidden]")).toBeGreaterThan(
      SHELL_CSS.indexOf(".droplet-shell .tabstrip {"),
    );
  });
});

/* ── WARP-3043 — one owner for `display`, derived rather than listed ─────────
 *
 * The two pins above are the cases WARP-1792 found by hand. The class of bug is
 * general: any class a chat stylesheet gives a `display` at (0,2,0) silently
 * beats a Tailwind display utility (0,1,0) on the same element. `chat-iconbtn
 * lg:hidden` shipped that way on both /chat drawer triggers — the rule reads
 * `display: inline-flex`, so `lg:hidden` never hid them and a second history
 * panel opened beside the rail on desktop.
 *
 * So the owned set is DERIVED from the sheets: every class that is the whole
 * last compound of a selector (pseudo-classes allowed) in a rule that declares
 * `display`. Scope classes are not element classes and are excluded. The
 * scanned files are the surfaces those sheets style.
 */

const OWNER_SHEETS = [
  "components/chat/chat-indigo.css",
  "components/workshop/workshop.css",
];

/** Classes that set a SCOPE (tokens, chrome) rather than style an element. */
const SCOPE_CLASSES = new Set([
  "droplet-shell",
  "chat-app",
  "workshop-app",
  "droplet-familiar",
  "fam-top",
]);

/** Split a selector on its top-level combinators; return the last compound. */
function lastCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return selector.slice(start).trim();
}

/** Drop pseudo-classes and pseudo-elements (with their argument lists). */
function stripPseudo(compound: string): string {
  let out = "";
  let i = 0;
  while (i < compound.length) {
    if (compound[i] !== ":") {
      out += compound[i++];
      continue;
    }
    i++;
    if (compound[i] === ":") i++;
    while (i < compound.length && /[\w-]/.test(compound[i])) i++;
    if (compound[i] === "(") {
      let depth = 0;
      do {
        if (compound[i] === "(") depth++;
        if (compound[i] === ")") depth--;
        i++;
      } while (i < compound.length && depth > 0);
    }
  }
  return out;
}

function ownedDisplayClasses(): Map<string, string> {
  const owned = new Map<string, string>();
  for (const sheet of OWNER_SHEETS) {
    const css = readFileSync(path.join(SRC, sheet), "utf8");
    postcss.parse(css).walkRules((rule: Rule) => {
      const declaresDisplay = rule.nodes.some(
        (n) => n.type === "decl" && n.prop === "display",
      );
      if (!declaresDisplay) return;
      for (const selector of rule.selectors) {
        const compound = stripPseudo(lastCompound(selector));
        const m = /^\.([\w-]+)$/.exec(compound);
        if (!m || SCOPE_CLASSES.has(m[1])) continue;
        if (!owned.has(m[1])) owned.set(m[1], `${sheet} \`${selector}\``);
      }
    });
  }
  return owned;
}

const SCANNED_DIRS = ["app/chat", "components/chat", "components/workshop"];
const SCANNED_FILES = [
  "components/ChatInput.tsx",
  "components/ChatMessage.tsx",
  "components/ModelSelector.tsx",
  "components/help/HelpLauncher.tsx",
];

function walkTsx(rel: string): string[] {
  const abs = path.join(SRC, rel);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const child = path.join(rel, name);
    if (statSync(path.join(SRC, child)).isDirectory()) out.push(...walkTsx(child));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(child);
  }
  return out;
}

function scannedFiles(): string[] {
  return [...SCANNED_DIRS.flatMap(walkTsx), ...SCANNED_FILES]
    .map((f) => f.split(path.sep).join("/"))
    .sort();
}

/** `file:line class+utility` for every element that pairs an owner with a utility. */
function displayOffenders(): string[] {
  const owned = ownedDisplayClasses();
  const out: string[] = [];
  for (const file of scannedFiles()) {
    const src = readFileSync(path.join(SRC, file), "utf8");
    for (const site of classNameSites(src)) {
      const owners = site.tokens.filter((t) => owned.has(t));
      const utils = site.tokens.filter((t) => TAILWIND_DISPLAY_RE.test(t));
      if (owners.length && utils.length) {
        out.push(`${file}:${site.line} ${owners.join(",")}+${utils.join(",")}`);
      }
    }
  }
  return out;
}

describe("display ownership is derived from the chat sheets (WARP-3043)", () => {
  it("derives a real owner set — the guard cannot pass on an empty one", () => {
    const owned = ownedDisplayClasses();
    // Known owners on every version of these sheets: a vacuous derivation
    // (a parser change, a moved file) would otherwise make the scan below
    // pass by construction.
    expect(owned.has("chat-iconbtn")).toBe(true);
    expect(owned.has("chat-send")).toBe(true);
    // Scope classes and utility-owned rails are never owners.
    expect(owned.has("droplet-shell")).toBe(false);
    expect(owned.has("conv-rail")).toBe(false);
    expect(scannedFiles()).toContain("app/chat/page.tsx");
    expect(scannedFiles()).toContain("components/workshop/WorkshopSpace.tsx");
  });

  it("reads className values in every shape the dashboard writes them", () => {
    const sites = classNameSites(
      [
        `<a className="chat-iconbtn lg:hidden" />`,
        `<b className={\`chat-send \${on ? "hidden" : ""}\`} />`,
        `<c className={cn("x",`,
        `  on && "md:flex")} />`,
      ].join("\n"),
    );
    expect(sites.map((s) => s.line)).toEqual([1, 2, 3]);
    expect(sites[0].tokens).toEqual(["chat-iconbtn", "lg:hidden"]);
    expect(sites[1].tokens).toContain("hidden");
    expect(sites[2].tokens).toEqual(["x", "md:flex"]);
    expect(TAILWIND_DISPLAY_RE.test("lg:hidden")).toBe(true);
    expect(TAILWIND_DISPLAY_RE.test("flex-1")).toBe(false);
  });

  it("no element pairs a sheet-owned display class with a Tailwind display utility", () => {
    expect(displayOffenders()).toEqual([
      "app/chat/page.tsx:882 chat-iconbtn+lg:hidden",
      "app/chat/page.tsx:926 chat-iconbtn+lg:hidden",
    ]);
  });
});
