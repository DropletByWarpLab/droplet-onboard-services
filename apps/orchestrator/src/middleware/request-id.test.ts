import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestIdMiddleware } from "./request-id.js";
import { getRequestId } from "../lib/request-context.js";

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers, header: (h: string) => headers[h.toLowerCase()] } as unknown as Request;
}
function mockRes(): Response & { _headers: Record<string, string> } {
  const _headers: Record<string, string> = {};
  return { setHeader: (k: string, v: string) => { _headers[k.toLowerCase()] = v; }, _headers } as any;
}

describe("requestIdMiddleware", () => {
  it("adopts a valid inbound x-request-id and echoes it", () => {
    const req = mockReq({ "x-request-id": "valid_id_123" });
    const res = mockRes();
    let seen: string | undefined;
    requestIdMiddleware(req, res, (() => { seen = getRequestId(); }) as NextFunction);
    expect(seen).toBe("valid_id_123");
    expect((req as any).requestId).toBe("valid_id_123");
    expect(res._headers["x-request-id"]).toBe("valid_id_123");
  });

  it("generates a fresh id when the header is missing", () => {
    const req = mockReq();
    const res = mockRes();
    let seen: string | undefined;
    requestIdMiddleware(req, res, (() => { seen = getRequestId(); }) as NextFunction);
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(res._headers["x-request-id"]).toBe(seen);
  });

  it("regenerates when the inbound id is invalid", () => {
    const req = mockReq({ "x-request-id": "bad id!" });
    const res = mockRes();
    let seen: string | undefined;
    requestIdMiddleware(req, res, (() => { seen = getRequestId(); }) as NextFunction);
    expect(seen).not.toBe("bad id!");
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });
});
