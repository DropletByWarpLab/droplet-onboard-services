/**
 * WARP-2977 P2b (spec §8 "Copy rules", §9 "The copy lint") — the Security
 * pages never promise what Droplet does not do.
 *
 * Droplet shows what happened on the site; it is not an alarm company. So no
 * string a person reads on /security, /security/zones or /security/settings
 * may say monitor, armed, arm, alarm, secure, protected, guard or space — nor
 * "zone" as a UI noun ("Area" is the noun; "timezone" is the ordinary word
 * for what the owner picks, and stays).
 *
 * WARP-2980 (P5 PR-B): nor the code's words for what the Patterns page calls
 * "Expected activity" and "what's usual" — suppress…, baseline(s) — matched
 * WORD-INITIALLY, so an identifier such as SecuritySuppressionView never trips
 * it; and never "all clear" or "all locked" (brief §3.2: a quiet source is
 * shown as quiet, never as all clear — the same lines P3 PR-C and the wall
 * add, one copy each).
 *
 * WHAT IS SCANNED
 *   · Every export of every module in components/security and app/security,
 *     walked at RUNTIME (COPY objects, MODE_DISCLAIMER, KIND_LABEL,
 *     SOURCE_LABEL, SUGGESTIONS, PRESETS, OPEN_FOR_OPTIONS, …): every string
 *     value, however deeply nested, and every KEY of an exported object whose
 *     name contains COPY. Functions are skipped — the copy they compose comes
 *     from these objects.
 *   · Every module file on disk must be one of the imported ones, so a new
 *     component cannot join the pages unscanned.
 *   · The literal text the source puts on screen without an export: JSX text
 *     nodes and the aria-label / title / placeholder / alt / label string
 *     attributes of every file in both folders.
 *
 * NEGATION: an explicit ALLOW-LIST, not a negation-aware matcher. There is
 * exactly one exception, pinned to the one place it lives and checked to
 * still exist, so a stale entry fails instead of silently widening:
 *   · MODE_DISCLAIMER's sentence "It doesn't lock doors, arm anything, or call
 *     anyone." — it has to name "arm" to deny it. Only that exact sentence is
 *     cut out; the rest of the disclaimer is scanned like everything else.
 * (WARP-2978 removed the second one, P2a's COPY key `notAlarm`, with the key:
 * its line became `alertsLine` / `alertsNotReady`. No key is exempt now.)
 * A negation-aware rule was rejected: "doesn't … arm" and "isn't armed" read
 * the same to a regex as "arm it" after a clause break, so it would let
 * positive claims through whenever a "not" appears earlier in the sentence.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PACKAGE_ROOT, packagePath } from "../../__tests__/helpers/test-paths";

import * as AreaDialog from "./AreaDialog";
import * as AreaLinksDialog from "./AreaLinksDialog";
import * as AreasPanel from "./AreasPanel";
import * as ExceptionsEditor from "./ExceptionsEditor";
import * as ExpectedActivityCard from "./ExpectedActivityCard";
import * as ExpectedActivityDialog from "./ExpectedActivityDialog";
import * as HoursEditor from "./HoursEditor";
import * as LearningList from "./LearningList";
import * as AckHistory from "./AckHistory";
import * as AlertRoutingPanel from "./AlertRoutingPanel";
import * as IncidentCard from "./IncidentCard";
import * as IncidentList from "./IncidentList";
import * as IncidentView from "./IncidentView";
import * as NoticeList from "./NoticeList";
import * as ReasonList from "./ReasonList";
import * as ResolveDialog from "./ResolveDialog";
import * as incidentCopy from "./incident-copy";
import * as ModeCard from "./ModeCard";
import * as PrecisionCard from "./PrecisionCard";
import * as SecurityFeed from "./SecurityFeed";
import * as TimezoneSelect from "./TimezoneSelect";
import * as UsualGrid from "./UsualGrid";
import * as PatternsCopy from "./patterns-copy";
import * as SecurityPage from "@/app/security/page";
import * as SecurityZonesPage from "@/app/security/zones/page";
import * as SecuritySettingsPage from "@/app/security/settings/page";
import * as SecurityPatternsPage from "@/app/security/patterns/page";
import * as SecurityIncidentPage from "@/app/security/incidents/[id]/page";

const MODULES: Record<string, Record<string, unknown>> = {
  "src/components/security/AreaDialog.tsx": AreaDialog,
  "src/components/security/AreaLinksDialog.tsx": AreaLinksDialog,
  "src/components/security/AreasPanel.tsx": AreasPanel,
  "src/components/security/ExceptionsEditor.tsx": ExceptionsEditor,
  // WARP-2980 (P5 PR-B) — expected activity and how often Droplet was right.
  "src/components/security/ExpectedActivityCard.tsx": ExpectedActivityCard,
  "src/components/security/ExpectedActivityDialog.tsx": ExpectedActivityDialog,
  "src/components/security/PrecisionCard.tsx": PrecisionCard,
  "src/components/security/HoursEditor.tsx": HoursEditor,
  // WARP-2980 (P5 PR-A) — the patterns page.
  "src/components/security/LearningList.tsx": LearningList,
  // WARP-2978 (ADR-059 P3 §8).
  "src/components/security/IncidentCard.tsx": IncidentCard,
  "src/components/security/IncidentList.tsx": IncidentList,
  "src/components/security/incident-copy.ts": incidentCopy,
  "src/components/security/IncidentView.tsx": IncidentView,
  "src/components/security/ReasonList.tsx": ReasonList,
  "src/components/security/NoticeList.tsx": NoticeList,
  "src/components/security/AckHistory.tsx": AckHistory,
  "src/components/security/ResolveDialog.tsx": ResolveDialog,
  "src/components/security/AlertRoutingPanel.tsx": AlertRoutingPanel,
  "src/components/security/ModeCard.tsx": ModeCard,
  "src/components/security/SecurityFeed.tsx": SecurityFeed,
  "src/components/security/TimezoneSelect.tsx": TimezoneSelect,
  "src/components/security/UsualGrid.tsx": UsualGrid,
  "src/components/security/patterns-copy.ts": PatternsCopy,
  "src/app/security/page.tsx": SecurityPage,
  "src/app/security/zones/page.tsx": SecurityZonesPage,
  "src/app/security/settings/page.tsx": SecuritySettingsPage,
  "src/app/security/patterns/page.tsx": SecurityPatternsPage,
  "src/app/security/incidents/[id]/page.tsx": SecurityIncidentPage,
};

const BANNED: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ["monitor", /monitor/i],
  ["armed", /armed/i],
  ["arm", /\barm\b/i],
  ["alarm", /alarm/i],
  ["secure", /\bsecure\b/i],
  ["protected", /protected/i],
  ["guard", /guard/i],
  ["space", /\bspaces?\b/i],
  ["zone (as a UI noun)", /\bzones?\b/i],
  // WARP-2980 (P5 PR-B) — word-initial: "Suppressed" trips, `SecuritySuppressionView` does not.
  ["suppress", /\bsuppress/i],
  ["baseline", /\bbaselines?\b/i],
  ["all clear", /\ball clear\b/i],
  ["all locked", /\ball locked\b/i],
];

/** Sentences cut out of ONE value before the scan. Each must still be there. */
const ALLOWED_SENTENCES: ReadonlyArray<{ where: string; sentence: string }> = [
  {
    where: "src/components/security/ModeCard.tsx MODE_DISCLAIMER",
    sentence: "It doesn't lock doors, arm anything, or call anyone.",
  },
];
/** Keys of exported COPY objects that are allowed to hold a banned word (never shown). None since WARP-2978. */
const ALLOWED_KEYS: ReadonlyArray<string> = [];

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

