/**
 * Resolve the AUTHORED CSS cascade against a real DOM element.
 *
 * jsdom has no layout engine and never applies these stylesheets, so
 * `getComputedStyle` returns "" for anything the sheets set — which makes it
 * useless for pinning a layout contract. What this does instead is stronger
 * than grepping the CSS: it parses every stylesheet a route loads with
 * postcss and resolves one property across all of them against the element
 * actually rendered. A rule that stops matching because a class was renamed,
 * or that loses on specificity to a rule in a different stylesheet, goes red.
 *
 * Two limits, stated so nothing built on this reads as broader than it is:
 *   - The corpus is the AUTHORED stylesheets. Tailwind's generated utilities
 *     are not in it, so a caller must separately assert the element under test
 *     carries no utility (and no inline style) for the property in question —
 *     that is what makes the resolution complete rather than partial.
 *   - Only the base layer is resolved. `@container` / `@media` declarations
 *     are excluded from `resolve()` because whether they apply is a layout
 *     question jsdom cannot answer; check those structurally, via `conditions`.
 *
 * Extracted from `home/ask-ai-reflow.test.tsx` (WARP-1875), which was the
 * first test to need it and still its largest consumer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule, type AtRule } from "postcss";

/** `src/` — every sheet path below is relative to it. */
export const SRC = path.resolve(__dirname, "../..");

export const SHEETS = {
  chat: "components/chat/chat-indigo.css",
  homeWidgets: "components/home/home-widgets.css",
  homeBento: "components/home/home-bento.css",
} as const;

/**
 * Every stylesheet the Home route loads, and where it enters the import
 * graph. The cascade is only as honest as this list: a widget's rules live in
 * home-widgets.css, but droplet-shell.css and globals.css target the same
 * elements from a DIFFERENT chunk, and a rule that quietly loses to one of
 * them is precisely the regression this exists to catch.
 *
 *   app/globals.css                      app/layout.tsx (root)
 *   components/shell/indigo-tokens.css   help/HelpLauncher.tsx, home/widgets.tsx
 *   components/shell/droplet-shell.css   help/HelpLauncher.tsx (AuthGate chrome)
 *   components/home/home-bento.css       app/page.tsx
 *   components/home/home-widgets.css     app/page.tsx
 *   components/chat/chat-indigo.css      home/widgets.tsx
 *   components/chat/thinking.css         components/ChatMessage.tsx
 */
export const HOME_SHEETS: readonly string[] = [
  "app/globals.css",
  "components/shell/indigo-tokens.css",
  "components/shell/droplet-shell.css",
  SHEETS.homeBento,
  SHEETS.homeWidgets,
  SHEETS.chat,
  "components/chat/thinking.css",
];

export function readSheet(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8");
}

export interface Decl {
  /** Stylesheet this came from — cross-sheet ties are unresolvable, see below. */
  sheet: string;
  selector: string;
  prop: string;
  value: string;
  /** `!important` outranks every normal declaration regardless of specificity. */
  important: boolean;
  specificity: number;
  order: number;
  /** `@container`/`@media` condition chain, empty for the base layer. */
  conditions: string[];
}

/** (b, c) only — no ids anywhere in these sheets. */
function flatSpecificity(selector: string): number {
  const b = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const c = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return b * 100 + c;
}

/**
 * Specificity as a single comparable number. `:where()` contributes nothing
 * and `:is()` / `:not()` / `:has()` contribute their most specific argument
 * rather than a pseudo-class of their own — without that, `.a:not(.b)` scores
 * 300 instead of 200 and the resolver ranks rules a browser would not. None
 * of these nest in the Home sheets, so one non-nesting pass is enough.
 */
export function specificity(selector: string): number {
  let rest = selector.replace(/::[\w-]+/g, "").replace(/:where\([^()]*\)/g, "");
  let fromArgs = 0;
  rest = rest.replace(/:(?:is|not|has)\(([^()]*)\)/g, (_match, args: string) => {
    fromArgs += Math.max(...args.split(",").map(flatSpecificity));
    return "";
  });
  return fromArgs + flatSpecificity(rest);
}

/** Flatten a stylesheet into declarations tagged with their at-rule chain. */
export function collect(css: string, sheet: string, firstOrder = 0): Decl[] {
  const out: Decl[] = [];
  let order = firstOrder;
  postcss.parse(css).walkRules((rule: Rule) => {
    const conditions: string[] = [];
    let parent = rule.parent;
    while (parent && parent.type === "atrule") {
      const at = parent as AtRule;
      conditions.unshift(`@${at.name} ${at.params}`);
      parent = at.parent;
    }
    for (const selector of rule.selectors) {
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        out.push({
          sheet,
          selector,
          prop: node.prop,
          value: node.value,
          important: node.important === true,
          specificity: specificity(selector),
          order: order++,
          conditions,
        });
      }
    }
  });
  return out;
}

/** One corpus across several stylesheets, with `order` continuous through it. */
export function collectSheets(sheets: { css: string; name: string }[]): Decl[] {
  const out: Decl[] = [];
  for (const { css, name } of sheets) out.push(...collect(css, name, out.length));
  return out;
}

/** The whole Home route's authored cascade, in import order. */
export function collectHomeCascade(): Decl[] {
  return collectSheets(HOME_SHEETS.map((rel) => ({ css: readSheet(rel), name: rel })));
}

export interface Resolution {
  /** What the browser lands on — trustworthy only while `contested` is empty. */
  winner?: Decl;
  /**
   * Declarations from OTHER stylesheets that tie the winner on importance and
   * specificity with a different value. Within one sheet source order is
   * stable; across sheets it is the order the bundler concatenates CSS chunks
   * in, which this repo does not control — so a cross-sheet tie is an
   * unresolved cascade, and the caller should fail on it rather than pick.
   */
  contested: Decl[];
}

/** Importance first, then specificity — the browser's ordering. */
export const rank = (d: Decl) => (d.important ? 1e6 : 0) + d.specificity;

/**
 * Resolve one property for a real DOM element across a whole cascade: every
 * base-layer rule whose selector actually matches, ranked by importance then
 * specificity, ties inside a stylesheet broken by source order.
 */
export function resolve(el: Element, decls: Decl[], prop: string): Resolution {
  const hits = decls.filter((d) => {
    if (d.prop !== prop || d.conditions.length > 0) return false;
    try {
      return el.matches(d.selector);
    } catch {
      // Selectors jsdom cannot parse (::-webkit-scrollbar, :has(), …).
      return false;
    }
  });
  if (hits.length === 0) return { contested: [] };

  const top = Math.max(...hits.map(rank));
  // Last-wins within each sheet, then one candidate per sheet left standing.
  const perSheet = new Map<string, Decl>();
  for (const d of hits) {
    if (rank(d) === top) perSheet.set(d.sheet, d);
  }
  const candidates = [...perSheet.values()].sort((a, b) => a.order - b.order);
  const winner = candidates[candidates.length - 1];
  return { winner, contested: candidates.filter((d) => d.value !== winner.value) };
}
