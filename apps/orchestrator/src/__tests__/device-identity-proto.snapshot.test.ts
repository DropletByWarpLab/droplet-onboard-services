/**
 * WARP-2900 (ADR-056 slice H1): the device-identity sidecar surface is
 * pinned.
 *
 * The sidecar holds the box's two private keys. Its gRPC surface is the
 * whole of what any process on the box can ask of them, so it changes only
 * deliberately:
 *
 *   - the RPC set is exactly {Sign, GetCert, GetStatus, Reseal,
 *     SignExtensionManifest}, in the .proto AND in the generated TS stub;
 *   - no message carries a field whose name looks like private key material
 *     (priv*, private_key, *_key_pem). GetCertResponse.cert_pem is a public
 *     certificate and matches none of those;
 *   - the extension key's public half is exposed as extension_spki_der /
 *     extension_key_fingerprint on GetStatus (field numbers 10 and 11);
 *   - the admin device-identity router still serves exactly status + reseal:
 *     there is no HTTP path to either signer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./helpers/test-paths.js";
import { DeviceIdentityServiceService } from "../grpc-generated/device_identity.js";
import { createAdminDeviceIdentityRouter } from "../routes/admin-device-identity.js";
import type { DeviceIdentityClient } from "../services/device-identity.client.js";

const PROTO = readFileSync(path.join(REPO_ROOT, "proto", "device_identity.proto"), "utf8");

/** Strip // comments so prose cannot satisfy or trip a match. */
const code = PROTO.split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

/** Top-level messages and their fields, by brace matching (handles `{}`). */
function messages(): Map<string, Array<{ type: string; name: string; num: number }>> {
  const out = new Map<string, Array<{ type: string; name: string; num: number }>>();
  for (const m of code.matchAll(/\bmessage\s+(\w+)\s*\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
    }
    const body = code.slice(start, i - 1);
    const fields = [
      ...body.matchAll(/^\s*(?:repeated\s+)?([\w.]+|map<[^>]+>)\s+(\w+)\s*=\s*(\d+)\s*;/gm),
    ].map((f) => ({ type: f[1].trim(), name: f[2], num: Number(f[3]) }));
    out.set(m[1], fields);
  }
  return out;
}

const EXPECTED_RPCS = ["Sign", "GetCert", "GetStatus", "Reseal", "SignExtensionManifest"];

describe("device-identity proto surface (WARP-2900)", () => {
  it("declares exactly the pinned RPC set", () => {
    const rpcs = [...code.matchAll(/\brpc\s+(\w+)\s*\(/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual([...EXPECTED_RPCS].sort());
  });

  it("the generated TS stub serves the same RPC set", () => {
    const paths = Object.values(DeviceIdentityServiceService)
      .map((d) => d.path.split("/").pop())
      .sort();
    expect(paths).toEqual([...EXPECTED_RPCS].sort());
  });

  it("parses a non-trivial set of messages (not vacuous)", () => {
    const m = messages();
    expect(m.size).toBeGreaterThanOrEqual(10);
    expect(m.get("GetCertResponse")?.map((f) => f.name)).toEqual(["cert_pem"]);
  });

  it("no field name looks like private key material", () => {
    const bad = /priv|private_key|_key_pem$/i;
    const offenders: string[] = [];
    for (const [msg, fields] of messages()) {
      for (const f of fields) if (bad.test(f.name)) offenders.push(`${msg}.${f.name}`);
    }
    expect(offenders).toEqual([]);
  });

  it("GetStatus exposes the extension key's public half at fields 10 and 11", () => {
    const status = messages().get("GetStatusResponse")!;
    expect(status).toContainEqual({ type: "bytes", name: "extension_spki_der", num: 10 });
    expect(status).toContainEqual({ type: "string", name: "extension_key_fingerprint", num: 11 });
  });

  it("SignExtensionManifest takes only the statement bytes", () => {
    expect(messages().get("SignExtensionManifestRequest")).toEqual([
      { type: "bytes", name: "statement", num: 1 },
    ]);
  });
});

describe("admin device-identity routes are pinned (WARP-2900)", () => {
  it("serves exactly GET status and POST reseal", () => {
    const router = createAdminDeviceIdentityRouter({} as DeviceIdentityClient) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };
    const routes = router.stack
      .map((l) => l.route)
      .filter((r): r is { path: string; methods: Record<string, boolean> } => Boolean(r))
      .map((r) => `${Object.keys(r.methods).join(",").toUpperCase()} ${r.path}`)
      .sort();
    expect(routes).toEqual([
      "GET /admin/device-identity/status",
      "POST /admin/device-identity/reseal",
    ]);
  });
});
