/**
 * Tests for the screen-QR state machine.
 *
 * The state-decision logic (`decideScreenQR`) is a pure function over
 * its inputs — we test it in isolation. Network side-effects
 * (`countRealNextcloudUsers`, the WiFi-QR fetch, `pushCustomImage`)
 * are NOT tested here; they belong to integration tests on the POC.
 */
import { describe, expect, it, vi } from "vitest";
import { decideScreenQR, decideClaimScreen } from "./screen-qr.service.js";

const wifiOk = async () => ({ payload: "WIFI:S:droplet-ap;T:WPA;P:secret;;", ssid: "droplet-ap" });
const wifiDown = async () => null;

describe("decideScreenQR — priority", () => {
  it("returns setup-URL when no real users exist (first boot)", async () => {
    const d = await decideScreenQR(0, null, Date.now(), wifiOk);
    expect(d.mode).toBe("setup");
    expect(d.payload).toMatch(/^https:\/\/.+\/setup$/);
    expect(d.signature.startsWith("setup:")).toBe(true);
    expect(d.caption.toLowerCase()).toContain("set up");
  });

  it("setup-URL wins even when a peer was just created (first-boot is sticky)", async () => {
    // Edge case: someone tries to add a peer before completing wizard.
    // The setup QR still takes priority — they can't have a working
    // VPN without an admin account anyway.
    const d = await decideScreenQR(
      0,
      { config: "[Interface]\n...", createdAt: Date.now(), name: "phone" },
      Date.now(),
      wifiOk,
    );
    expect(d.mode).toBe("setup");
  });

  it("returns peer-QR when a peer was created in the last 60 s", async () => {
    const peerConf = "[Interface]\nPrivateKey = abc\n[Peer]\nPublicKey = def";
    const d = await decideScreenQR(
      1,
      { config: peerConf, createdAt: Date.now() - 5_000, name: "stefan-phone" },
      Date.now(),
      wifiOk,
    );
    expect(d.mode).toBe("peer");
    expect(d.payload).toBe(peerConf);
    expect(d.caption).toContain("stefan-phone");
  });

  it("falls back to WiFi-QR once the peer window expires", async () => {
    const d = await decideScreenQR(
      1,
      // 65 s ago — past the 60 s window
      { config: "[Interface]\n...", createdAt: Date.now() - 65_000, name: "phone" },
      Date.now(),
      wifiOk,
    );
    expect(d.mode).toBe("wifi");
    expect(d.payload).toContain("WIFI:");
    expect(d.caption).toContain("droplet-ap");
  });

  it("returns WiFi-QR when admin exists and no peer event", async () => {
    const d = await decideScreenQR(1, null, Date.now(), wifiOk);
    expect(d.mode).toBe("wifi");
    expect(d.payload.startsWith("WIFI:")).toBe(true);
  });

  it("returns 'none' when admin exists, no peer, and device-bridge is down", async () => {
    // Honest failure mode: leave the screen alone.
    const d = await decideScreenQR(1, null, Date.now(), wifiDown);
    expect(d.mode).toBe("none");
    expect(d.payload).toBe("");
  });

  it("uses peer name in caption when provided", async () => {
    const d = await decideScreenQR(
      1,
      { config: "x", createdAt: Date.now(), name: "iPad" },
      Date.now(),
      wifiOk,
    );
    expect(d.caption).toBe("Scan to add VPN peer iPad");
  });

  it("omits peer name from caption when not provided", async () => {
    const d = await decideScreenQR(
      1,
      { config: "x", createdAt: Date.now() },
      Date.now(),
      wifiOk,
    );
    expect(d.caption).toBe("Scan to add VPN peer");
  });
});

