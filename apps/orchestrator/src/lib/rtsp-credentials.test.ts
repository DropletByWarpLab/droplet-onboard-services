/**
 * WARP-3505 — operator-typed camera credentials.
 *
 * Two jobs, both security-relevant:
 *   - validateCameraCredentials: the values end up inside an RTSP
 *     `Authorization` header downstream, so control characters (CR/LF header
 *     injection) and absurd lengths are refused up front, and an error message
 *     can never echo the value back.
 *   - embedRtspCredentials: merges them into the stream URL server-side. The
 *     consumer is Frigate's ffmpeg, which does NOT percent-decode userinfo, so
 *     characters that are legal in userinfo (`!$&'()*+,;=`) stay literal
 *     (WARP-1873) and only the delimiters that would corrupt the parse
 *     (`@ / : # % ?` and whitespace) are encoded.
 */
import { describe, it, expect } from "vitest";
import { embedRtspCredentials, validateCameraCredentials } from "./rtsp-credentials.js";

describe("embedRtspCredentials", () => {
  it("adds userinfo to a bare URL", () => {
    expect(embedRtspCredentials("rtsp://192.168.9.219:554/profile2/media.smp", "admin", "s3cret!")).toBe(
      "rtsp://admin:s3cret!@192.168.9.219:554/profile2/media.smp",
    );
  });

  it("keeps ffmpeg-literal sub-delims unescaped and encodes parse-breaking characters", () => {
    expect(embedRtspCredentials("rtsp://10.0.0.5/live", "ad min", "p@ss/w:rd#1%")).toBe(
      "rtsp://ad%20min:p%40ss%2Fw%3Ard%231%25@10.0.0.5/live",
    );
    expect(embedRtspCredentials("rtsp://10.0.0.5/live", "u", "!$&'()*+,;=")).toBe(
      "rtsp://u:!$&'()*+,;=@10.0.0.5/live",
    );
  });

  it("replaces credentials already embedded in the URL", () => {
    expect(embedRtspCredentials("rtsp://user:password@10.0.0.5:554/stream", "admin", "s3cret!")).toBe(
      "rtsp://admin:s3cret!@10.0.0.5:554/stream",
    );
  });

  it("is not fooled by an @ in the path", () => {
    expect(embedRtspCredentials("rtsp://10.0.0.5/a@b", "admin", "pw")).toBe("rtsp://admin:pw@10.0.0.5/a@b");
  });

  it("supports rtsps and an empty password", () => {
    expect(embedRtspCredentials("rtsps://10.0.0.5:322/x", "admin", "")).toBe("rtsps://admin:@10.0.0.5:322/x");
  });

  it("leaves the URL untouched when no username is given", () => {
    expect(embedRtspCredentials("rtsp://u:p@10.0.0.5/x", undefined, undefined)).toBe("rtsp://u:p@10.0.0.5/x");
    expect(embedRtspCredentials("rtsp://10.0.0.5/x", "", "")).toBe("rtsp://10.0.0.5/x");
  });
});

describe("validateCameraCredentials", () => {
  it("accepts a normal pair, a username with no password, and neither", () => {
    expect(validateCameraCredentials("admin", "s3cret!")).toEqual({ ok: true });
    expect(validateCameraCredentials("admin", undefined)).toEqual({ ok: true });
    expect(validateCameraCredentials(undefined, undefined)).toEqual({ ok: true });
  });

  it.each([
    [{ username: 5, password: "x" }, "username"],
    [{ username: "admin", password: 5 }, "password"],
    [{ username: undefined, password: "orphan-pw" }, "username"],
    [{ username: "ad\r\nmin", password: "x" }, "username"],
    [{ username: "admin", password: "pw\r\nCSeq: 9" }, "password"],
    [{ username: "admin", password: "pw\u0000" }, "password"],
    [{ username: "a".repeat(129), password: "x" }, "username"],
    [{ username: "admin", password: "p".repeat(257) }, "password"],
  ])("rejects %j", (input, field) => {
    const r = validateCameraCredentials(input.username, input.password);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(field);
      // The message names the field, never the value (NET-05).
      for (const v of [input.username, input.password]) {
        if (typeof v === "string" && v.length > 3) expect(r.error).not.toContain(v);
      }
    }
  });
});
