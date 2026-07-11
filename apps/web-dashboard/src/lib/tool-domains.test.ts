/**
 * WARP-899/WARP-900 — the `data` tool domain (encode/decode, hashing,
 * format conversion) ships in tools-core's catalog, so the dashboard
 * domain map must know it. Without an explicit entry the /tools page would
 * render the domain with the generic fallback icon.
 */
import { describe, it, expect } from "vitest";
import { Braces, Wrench } from "lucide-react";
import { iconForDomain, labelForDomain } from "./tool-domains";

describe("tool-domains — data domain (WARP-899/WARP-900)", () => {
  it("labels the data domain 'Data'", () => {
    expect(labelForDomain("data")).toBe("Data");
  });

  it("gives the data domain a dedicated icon, not the generic fallback", () => {
    expect(iconForDomain("data")).toBe(Braces);
    expect(iconForDomain("data")).not.toBe(Wrench);
  });

  it("still falls back gracefully for a truly unknown domain", () => {
    expect(labelForDomain("never-heard-of-it")).toBe("Never heard of it");
    expect(iconForDomain("never-heard-of-it")).toBe(Wrench);
  });
});
