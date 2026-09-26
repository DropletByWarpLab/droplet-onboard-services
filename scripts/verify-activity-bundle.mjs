#!/usr/bin/env node
// WARP-3153 — offline verifier for a Droplet audit bundle
// (POST /api/activity/export, format droplet.activity-bundle.v3).
//
// Usage:
//   node verify-activity-bundle.mjs <bundle.jsonl> [--fingerprint sha256:<hex>]
//
// Needs Node 18+ and nothing else: no network, no secret. Checks
//   1. the last line (seal) signs SHA-256 of every byte before it with the
//      device key in the bundled cert;
//   2. the bundled cert's fingerprint matches --fingerprint, the value the
//      box shows on GET /api/admin/device-identity/status (certFingerprint).
//      Without it the verdict proves integrity but NOT origin: anyone can
//      mint a key and seal a fake bundle;
//   3. row count, ascending ids, and (unfiltered bundles only) every row's
//      prevSignatureHash = base64url(SHA-256(previous row's signature));
//   4. the box's own HMAC check at export time reported no failure.
// Exit 0 = verified, 1 = failed, 2 = usage error.
// Full procedure: docs/security/audit-bundle-verification.md
import { createHash, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPE = "droplet.activity-bundle.v3";
const SEAL_PREFIX = "droplet-activity-bundle:v3:";

export function verifyBundle(text, { fingerprint } = {}) {
  const errors = [];
  const warnings = [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const cut = body.lastIndexOf("\n");
  if (cut < 0) return { ok: false, errors: ["bundle has no seal line"], warnings };
  const signed = body.slice(0, cut + 1); // every byte the seal covers
  let seal, lines;
  try {
    seal = JSON.parse(body.slice(cut + 1));
    lines = signed.slice(0, -1).split("\n").map((l) => JSON.parse(l));
  } catch (e) {
    return { ok: false, errors: [`not valid NDJSON: ${e.message}`], warnings };
  }
  const [manifest, ...rows] = lines;

  if (manifest.type !== TYPE) errors.push(`manifest type ${manifest.type}, expected ${TYPE}`);
  if (seal.type !== `${TYPE}.seal`) errors.push("last line is not a seal");
  if (seal.error || !seal.signature) errors.push(`bundle is not sealed (${seal.error ?? "no signature"})`);

  const digest = createHash("sha256").update(signed, "utf8").digest("base64url");
  if (digest !== seal.digest) errors.push("digest mismatch: the file was modified after export");

  let certFp = null;
  try {
    const cert = new X509Certificate(manifest.deviceCertPem);
    certFp = `sha256:${createHash("sha256").update(manifest.deviceCertPem, "utf8").digest("hex")}`;
    if (certFp !== manifest.deviceCertFingerprint) errors.push("manifest fingerprint does not match its cert");
    if (seal.signature) {
      const good = verify(
        "sha256",
        Buffer.from(SEAL_PREFIX + seal.digest, "utf8"),
        cert.publicKey,
        Buffer.from(seal.signature, "base64"),
      );
      if (!good) errors.push("seal signature does not verify against the device cert");
    }
  } catch (e) {
    errors.push(`device cert unusable: ${e.message}`);
  }
  if (fingerprint) {
    if (certFp !== fingerprint) errors.push(`device cert ${certFp} is not the expected ${fingerprint}`);
  } else {
    warnings.push("no --fingerprint given: integrity checked, origin NOT checked");
  }

  if (seal.rowCount !== rows.length) errors.push(`seal says ${seal.rowCount} rows, file has ${rows.length}`);
  const filtered = Object.values(manifest.filter ?? {}).some((v) => v !== undefined && v !== null);
  for (let i = 1; i < rows.length; i++) {
    if (BigInt(rows[i].id) <= BigInt(rows[i - 1].id)) errors.push(`row ${rows[i].id} out of order`);
    if (!filtered) {
      const want = createHash("sha256").update(rows[i - 1].signature, "utf8").digest("base64url");
      if (rows[i].prevSignatureHash !== want) errors.push(`chain broken at row ${rows[i].id}`);
    }
  }
  if (filtered) warnings.push("filtered export: chain links between rows are not checkable");
  if (seal.rowHmac?.failed) {
    errors.push(`box reported ${seal.rowHmac.failed} row(s) failing its HMAC check: ${seal.rowHmac.failedRowIds.join(", ")}`);
  }

  return { ok: errors.length === 0, errors, warnings, rowCount: rows.length, certFingerprint: certFp };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fpAt = args.indexOf("--fingerprint");
  const fingerprint = fpAt >= 0 ? args[fpAt + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && (fpAt < 0 || i !== fpAt + 1));
  if (!file || (fpAt >= 0 && !fingerprint)) {
    console.error("usage: verify-activity-bundle.mjs <bundle.jsonl> [--fingerprint sha256:<hex>]");
    process.exit(2);
  }
  const r = verifyBundle(readFileSync(file, "utf8"), { fingerprint });
  for (const w of r.warnings) console.log(`warning: ${w}`);
  for (const e of r.errors) console.log(`FAIL: ${e}`);
  console.log(r.ok ? `OK: ${r.rowCount} row(s) sealed by ${r.certFingerprint}` : "NOT VERIFIED");
  process.exit(r.ok ? 0 : 1);
}
