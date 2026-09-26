/**
 * WARP-537 — release-manifest parsing + schema validation.
 *
 * `parseReleaseManifest` is the second gate in the OTA trust chain
 * (verify.ts checks the cosign signature FIRST; these tests exercise the
 * parse gate in isolation over the golden fixtures in __fixtures__/).
 *
 * Contract:
 *   - valid schema-v1 manifest → { ok: true, manifest } with typed fields;
 *   - unparseable JSON → `malformed_manifest`;
 *   - parseable JSON with invalid fields → `schema_invalid`;
 *   - schemaVersion below the supported version → `schema_downgrade`
 *     (anti-rollback: dominates any other field problem);
 *   - schemaVersion above the supported version → `schema_unsupported`
 *     (forward-compat: this agent cannot safely interpret it);
 *   - release.minOrchestratorSchema above what this orchestrator build
 *     understands → `orchestrator_schema_unsupported`.
 *
 * failureReason values are the canonical strings that land in
 * DeviceUpdate.failureReason / the `update.*` log events — asserted
 * exactly, not just truthiness.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseReleaseManifest,
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_ORCHESTRATOR_SCHEMA,
} from "./manifest.js";

const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

describe("parseReleaseManifest (WARP-537)", () => {
  it("accepts the golden valid manifest and exposes typed fields", () => {
    const res = parseReleaseManifest(fixture("release.valid.json"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(res.manifest.release.gitSha).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(res.manifest.release.channel).toBe("stable");
    expect(res.manifest.release.minOrchestratorSchema).toBe(1);
    expect(res.manifest.services).toHaveLength(3);
    expect(res.manifest.services[0]).toEqual({
      name: "orchestrator",
      image:
        "ghcr.io/dropletbywarplab/droplet-orchestrator@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      healthcheck: { type: "http", port: 3000, path: "/api/orchestrator/health" },
    });
    expect(res.manifest.services[2]?.healthcheck).toEqual({ type: "none" });
    expect(res.manifest.configs).toEqual({
      file: "configs.tar.gz",
      sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
  });

  it("rejects unparseable JSON as malformed_manifest", () => {
    const res = parseReleaseManifest(fixture("release.malformed.json"));
    expect(res).toMatchObject({ ok: false, failureReason: "malformed_manifest" });
  });

  it("rejects parseable-but-invalid fields as schema_invalid", () => {
    const res = parseReleaseManifest(fixture("release.schema-invalid.json"));
    expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
    if (res.ok) return;
    // The detail must name at least one offending path so the log event /
    // failureReason audit row is actionable.
    expect(res.detail).toMatch(/gitSha|services|sha256/);
  });

  it("rejects a schemaVersion below the supported one as schema_downgrade", () => {
    const res = parseReleaseManifest(fixture("release.schema-downgrade.json"));
    expect(res).toMatchObject({ ok: false, failureReason: "schema_downgrade" });
  });

  it("rejects a schemaVersion above the supported one as schema_unsupported", () => {
    const doc = JSON.parse(fixture("release.valid.json")) as Record<string, unknown>;
    doc.schemaVersion = SUPPORTED_SCHEMA_VERSION + 1;
    const res = parseReleaseManifest(JSON.stringify(doc));
    expect(res).toMatchObject({ ok: false, failureReason: "schema_unsupported" });
  });

  it("rejects a manifest demanding a newer orchestrator schema", () => {
    const doc = JSON.parse(fixture("release.valid.json")) as {
      release: { minOrchestratorSchema: number };
    };
    doc.release.minOrchestratorSchema = SUPPORTED_ORCHESTRATOR_SCHEMA + 1;
    const res = parseReleaseManifest(JSON.stringify(doc));
    expect(res).toMatchObject({
      ok: false,
      failureReason: "orchestrator_schema_unsupported",
    });
  });

  it("rejects a service whose image is not pinned by its own digest", () => {
    const doc = JSON.parse(fixture("release.valid.json")) as {
      services: Array<{ image: string; digest: string }>;
    };
    // Tag-only reference — mutable, therefore not a contract.
    doc.services[0]!.image = "ghcr.io/dropletbywarplab/droplet-orchestrator:latest";
    const res = parseReleaseManifest(JSON.stringify(doc));
    expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
  });

  it("rejects duplicate service names", () => {
    const doc = JSON.parse(fixture("release.valid.json")) as {
      services: Array<{ name: string }>;
    };
    doc.services[1]!.name = doc.services[0]!.name;
    const res = parseReleaseManifest(JSON.stringify(doc));
    expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
  });

  // WARP-2898 (ADR-056 slice K1): an extension document can never parse as a
  // release. The zod schema strips unknown keys, so without this fence a
  // manifest carrying `kind: extension` beside release-shaped fields would
  // ride the LLM-triggerable apply-now path (WARP-1450) as a release.
  describe("a non-release kind or a key-usage field is refused (WARP-2898)", () => {
    const withTop = (extra: Record<string, unknown>): string =>
      JSON.stringify({ ...(JSON.parse(fixture("release.valid.json")) as object), ...extra });

    it.each([
      ["kind: extension", { kind: "extension" }, /kind "extension" is not a release/],
      ["kind: Release (case)", { kind: "Release" }, /kind "Release" is not a release/],
      ["kind: null", { kind: null }, /kind null is not a release/],
      ["usage: extension", { usage: "extension" }, /usage is an extension-signing field/],
      ["keyUsage: extension", { keyUsage: "extension" }, /keyUsage is an extension-signing field/],
      ["kind: release + usage: release", { kind: "release", usage: "release" }, /usage is an extension-signing field/],
    ])("%s -> schema_invalid", (_label, extra, detail) => {
      const res = parseReleaseManifest(withTop(extra));
      expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
      if (res.ok) return;
      expect(res.detail).toMatch(detail);
    });

    it("the kind verdict comes before the version gates", () => {
      // An extension document at another schemaVersion is still refused as
      // what it is, not as a release of the wrong version.
      const res = parseReleaseManifest(withTop({ kind: "extension", schemaVersion: 0 }));
      expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
    });

    it.each(["extension.valid.json", "extension.manifest.json"])(
      "the H1 extension fixture %s is refused as schema_invalid",
      (name) => {
        const res = parseReleaseManifest(fixture(name));
        expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
      },
    );

    it("an explicit kind: release is still a release", () => {
      const res = parseReleaseManifest(withTop({ kind: "release" }));
      expect(res.ok).toBe(true);
    });

    it("a document with no kind is still a release (back-compat with every published release)", () => {
      // The fence refuses a WRONG kind, never a MISSING one, on purpose: no
      // published release.json carries `kind`, so requiring it would refuse
      // every release already on every channel.
      const raw = fixture("release.valid.json");
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(raw), "kind")).toBe(false);
      expect(parseReleaseManifest(raw).ok).toBe(true);
    });

    // The fleet-agent port (release_verify.py) pins these exact strings too:
    // both ports render a non-string kind byte-identically.
    it.each([
      [["extension", "release"], '["extension","release"]'],
      [{ type: "extension", v: 1 }, '{"type":"extension","v":1}'],
      [[{ a: [1, 2] }, null, true], '[{"a":[1,2]},null,true]'],
      [{ k: "é" }, '{"k":"é"}'],
    ])("a non-string kind %j renders as %s", (kind, rendered) => {
      const res = parseReleaseManifest(withTop({ kind }));
      expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
      if (res.ok) return;
      expect(res.detail).toBe(
        `kind ${rendered} is not a release — an extension document never parses as a release manifest`,
      );
    });
  });
});

describe("release.json clients (WARP-3120)", () => {
  const golden = (): Record<string, unknown> =>
    JSON.parse(fixture("release.valid.json")) as Record<string, unknown>;
  const DMG = {
    platform: "macos",
    version: "0.2.0",
    file: "Droplet-0.2.0.dmg",
    size: 50331648,
    sha256: "e".repeat(64),
  };
  const withClients = (clients: unknown) => JSON.stringify({ ...golden(), clients });

  it("a manifest without clients parses as before", () => {
    const res = parseReleaseManifest(fixture("release.valid.json"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.clients).toBeUndefined();
  });

  it("parses and exposes a clients entry", () => {
    const res = parseReleaseManifest(withClients([DMG]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.clients).toEqual([DMG]);
  });

  it("an older parser strips an unknown top-level key rather than refusing it", () => {
    // What a box on a pre-WARP-3120 orchestrator does with `clients`: the
    // schema is a non-strict zod object. Pinned with a key no version knows.
    const res = parseReleaseManifest(JSON.stringify({ ...golden(), notYetInvented: [1] }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest).not.toHaveProperty("notYetInvented");
  });

  it.each([
    ["a bad sha256", { sha256: "E".repeat(64) }],
    ["a file with a slash", { file: "../Droplet.dmg" }],
    ["an unknown platform", { platform: "ios" }],
    ["a non-x.y.z version", { version: "0.2" }],
    ["a zero size", { size: 0 }],
  ])("refuses the manifest for %s", (_label, over) => {
    expect(parseReleaseManifest(withClients([{ ...DMG, ...over }]))).toMatchObject({
      ok: false,
      failureReason: "schema_invalid",
    });
  });

  it("refuses two entries for one platform", () => {
    expect(parseReleaseManifest(withClients([DMG, { ...DMG, file: "Droplet-0.2.1.dmg" }]))).toMatchObject({
      ok: false,
      failureReason: "schema_invalid",
    });
  });
});
