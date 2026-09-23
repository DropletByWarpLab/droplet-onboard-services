// `npm run build` (WARP-2899): render connector-draft.json into the files a
// Warp Lab PR for this vendor needs. Refuses, and writes nothing, while the
// draft has a problem.
//
// Why a generator: a workspace can write files but not delete or rename them,
// so a template cannot ship vendor-named files for a run to rename. The run
// edits ONE file, connector-draft.json, and this renders:
//
//   services/erp-connector/src/rest/vendors/<provider>.ts   the REST profile
//   docs/integrations/<provider>.md                         the setup guide
//   docs/security/allowed-egress.<provider>.draft.yaml      the egress entry
//   docs/adr-042/<provider>.rows.md                         the ADR-042 rows
//   DRAFT-CHECKLIST.md                                      what the PR still needs
//
// Nothing here is verified. Every vendor fact a person has not checked against
// the vendor's own documentation stays a TODO(verify) marker.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GUIDE_SECTIONS, MARKER, OUTPUT_DIRS, outputPaths, providerConst, validateDraft } from "./validate.mjs";

const TODO = "TODO(verify)";
const NOTE = `${MARKER}. Not verified. Ships only through a Warp Lab PR.`;

/** A value that may be empty, rendered: the value, or TODO(verify). */
function fill(value) {
  const v = typeof value === "string" ? value.trim() : "";
  return v || TODO;
}

/** A fact pin (plan, cost, prefix, expiry, scope): ALWAYS carries TODO(verify). */
function pin(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return TODO;
  return `${/[.!?]$/.test(v) ? v : `${v}.`} ${TODO}`;
}

