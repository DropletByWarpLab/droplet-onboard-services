/**
 * WARP-3505 — what an operator reads when "Add camera" with typed credentials
 * fails. Driven THROUGH the real api client and the real translateError (the
 * modal tests mock the translator), so the wire code -> user copy chain is the
 * thing under test.
 *
 * Why each message differs: the next step differs. A wrong password wants a
 * retry (carefully: a few wrong tries in a row lock the camera), a lockout wants
 * a wait, a missing stream path wants the manual address, an unreachable camera
 * wants a power/cable check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { addCameraManual, addDiscoveredCameraWithCredentials } from "./api";
import { authFetch } from "./auth";
import { translateError } from "./friendly-errors";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));
// The operator breadcrumb is not under test.
vi.spyOn(console, "error").mockImplementation(() => {});

const authFetchMock = vi.mocked(authFetch);

function failure(status: number, json: unknown): Response {
  return { ok: false, status, json: vi.fn().mockResolvedValue(json) } as unknown as Response;
}

/** The copy shown for a failed credentials submit with this wire reply. */
async function copyFor(status: number, json: unknown): Promise<string> {
  authFetchMock.mockResolvedValue(failure(status, json));
  const err = await addDiscoveredCameraWithCredentials("mac:AA:BB", "admin", "s3cret!").catch((e) => e);
  return translateError(err, "camera");
}

const FALLBACK = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "camera");

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("camera credentials failures — copy per reason", () => {
  it("auth_failed says to check them, and warns that repeated wrong tries lock the camera (F10)", async () => {
    const copy = await copyFor(422, { error: "Rejected.", code: "auth_failed" });
    expect(copy).toMatch(/didn't accept that username and password/);
    expect(copy).toMatch(/Check them and try again\./);
    expect(copy).toContain("A few wrong tries in a row can lock the camera.");
  });

  it("locked says to wait", async () => {
    const copy = await copyFor(423, { error: "Locked.", code: "locked" });
    expect(copy).toMatch(/locked/);
    expect(copy).toMatch(/Wait a few minutes/);
  });

  it("no_stream_path names the control that is actually on the screen (F11)", async () => {
    const copy = await copyFor(422, { error: "No path.", code: "no_stream_path" });
    expect(copy).toContain("Enter the stream address instead");
    // Not the tab the form is NOT on.
    expect(copy).not.toMatch(/Enter details/);
  });

  it("unreachable asks for a power / network check", async () => {
    expect(await copyFor(502, { error: "Down.", code: "unreachable" })).toMatch(/reach the camera/);
  });

  it("discovery_unavailable says discovery is not running", async () => {
    expect(await copyFor(502, { error: "Down.", code: "discovery_unavailable" })).toMatch(/discovery/i);
  });

  it("timeout says it took too long AND that the camera may have been added", async () => {
    const copy = await copyFor(502, { error: "Took too long.", code: "timeout" });
    expect(copy).toMatch(/took too long/);
    expect(copy).toMatch(/may|If it was added/);
    // Not the "discovery is not running" story: discovery answered nothing in
    // time, it did not fail to start.
    expect(copy).not.toMatch(/isn't running/);
  });

  it("unsupported_password says which characters, and what to do about it", async () => {
    const copy = await copyFor(400, { error: "password cannot contain spaces or curly braces", code: "unsupported_password" });
    expect(copy).toMatch(/space/);
    expect(copy).toMatch(/curly brace/);
    expect(copy).toMatch(/Change the camera's password/);
  });

  it("invalid_credentials says to check them", async () => {
    const copy = await copyFor(400, { error: "username contains invalid characters", code: "invalid_credentials" });
    expect(copy).toMatch(/Check the username and password/);
  });

  it("basic_auth_only explains that no password was sent and asks for Digest", async () => {
    const copy = await copyFor(422, { error: "s3cret!", code: "basic_auth_only" });
    expect(copy).toMatch(/didn't send your password/);
    expect(copy).toMatch(/Digest/);
    expect(copy).toMatch(/administrator/);
    expect(copy).not.toContain("s3cret!");
  });

  it("unsupported_stream_address asks for camera stream settings instead of retyping the password", async () => {
    const copy = await copyFor(400, { error: "s3cret!", code: "unsupported_stream_address" });
    expect(copy).toMatch(/stream settings/);
    expect(copy).not.toContain("s3cret!");
  });

  it("the manual form's add explains an unsupported password the same way", async () => {
    authFetchMock.mockResolvedValue(failure(400, { error: "password cannot contain spaces", code: "unsupported_password" }));
    const err = await addCameraManual("cam", "rtsp://192.168.9.5/live", undefined, undefined, "admin", "has space").catch((e) => e);
    expect(translateError(err, "camera")).toMatch(/Change the camera's password/);
  });

  it("gives each reason its own words, none of them the generic fallback", async () => {
    const copies = await Promise.all(
      [
        "auth_failed",
        "locked",
        "no_stream_path",
        "unreachable",
        "discovery_unavailable",
        "timeout",
        "invalid_credentials",
        "unsupported_password",
        "basic_auth_only",
        "unsupported_stream_address",
      ].map((code) =>
        copyFor(422, { error: "x", code }),
      ),
    );
    expect(new Set(copies).size).toBe(copies.length);
    for (const c of copies) expect(c).not.toBe(FALLBACK);
  });

  it("never echoes the server's own sentence or the password", async () => {
    const copy = await copyFor(422, { error: "Camera not found in pending list s3cret!", code: "auth_failed" });
    expect(copy).not.toContain("pending list");
    expect(copy).not.toContain("s3cret");
  });
});

describe("camera status-only failures (F13)", () => {
  it("a 404 says the camera is no longer on the network, not the generic fallback", async () => {
    const copy = await copyFor(404, { error: "Camera not found in pending list" });
    expect(copy).not.toBe(FALLBACK);
    expect(copy).toMatch(/couldn't find that camera/);
    expect(copy).toMatch(/[Ss]can again/);
  });

  it("a 502 from the camera service says so, not the generic fallback", async () => {
    const copy = await copyFor(502, { error: "Failed to add camera to Frigate" });
    expect(copy).not.toBe(FALLBACK);
    expect(copy).toMatch(/camera system/);
    expect(copy).not.toContain("Frigate");
  });

  it("an unknown status still gets the generic fallback", async () => {
    expect(await copyFor(418, { error: "teapot" })).toBe(FALLBACK);
  });
});
