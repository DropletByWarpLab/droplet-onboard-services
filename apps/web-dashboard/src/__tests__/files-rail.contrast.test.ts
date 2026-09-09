/**
 * WARP-1548 (review send-back) — every colour the Files places rail paints
 * must clear WCAG 2.1 AA 1.4.3 (4.5:1, normal text) in BOTH themes and on BOTH
 * hosts the rail mounts on.
 *
 * Two defects sit behind this guard, and they compound:
 *
 * 1. The state captions took the vivid fills. Measured in Chrome against the
 *    shipped sheet, `--color-system-orange` reads 1.97:1 on the sidebar
 *    material and 2.20:1 on the drawer card in light mode;
 *    `--color-system-red` reads 3.18:1 and 3.55:1. globals.css already ships
 *    `-text` variants for exactly this (WARP-633 red, WARP-1475 orange) —
 *    the rail now uses them.
 *
 * 2. The rest of the rail reached for `--text`, `--text-muted`, `--text-faint`,
 *    `--brand`, `--border` and `--surface`. Those are DESCENDANT-SCOPED to
 *    `.droplet-shell` / `.droplet-home`, and `AuthGate` renders the Sidebar
 *    ABOVE every page scope (WARP-1079) — so in the sidebar those declarations
 *    were simply dropped and every row inherited label-primary: caption, row,
 *    chip and the active row all painted the same 18.8:1 black, i.e. no
 *    hierarchy and an active state that never lit. In the mobile drawer (whose
 *    `<Dialog>` backdrop does carry `.droplet-shell`) they resolved and then
 *    failed on their own merits: 2.32:1 light / 1.73:1 dark for the caption,
 *    the chip and the disabled rows.
 *
 * jsdom applies no stylesheet, so — like `dp-btn-secondary.contrast.test.ts`
 * and the WARP-1277 drift gate — this is a source-level guard that reads the
 * real token values out of the real sheets and computes the real ratio.
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

const SRC_ROOT = resolve(__dirname, "..");
const globalsCss = readFileSync(resolve(SRC_ROOT, "app", "globals.css"), "utf8");
const shellCss = readFileSync(
  resolve(SRC_ROOT, "components", "shell", "indigo-tokens.css"),
  "utf8"
);

// ── WCAG 2.1 relative luminance + contrast ────────────────────────────────

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(v);
  if (!rgb) throw new Error(`not a colour: ${value}`);
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

/** Source-over composite — what the browser paints for a translucent colour. */
const over = (fg: Rgba, bg: Rgba): Rgba => ({
  r: fg.a * fg.r + (1 - fg.a) * bg.r,
  g: fg.a * fg.g + (1 - fg.a) * bg.g,
  b: fg.a * fg.b + (1 - fg.a) * bg.b,
  a: 1,
});

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const painted = fg.a < 1 ? over(fg, bg) : fg;
  const [hi, lo] = [luminance(painted), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const round = (n: number): number => Math.round(n * 100) / 100;

// ── Token + rule extraction ───────────────────────────────────────────────

/**
 * First declaration of `prop` inside the first block whose selector LIST
 * contains `selector`. The list matters: the rail's provisioning caption
 * shares one rule with WARP-1475's compound override rather than restating
 * `#a3520a` in a second place.
 */
function declIn(css: string, selector: string, prop: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(
    `(^|[},;/*\\s])${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`,
    "m"
  ).exec(css);
  if (!block) return null;
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "m").exec(block[2]);
  return decl ? decl[1].trim() : null;
}

/** Source with comments stripped — prose legitimately names the bad tokens. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** A `:root` / `.dark` contract token. These resolve everywhere. */
function token(theme: Theme, prop: string): string {
  const v = declIn(globalsCss, theme === "dark" ? ".dark" : ":root", prop);
  if (!v) throw new Error(`${theme} contract block is missing ${prop}`);
  return v;
}

/** A `.droplet-shell` token — only the mobile drawer is inside that scope. */
function shellToken(theme: Theme, prop: string): string {
  const v = declIn(
    shellCss,
    theme === "dark" ? ".dark .droplet-shell" : ".droplet-shell",
    prop
  );
  if (!v) throw new Error(`${theme} .droplet-shell is missing ${prop}`);
  return v;
}

/**
 * Resolve a `var(--x)` chain against the contract block, so a rule that says
 * `color: var(--color-system-red-text)` is measured as the value the browser
 * would actually paint rather than as a string.
 */
