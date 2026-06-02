import { describe, it, expect } from "vitest";

import { translateError, type ErrorDomain } from "@/lib/friendly-errors";

/**
 * WARP-294 — Tests for the typed-error → friendly-copy translator.
 *
 * Per-domain code mappings are intentionally incremental: the test suite
 * pins a small known set (the ones we actively rely on at migrated
 * callsites) and exercises the universal contracts:
 *
 *   1. Each domain has a fixed-string fallback for unknown codes.
 *   2. `err.message` is NEVER returned verbatim — even if it looks
 *      friendly, the helper substitutes a fallback so future regressions
 *      can't leak internal strings.
 *   3. `null` / `undefined` / `{}` produce the same fallback as an
 *      unknown code.
 *
 * Defense in depth: a fictitious "SECRET_INTERNAL_DETAIL" message is
 * passed in for every domain and asserted to be absent from the result.
 */

const SECRET = "SECRET_INTERNAL_DETAIL_DO_NOT_LEAK";

const DOMAINS: ErrorDomain[] = [
  "auth",
  "files",
  "chat",
  "invite",
  "calendar",
  "subscription",
  "provider-key",
  "push",
  "knowledge",
  "media",
  "network",
  "vpn",
  "camera",
  "device",
  "generic",
];

describe("translateError — universal contracts", () => {
  it("returns a non-empty fallback for unknown errors in every domain", () => {
    for (const domain of DOMAINS) {
      const result = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, domain);
      expect(result, `domain=${domain}`).toBeTypeOf("string");
      expect(result.length, `domain=${domain}`).toBeGreaterThan(0);
    }
  });

  it("never echoes err.message verbatim — even when it looks friendly", () => {
    for (const domain of DOMAINS) {
      const result = translateError({ message: SECRET }, domain);
      expect(result, `domain=${domain}`).not.toBe(SECRET);
      expect(result, `domain=${domain}`).not.toContain(SECRET);
    }
  });

  it("handles null / undefined / empty / non-object inputs with the domain fallback", () => {
    for (const domain of DOMAINS) {
      const fallback = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, domain);
      expect(translateError(null, domain), `domain=${domain} null`).toBe(fallback);
      expect(translateError(undefined, domain), `domain=${domain} undefined`).toBe(fallback);
      expect(translateError({}, domain), `domain=${domain} empty`).toBe(fallback);
      expect(translateError("just a string", domain), `domain=${domain} string`).toBe(fallback);
      expect(translateError(42, domain), `domain=${domain} number`).toBe(fallback);
    }
  });

  it("accepts native Error instances and still returns a friendly fallback (never `err.message`)", () => {
    for (const domain of DOMAINS) {
      const e = new Error(SECRET);
      const result = translateError(e, domain);
      expect(result, `domain=${domain}`).not.toContain(SECRET);
    }
  });
});

describe("translateError — auth domain", () => {
  it("maps 401 / INVALID_CREDENTIALS to a friendly login-failed string", () => {
    const a = translateError({ status: 401 }, "auth");
    const b = translateError({ code: "INVALID_CREDENTIALS" }, "auth");
    expect(a.toLowerCase()).toMatch(/username|password|sign in|credential/);
    expect(b.toLowerCase()).toMatch(/username|password|sign in|credential/);
  });

  it("falls back to a friendly string for unknown auth errors (no orchestrator leakage)", () => {
    const result = translateError({ message: "OCS 401" }, "auth");
    expect(result).not.toContain("OCS");
    expect(result).not.toContain("401");
  });
});

describe("translateError — chat domain", () => {
  it("maps an upload-too-large code to a size-aware friendly string", () => {
    const result = translateError({ code: "UPLOAD_TOO_LARGE" }, "chat");
    expect(result.toLowerCase()).toMatch(/large|size|smaller/);
  });

  it("falls back to a 'something went wrong' string for unknown chat errors", () => {
    const result = translateError({ code: "GIBBERISH" }, "chat");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toMatch(/GIBBERISH/);
  });

  // WARP-305: brain-ingest reasons land on AttachmentChip's `error`
  // string in their raw lowercase form. They must NOT fall through to
  // the generic "Something went wrong on this turn" copy — that lies
  // to the user about a chat that's actually fine.
  it("maps `empty_extraction` (raw reason) to a friendly 'still attached, can't search' string", () => {
    const result = translateError({ message: "empty_extraction" }, "chat");
    expect(result).not.toMatch(/Something went wrong on this turn/i);
    expect(result.toLowerCase()).toMatch(/text|search|attached/);
  });

  it("maps `image_only` (raw reason) to an image-stored friendly string", () => {
    const result = translateError({ message: "image_only" }, "chat");
    expect(result).not.toMatch(/Something went wrong on this turn/i);
    expect(result.toLowerCase()).toMatch(/image|stored|attached/);
  });

  it("maps the IMAGE_ONLY code directly when it comes in as a typed error", () => {
    const result = translateError({ code: "IMAGE_ONLY" }, "chat");
    expect(result.toLowerCase()).toMatch(/image|stored/);
  });
});

