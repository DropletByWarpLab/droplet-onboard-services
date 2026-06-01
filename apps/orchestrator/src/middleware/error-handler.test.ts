import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { errorHandler } from "./error-handler.js";
import { HttpError } from "../types/http-error.js";

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const req = {} as Request;
const next = vi.fn() as unknown as NextFunction;

function statusOf(res: Response): number {
  return (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
}
function bodyOf(res: Response): Record<string, unknown> {
  return (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

describe("errorHandler", () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it("honors an explicit `status` on the error (HttpError) → 404", () => {
    const res = mockRes();
    errorHandler(HttpError.notFound("device gone"), req, res, next);
    expect(statusOf(res)).toBe(404);
    expect(bodyOf(res).message).toBe("device gone");
  });

  it("honors `statusCode` (http-errors shape) → 401", () => {
    const res = mockRes();
    const err = Object.assign(new Error("nope"), { statusCode: 401 });
    errorHandler(err, req, res, next);
    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res).message).toBe("nope");
  });

  it("maps a ZodError to 400 with validation details", () => {
    const res = mockRes();
    const schema = z.object({ mac: z.string() });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    errorHandler(parsed.error, req, res, next);
    expect(statusOf(res)).toBe(400);
    expect(bodyOf(res).details).toBeDefined();
  });

  it("maps Prisma P2025 (record not found) to 404", () => {
    const res = mockRes();
    const err = Object.assign(new Error("Record to update not found."), {
      name: "PrismaClientKnownRequestError",
      code: "P2025",
    });
    errorHandler(err, req, res, next);
    expect(statusOf(res)).toBe(404);
  });

  it("maps Prisma P2002 (unique constraint) to 409", () => {
    const res = mockRes();
    const err = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    errorHandler(err, req, res, next);
    expect(statusOf(res)).toBe(409);
  });

  it("redacts a Prisma-derived 4xx message and withholds its code in production", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    const err = Object.assign(
      new Error("Unique constraint failed on the fields: (`nextcloudUsername`)"),
      { name: "PrismaClientKnownRequestError", code: "P2002" }
    );
    errorHandler(err, req, res, next);
    expect(statusOf(res)).toBe(409);
    // The internal Prisma text (model/field/constraint) must not reach the client.
    expect(bodyOf(res).message).toBe("Conflict");
    expect(bodyOf(res).message).not.toContain("nextcloudUsername");
    expect(bodyOf(res).message).not.toContain("constraint");
    // The Prisma code must not be exposed as public API surface.
    expect(bodyOf(res).code).toBeUndefined();
  });

  it("redacts a Prisma-derived 404 message in production", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    const err = Object.assign(
      new Error("An operation failed because it depends on one or more records that were required but not found. Record to update not found."),
      { name: "PrismaClientKnownRequestError", code: "P2025" }
    );
    errorHandler(err, req, res, next);
    expect(statusOf(res)).toBe(404);
    expect(bodyOf(res).message).toBe("Not found");
    expect(bodyOf(res).code).toBeUndefined();
  });

  it("still exposes code for a trusted typed 4xx error", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    errorHandler(HttpError.conflict("group still in use"), req, res, next);
    expect(statusOf(res)).toBe(409);
    expect(bodyOf(res).message).toBe("group still in use");
    expect(bodyOf(res).code).toBe("CONFLICT");
  });

  it("hands off to next() and writes nothing when headers were already sent", () => {
    const res = mockRes();
    (res as unknown as { headersSent: boolean }).headersSent = true;
    const passthrough = vi.fn() as unknown as NextFunction;
    const err = new Error("kaboom");
    errorHandler(err, req, res, passthrough);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(passthrough).toHaveBeenCalledWith(err);
  });

  it("does not throw on a non-Error throw (string) and defaults to 500", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    errorHandler("just a string" as unknown as Error, req, res, next);
    expect(statusOf(res)).toBe(500);
    expect(bodyOf(res).message).toBe("Something went wrong");
  });

  it("does not throw on a null throw and defaults to 500", () => {
    const res = mockRes();
    errorHandler(null as unknown as Error, req, res, next);
    expect(statusOf(res)).toBe(500);
  });

  it("falls back to 500 for an unexpected error", () => {
    const res = mockRes();
    errorHandler(new Error("kaboom"), req, res, next);
    expect(statusOf(res)).toBe(500);
  });

  it("redacts the message for a 500 when NODE_ENV is not development", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    errorHandler(new Error("secret stack detail"), req, res, next);
    expect(statusOf(res)).toBe(500);
    expect(bodyOf(res).message).toBe("Something went wrong");
    expect(bodyOf(res).message).not.toContain("secret");
  });

  it("surfaces the real message for a 500 in development", () => {
    process.env.NODE_ENV = "development";
    const res = mockRes();
    errorHandler(new Error("secret stack detail"), req, res, next);
    expect(statusOf(res)).toBe(500);
    expect(bodyOf(res).message).toBe("secret stack detail");
  });

  it("never redacts a 4xx message, even in production", () => {
    process.env.NODE_ENV = "production";
    const res = mockRes();
    errorHandler(HttpError.badRequest("mac is required"), req, res, next);
    expect(statusOf(res)).toBe(400);
    expect(bodyOf(res).message).toBe("mac is required");
  });
});
