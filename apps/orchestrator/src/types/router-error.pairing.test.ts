/**
 * ADR-071 — `PAIRED_ELSEWHERE` beside `AUTH`.
 *
 * `routerErrorFromResponse` maps EVERY 502 to AUTH (WARP-1673) and must keep
 * doing so; the one 502 that means something else is read from the body by
 * `routerErrorFromResponseBody`.
 */
import { describe, it, expect } from "vitest";
import {
  RouterError,
  routerErrorFromResponse,
  routerErrorFromResponseBody,
} from "./router-error.js";

const BOX = "ab".repeat(32);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("routerErrorFromResponseBody", () => {
  it("maps 502 ROUTER_PAIRED_ELSEWHERE (FastAPI detail shape) to PAIRED_ELSEWHERE with the fingerprint", async () => {
    const err = await routerErrorFromResponseBody(
      json(502, { detail: { code: "ROUTER_PAIRED_ELSEWHERE", message: "paired to another box", paired_box: BOX } }),
      "Router summary",
    );
    expect(err.code).toBe("PAIRED_ELSEWHERE");
    expect(err.status).toBe(502);
    expect(err.pairedBox).toBe(BOX);
    expect(err.toJSON()).toMatchObject({ code: "PAIRED_ELSEWHERE", pairedBox: BOX });
  });

  it("accepts the flat body shape too", async () => {
    const err = await routerErrorFromResponseBody(
      json(502, { code: "ROUTER_PAIRED_ELSEWHERE", paired_box: BOX }),
      "x",
    );
    expect(err.code).toBe("PAIRED_ELSEWHERE");
    expect(err.pairedBox).toBe(BOX);
  });

  it("drops a malformed paired_box rather than carrying it", async () => {
    const err = await routerErrorFromResponseBody(
      json(502, { detail: { code: "ROUTER_PAIRED_ELSEWHERE", paired_box: "<script>" } }),
      "x",
    );
    expect(err.code).toBe("PAIRED_ELSEWHERE");
    expect(err.pairedBox).toBeUndefined();
    expect(err.toJSON()).not.toHaveProperty("pairedBox");
  });

  it("keeps ROUTER_AUTH as AUTH", async () => {
    const err = await routerErrorFromResponseBody(
      json(502, { detail: { code: "ROUTER_AUTH", message: "rejected" } }),
      "x",
    );
    expect(err.code).toBe("AUTH");
  });

  it("keeps an unreadable 502 body as AUTH (the status-only rule)", async () => {
    const err = await routerErrorFromResponseBody(new Response("<html>bad gateway</html>", { status: 502 }), "x");
    expect(err.code).toBe("AUTH");
  });

  it("leaves every other status to the status-only classifier", async () => {
    expect((await routerErrorFromResponseBody(json(401, {}), "x")).code).toBe("AUTH");
    expect((await routerErrorFromResponseBody(json(503, {}), "x")).code).toBe("UNREACHABLE");
    expect((await routerErrorFromResponseBody(json(404, {}), "x")).code).toBe("UNKNOWN");
  });

  it("does not consume the callers Response body", async () => {
    const res = json(502, { detail: { code: "ROUTER_PAIRED_ELSEWHERE", paired_box: BOX } });
    await routerErrorFromResponseBody(res, "x");
    expect(res.bodyUsed).toBe(false);
  });

  it("the sync classifier is unchanged: every 502 is AUTH", () => {
    expect(routerErrorFromResponse(json(502, { code: "ROUTER_PAIRED_ELSEWHERE" }), "x").code).toBe("AUTH");
  });

  it("RouterError.pairedElsewhere is a 502", () => {
    const err = RouterError.pairedElsewhere(undefined, { pairedBox: BOX });
    expect(err.code).toBe("PAIRED_ELSEWHERE");
    expect(err.status).toBe(502);
  });
});