describe("translateError — provider-key domain", () => {
  it("maps an INVALID_KEY code to a friendly string mentioning the key", () => {
    const result = translateError({ code: "INVALID_KEY" }, "provider-key");
    expect(result.toLowerCase()).toMatch(/key/);
  });

  it("falls back to a 'couldn't save' style string for unknowns", () => {
    const result = translateError({ message: "ECONNREFUSED" }, "provider-key");
    expect(result).not.toContain("ECONNREFUSED");
  });
});

describe("translateError — push domain", () => {
  it("maps a denied-permission code to a friendly string", () => {
    const result = translateError({ code: "PERMISSION_DENIED" }, "push");
    expect(result.toLowerCase()).toMatch(/notification|permission|blocked|denied/);
  });

  it("maps a 'not configured' phrase (substring) to a configured-off friendly string", () => {
    // Existing PushSubscriptionCard probes the orchestrator and falls
    // back on substring matching; the helper must accept the same input.
    const result = translateError({ message: "VAPID not configured" }, "push");
    expect(result).not.toContain("VAPID");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("translateError — media domain", () => {
  it("maps a fatal hls.js details enum to a friendly playback string", () => {
    // bufferStalledError is a real hls.js Hls.ErrorDetails value. The
    // user must never see the enum.
    const result = translateError({ code: "bufferStalledError" }, "media");
    expect(result).not.toContain("bufferStalled");
    expect(result.toLowerCase()).toMatch(/play|video|stream|recording/);
  });

  it("maps a manifest-load failure to a friendly playback string", () => {
    const result = translateError({ code: "manifestLoadError" }, "media");
    expect(result).not.toContain("manifestLoadError");
  });

  it("falls back to a generic playback string for unknown media codes", () => {
    const result = translateError({ code: "WHATEVER" }, "media");
    expect(result).not.toContain("WHATEVER");
  });
});

describe("translateError — calendar / subscription domains", () => {
  it("returns a friendly fallback for calendar errors", () => {
    const result = translateError({ message: "Failed to create reminder" }, "calendar");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a friendly fallback for subscription errors", () => {
    const result = translateError({ message: "401 Unauthorized" }, "subscription");
    expect(result).not.toContain("401");
  });
});

describe("translateError — invite domain (parity with /invite/[token])", () => {
  it("maps USED / EXPIRED / INVALID_PASSWORD to friendly invite copy", () => {
    expect(translateError({ code: "USED" }, "invite").toLowerCase()).toMatch(/used|already/);
    expect(translateError({ code: "EXPIRED" }, "invite").toLowerCase()).toMatch(/expired|fresh/);
    expect(translateError({ code: "INVALID_PASSWORD" }, "invite").toLowerCase()).toMatch(/password/);
  });
});

// WARP-646 — domains added so the ~46 raw-`err.message` toasts across the
// dashboard (files, network, remote-access, device pairing, cameras, …)
// route through the translator instead of leaking orchestrator strings.
describe("translateError — network / vpn / camera / device domains (WARP-646)", () => {
  it("returns a friendly fallback for every new domain and never leaks the raw message", () => {
    const raw = "ECONNREFUSED 127.0.0.1:3000";
    for (const domain of ["network", "vpn", "camera", "device"] as ErrorDomain[]) {
      const result = translateError({ message: raw }, domain);
      expect(result.length, `domain=${domain}`).toBeGreaterThan(0);
      expect(result, `domain=${domain}`).not.toContain("ECONNREFUSED");
      expect(result, `domain=${domain}`).not.toContain("3000");
    }
  });

  it("maps a NETWORK substring to a connection-aware string per domain", () => {
    for (const domain of ["network", "vpn", "camera", "device"] as ErrorDomain[]) {
      const result = translateError({ message: "Failed to fetch" }, domain);
      expect(result.toLowerCase(), `domain=${domain}`).toMatch(
        /connection|reach|powered|connected|moment/,
      );
    }
  });

  it("camera AUTH_REQUIRED mentions credentials", () => {
    const result = translateError({ code: "AUTH_REQUIRED" }, "camera");
    expect(result.toLowerCase()).toMatch(/username|password|credential/);
  });

  // network was the odd domain out: inferCodeFromMessage returns "TIMEOUT"
  // for timeout-like messages, but the network CODES table only had
  // NETWORK / NOT_FOUND, so a network-op timeout silently fell through to
  // the domain fallback. The TIMEOUT entry restores parity with
  // device / chat / generic.
  it("maps a network-domain timeout message to the TIMEOUT copy, not the fallback", () => {
    const result = translateError({ message: "request timed out" }, "network");
    const fallback = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "network");
    expect(result.toLowerCase()).toMatch(/took too long/);
    expect(result).not.toBe(fallback);
  });
});

describe("translateError — auth domain two-factor codes (WARP-646)", () => {
  it("maps TOTP_INVALID to a code-mismatch string, not a username/password one", () => {
    const result = translateError({ code: "TOTP_INVALID" }, "auth");
    expect(result.toLowerCase()).toMatch(/code|authenticator/);
  });

  it("maps RECOVERY_INVALID to a recovery-code string", () => {
    const result = translateError({ code: "RECOVERY_INVALID" }, "auth");
    expect(result.toLowerCase()).toMatch(/recovery|code/);
  });
});
