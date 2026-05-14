/**
 * Tests for the screen-QR state machine.
 *
 * The state-decision logic (`decideScreenQR`) is a pure function over
 * its inputs — we test it in isolation. Network side-effects
 * (`countRealNextcloudUsers`, the WiFi-QR fetch, `pushCustomImage`)
 * are NOT tested here; they belong to integration tests on the POC.
 */
import { describe, expect, it } from "vitest";
import { decideScreenQR } from "./screen-qr.service.js";

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
