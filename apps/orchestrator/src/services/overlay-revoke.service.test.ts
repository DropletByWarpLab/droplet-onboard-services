import { describe, it, expect, vi } from "vitest";
import { revokeOverlayDeviceAtHq } from "./overlay-revoke.service.js";
import type { LegacyOverlayRevokeDeps } from "./overlay-revoke.service.js";

function identity(): LegacyOverlayRevokeDeps["identity"] {
  return {
    getDeviceIdentityStatus: vi.fn(async () => ({ certFingerprint: "BOXFP" } as never)),
    signWithDeviceKey: vi.fn(async () => ({
      signature: new Uint8Array([1, 2, 3]), algorithm: "ECDSA-P256-SHA256",
    } as never)),
  };
}

describe("legacy fleet overlay revocation", () => {
  it("signs the existing revoke contract and sends only a revocation request", async () => {
    const signer = identity();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await revokeOverlayDeviceAtHq({
      config: { hqBaseUrl: "https://hq.test/", deviceId: "droplet-abc" },
      identity: signer,
      fetchImpl,
    }, "WGPUB123");
    expect(signer.signWithDeviceKey).toHaveBeenCalledWith(
      new TextEncoder().encode("droplet-overlay-revoke:v1:droplet-abc:WGPUB123"),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hq.test/api/overlay/devices/revoke");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      device_id: "droplet-abc", key_fingerprint: "BOXFP", sig: "AQID",
      sig_alg: "ecdsa-sha256", wg_public_key: "WGPUB123",
    });
  });

  it("accepts a grant already absent from HQ", async () => {
    await expect(revokeOverlayDeviceAtHq({
      config: { hqBaseUrl: "https://hq.test", deviceId: "box" },
      identity: identity(),
      fetchImpl: vi.fn(async () => new Response("{}", { status: 404 })),
    }, "key")).resolves.toBeUndefined();
  });

  it("does not report success on a fleet error", async () => {
    await expect(revokeOverlayDeviceAtHq({
      config: { hqBaseUrl: "https://hq.test", deviceId: "box" },
      identity: identity(),
      fetchImpl: vi.fn(async () => new Response("boom", { status: 500 })),
    }, "key")).rejects.toThrow("HQ overlay revoke returned 500");
  });

  it("fails before any network call when the legacy fleet endpoint is absent", async () => {
    const fetchImpl = vi.fn();
    await expect(revokeOverlayDeviceAtHq({
      config: { hqBaseUrl: "", deviceId: "box" }, identity: identity(), fetchImpl,
    }, "key")).rejects.toThrow("HQ_ISSUANCE_URL not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
