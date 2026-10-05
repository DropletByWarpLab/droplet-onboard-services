/**
 * WARP-3509 — no `/NN` alpha on a colour that is a CSS variable.
 *
 * Tailwind builds `bg-red-500/90` by splitting the colour into channels and
 * writing the alpha in. It can do that for `#ff3b30`. It cannot for
 * `var(--color-system-red)`, which is what every semantic colour in
 * tailwind.config.ts is (system, label, surface, separator, accent, role): there
 * is no `<alpha-value>` placeholder to fill, so it emits NO RULE for the class
 * — no error, no warning, the element just has no such style. That is how the
 * Events page shipped a severity badge with no background (white label on the
 * light placeholder: ~1.08:1), a "Saved" badge with none, and error toasts with
 * no tint and no border. (`.text-system-red.bg-system-red\/10` in globals.css
 * matches by class name, so it still repaints the text of a toast whose tint
 * never rendered.)
 *
 * The same family is already ratcheted for the accent
 * (`scripts/check-dashboard-classes.sh`, rule `accent-alpha`); nothing covered
 * the rest, and well over two hundred sites across the dashboard still carry it.
 * This guard is clean-tree for the components the Events surface is built from —
 * the ratchet for the rest is its own piece of work, and each file there that is
 * cleaned can be added to FILES below.
 *
 * What works instead:
 *   - an opaque token:        `bg-system-orange`            (no alpha)
 *   - a fixed-colour alpha:   `bg-black/60`                 (a hex, so Tailwind can)
 *   - a token, mixed in:      `bg-[color:color-mix(in_srgb,var(--color-system-red)_12%,var(--color-surface-elevated))]`
 *   - a shell token:          `bg-[var(--danger)]`, `border-[color:var(--card-bd)]`
 *
 * Source-level on purpose, like dashboard-classes-guard.test.ts: jsdom never
 * applies a stylesheet, so a test that rendered the component could not see the
 * missing rule either.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import tailwindConfig from "../../tailwind.config";
import { PACKAGE_ROOT, packagePath } from "./helpers/test-paths";

type ColorTree = { [key: string]: string | ColorTree };

/** `system-red`, `accent-hover`, `label-secondary`… — the class suffix of every colour that is a `var()`. */
function varColorNames(tree: ColorTree, prefix = ""): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
    if (typeof value === "string") {
      if (name && value.includes("var(")) names.push(name);
    } else {
      names.push(...varColorNames(value, name));
    }
  }
  return names;
}

const VAR_COLORS = varColorNames(
  (tailwindConfig.theme!.extend as unknown as { colors: ColorTree }).colors,
);

/** Comments name the very classes this guard bans (to explain the ban), so they are not code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/ .*$/gm, "");
}

/**
 * Every utility in `source` that puts an alpha on a variable colour:
 *   `bg-system-red/90`, `hover:!bg-system-orange/25`, `border-accent/25`,
 *   `bg-surface-secondary/80`, `ring-[var(--brand)]/40`.
 */