/** One markdown table cell: no pipe, no newline. */
function cell(text) {
  return text.replace(/\\/g, "\\\\").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** A YAML scalar. JSON strings are valid YAML double-quoted scalars. */
const y = (s) => JSON.stringify(s);

/** The RestVendorProfile subset of the draft — the connector's type, nothing more. */
function profileOf(draft) {
  const baseUrl =
    draft.baseUrl.kind === "static"
      ? { kind: "static", origin: draft.baseUrl.origin }
      : {
          kind: "dynamic",
          configField: draft.baseUrl.configField,
          allowedSuffixes: draft.baseUrl.allowedSuffixes,
          allowedHosts: draft.baseUrl.allowedHosts,
        };
  const profile = {
    provider: draft.provider,
    baseUrl,
    auth: { headerName: draft.auth.headerName, valueTemplate: draft.auth.valueTemplate },
    constantHeaders: draft.constantHeaders,
    probePath: draft.probePath,
    datasets: draft.datasets,
  };
  if (Number.isInteger(draft.minRequestIntervalMs)) profile.minRequestIntervalMs = draft.minRequestIntervalMs;
  return profile;
}

function renderProfile(draft) {
  const up = providerConst(draft.provider);
  return [
    `// ${NOTE}`,
    `// Rendered from connector-draft.json by \`npm run build\`. Edit the draft, not this file.`,
    `import type { RestVendorProfile } from "../profile.js";`,
    ``,
    `export const ${up}_PROVIDER = ${JSON.stringify(draft.provider)};`,
    ``,
    `export const ${up}_PROFILE: RestVendorProfile = ${JSON.stringify(profileOf(draft), null, 2)};`,
    ``,
  ].join("\n");
}

function renderGuide(draft) {
  const name = draft.displayName?.trim() || draft.provider;
  const g = draft.guide ?? {};
  const c = draft.credential ?? {};
  const steps = (g.clickPath ?? []).filter((s) => typeof s === "string" && s.trim());
  const body = {
    "## Plan prerequisite": pin(g.planPrerequisite),
    "## Cost": pin(g.cost),
    "## Click-path": steps.length ? `${steps.map((s, i) => `${i + 1}. ${s.trim()}`).join("\n")}\n\n${TODO}` : TODO,
    // The key's prefix or shape is a fact pin too (check-setup-guides fact_pins).
    "## Scopes and permissions": `${pin(g.scopes)}\n\nAccepted credential: ${pin(c.acceptedShape)}`,
    "## Rotation and expiry": `Rotation: ${fill(g.rotation)}\n\nExpiry: ${pin(c.expires)}`,
    "## Revocation": fill(g.revocation),
  };
  const out = [
    `<!-- ${NOTE} -->`,
    ``,
    `# ${name} — setup`,
    ``,
    `> A draft. Every \`${TODO}\` is a fact nobody has checked against ${name}'s own documentation yet.`,
    ``,
  ];
  for (const h of GUIDE_SECTIONS) out.push(h, "", body[h], "");
  return out.join("\n");
}

function renderEgress(draft, today) {
  const p = draft.provider;
  const [yyyy, rest] = [Number(today.slice(0, 4)), today.slice(4)];
  const reviewBy = `${yyyy + 1}${rest}`;
  const profilePath = outputPaths(p).profile;
  const common = (lines) => [
    ...lines,
    `    ticket: ${TODO}`,
    `    added: ${today}`,
    `    review_by: ${reviewBy}`,
  ];
  const purpose = fill(draft.egress?.purpose);
  const out = [
    `# ${NOTE}`,
    `# Paste the entries below under \`entries:\` in docs/security/allowed-egress.yaml.`,
    `# Registering a destination needs security review (Romain) on the PR that adds it.`,
    `entries:`,
  ];
  if (draft.baseUrl.kind === "static") {
    const host = new URL(draft.baseUrl.origin).hostname;
    out.push(
      ...common([
        `  - id: ${p}-api`,
        `    kind: egress`,
        `    service: erp-connector`,
        `    destination:`,
        `      hosts: [${y(host)}]`,
        `      ports: [443]`,
        `      protocol: https`,
        `    phase: runtime`,
        `    data_class: ${draft.egress.dataClass}`,
        `    purpose: ${y(purpose)}`,
      ]),
      `    code_refs: [${profilePath}]`,
    );
    return `${out.join("\n")}\n`;
  }
  const b = draft.baseUrl;
  out.push(
    ...common([
      `  - id: ${p}-api`,
      `    kind: dynamic`,
      `    service: erp-connector`,
      `    config_key: ${y(`IntegrationConnection.providerConfig.${b.configField} (${b.hostShape.trim()})`)}`,
      `    phase: runtime`,
      `    data_class: ${draft.egress.dataClass}`,
      `    purpose: ${y(purpose)}`,
    ]),
    `    code_refs: [${profilePath}]`,
  );
  const refs = [
    ...b.allowedSuffixes.map((s, i) => [`ref-${p}-host-suffix${i ? `-${i + 1}` : ""}`, s.slice(1), `the anchored host suffix ${s} behind the ${p} exact-host guard`]),
    ...b.allowedHosts.map((h, i) => [`ref-${p}-host${i ? `-${i + 1}` : ""}`, h, `an exact host the ${p} exact-host guard admits`]),
  ];
  for (const [id, host, why] of refs) {
    out.push(
      ...common([
        `  - id: ${id}`,
        `    kind: reference`,
        `    service: erp-connector`,
        `    destination:`,
        `      hosts: [${y(host)}]`,
        `    purpose: ${y(`${why}, named in the profile as the guard's anchor; not a connection the box makes`)}`,
      ]),
    );
  }
  return `${out.join("\n")}\n`;
}

function renderAdr042(draft) {
  const name = cell(draft.displayName?.trim() || draft.provider);
  const c = draft.credential ?? {};
  const f = (v) => cell(fill(v));
  const pinned = (v) => cell(pin(v));
  return [
    `<!-- ${NOTE} -->`,
    ``,
    `# ${name} — ADR-042 rows`,
    ``,
    `Paste each row into its table in docs/ADR-042-customer-supplied-credentials.md.`,
    ``,
    `## §2 What the owner pastes`,
    ``,
    `| Vendor | What the owner pastes | Accepted shape | Full-privilege alternative to refuse | Scope granularity | Expires? | Verified |`,
    `|---|---|---|---|---|---|---|`,
    `| **${name}** | ${f(c.pastes)} | ${pinned(c.acceptedShape)} | ${f(c.fullPrivilegeAlternative)} | ${pinned(c.scopeGranularity)} | ${pinned(c.expires)} | ${TODO} — drafted on a box, not verified |`,
    ``,
    `## §4 Accept and reject`,
    ``,
    `| Vendor | Accept | Reject |`,
    `|---|---|---|`,
    `| ${name} | ${f(c.accept)} | ${f(c.reject)} |`,
    ``,
    `## §7 Who provisions`,
    ``,
    `| Integration | Who provisions | Does Warp Lab register or publish anything? |`,
    `|---|---|---|`,
    `| ${name} | ${f(c.provisionedBy)} | **No** ${TODO} |`,
    ``,
  ].join("\n");
}

function renderChecklist(draft) {
  const p = draft.provider;
  const paths = outputPaths(p);
  const up = providerConst(p);
  return [
    `<!-- ${NOTE} -->`,
    ``,
    `# Connector draft: ${p}`,
    ``,
    `Nothing on the box that drafted this loads it. It becomes a connector only`,
    `through a Warp Lab pull request (ADR-046 §5), which needs everything below.`,
    ``,
    `## Apply the bundle`,
    ``,
    "```",
    `git fetch <file>.bundle work:draft/${p}`,
    `git checkout draft/${p} -- ${paths.profile} ${paths.guide}`,
    "```",
    ``,
    `Then copy the entries in ${paths.egress} and the rows in ${paths.adr042}`,
    `into the files they name. Neither file is committed as-is.`,
    ``,
    `## Still to do in the PR`,
    ``,
    `- [ ] Resolve every ${TODO} against ${p}'s own documentation, and cite the page in the vendor test.`,
    `- [ ] Register ${up}_PROFILE in services/erp-connector/src/rest/profiles.ts (import, REST_VENDOR_PROFILES, re-export ${up}_PROVIDER).`,
    `- [ ] Add a ProviderDescriptor in packages/shared-types/src/provider-registry.ts.`,
    `- [ ] Add ${p} to CLOUD_PROVIDERS and its fact_pins in scripts/check-setup-guides.sh.`,
    `- [ ] Index the guide in SETUP.md §3.3 and import it (?raw) in apps/web-dashboard integration-guides.ts.`,
    `- [ ] Wire every dataset through the four lists in docs/integrations/ADD-A-PROVIDER.md §7b.`,
    `- [ ] Write the vendor test (host guard, fieldMap paths, pagination) in services/erp-connector/__tests__.`,
    `- [ ] Paste the egress entries into docs/security/allowed-egress.yaml, under security review.`,
    `- [ ] Paste the three ADR-042 rows, with the Verified cell filled by whoever verified them.`,
    ``,
  ].join("\n");
}

/**
 * The rendered files, as a Map of path to text. Pure. Throws when the draft
 * has a problem, so a caller can never write half a render.
 */
export function renderDraft(draft, vocab, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = validateDraft(draft, vocab);
  if (problems.length) {
    const err = new Error(`the connector draft is not ready:\n- ${problems.join("\n- ")}`);
    err.problems = problems;
    throw err;
  }
  const paths = outputPaths(draft.provider);
  return new Map([
    [paths.profile, renderProfile(draft)],
    [paths.guide, renderGuide(draft)],
    [paths.egress, renderEgress(draft, today)],
    [paths.adr042, renderAdr042(draft)],
    [paths.checklist, renderChecklist(draft)],
  ]);
}

/** Files an earlier render wrote (its first line carries the marker). */
function previousRenders(root) {
  const found = [];
  for (const dir of OUTPUT_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = `${dir}/${entry.name}`;
      const first = readFileSync(join(abs, entry.name), "utf8").split("\n", 1)[0];
      if (first.includes(MARKER)) found.push(rel);
    }
  }
  return found;
}

function main(root) {
  let draft;
  try {
    draft = JSON.parse(readFileSync(join(root, "connector-draft.json"), "utf8"));
  } catch (err) {
    console.error(`connector-draft.json could not be read: ${err.message}`);
    return 1;
  }
  const vocab = JSON.parse(readFileSync(join(root, "vocabulary.json"), "utf8"));
  let files;
  try {
    files = renderDraft(draft, vocab);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  // A renamed provider must not leave the old name's files behind.
  for (const rel of previousRenders(root)) {
    if (!files.has(rel)) rmSync(join(root, rel));
  }
  for (const [rel, text] of files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  console.log(`rendered ${files.size} files for ${draft.provider}:\n  ${[...files.keys()].join("\n  ")}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
