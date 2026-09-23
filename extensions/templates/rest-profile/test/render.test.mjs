// The generator's own tests (WARP-2899). They run against the fixtures in
// test/fixtures/, never against this workspace's connector-draft.json — that
// is draft.test.mjs's job.
//
// Fixture hosts are RFC-2606 names under .example. A static origin is joined
// from parts at runtime, so no file in this template carries a scheme URL for
// the egress gate's URL pattern to read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GUIDE_SECTIONS, MARKER, checkRendered, outputPaths, validateDraft } from "../scripts/validate.mjs";
import { renderDraft } from "../scripts/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VOCAB = JSON.parse(readFileSync(join(ROOT, "vocabulary.json"), "utf8"));
const SCHEME = "https:" + "//";
const ORIGIN = SCHEME + "api.acme.example";
const TODAY = "2026-09-23";

function fixture(name) {
  const text = readFileSync(join(ROOT, "test", "fixtures", `${name}.json`), "utf8");
  return JSON.parse(text.replace("@ORIGIN@", ORIGIN));
}

function render(draft) {
  return renderDraft(draft, VOCAB, { today: TODAY });
}

/** A scratch copy of the template with `draft` as its connector-draft.json. */
function scratch(draft) {
  const dir = mkdtempSync(join(tmpdir(), "rest-profile-"));
  for (const entry of ["package.json", "vocabulary.json", "scripts"]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  writeFileSync(join(dir, "connector-draft.json"), JSON.stringify(draft, null, 2));
  return dir;
}

function build(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "render.mjs")], { cwd: dir, encoding: "utf8" });
}

test("the fixtures are valid drafts", () => {
  assert.deepEqual(validateDraft(fixture("static"), VOCAB), []);
  assert.deepEqual(validateDraft(fixture("dynamic"), VOCAB), []);
});