function varAlphaUtilities(source: string): string[] {
  const hits: string[] = [];
  for (const token of stripComments(source).split(/[\s"'`]+/)) {
    const m = /^(.+)\/(\d+(?:\.\d+)?|\[[^\]]+\])$/.exec(token);
    if (!m) continue;
    const base = m[1];
    const onNamedColor = VAR_COLORS.some((name) => base.endsWith(`-${name}`));
    const onArbitraryVar = /\[[^\]]*var\(/.test(base) && base.endsWith("]");
    if (onNamedColor || onArbitraryVar) hits.push(token);
  }
  return hits;
}

/** The files this guard keeps clean: the Events surface and the toasts it raises. */
const COMPONENT_DIRS = ["src/components/events"];
const FILES = [
  "src/components/Toast.tsx",
  "src/components/recordings/HlsPlayer.tsx",
  "src/components/cameras/CameraEvents.tsx",
  "src/components/cameras/CameraNotificationToast.tsx",
  "src/app/events/page.tsx",
  "src/app/cameras/system/page.tsx",
];

function guardedFiles(): string[] {
  const files = [...FILES.map((f) => packagePath(f))];
  for (const dir of COMPONENT_DIRS) {
    for (const entry of readdirSync(packagePath(dir))) {
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(join(packagePath(dir), entry));
    }
  }
  return files;
}

describe("the detector", () => {
  it("knows which colours are variables, from tailwind.config.ts", () => {
    expect(VAR_COLORS).toEqual(
      expect.arrayContaining([
        "system-red",
        "system-orange",
        "system-yellow",
        "system-green",
        "label-secondary",
        "surface-secondary",
        "separator",
        "accent",
        "accent-subtle",
        "role-owner",
      ]),
    );
    // The brand ramp is hex, so Tailwind can alpha it.
    expect(VAR_COLORS.some((n) => n.startsWith("droplet"))).toBe(false);
  });

  it.each([
    "bg-system-red/90",
    "bg-system-orange/90",
    "bg-label-secondary/90",
    "bg-system-yellow/90",
    "hover:!bg-system-orange/25",
    "border-system-red/25",
    "border-accent/25",
    "bg-surface-secondary/80",
    "text-label-secondary/70",
    "bg-system-red/[0.4]",
    "ring-[var(--brand)]/40",
    "dark:bg-accent-subtle/50",
  ])("flags %s", (cls) => {
    expect(varAlphaUtilities(`<div className="flex ${cls} p-2" />`)).toEqual([cls]);
  });

  it.each([
    "bg-system-red", // opaque
    "bg-black/60", // a hex colour: Tailwind can alpha it
    "bg-white/10",
    "text-white/70",
    "bg-droplet-500/20", // hex ramp
    "bg-[color:color-mix(in_srgb,var(--color-system-red)_12%,var(--color-surface-elevated))]",
    "border-[color:color-mix(in_srgb,var(--color-system-red)_35%,transparent)]",
    "bg-[var(--danger)]",
    "text-[color:var(--danger-ink)]",
    "w-1/2",
    "aspect-4/3",
    "basis-1/3",
    "-translate-x-1/2",
  ])("lets %s through", (cls) => {
    expect(varAlphaUtilities(`<div className="${cls}" />`)).toEqual([]);
  });

  it("reads template-literal and string-concatenated class lists too", () => {
    expect(varAlphaUtilities("const c = `a ${x} bg-system-red/10 b`;")).toEqual(["bg-system-red/10"]);
    expect(varAlphaUtilities("const c = 'a ' + 'bg-system-red/10';")).toEqual(["bg-system-red/10"]);
  });

  it("does not read a comment that explains the ban as a use of it", () => {
    expect(varAlphaUtilities("/** was `bg-system-red/90` */\n// bg-system-red/90 emitted nothing\nconst a = 1;")).toEqual([]);
  });
});

describe("tailwind alpha on a CSS-variable colour (WARP-3509)", () => {
  const files = guardedFiles();

  it("guards the files it says it does", () => {
    const rel = files.map((f) => relative(PACKAGE_ROOT, f).split("\\").join("/"));
    expect(rel).toEqual(
      expect.arrayContaining([
        "src/components/events/EventCard.tsx",
        "src/components/events/EventClipModal.tsx",
        "src/components/events/ReviewCard.tsx",
        "src/components/events/ReviewClipModal.tsx",
        "src/components/Toast.tsx",
      ]),
    );
  });

  it.each(files.map((f) => [relative(PACKAGE_ROOT, f).split("\\").join("/"), f]))(
    "%s has no /NN alpha on a variable colour",
    (_rel, file) => {
      const hits = varAlphaUtilities(readFileSync(file, "utf8"));
      expect(
        hits,
        `Tailwind emits no CSS for these, so the element has no such colour at all. ` +
          `Use an opaque token, a fixed-colour alpha (bg-black/60), or color-mix() — see the note at the top of this test.`,
      ).toEqual([]);
    },
  );
});
