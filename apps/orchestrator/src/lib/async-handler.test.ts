import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "./async-handler.js";

describe("asyncHandler (WARP-3193 QUAL-8)", () => {
  const req = {} as Request;
  const res = {} as Response;

  it("forwards a rejected handler's error to next()", async () => {
    const err = new Error("boom");
    const next = vi.fn() as unknown as NextFunction;
    await asyncHandler(async () => {
      throw err;
    })(req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("does not call next() when the handler resolves", async () => {
    const next = vi.fn() as unknown as NextFunction;
    await asyncHandler(async () => undefined)(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });
});
