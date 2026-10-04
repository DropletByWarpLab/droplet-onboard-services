/**
 * WARP-3505 — operator-typed camera credentials.
 *
 * Three jobs, all security-relevant:
 *   - validateCameraCredentials: the values end up inside an RTSP
 *     `Authorization` header downstream, so control characters (CR/LF header
 *     injection), lone surrogates (which crash UTF-8 encoding) and absurd lengths
 *     are refused up front, and an error message can never echo the value back.
 *   - embedRtspCredentials: merges them into the stream URL server-side, in the
 *     form FRIGATE needs.
 *   - scrubUrlCredentials: removes them from text that gets logged.
 *
 * The form Frigate needs is NOT "percent-encode the password". Frigate 0.17 runs
 * `escape_special_characters` over every ffmpeg input path (regex
 * `://[a-zA-Z0-9_-]+:[\S]+@`, `quote_plus` on the password) and ffmpeg then
 * URL-decodes the userinfo ONCE. So for a username that regex matches the
 * password must be stored RAW (Frigate encodes it); storing `C%40mera!2024`
 * encodes it twice and the camera receives `C%40mera!2024` — 401 on every retry,
 * then a Hanwha lockout. For any other username nothing re-encodes it, so it must
 * be percent-encoded for ffmpeg's one decode. (The earlier WARP-1873 reading —
 * "ffmpeg does not decode userinfo" — was wrong, and the encoding it prescribed
 * broke every password with `@`, `/`, `:`, `?`, `#` or `%`.)
 *
 * So the central tests below assert what the CAMERA receives, by running the
 * stored path through an emulation of Frigate's escape and ffmpeg's decode.
 */
import { describe, it, expect } from "vitest";
import { cameraReceives, frigateEscape } from "../__tests__/frigate-credentials.fake.js";
import {
  embedRtspCredentials,
  scrubUrlCredentials,
  UnsafeCredentialsError,
  validateCameraCredentials,
} from "./rtsp-credentials.js";

// ── Frigate + ffmpeg: see ../__tests__/frigate-credentials.fake.ts ────────────

const BASE = "rtsp://192.168.9.219:554/profile2/media.smp";

// QA's four, then the characters each layer treats specially.
const PASSWORDS = [
  "C@mera!2024",
  "Qa@2024#x",
  "p:ss/w?rd",
  "WarpLab123!",
  "100%sure",
  "a+b=c&d",
  "x@y@z",
  "ünïcode✓pw",
  "emoji🔑pw", // an astral character: a surrogate PAIR in JS, which is fine; a lone half is not
  "~tilde.-_",
];
const MATCHING_USERS = ["admin", "svc_cam-1", "Root"];
const OTHER_USERS = ["john.doe", "ops@example.com", "ünï", "a b"];

describe("the Frigate + ffmpeg emulation", () => {
  it("reproduces the double-encoding bug the old output had", () => {
    expect(cameraReceives("rtsp://admin:C%40mera!2024@192.168.9.219:554/x")).toEqual({
      user: "admin",
      password: "C%40mera!2024",
    });
  });

  it("delivers a raw password intact, and leaves a username outside its pattern alone", () => {
    expect(cameraReceives("rtsp://admin:C@mera!2024@192.168.9.219:554/x").password).toBe("C@mera!2024");
    const encoded = "rtsp://john.doe:C%40mera%212024@192.168.9.219:554/x";
    expect(frigateEscape(encoded)).toBe(encoded);
    expect(cameraReceives(encoded)).toEqual({ user: "john.doe", password: "C@mera!2024" });
  });
});