test("a static draft renders the four outputs and the checklist at the provider's paths", () => {
  const out = render(fixture("static"));
  const paths = outputPaths("acme");
  assert.deepEqual(paths, {
    profile: "services/erp-connector/src/rest/vendors/acme.ts",
    guide: "docs/integrations/acme.md",
    egress: "docs/security/allowed-egress.acme.draft.yaml",
    adr042: "docs/adr-042/acme.rows.md",
    checklist: "DRAFT-CHECKLIST.md",
  });
  assert.deepEqual([...out.keys()].sort(), Object.values(paths).sort());
  const profile = out.get(paths.profile);
  assert.match(profile, /^\/\/ Drafted on a Droplet box by the rest-profile template \(WARP-2899\)/);
  assert.match(profile, /import type \{ RestVendorProfile \} from "\.\.\/profile\.js";/);
  assert.match(profile, /export const ACME_PROVIDER = "acme";/);
  assert.match(profile, /export const ACME_PROFILE: RestVendorProfile = \{/);
  for (const text of out.values()) assert.ok(text.includes(MARKER), "every rendered file carries the marker");
});

test("the static origin appears exactly once, as a whole-string literal in the profile", () => {
  const out = render(fixture("static"));
  const all = [...out.values()].join("\n");
  assert.equal(all.split(ORIGIN).length - 1, 1);
  assert.ok(out.get(outputPaths("acme").profile).includes(`"${ORIGIN}"`));
  // The egress fragment names the HOST, never the URL.
  assert.match(out.get(outputPaths("acme").egress), /hosts: \["api\.acme\.example"\]/);
});

test("the guide has exactly the six sections, in order", () => {
  // MUTATION: swap two headings in GUIDE_SECTIONS → red.
  for (const name of ["static", "dynamic"]) {
    const draft = fixture(name);
    const guide = render(draft).get(outputPaths(draft.provider).guide);
    const h2 = guide.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(h2, [
      "## Plan prerequisite",
      "## Cost",
      "## Click-path",
      "## Scopes and permissions",
      "## Rotation and expiry",
      "## Revocation",
    ]);
  }
});

test("every fact pin carries TODO(verify), and every empty value IS TODO(verify)", () => {
  // MUTATION: make pin() return the bare value → red.
  const guide = render(fixture("static")).get(outputPaths("acme").guide);
  const section = (h) => guide.split(`## ${h}\n`)[1].split("\n## ")[0];
  assert.match(section("Plan prerequisite"), /Every plan, including Free\. TODO\(verify\)/);
  assert.match(section("Cost"), /^\s*TODO\(verify\)\s*$/);
  assert.match(section("Scopes and permissions"), /read:tasks\. TODO\(verify\)/);
  // The key prefix / accepted shape is a fact pin too (check-setup-guides
  // fact_pins). MUTATION: drop the Accepted credential line → red.
  assert.match(section("Scopes and permissions"), /Accepted credential: An opaque token in the Authorization header\. TODO\(verify\)/);
  assert.match(section("Rotation and expiry"), /Rotation: TODO\(verify\)/);
  assert.match(section("Rotation and expiry"), /optional, owner-chosen\. TODO\(verify\)/);
  assert.match(section("Click-path"), /1\. Settings\n2\. API tokens\n3\. Create token/);

  const empty = render(fixture("dynamic")).get(outputPaths("globex-crm").guide);
  assert.match(empty, /Accepted credential: TODO\(verify\)/);
  for (const h of GUIDE_SECTIONS) {
    const body = empty.split(`${h}\n`)[1].split("\n## ")[0];
    assert.match(body, /TODO\(verify\)/, h);
  }
  const rows = render(fixture("dynamic")).get(outputPaths("globex-crm").adr042);
  assert.match(rows, /\| TODO\(verify\) — drafted on a box, not verified \|/);
  // Every empty credential cell reads TODO(verify); none is blank.
  assert.doesNotMatch(rows, /\| +\|/);
  const pinned = render(fixture("static")).get(outputPaths("acme").adr042);
  assert.match(pinned, /\| An opaque token in the Authorization header\. TODO\(verify\) \|/);
  assert.match(pinned, /\| read-only token kind\. TODO\(verify\) \| optional, owner-chosen\. TODO\(verify\) \|/);
});

test("a dynamic draft renders no scheme URL anywhere, a kind: dynamic entry and one reference per suffix or host", () => {
  // MUTATION: emit a scheme URL for the suffix in render → red.
  const out = render(fixture("dynamic"));
  for (const [path, text] of out) assert.ok(!text.includes("://"), `${path} carries a scheme URL`);
  const egress = out.get(outputPaths("globex-crm").egress);
  assert.match(egress, /id: globex-crm-api\n\s+kind: dynamic/);
  assert.match(egress, /config_key: "IntegrationConnection\.providerConfig\.companyDomain \(/);
  assert.match(egress, /id: ref-globex-crm-host-suffix\n\s+kind: reference[\s\S]*?hosts: \["globex\.example"\]/);
  assert.match(egress, /id: ref-globex-crm-host\n\s+kind: reference[\s\S]*?hosts: \["eu\.globex-hosted\.example"\]/);
  assert.match(egress, /code_refs: \[services\/erp-connector\/src\/rest\/vendors\/globex-crm\.ts\]/);
  assert.match(egress, /ticket: TODO\(verify\)/);
  const profile = out.get(outputPaths("globex-crm").profile);
  assert.match(profile, /export const GLOBEX_CRM_PROFILE: RestVendorProfile/);
  assert.match(profile, /"configField": "companyDomain"/);
  assert.doesNotMatch(profile, /hostShape/);
});

test("render is idempotent", () => {
  for (const name of ["static", "dynamic"]) {
    const a = render(fixture(name));
    const b = render(fixture(name));
    assert.deepEqual([...a.entries()], [...b.entries()]);
  }
  const dir = scratch(fixture("static"));
  try {
    assert.equal(build(dir).status, 0);
    const first = readFileSync(join(dir, outputPaths("acme").profile), "utf8");
    assert.equal(build(dir).status, 0);
    assert.equal(readFileSync(join(dir, outputPaths("acme").profile), "utf8"), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function invalid(base, mutate) {
  const d = structuredClone(fixture(base));
  mutate(d);
  return d;
}

const INVALID = {
  "fieldMap key not canonical": invalid("static", (d) => (d.datasets[0].fieldMap.chrage_id = "id")),
  "required column unmapped": invalid("static", (d) => delete d.datasets[0].fieldMap.status),
  "suffix without leading dot": invalid("dynamic", (d) => (d.baseUrl.allowedSuffixes = ["globex.example"])),
  "provider escapes": invalid("static", (d) => (d.provider = "../x")),
  "dynamic string with a scheme": invalid("dynamic", (d) => (d.egress.purpose = `see ${SCHEME}globex.example`)),
  "static origin with a path": invalid("static", (d) => (d.baseUrl.origin = `${ORIGIN}/v1`)),
  "static origin not https": invalid("static", (d) => (d.baseUrl.origin = "http:" + "//api.acme.example")),
  "no placeholder": invalid("static", (d) => (d.auth.valueTemplate = "Bearer")),
  "dynamic without a hostShape": invalid("dynamic", (d) => (d.baseUrl.hostShape = "")),
  "dynamic with nothing allowed": invalid("dynamic", (d) => ((d.baseUrl.allowedSuffixes = []), (d.baseUrl.allowedHosts = []))),
  "unknown dataset": invalid("static", (d) => (d.datasets[0].dataset = "issue")),
  "duplicate dataset": invalid("static", (d) => d.datasets.push(structuredClone(d.datasets[0]))),
  "no datasets": invalid("static", (d) => (d.datasets = [])),
  "probe without slash": invalid("static", (d) => (d.probePath = "v1/me")),
  "minor-units without currency": invalid("dynamic", (d) => delete d.datasets[1].fieldMap.amount.currencyFrom),
  "scheme outside the origin": invalid("static", (d) => (d.guide.cost = `see ${ORIGIN}`)),
};

test("an invalid draft is refused with a problem, and render writes NOTHING", () => {
  for (const [label, draft] of Object.entries(INVALID)) {
    assert.notDeepEqual(validateDraft(draft, VOCAB), [], label);
    assert.throws(() => render(draft), /not ready/, label);
    const dir = scratch(draft);
    try {
      const r = build(dir);
      assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
      for (const p of ["services", "docs", "DRAFT-CHECKLIST.md"]) {
        assert.ok(!existsSync(join(dir, p)), `${label}: wrote ${p}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("renaming the provider removes the previous render's files, and nothing else", () => {
  const dir = scratch(fixture("static"));
  try {
    assert.equal(build(dir).status, 0);
    // A file the person wrote beside the renders is not the generator's to remove.
    mkdirSync(join(dir, "docs", "integrations"), { recursive: true });
    writeFileSync(join(dir, "docs", "integrations", "notes.md"), "# mine\n");
    const renamed = { ...fixture("static"), provider: "acme-two" };
    writeFileSync(join(dir, "connector-draft.json"), JSON.stringify(renamed));
    assert.equal(build(dir).status, 0);
    for (const p of Object.values(outputPaths("acme"))) {
      if (p === "DRAFT-CHECKLIST.md") continue;
      assert.ok(!existsSync(join(dir, p)), `stale ${p}`);
    }
    for (const p of Object.values(outputPaths("acme-two"))) assert.ok(existsSync(join(dir, p)), p);
    assert.equal(readFileSync(join(dir, "docs", "integrations", "notes.md"), "utf8"), "# mine\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── checkRendered: what `npm test` (draft.test.mjs) and propose both hold ──

/** A reader over a render, with `edit` applied to one path's text. */
function reader(out, edit = {}) {
  return (rel) => {
    const text = out.has(rel) ? out.get(rel) : null;
    return rel in edit ? edit[rel](text) : text;
  };
}

test("checkRendered passes the renderer's own output, static and dynamic", () => {
  for (const name of ["static", "dynamic"]) {
    const draft = fixture(name);
    assert.deepEqual(checkRendered(draft, reader(render(draft))), [], name);
  }
});

test("checkRendered refuses a profile that dials another host, or is not the rendered layout", () => {
  // MUTATION: drop the baseUrl comparison, or accept trailing statements → red.
  const draft = fixture("static");
  const out = render(draft);
  const p = outputPaths("acme").profile;
  const EVIL = SCHEME + "api.evil.example";
  const cases = {
    "origin swapped, the draft's left in a comment": () => `export const ACME_PROFILE = {origin:"${EVIL}"}; // "${ORIGIN}"\n`,
    "origin swapped in place": (t) => t.replace(ORIGIN, EVIL),
    "a statement after the object": (t) => `${t}ACME_PROFILE.probePath = "/x";\n`,
    "an escaped second URL": (t) => t.replace('"probePath": "/v1/me"', `"probePath": "https:\\/\\/api.evil.example/v1"`),
  };
  for (const [label, edit] of Object.entries(cases)) {
    assert.notDeepEqual(checkRendered(draft, reader(out, { [p]: edit })), [], label);
  }
});

test("checkRendered wants each ADR-042 table's row, and no scheme outside a static origin", () => {
  // MUTATION: go back to "the file exists" for the rows → red.
  const draft = fixture("static");
  const out = render(draft);
  const rows = outputPaths("acme").adr042;
  const headerOnly = (t) => t.split("\n").filter((l) => !l.startsWith("| ") || l.startsWith("| Vendor") || l.startsWith("| Integration")).join("\n");
  assert.ok(checkRendered(draft, reader(out, { [rows]: headerOnly })).some((m) => m.includes("no §2 row for Acme Tasks")));
  const noProvisioning = (t) => t.slice(0, t.indexOf("## §7"));
  assert.ok(checkRendered(draft, reader(out, { [rows]: noProvisioning })).some((m) => m.includes("no §7 provisioning row")));
  const guide = outputPaths("acme").guide;
  assert.ok(checkRendered(draft, reader(out, { [guide]: (t) => `${t}\nSee ${SCHEME}docs.acme.example\n` })).some((m) => m.includes("scheme URL")));

  // A dynamic draft: any "://", an IP or a single label included.
  const dyn = fixture("dynamic");
  const dout = render(dyn);
  const dguide = outputPaths("globex-crm").guide;
  for (const host of ["127.0.0.1", "intranet"]) {
    assert.ok(checkRendered(dyn, reader(dout, { [dguide]: (t) => `${t}\n${SCHEME}${host}\n` })).some((m) => m.includes("scheme URL")), host);
  }
});
