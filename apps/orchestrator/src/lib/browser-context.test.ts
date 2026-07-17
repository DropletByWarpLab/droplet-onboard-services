import { describe, it, expect } from "vitest";
import { browserMarkerHeader, isBrowserRequest } from "./browser-context.js";

/**
 * WARP-582 — unit coverage for the browser-context classifier that gates the
 * `?return=body` token escape hatch on /auth/login (+ the passkey twin).
 */
describe("browser-context (WARP-582)", () => {
  it("classifies a bare native-client request (OkHttp/URLSession shape) as non-browser", () => {
    expect(
      isBrowserRequest({
        "content-type": "application/json",
        "user-agent": "okhttp/4.12.0",
        accept: "application/json",
      }),
    ).toBe(false);
    expect(browserMarkerHeader({})).toBeNull();
  });

  it("flags each Sec-Fetch-* forbidden header", () => {
    expect(browserMarkerHeader({ "sec-fetch-site": "same-origin" })).toBe(
      "sec-fetch-site",
    );
    expect(browserMarkerHeader({ "sec-fetch-mode": "cors" })).toBe(
      "sec-fetch-mode",
    );
    expect(browserMarkerHeader({ "sec-fetch-dest": "empty" })).toBe(
      "sec-fetch-dest",
    );
  });

  it("flags Origin (browsers attach it to every POST) and Referer", () => {
    expect(browserMarkerHeader({ origin: "https://droplet-ai.local" })).toBe(
      "origin",
    );
    expect(
      browserMarkerHeader({ referer: "https://droplet-ai.local/login" }),
    ).toBe("referer");
  });

  it("flags even an empty-string marker value (presence, not content, is the signal)", () => {
    expect(isBrowserRequest({ origin: "" })).toBe(true);
  });

  it("does not treat unrelated sec-* headers as browser markers", () => {
    expect(
      isBrowserRequest({ "sec-websocket-key": "x", "x-origin-app": "droplet" }),
    ).toBe(false);
  });
});
