/**
 * WARP-899/WARP-900/WARP-901 — the `data` tool domain (encode/decode, hashing,
 * format conversion + misc dev utilities: timestamp_convert / uuid_generate /
 * regex_test) ships in tools-core's catalog, so the dashboard domain map must
 * know it. Without an explicit entry the /tools page would render the domain
 * with the generic fallback icon — the same drift the catalog completeness
 * tests guard against on the tools-core side.
 */
import { describe, it, expect } from "vitest";
import { Braces, Wrench } from "lucide-react";
import { iconForDomain, labelForDomain } from "./tool-domains";

describe("tool-domains — data domain (WARP-899/WARP-900/WARP-901)", () => {
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

describe("tool-domains — team_chat domain (WARP-1685)", () => {
  it("labels the team_chat domain 'Messages' with a dedicated icon", () => {
    expect(labelForDomain("team_chat")).toBe("Messages");
    expect(iconForDomain("team_chat")).not.toBe(Wrench);
  });
});
