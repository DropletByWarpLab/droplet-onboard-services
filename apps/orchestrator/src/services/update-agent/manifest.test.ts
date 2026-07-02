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
});
