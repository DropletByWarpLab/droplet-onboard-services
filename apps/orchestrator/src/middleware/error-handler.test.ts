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