function strip(where: string, text: string): string {
  let out = text;
  for (const a of ALLOWED_SENTENCES) if (a.where === where) out = out.split(a.sentence).join(" ");
  return out;
}

function violations(found: Found[], allowedKeys: ReadonlyArray<string> = []): string[] {
  const out: string[] = [];
  for (const f of found) {
    if (allowedKeys.includes(f.where)) continue;
    const text = strip(f.where, f.text);
    for (const [name, re] of BANNED) if (re.test(text)) out.push(`${f.where}: "${f.text}" says ${name}`);
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

describe("Security copy lint (spec §8)", () => {
  it("scans every module in components/security and app/security (none joins unscanned)", () => {
    const onDisk = [...filesUnder("src/components/security"), ...filesUnder("src/app/security")].sort();
    expect(onDisk).toEqual(Object.keys(MODULES).sort());
  });

  it("finds the copy it claims to scan (a lint over nothing passes everything)", () => {
    const { values, keys } = collect();
    expect(values.length).toBeGreaterThan(150);
    expect(values).toContainEqual({ where: "src/components/security/ModeCard.tsx MODE_DISCLAIMER", text: ModeCard.MODE_DISCLAIMER });
    expect(values.some((v) => v.where.startsWith("src/components/security/AreasPanel.tsx COPY."))).toBe(true);
    expect(values.some((v) => v.where.startsWith("src/components/security/HoursEditor.tsx COPY."))).toBe(true);
    expect(keys.some((k) => k.where === "src/components/security/SecurityFeed.tsx COPY.alertsLine")).toBe(true);
    expect(keys.some((k) => k.where.endsWith("COPY.notAlarm"))).toBe(false);
  });

  it("no exported string says monitor, armed, arm, alarm, secure, protected, guard, space or zone", () => {
    expect(violations(collect().values)).toEqual([]);
  });

  it("no COPY key says them either", () => {
    expect(violations(collect().keys, ALLOWED_KEYS)).toEqual([]);
  });

  it("no literal JSX text or reading attribute in either folder says them", () => {
    const files = [...filesUnder("src/components/security"), ...filesUnder("src/app/security")];
    const found = files.flatMap(literalScreenText);
    expect(found.length).toBeGreaterThan(0);
    expect(violations(found)).toEqual([]);
  });

  it("the allow-list is exact and live: the disclaimer still carries its one sentence, and nothing else in it is exempt", () => {
    for (const a of ALLOWED_SENTENCES) {
      const hit = collect().values.find((v) => v.where === a.where);
      expect(hit, a.where).toBeDefined();
      expect(hit!.text, a.where).toContain(a.sentence);
      // Without the cut it WOULD trip — the exemption is doing real work.
      expect(violations([hit!].map((h) => ({ where: "unlisted", text: h.text }))), a.where).not.toEqual([]);
    }
    expect(ModeCard.MODE_DISCLAIMER).toBe(
      "The mode tells Droplet when the site should be empty. It doesn't lock doors, arm anything, or call anyone.",
    );
    for (const k of ALLOWED_KEYS) {
      expect(collect().keys.some((x) => x.where === k), k).toBe(true);
    }
  });

  // Guards the matcher itself.
  it.each([
    ["Droplet is monitoring the shop"],
    ["The site is armed"],
    ["Arm the site"],
    ["Alarm sent"],
    ["Your site is secure"],
    ["Protected by Droplet"],
    ["Guarding the door"],
    ["This space is empty"],
    ["Add a zone"],
    ["Zones"],
    // WARP-2980 (P5 PR-B)
    ["Suppressed"],
    ["Remove the suppression"],
    ["What the baseline says"],
    ["Baselines"],
    ["All clear"],
    ["The doors are all locked"],
  ])("the matcher catches %j", (text) => {
    expect(violations([{ where: "probe", text }])).not.toEqual([]);
  });

  it.each([
    ["Times are in Europe/London (your timezone)"],
    ["Opening hours"],
    ["Warm up"],
    ["Farm shop"],
    // WARP-2980 (P5 PR-B) — the UI's own words, and an identifier-shaped probe.
    ["Expected activity"],
    ["Kept 3 flags quiet"],
    ["SecuritySuppressionView"],
    ["Clear the form"],
  ])(
    "the matcher lets %j through",
    (text) => {
      expect(violations([{ where: "probe", text }])).toEqual([]);
    },
  );
});
