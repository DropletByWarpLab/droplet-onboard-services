import { describe, it, expect } from "vitest";
import { HttpError } from "./http-error.js";

describe("HttpError", () => {
  it("maps badRequest to 400", () => {
    const err = HttpError.badRequest();
    expect(err.status).toBe(400);
    expect(err.code).toBe("BAD_REQUEST");
  });

  it("maps unauthorized to 401", () => {
    expect(HttpError.unauthorized().status).toBe(401);
  });

  it("maps forbidden to 403", () => {
    expect(HttpError.forbidden().status).toBe(403);
  });

  it("maps notFound to 404", () => {
    const err = HttpError.notFound();
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("maps conflict to 409", () => {
    expect(HttpError.conflict().status).toBe(409);
  });

  it("maps internal to 500", () => {
    expect(HttpError.internal().status).toBe(500);
  });

  it("preserves a custom message", () => {
    const err = HttpError.notFound("widget gone");
    expect(err.status).toBe(404);
    expect(err.message).toBe("widget gone");
  });

  it("is an instance of Error", () => {
    expect(HttpError.badRequest()).toBeInstanceOf(Error);
  });

  it("serializes via toJSON with error/code/status", () => {
    const err = HttpError.conflict("dupe");
    expect(err.toJSON()).toEqual({
      error: "dupe",
      code: "CONFLICT",
      status: 409,
    });
  });

  it("accepts an explicit status + code via the constructor", () => {
    const err = new HttpError("teapot", 418, "IM_A_TEAPOT");
    expect(err.status).toBe(418);
    expect(err.code).toBe("IM_A_TEAPOT");
  });
});
