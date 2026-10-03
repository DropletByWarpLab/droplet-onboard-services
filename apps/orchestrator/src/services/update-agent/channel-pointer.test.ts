/**
 * WARP-3430 — the signed channel pointer's schema, and the domain separation
 * between a pointer and a release manifest.
 *
 * The release key signs raw bytes with no domain prefix, so a document signed
 * as one kind must be impossible to accept as the other. Both directions are
 * pinned here with real fixture bytes; no cosign (pure parsing). The wiring
 * that verifies a pointer's signature and follows it is in poller.test.ts.
 *
 * MUTATION: drop `.strict()` from the pointer schema -> the hybrid case is red.
 * MUTATION: drop the `kind` literal -> every release/extension fixture parses.
 * MUTATION: delete the `kind` fence in manifest.ts -> the pointer-as-manifest
 * case is red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHANNEL_POINTER_KIND, parseChannelPointer } from "./channel-pointer.js";
import { parseReleaseManifest } from "./manifest.js";

const fx = (name: string): Buffer => readFileSync(path.join(__dirname, "__fixtures__", name));

const VALID = {
  schemaVersion: 1,
  kind: CHANNEL_POINTER_KIND,
  channel: "stage",
  tag: "ota-stage-404-g3c71b82",
  gitSha: "c".repeat(40),
  builtAt: "2026-05-28T03:00:00Z",
  manifestSha256: "a".repeat(64),
  publishedAt: "2026-05-28T04:00:00Z",
};
const doc = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...VALID, ...over });
const without = (key: string): string => {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy[key];
  return JSON.stringify(copy);
};

describe("parseChannelPointer — the v1 schema (WARP-3430)", () => {
  it("accepts a well-formed pointer, for each channel", () => {
    expect(parseChannelPointer(doc())).toMatchObject({ ok: true, pointer: { channel: "stage", tag: VALID.tag } });
    expect(
      parseChannelPointer(doc({ channel: "stable", tag: "ota-stable-399-g82be2ca" })),
    ).toMatchObject({ ok: true, pointer: { channel: "stable" } });
  });

  it.each([
    ["not JSON", "{nope"],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"x"'],
  ])("refuses %s as pointer_invalid", (_l, raw) => {
    expect(parseChannelPointer(raw)).toMatchObject({ ok: false, failureReason: "pointer_invalid" });
  });

  it.each([
    ["a missing kind", without("kind")],
    ["another kind", doc({ kind: "release" })],
    ["an extension kind", doc({ kind: "extension" })],
    ["schemaVersion 2", doc({ schemaVersion: 2 })],
    ["schemaVersion 0", doc({ schemaVersion: 0 })],
    ["an empty channel", doc({ channel: "", tag: "ota--404-g3c71b82" })],
    ["a short gitSha", doc({ gitSha: "c".repeat(39) })],
    ["an uppercase gitSha", doc({ gitSha: "C".repeat(40) })],
    ["a short manifestSha256", doc({ manifestSha256: "a".repeat(63) })],
    ["a non-hex manifestSha256", doc({ manifestSha256: "z".repeat(64) })],
    ["a non-date builtAt", doc({ builtAt: "yesterday" })],
    ["a non-date publishedAt", doc({ publishedAt: "soon" })],
    ["a missing publishedAt", without("publishedAt")],
    ["an unknown key (a new field is a new schemaVersion)", doc({ extra: true })],
  ])("refuses %s", (_l, raw) => {
    expect(parseChannelPointer(raw)).toMatchObject({ ok: false, failureReason: "pointer_invalid" });
  });

  it.each([
    ["no run number", "ota-stage-g3c71b82"],
    ["the legacy untagged shape", "ota-1-gvalid"],
    ["a path traversal", "../ota-stage-404-g3c71b82"],
    ["a sub-path", "ota-stage-404-g3c71b82/x"],
    ["a query", "ota-stage-404-g3c71b82?x=1"],
    ["an uppercase sha", "ota-stage-404-gC3C71B8"],
    ["a short sha", "ota-stage-404-g3c71b8"],
    ["the word latest", "latest"],
  ])("refuses a tag with %s", (_l, tag) => {
    expect(parseChannelPointer(doc({ tag }))).toMatchObject({ ok: false, failureReason: "pointer_invalid" });
  });

  it("refuses a tag that names a different channel than the pointer's own", () => {
    // Otherwise a stage pointer could send a box into a stable tag's directory.
    const res = parseChannelPointer(doc({ channel: "stage", tag: "ota-stable-399-g82be2ca" }));
    expect(res).toMatchObject({ ok: false, failureReason: "pointer_invalid" });
    if (!res.ok) expect(res.detail).toContain("tag");
  });
});

describe("a pointer is never a manifest, and a manifest is never a pointer (WARP-3430)", () => {
  it.each([
    "release.valid.json",
    "release.valid-v2.json",
    "release.channel-stage.json",
    "release.channel-beta.json",
    "extension.valid.json",
  ])("%s, signed by the same key, does not parse as a pointer", (name) => {
    expect(parseChannelPointer(fx(name))).toMatchObject({ ok: false, failureReason: "pointer_invalid" });
  });

  it("a pointer does not parse as a release manifest", () => {
    const res = parseReleaseManifest(doc());
    expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
    if (!res.ok) expect(res.detail).toContain("is not a release");
  });

  it("a hybrid carrying both shapes is refused by BOTH parsers", () => {
    const manifest = JSON.parse(fx("release.channel-stage.json").toString("utf8")) as Record<string, unknown>;
    const hybrid = JSON.stringify({ ...manifest, ...VALID });
    // As a pointer: the manifest's release/services/configs keys are unknown.
    expect(parseChannelPointer(hybrid)).toMatchObject({ ok: false, failureReason: "pointer_invalid" });
    // As a manifest: it carries a kind that is not "release".
    expect(parseReleaseManifest(hybrid)).toMatchObject({ ok: false, failureReason: "schema_invalid" });
  });
});