describe("embedRtspCredentials — the camera receives exactly what was typed", () => {
  it.each(PASSWORDS.flatMap((pw) => MATCHING_USERS.map((user) => [user, pw] as const)))(
    "a matching username %s stores the password RAW: %s",
    (user, pw) => {
      const stored = embedRtspCredentials(BASE, user, pw);
      expect(stored).toBe(`rtsp://${user}:${pw}@192.168.9.219:554/profile2/media.smp`);
      expect(cameraReceives(stored)).toEqual({ user, password: pw });
    },
  );

  it.each(PASSWORDS.flatMap((pw) => OTHER_USERS.map((user) => [user, pw] as const)))(
    "another username %s percent-encodes both, which Frigate leaves alone: %s",
    (user, pw) => {
      const stored = embedRtspCredentials(BASE, user, pw);
      expect(frigateEscape(stored)).toBe(stored);
      expect(cameraReceives(stored)).toEqual({ user, password: pw });
    },
  );

  it("the four passwords named in review", () => {
    for (const pw of ["C@mera!2024", "Qa@2024#x", "p:ss/w?rd", "WarpLab123!"]) {
      expect(cameraReceives(embedRtspCredentials(BASE, "admin", pw))).toEqual({ user: "admin", password: pw });
    }
  });

  it("keeps a query string and the path intact", () => {
    const url = "rtsp://192.168.9.219:554/cam/realmonitor?channel=1&subtype=0";
    const stored = embedRtspCredentials(url, "admin", "p:ss/w?rd");
    expect(frigateEscape(stored).endsWith("@192.168.9.219:554/cam/realmonitor?channel=1&subtype=0")).toBe(true);
    expect(cameraReceives(stored).password).toBe("p:ss/w?rd");
  });

  it("replaces credentials already embedded in the URL", () => {
    expect(embedRtspCredentials("rtsp://user:password@10.0.0.5:554/stream", "admin", "s3cret!")).toBe(
      "rtsp://admin:s3cret!@10.0.0.5:554/stream",
    );
  });

  it.each(["/a@b", "/stream?token=a@b", "/a@b?x=1", "/a?x=@", "/@", "/p/@host"])(
    "refuses an @ after the host for a raw-password account: %s",
    (tail) => {
      for (const user of MATCHING_USERS) {
        try {
          embedRtspCredentials(`rtsp://10.0.0.5${tail}`, user, "s3cret!");
          expect.fail("Frigate would swallow the host into the password");
        } catch (err) {
          expect(err).toBeInstanceOf(UnsafeCredentialsError);
          expect(err).toMatchObject({ field: "address", code: "unsupported_stream_address" });
          expect((err as Error).message).not.toContain("s3cret!");
          expect((err as Error).message).not.toContain(tail);
        }
      }
    },
  );

  it.each(["/a@b", "/stream?token=a@b", "/a?x=@"])(
    "preserves an @ after the host when Frigate leaves encoded credentials alone: %s",
    (tail) => {
      for (const user of OTHER_USERS) {
        const stored = embedRtspCredentials(`rtsp://10.0.0.5${tail}`, user, "C@mera!2024");
        expect(frigateEscape(stored)).toBe(stored);
        expect(stored.endsWith(`@10.0.0.5${tail}`)).toBe(true);
        expect(cameraReceives(stored)).toEqual({ user, password: "C@mera!2024" });
      }
    },
  );

  it("does not discard the authority when a query contains an @", () => {
    const stored = embedRtspCredentials("rtsp://old:pw@10.0.0.5?token=a@b", "john.doe", "new!");
    expect(stored).toBe("rtsp://john.doe:new%21@10.0.0.5?token=a@b");
  });

  it("supports rtsps and an empty password", () => {
    expect(embedRtspCredentials("rtsps://10.0.0.5:322/x", "admin", "")).toBe("rtsps://admin:@10.0.0.5:322/x");
  });

  it("leaves the URL untouched when no username is given", () => {
    expect(embedRtspCredentials("rtsp://u:p@10.0.0.5/x", undefined, undefined)).toBe("rtsp://u:p@10.0.0.5/x");
    expect(embedRtspCredentials("rtsp://10.0.0.5/x", "", "")).toBe("rtsp://10.0.0.5/x");
  });

  it.each(["has space", "tab\there", "brace{", "}brace", "{FRIGATE_X}"])(
    "refuses a raw password it cannot store (%j) rather than write a broken config",
    (pw) => {
      expect(() => embedRtspCredentials(BASE, "admin", pw)).toThrow(UnsafeCredentialsError);
    },
  );

  it.each(["has space", "brace{", "{FRIGATE_X}"])(
    "but %j is fine percent-encoded, for a username Frigate does not match",
    (pw) => {
      const stored = embedRtspCredentials(BASE, "john.doe", pw);
      expect(stored).not.toMatch(/[{} ]/);
      expect(cameraReceives(stored)).toEqual({ user: "john.doe", password: pw });
    },
  );

  it("refuses a password that also occurs in the address, which Frigate would rewrite there too", () => {
    expect(() => embedRtspCredentials("rtsp://192.168.9.219:554/a/b", "admin", "/")).toThrow(UnsafeCredentialsError);
    // ...unless quote_plus leaves it alone, so nothing is rewritten:
    expect(cameraReceives(embedRtspCredentials("rtsp://192.168.9.219:554/profile2", "admin", "profile2")).password).toBe(
      "profile2",
    );
  });

  it.each(["@", ":", "/", "//", "min:", "min:min"])(
    "refuses a password that Frigate would also replace in the scheme or separator: %s",
    (pw) => {
      expect(() => embedRtspCredentials("rtsp://192.168.9.219", "admin", pw)).toThrow(UnsafeCredentialsError);
    },
  );

  it("accepts punctuation that only occurs inside the password field", () => {
    expect(cameraReceives(embedRtspCredentials(BASE, "admin", ":@"))).toEqual({ user: "admin", password: ":@" });
  });
});

