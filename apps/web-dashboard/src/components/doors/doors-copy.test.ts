/**
 * ADR-055 P4b — the /doors page never promises what Droplet does not do.
 *
 * The Security copy lint's rules, applied to the doors page: Droplet shows what
 * a door reports; it is not an alarm company, it does not lock or unlock a door
 * from this page, and nothing on the page says a door is safe. So no string a
 * person reads on /doors may say monitor, armed, arm, alarm, secure, protected
 * or guard, nor "all clear" or "all locked", nor the code's word for a tier
 * ("family" — a role is named through tierLabel()), which is the list
 * security-copy.test.ts holds for /security.
 *
 * Doors adds four of its own, each one a promise the page cannot keep today:
 *
 *   · "locked" / "unlocked" as a state. The page shows whether a door is open
 *     or closed, which is not whether it is locked. ("Nothing here locks or
 *     unlocks a door", and "Unlock allowed" as what a door reported, are verbs
 *     and events, and pass.)
 *   · "safe", "safely", "safety".
 *   · alerts, notifications, detection, prevention. Nothing derives a
 *     forced-door or held-open alert yet, and nothing tells anyone.
 *   · anything that presents a position as current — right now, currently,
 *     live, real-time, up to date. A position is the last thing a door
 *     reported, and the page says when. Never as current without its age.
 *
 * WHAT IS SCANNED
 *   · Every export of every module in components/doors and app/doors, walked at
 *     RUNTIME (COPY, the label tables, the choices): every string value, however
 *     deeply nested, and every KEY of an exported object whose name contains
 *     COPY. Functions are skipped — the copy they compose comes from these.
 *   · Every module file on disk must be one of the imported ones, so a new
 *     component cannot join the page unscanned.
 *   · The literal text the source puts on screen without an export: JSX text
 *     nodes and the aria-label / title / placeholder / alt / label attributes.
 *
 * There is no allow-list: nothing on this page needs to name a banned word to
 * deny it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PACKAGE_ROOT, packagePath } from "../../__tests__/helpers/test-paths";

import * as DoorDialog from "./DoorDialog";
import * as DoorEvents from "./DoorEvents";
import * as DoorsNotAvailable from "./DoorsNotAvailable";
import * as DoorsPanel from "./DoorsPanel";
import * as doorCopy from "./door-copy";
import * as DoorsPage from "@/app/doors/page";

const MODULES: Record<string, Record<string, unknown>> = {
  "src/components/doors/DoorDialog.tsx": DoorDialog,
  "src/components/doors/DoorEvents.tsx": DoorEvents,
  "src/components/doors/DoorsNotAvailable.tsx": DoorsNotAvailable,
  "src/components/doors/DoorsPanel.tsx": DoorsPanel,
  "src/components/doors/door-copy.ts": doorCopy,
  "src/app/doors/page.tsx": DoorsPage,
};

const BANNED: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  // The Security copy lint's list (security-copy.test.ts).
  ["monitor", /monitor/i],
  ["armed", /armed/i],
  ["arm", /\barm\b/i],
  ["alarm", /alarm/i],
  ["secure", /\bsecure\b/i],
  ["protected", /protected/i],
  ["guard", /guard/i],
  ["space", /\bspaces?\b/i],
  ["zone (as a UI noun)", /\bzones?\b/i],
  ["suppress", /\bsuppress/i],
  ["baseline", /\bbaselines?\b/i],
  ["all clear", /\ball\s+clear\b/i],
  ["all locked", /\ball\s+locked\b/i],
  ["family", /\bfamil(?:y|ies)\b/i],
  // Doors' own.
  ["locked / unlocked as a state", /\b(?:un)?locked\b/i],
  ["safe", /\bsafe(?:ty|ly)?\b/i],
  ["protect", /\bprotect/i],
  ["alert", /\balert/i],
  ["notify", /\bnotif/i],
  ["detect", /\bdetect/i],
  ["prevent", /\bprevent/i],
  ["right now", /\bright\s+now\b/i],
  ["current / currently", /\bcurrent(?:ly)?\b/i],
  ["live", /\blive\b/i],
  ["real-time", /\breal[-\s]?time\b/i],
  ["up to date", /\bup[-\s]to[-\s]date\b/i],
];

interface Found {
  where: string;
  text: string;
}

/** Every string under an export, and the keys of COPY-named objects. */
function collect(): { values: Found[]; keys: Found[] } {
  const values: Found[] = [];
  const keys: Found[] = [];
  const walk = (v: unknown, where: string, copyKeys: boolean, seen: Set<unknown>): void => {
    if (typeof v === "string") {
      values.push({ where, text: v });
      return;
    }
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`, copyKeys, seen));
      return;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return; // components, icons, class instances
    for (const [k, x] of Object.entries(v)) {
      if (copyKeys) keys.push({ where: `${where}.${k}`, text: k });
      walk(x, `${where}.${k}`, copyKeys, seen);
    }
  };
  for (const [file, mod] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default" || typeof value === "function") continue;
      walk(value, `${file} ${name}`, /COPY/.test(name), new Set());
    }
  }
  return { values, keys };
}

function violations(found: Found[]): string[] {
  const out: string[] = [];
  for (const f of found) {
    for (const [name, re] of BANNED) if (re.test(f.text)) out.push(`${f.where}: "${f.text}" says ${name}`);
  }
  return out;
}

/** Source files under a package-relative folder, as package-relative `/` paths. */
function filesUnder(rel: string): string[] {
  const root = packagePath(rel);
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(PACKAGE_ROOT, full).split(sep).join("/"));
    }
  };
  visit(root);
  return out.sort();
}

/** Text a person reads that is written straight into the JSX: text nodes and the reading attributes. */
function literalScreenText(file: string): Found[] {
  const code = readFileSync(packagePath(file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out: Found[] = [];
  for (const m of code.matchAll(/>([^<>{}=;()]*[A-Za-z][^<>{}=;()]*)</g)) {
    const text = m[1]!.trim();
    if (text) out.push({ where: `${file} <jsx text>`, text });
  }
  for (const m of code.matchAll(/\b(?:aria-label|title|placeholder|alt|label)=(["'])([^"']*)\1/g)) {
    out.push({ where: `${file} <attribute>`, text: m[2]! });
  }
  return out;
}

describe("Doors copy lint", () => {
  it("scans every module in components/doors and app/doors (none joins unscanned)", () => {
    const onDisk = [...filesUnder("src/components/doors"), ...filesUnder("src/app/doors")].sort();
    expect(onDisk).toEqual(Object.keys(MODULES).sort());
  });

  it("finds the copy it claims to scan (a lint over nothing passes everything)", () => {
    const { values, keys } = collect();
    expect(values.length).toBeGreaterThan(60);
    expect(values).toContainEqual({ where: "src/components/doors/door-copy.ts COPY.title", text: "Doors" });
    expect(values.some((v) => v.where.startsWith("src/components/doors/door-copy.ts EVENT_LABEL."))).toBe(true);
    expect(values.some((v) => v.where.startsWith("src/components/doors/door-copy.ts SOURCE_CHOICES"))).toBe(true);
    expect(values.some((v) => v.where.startsWith("src/components/doors/door-copy.ts POSITION_LABEL."))).toBe(true);
    expect(keys.some((k) => k.where === "src/components/doors/door-copy.ts COPY.retireBody")).toBe(true);
  });

  it("no exported string breaks a rule", () => {
    expect(violations(collect().values)).toEqual([]);
  });

  it("no COPY key breaks a rule either", () => {
    expect(violations(collect().keys)).toEqual([]);
  });

  it("no literal JSX text or reading attribute in either folder breaks a rule", () => {
    const files = [...filesUnder("src/components/doors"), ...filesUnder("src/app/doors")];
    const found = files.flatMap(literalScreenText);
    expect(found.length).toBeGreaterThan(0);
    expect(violations(found)).toEqual([]);
  });

  // Guards the matcher itself.
  it.each([
    ["Droplet is monitoring the doors"],
    ["The door is armed"],
    ["Arm the door"],
    ["Alarm sent"],
    ["Your doors are secure"],
    ["Protected by Droplet"],
    ["Guarding the door"],
    ["All clear"],
    ["The doors are all locked"],
    ["Family"],
    // Doors' own
    ["The door is locked"],
    ["Unlocked"],
    ["Your doors are safe"],
    ["Keeps you safely informed"],
    ["Droplet will alert you"],
    ["You'll get a notification"],
    ["Droplet notifies the owner"],
    ["Detects a forced door"],
    ["Prevents break-ins"],
    ["Closed right now"],
    ["Currently open"],
    ["The current position"],
    ["Live status"],
    ["Real-time position"],
    ["Real time updates"],
    ["Always up to date"],
  ])("the matcher catches %j", (text) => {
    expect(violations([{ where: "probe", text }])).not.toEqual([]);
  });

  it.each([
    ["Closed since 6:02 PM"],
    ["Nothing here locks or unlocks a door."],
    ["Unlock allowed"],
    ["Unlock refused"],
    ["Latch pulled back"],
    ["Position unknown"],
    ["Forced open"],
    ["Left open"],
    ["Retire Front door?"],
    ["Droplet stopped hearing from this door."],
    ["Lock"],
    ["Doors isn't available"],
    ["Clear the form"],
    ["Show older"],
  ])("the matcher lets %j through", (text) => {
    expect(violations([{ where: "probe", text }])).toEqual([]);
  });
});
