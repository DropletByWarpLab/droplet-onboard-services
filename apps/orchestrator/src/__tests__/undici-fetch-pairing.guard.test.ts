/**
 * WARP-2626 — a dispatcher may only be handed to the undici that minted it.
 *
 * `dispatcher` is an undici extension to `RequestInit`, honoured only by the
 * undici copy that created the `Agent`. Node's built-in `fetch` is its OWN
 * bundled undici, and the two agree only by coincidence of version:
 *
 *   - Node 20 (`.nvmrc`, `engines.node`, every workflow's `setup-node`) bundles
 *     undici 6 and accepts the npm `undici@6` Agent this repo installs.
 *   - Node >= 22 bundles undici 7, whose handler interface changed, and rejects
 *     it with `UND_ERR_INVALID_ARG: invalid onError method` before a byte is
 *     sent. Every call surfaces as a bare `fetch failed` — indistinguishable
 *     from an unreachable box, so the Eaglesoft REST track reported
 *     `connected: false` against a healthy one with nothing naming the cause.
 *
 * The fix is structural: any module that puts a `dispatcher` into a request
 * init must call the npm `undici`'s own `fetch`. That is invisible to `tsc`
 * (`dispatcher` is cast in at the boundary) and invisible to every unit test
 * that injects a fetch — a reviewer reading a one-line "simplify to
 * globalThis.fetch" diff has nothing to catch it with. So it is pinned here, by
 * scanning source rather than by trusting the convention.
 *
 * This is a source-shape guard, not a runtime one. The runtime half — a real
 * request through a real Agent on whatever Node is installed — is
 * `services/erp-connector/__tests__/api-auth.dispatcher.test.ts`. Both are
 * needed: this one catches the reintroduction on Node 20 (where the runtime
 * test would still pass), that one catches it on Node >= 22.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** apps/orchestrator/src/__tests__ → the repo root. */
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/**
 * The source roots that own outbound HTTP with private-CA trust. Kept explicit
 * rather than "the whole repo": these are the trees where an undici `Agent` is
 * built and consumed, and a silent scan over an unrelated tree would make a
 * green result meaningless.
 */
const SCANNED_ROOTS = [
  "apps/orchestrator/src",
  "services/erp-connector/src",
  "services/mcp-server/src",
] as const;

/** `dispatcher` used as a request-init property: `dispatcher: x` / `dispatcher,`. */
const DISPATCHER_IN_INIT = /(^|[{,\s])dispatcher\s*(:|,|\}|$)/m;