describe("decideScreenQR — signature stability", () => {
  // signature is what the poller uses to decide whether to re-push to
  // the display. Same logical content must produce the same signature
  // across calls so we don't slam the screen with the same image
  // every 30 s tick.

  it("setup signature is stable across calls", async () => {
    const a = await decideScreenQR(0, null, Date.now(), wifiOk);
    const b = await decideScreenQR(0, null, Date.now() + 5000, wifiOk);
    expect(a.signature).toBe(b.signature);
  });

  it("wifi signature changes when SSID changes", async () => {
    const wifiAlt = async () => ({ payload: "WIFI:S:other;T:WPA;P:p;;", ssid: "other" });
    const a = await decideScreenQR(1, null, Date.now(), wifiOk);
    const b = await decideScreenQR(1, null, Date.now(), wifiAlt);
    expect(a.signature).not.toBe(b.signature);
  });

  it("peer signature differs per peer-created-at timestamp", async () => {
    const t1 = Date.now() - 1000;
    const t2 = Date.now() - 2000;
    const a = await decideScreenQR(
      1, { config: "x", createdAt: t1, name: "p" }, Date.now(), wifiOk,
    );
    const b = await decideScreenQR(
      1, { config: "x", createdAt: t2, name: "p" }, Date.now(), wifiOk,
    );
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("decideClaimScreen — claim takes priority over every QR (WARP-632)", () => {
  // The claim screen is the HIGHEST-priority branch of the refresh path: while
  // the box is unclaimed we render the minted claim code on the lid and SKIP
  // the QR image push entirely. Once claimed we hand back to the QR/peer/wifi
  // logic. `decideClaimScreen` takes its side-effecting collaborators as deps
  // (isClaimed/ensureClaimCode/pushClaimCode/setupUrl) so it's unit-testable
  // with no DB and no network. The `prisma` arg is opaque here.
  const fakePrisma = {} as never;

  it("when NOT claimed and a code is minted: pushes the claim screen and reports handled", async () => {
    const ensureClaimCode = vi.fn(async () => "DRPL-7K2Q-9F4M");
    const pushClaimCode = vi.fn(async () => true);
    const setupUrl = () => "https://192.168.1.87/setup";

    const result = await decideClaimScreen(fakePrisma, {
      isClaimed: async () => false,
      ensureClaimCode,
      pushClaimCode,
      setupUrl,
    });

    expect(result.handled).toBe(true);
    expect(ensureClaimCode).toHaveBeenCalledOnce();
    expect(pushClaimCode).toHaveBeenCalledWith("DRPL-7K2Q-9F4M", "https://192.168.1.87/setup");
    // Signature is claim-scoped + changes only when the code changes, so the
    // poller won't re-push the same code every 30 s tick.
    expect(result.signature?.startsWith("claim:")).toBe(true);
  });

  it("when CLAIMED: does NOT mint or push, and reports not handled (falls through to QR)", async () => {
    const ensureClaimCode = vi.fn(async () => null);
    const pushClaimCode = vi.fn(async () => true);

    const result = await decideClaimScreen(fakePrisma, {
      isClaimed: async () => true,
      ensureClaimCode,
      pushClaimCode,
      setupUrl: () => "https://host/setup",
    });

    expect(result.handled).toBe(false);
    expect(ensureClaimCode).not.toHaveBeenCalled();
    expect(pushClaimCode).not.toHaveBeenCalled();
  });

  it("when not claimed but ensureClaimCode returns null (race: just claimed): not handled, no push", async () => {
    // isClaimed said false, but between that read and the mint the box got
    // claimed, so ensureClaimCode returns null. We must NOT push a stale claim
    // screen — fall through.
    const pushClaimCode = vi.fn(async () => true);

    const result = await decideClaimScreen(fakePrisma, {
      isClaimed: async () => false,
      ensureClaimCode: async () => null,
      pushClaimCode,
      setupUrl: () => "https://host/setup",
    });

    expect(result.handled).toBe(false);
    expect(pushClaimCode).not.toHaveBeenCalled();
  });

  it("signature is stable for the same code and changes when the code rotates", async () => {
    const mk = (code: string) =>
      decideClaimScreen(fakePrisma, {
        isClaimed: async () => false,
        ensureClaimCode: async () => code,
        pushClaimCode: async () => true,
        setupUrl: () => "https://host/setup",
      });

    const a = await mk("DRPL-7K2Q-9F4M");
    const b = await mk("DRPL-7K2Q-9F4M");
    const c = await mk("DRPL-AAAA-BBBB");

    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it("reports handled even if the push fails, so we still skip the QR image this tick", async () => {
    // A display outage shouldn't make us fall through to the WiFi QR while the
    // box is unclaimed — the claim screen still owns the tick; we retry next
    // tick (the signature isn't recorded by the caller on a failed push).
    const result = await decideClaimScreen(fakePrisma, {
      isClaimed: async () => false,
      ensureClaimCode: async () => "DRPL-7K2Q-9F4M",
      pushClaimCode: async () => false,
      setupUrl: () => "https://host/setup",
    });

    expect(result.handled).toBe(true);
    expect(result.pushed).toBe(false);
  });
});