describe("validateCameraCredentials", () => {
  it("accepts a normal pair, a username with no password, and neither", () => {
    expect(validateCameraCredentials("admin", "s3cret!")).toEqual({ ok: true });
    expect(validateCameraCredentials("admin", undefined)).toEqual({ ok: true });
    expect(validateCameraCredentials(undefined, undefined)).toEqual({ ok: true });
    expect(validateCameraCredentials("", "")).toEqual({ ok: true }); // blank form fields: nothing given
  });

  it("accepts every password QA named, with a username Frigate matches or not", () => {
    for (const user of ["admin", "john.doe"]) {
      for (const pw of PASSWORDS) expect(validateCameraCredentials(user, pw)).toEqual({ ok: true });
    }
  });

  it.each([
    [{ username: 5, password: "x" }, "username"],
    [{ username: "admin", password: 5 }, "password"],
    [{ username: undefined, password: "orphan-pw" }, "username"],
    [{ username: "   ", password: "x" }, "username"], // whitespace-only
    [{ username: "   ", password: undefined }, "username"],
    [{ username: "\t", password: undefined }, "username"],
    [{ username: "ad\r\nmin", password: "x" }, "username"],
    [{ username: "admin", password: "pw\r\nCSeq: 9" }, "password"],
    [{ username: "admin", password: "pw\u0000" }, "password"],
    [{ username: "admin", password: "tab\there" }, "password"],
    [{ username: "a".repeat(129), password: "x" }, "username"],
    [{ username: "admin", password: "p".repeat(257) }, "password"],
    [{ username: "ad:min", password: "x" }, "username"], // ffmpeg splits the DECODED userinfo at ':'
    [{ username: "admin", password: "bad\ud800pw" }, "password"], // lone surrogate: encodeURIComponent throws on it
    [{ username: "bad\udfffname", password: "x" }, "username"],
  ])("rejects %j as invalid_credentials", (input, field) => {
    const r = validateCameraCredentials(input.username, input.password);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_credentials");
      expect(r.error).toContain(field);
      // The message names the field, never the value (NET-05).
      for (const v of [input.username, input.password]) {
        if (typeof v === "string" && v.trim().length > 3) expect(r.error).not.toContain(v);
      }
    }
  });

  it.each(["has space", "nbsp\u00a0here", "brace{", "}", "{FRIGATE_CAMERA_X_PASSWORD}"])(
    "a password Frigate cannot store (%j) is unsupported_password for a username it matches",
    (pw) => {
      const r = validateCameraCredentials("admin", pw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("unsupported_password");
        expect(r.error).toContain("password");
        expect(r.error).not.toContain(pw);
      }
    },
  );

  it("does not apply that limit to a username Frigate does not match (percent-encoded)", () => {
    expect(validateCameraCredentials("john.doe", "has space{")).toEqual({ ok: true });
  });
});

describe("scrubUrlCredentials", () => {
  it.each([
    "Invalid path rtsp://admin:C@mera!2024@192.168.9.5:554/profile2/media.smp for camera x",
    '{"path": "rtsp://admin:s3cret!@192.168.9.5/x", "roles": ["detect"]}',
    "rtsps://u:p%40ss@host/x failed",
  ])("removes the credentials from a URL in free text: %s", (text) => {
    const out = scrubUrlCredentials(text);
    for (const secret of ["C@mera!2024", "s3cret", "p%40ss", "admin:", "u:p"]) expect(out).not.toContain(secret);
    expect(out).toContain("rtsp");
  });

  it("leaves text without credentials alone", () => {
    const text = "Frigate rejected camera front: rtsp://192.168.9.5:554/live is not reachable";
    expect(scrubUrlCredentials(text)).toBe(text);
  });
});
