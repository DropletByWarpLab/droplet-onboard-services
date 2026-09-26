#!/usr/bin/env node
// WARP-3153 — offline verifier for a Droplet audit bundle
// (POST /api/activity/export, format droplet.activity-bundle.v3).
//
// Usage:
//   node verify-activity-bundle.mjs <bundle.jsonl> --fingerprint sha256:<hex>
//   node verify-activity-bundle.mjs <bundle.jsonl> --no-fingerprint   (integrity only)
//
// Needs Node 18+ and nothing else: no network, no secret. Checks
//   1. the seal (last line) is signed by the key in the bundled device cert,
//      over "droplet-activity-bundle:v3:" + its `statement` string verbatim;
//      every seal field (digest, rowCount, rowHmac) lives in that statement;
//   2. statement.digest = SHA-256 of every byte before the seal line;
//   3. the cert's fingerprint equals --fingerprint, the value the box shows
//      on GET /api/admin/device-identity/status (certFingerprint). Without it
//      anyone can mint a key and seal a fake bundle, so it is required unless
//      --no-fingerprint is passed explicitly;
//   4. rowCount and rowHmac.checked equal the rows in the file, ids ascend,
//      rowHmac.failed is 0, and (unfiltered bundles only) every row's
//      prevSignatureHash = base64url(SHA-256(previous row's signature)).
// Exit 0 = verified, 1 = failed, 2 = usage error.
// Full procedure and limits: docs/security/audit-bundle-verification.md
import { createHash, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPE = "droplet.activity-bundle.v3";
const SEAL_PREFIX = "droplet-activity-bundle:v3:";

export function verifyBundle(text, { fingerprint, allowUnpinned = false } = {}) {
  const errors = [];
  const warnings = [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const cut = body.lastIndexOf("\n");
  if (cut < 0) return { ok: false, errors: ["bundle has no seal line"], warnings };
  const signed = body.slice(0, cut + 1); // every byte the digest covers
  let seal, stmt, lines;
  try {
    seal = JSON.parse(body.slice(cut + 1));
    stmt = JSON.parse(seal.statement);
    lines = signed.slice(0, -1).split("\n").map((l) => JSON.parse(l));
  } catch (e) {
    return { ok: false, errors: [`not a v3 bundle: ${e.message}`], warnings };
  }
  const [manifest, ...rows] = lines;

  if (manifest.type !== TYPE) errors.push(`manifest type ${manifest.type}, expected ${TYPE}`);
  if (stmt.type !== `${TYPE}.seal`) errors.push("last line is not a seal");
  if (seal.error || !seal.signature) errors.push(`bundle is not sealed (${seal.error ?? "no signature"})`);

  const digest = createHash("sha256").update(signed, "utf8").digest("base64url");
  if (digest !== stmt.digest) errors.push("digest mismatch: the file was modified after export");

  let certFp = null;
  try {
    const cert = new X509Certificate(manifest.deviceCertPem);
    certFp = `sha256:${createHash("sha256").update(manifest.deviceCertPem, "utf8").digest("hex")}`;
    if (certFp !== manifest.deviceCertFingerprint) errors.push("manifest fingerprint does not match its cert");
    if (seal.signature) {
      const sig = Buffer.from(seal.signature, "base64");
      const good =
        sig.length > 0 &&
        verify("sha256", Buffer.from(SEAL_PREFIX + seal.statement, "utf8"), cert.publicKey, sig);
      if (!good) errors.push("seal signature does not verify against the device cert");
    }
  } catch (e) {
    errors.push(`device cert unusable: ${e.message}`);
  }
  if (fingerprint) {
    if (certFp !== fingerprint) errors.push(`device cert ${certFp} is not the expected ${fingerprint}`);
  } else if (allowUnpinned) {
    warnings.push(
      "NO FINGERPRINT PINNED: integrity is checked but ORIGIN IS NOT. Anyone can seal a fabricated bundle with their own key.",
    );
  } else {
    errors.push("no --fingerprint given (pass --no-fingerprint to check integrity only)");
  }

  if (stmt.rowCount !== rows.length) errors.push(`seal says ${stmt.rowCount} rows, file has ${rows.length}`);
  const h = stmt.rowHmac;
  if (!h || h.checked !== rows.length) {
    errors.push(`box HMAC check covered ${h?.checked} row(s), file has ${rows.length}`);
  } else if (h.failed !== 0) {
    errors.push(`box reported ${h.failed} row(s) failing its HMAC check: ${(h.failedRowIds ?? []).join(", ")}`);
  }
  const filtered = Object.values(manifest.filter ?? {}).some((v) => v !== undefined && v !== null);
  for (let i = 1; i < rows.length; i++) {
    if (BigInt(rows[i].id) <= BigInt(rows[i - 1].id)) errors.push(`row ${rows[i].id} out of order`);
    if (!filtered) {
      const want = createHash("sha256").update(rows[i - 1].signature, "utf8").digest("base64url");
      if (rows[i].prevSignatureHash !== want) errors.push(`chain broken at row ${rows[i].id}`);
    }
  }
  if (filtered) warnings.push("filtered export: chain links between rows are not checkable");

  return { ok: errors.length === 0, errors, warnings, rowCount: rows.length, certFingerprint: certFp };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fpAt = args.indexOf("--fingerprint");
  const fingerprint = fpAt >= 0 ? args[fpAt + 1] : undefined;
  const allowUnpinned = args.includes("--no-fingerprint");
  const file = args.find((a, i) => !a.startsWith("--") && (fpAt < 0 || i !== fpAt + 1));
  if (!file || (fpAt >= 0 && !fingerprint) || (fingerprint && allowUnpinned)) {
    console.error(
      "usage: verify-activity-bundle.mjs <bundle.jsonl> (--fingerprint sha256:<hex> | --no-fingerprint)",
    );
    process.exit(2);
  }
  const r = verifyBundle(readFileSync(file, "utf8"), { fingerprint, allowUnpinned });
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  for (const e of r.errors) console.log(`FAIL: ${e}`);
  console.log(r.ok ? `OK: ${r.rowCount} row(s) sealed by ${r.certFingerprint}` : "NOT VERIFIED");
  process.exit(r.ok ? 0 : 1);
}