function resolve_(theme: Theme, value: string, scope?: Record<string, string>): string {
  let v = value.trim();
  for (let i = 0; i < 8 && v.startsWith("var("); i++) {
    const name = /^var\(\s*(--[\w-]+)/.exec(v)?.[1];
    if (!name) break;
    v = (scope?.[name] ?? token(theme, name)).trim();
  }
  return v;
}

/** `color` declared by a `.files-rail-*` rule, honouring the `.dark` variant. */
function railColor(theme: Theme, selector: string): Rgba {
  const light = declIn(globalsCss, selector, "color");
  if (!light) throw new Error(`globals.css has no \`color\` on ${selector}`);
  // Rules that mint a locally-scoped token (the WARP-1475 orange) carry the
  // value on the rule itself, and the dark override restates only the token.
  const localLight = declIn(globalsCss, selector, "--color-system-orange-text");
  const localDark = declIn(globalsCss, `.dark ${selector}`, "--color-system-orange-text");
  const scope: Record<string, string> = {};
  if (theme === "light" && localLight) scope["--color-system-orange-text"] = localLight;
  if (theme === "dark" && localDark) scope["--color-system-orange-text"] = localDark;
  return parseColor(resolve_(theme, light, scope));
}

// ── The two hosts, painted ────────────────────────────────────────────────
//
// sidebar: `<aside className="bg-[var(--color-sidebar-bg)] dp-material">` over
//          `<body>`'s `bg-surface-secondary`  (Sidebar.tsx / globals.css @layer base)
// drawer:  the `<Dialog placement="right">` panel's
//          `style={{ background: "var(--card-bg)" }}`, inside a backdrop that
//          carries `.droplet-shell`  (Dialog.tsx)

function hostBackground(theme: Theme, host: "sidebar" | "drawer"): Rgba {
  if (host === "drawer") return parseColor(shellToken(theme, "--card-bg"));
  const page = parseColor(token(theme, "--color-surface-secondary"));
  return over(parseColor(token(theme, "--color-sidebar-bg")), page);
}

/** The rights chip paints its own opaque fill on top of the host. */
function chipBackground(theme: Theme, host: "sidebar" | "drawer"): Rgba {
  return over(
    parseColor(token(theme, "--color-surface-tertiary")),
    hostBackground(theme, host)
  );
}

const AA = 4.5;

const SURFACES = [
  { host: "sidebar" as const, label: "sidebar material" },
  { host: "drawer" as const, label: "More-drawer card" },
];

describe("WARP-1548 — the Files rail clears WCAG AA on both hosts", () => {
  const rows = [
    { name: "group caption", selector: ".files-rail-caption", chip: false },
    { name: "library row", selector: ".files-rail-row", chip: false },
    { name: "active row", selector: '.files-rail-row[aria-current="page"]', chip: false },
    { name: "rights chip", selector: ".files-rail-chip", chip: true },
    { name: '"Setting up…"', selector: ".files-rail-state-provisioning", chip: false },
    { name: '"Needs attention"', selector: ".files-rail-state-failed", chip: false },
  ];

  for (const theme of THEMES) {
    for (const { host, label } of SURFACES) {
      for (const { name, selector, chip } of rows) {
        it(`${theme}: ${name} on the ${label}`, () => {
          const fg = railColor(theme, selector);
          const bg = chip ? chipBackground(theme, host) : hostBackground(theme, host);
          const ratio = round(contrast(fg, bg));
          expect(
            ratio,
            `${selector} measured ${ratio}:1 on the ${label} (${theme})`
          ).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }
});

describe("the rail never reaches back for a colour that fails, or one that is out of scope", () => {
  const railTsx = stripComments(
    readFileSync(resolve(SRC_ROOT, "components", "nav", "FilesLibrariesNav.tsx"), "utf8")
  );
  /** Every `.files-rail*` rule in the sheet, comments stripped. */
  const railRules = stripComments(globalsCss)
    .split(/(?=\n[.:@])/)
    .filter((chunk) => /^\s*\.(dark\s+\.)?files-rail/.test(chunk))
    .join("\n");

  it("uses the -text variants, never the vivid system fills", () => {
    // Measured at 1.97:1 (orange) and 3.18:1 (red) on the sidebar in light
    // mode — see the file header.
    expect(railTsx).not.toMatch(/--color-system-(red|orange)\b(?!-text)/);
    expect(globalsCss).toMatch(
      /\.files-rail-state-failed\s*\{[^}]*color:\s*var\(--color-system-red-text\)/
    );
    expect(globalsCss).toMatch(/\.files-rail-state-provisioning[^{]*\{[^}]*--color-system-orange-text/);
  });

  it("carries no `.droplet-shell`-scoped custom property at all", () => {
    // The Sidebar renders above every page scope (WARP-1079), so these are
    // dropped declarations there, not colours. Both the component and the
    // rail's own rules must key off the :root/.dark contract instead.
    const SHELL_SCOPED = /var\(--(?:text|text-muted|text-faint|brand|brand-hover|border|surface|surface-2|card-bg)\)/;
    expect(railTsx).not.toMatch(SHELL_SCOPED);
    expect(railRules).not.toMatch(SHELL_SCOPED);
    // Sanity: the slice above actually found the rules it is policing.
    expect(railRules).toMatch(/\.files-rail-row/);
    expect(railRules).toMatch(/\.files-rail-state-provisioning/);
  });

  it("needs no !important to make hover work any more", () => {
    // The `!important` existed only because the resting colour was inline.
    expect(railRules).not.toMatch(/!important/);
  });
});