/** A call that performs HTTP: `fetch(`, `undiciFetch(`, `fetchImpl(`, `doFetch(`. */
const PERFORMS_FETCH = /\b(?:undiciFetch|fetchImpl|doFetch|fetch)\s*\(/;

/** An import that brings undici's OWN fetch into the module. */
const IMPORTS_UNDICI_FETCH =
  /import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*["']undici["']/;

/** Declarations that merely NAME a dispatcher type/param — not an init literal. */
const TYPE_ONLY_DISPATCHER = /dispatcher\s*:\s*(?:Dispatcher|StepDispatcher|unknown|\w*Dispatcher)\b/;

interface Offender {
  file: string;
  line: number;
  text: string;
}

/**
 * Blank out comment bodies, preserving line structure so reported line numbers
 * stay true.
 *
 * Load-bearing, not tidiness: this guard's own explanatory comments name
 * `globalThis.fetch` and `dispatcher:` as the things NOT to do, and a scanner
 * that reads prose flags the documentation describing the rule. A guard that
 * fires on its own rationale gets deleted rather than fixed.
 */
function codeOnly(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank) // block + JSDoc
    .replace(/\/\/[^\n]*/g, blank); // line
}

/** Read a source file with its comments blanked. */
function readCode(file: string): string {
  return codeOnly(readFileSync(path.join(REPO_ROOT, file), "utf8"));
}

/** Recursively list `.ts` files under a repo-relative directory. */
function walk(relDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walk(rel));
    } else if (entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

function sourceFiles(): string[] {
  return SCANNED_ROOTS.flatMap(walk)
    // Tests may pair whatever they like — they are asserting ABOUT the pairing
    // (mtls-server.test.ts deliberately drives both halves).
    .filter((f) => !/\.test\.ts$/.test(f) && !f.includes("/__tests__/"))
    .sort();
}

/**
 * Files that write a `dispatcher` into an object destined for a fetch call.
 * A line-level scan, so a file that merely declares `dispatcher: Dispatcher`
 * as a field type is not counted.
 */
function filesPairingDispatcherWithFetch(): { file: string; offenders: Offender[] }[] {
  const hits: { file: string; offenders: Offender[] }[] = [];
  for (const file of sourceFiles()) {
    const src = readCode(file);
    if (!PERFORMS_FETCH.test(src)) continue;

    const offenders: Offender[] = [];
    src.split("\n").forEach((text, i) => {
      if (!DISPATCHER_IN_INIT.test(text)) return;
      if (TYPE_ONLY_DISPATCHER.test(text)) return;
      offenders.push({ file, line: i + 1, text: text.trim() });
    });
    if (offenders.length > 0) hits.push({ file, offenders });
  }
  return hits;
}

describe("undici dispatcher/fetch pairing (WARP-2626)", () => {
  const pairing = filesPairingDispatcherWithFetch();

  it("finds dispatcher-carrying fetch sites at all — a silent zero makes this guard vacuous", () => {
    expect(
      pairing.length,
      `No source file under ${SCANNED_ROOTS.join(", ")} was found putting a ` +
        `dispatcher into a fetch init. Either the CA-trust plumbing moved and ` +
        `this guard now protects nothing, or the regexes rotted. Fix the scan ` +
        `before trusting a green run.`,
    ).toBeGreaterThan(0);
  });

  it("every module that passes a dispatcher to fetch imports fetch from undici", () => {
    const broken = pairing.filter(
      ({ file }) => !IMPORTS_UNDICI_FETCH.test(readCode(file)),
    );

    expect(
      broken.map((b) => `${b.file}:${b.offenders.map((o) => o.line).join(",")}`),
      broken
        .map(
          (b) =>
            `${b.file} puts a dispatcher into a fetch init (line ${b.offenders[0]?.line}: ` +
            `${b.offenders[0]?.text}) but does not import \`fetch\` from "undici". ` +
            `A dispatcher is only honoured by the undici that minted it: handing an ` +
            `npm-undici Agent to the runtime's built-in fetch works on the pinned Node 20 ` +
            `and throws UND_ERR_INVALID_ARG on Node >= 22, where every call degrades to a ` +
            `bare "fetch failed" that reads as an unreachable box. ` +
            `Add: import { fetch as undiciFetch } from "undici" — and use it. (WARP-2626)`,
        )
        .join("\n\n"),
    ).toEqual([]);
  });

  it("no scanned source resolves globalThis.fetch in a file that also builds an undici Agent", () => {
    // The other half of the same mistake: importing `Agent` from undici and
    // then reaching for the global fetch in the same module.
    const offenders = sourceFiles().filter((file) => {
      const src = readCode(file);
      const buildsAgent = /import\s*\{[^}]*\bAgent\b[^}]*\}\s*from\s*["']undici["']/.test(src);
      const usesGlobalFetch = /globalThis\s*\.\s*fetch|global\s*\.\s*fetch/.test(src);
      return buildsAgent && usesGlobalFetch;
    });

    expect(
      offenders,
      `These modules import undici's Agent AND resolve globalThis.fetch. If the ` +
        `Agent ever reaches that fetch, the request throws UND_ERR_INVALID_ARG on ` +
        `Node >= 22. Route dispatcher-carrying calls through undici's own fetch. (WARP-2626)`,
    ).toEqual([]);
  });
});
