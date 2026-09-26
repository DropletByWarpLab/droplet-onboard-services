import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "./prisma-errors.js";

describe("isUniqueViolation (WARP-3193 ARCH-9)", () => {
  it("is true only for an object carrying code P2002", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "P2002" }))).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("P2002"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
  });
});
