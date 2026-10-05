import { describe, it, expect, vi } from "vitest";
import { authorizeSharedDriveHits, isSharedDrivePath } from "./shared-drive-access.js";

describe("shared-drive per-file authorization", () => {
  const hit = { path: "/Droplet/report.pdf", source: "nextcloud", externalFileId: 42, snippet: "private" };
  it("requires the current caller's access to the same indexed file", async () => {
    const resolve = vi.fn().mockResolvedValue(42);
    expect(await authorizeSharedDriveHits([hit, hit], resolve)).toEqual([hit, hit]);
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockResolvedValue(null);
    expect(await authorizeSharedDriveHits([hit], resolve)).toEqual([]);
    resolve.mockResolvedValue(43);
    expect(await authorizeSharedDriveHits([hit], resolve)).toEqual([]);
  });
  it("does not reuse permission verdicts for cached results after revocation", async () => {
    const resolve = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(null);
    expect(await authorizeSharedDriveHits([hit], resolve)).toEqual([hit]);
    expect(await authorizeSharedDriveHits([hit], resolve)).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("fails closed on missing identity, exceptions and mismatched mount paths", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await authorizeSharedDriveHits([hit, { ...hit, externalFileId: undefined }, { ...hit, path: "/Personal/a" }], resolve)).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it.each(["/Droplet", "/Droplet/../secret", "/Droplet//file", "/Droplet/a\\b", "/Droplet/./file", "/Droplet/a\u0000"])("rejects noncanonical paths %s", async (path) => {
    expect(isSharedDrivePath(path)).toBe(false);
    const resolve = vi.fn();
    expect(await authorizeSharedDriveHits([{ ...hit, path }], resolve)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("preserves ordinary personal, department and brain results in rank order", async () => {
    const ordinary = [{ path: "/Personal/a" }, { path: "/Department/b" }, { path: "/Droplet/brain", source: "brain" }];
    const resolve = vi.fn().mockResolvedValue(42);
    expect(await authorizeSharedDriveHits([ordinary[0], hit, ordinary[1], ordinary[2]], resolve)).toEqual([ordinary[0], hit, ordinary[1], ordinary[2]]);
  });
  it("bounds concurrent checks without changing output order", async () => {
    let active = 0;
    let max = 0;
    const hits = Array.from({ length: 25 }, (_, i) => ({ ...hit, path: `/Droplet/${i}`, externalFileId: i + 1 }));
    const resolve = async (path: string) => {
      active++;
      max = Math.max(max, active);
      await new Promise((done) => setTimeout(done, 1));
      active--;
      return Number(path.split("/").at(-1)) + 1;
    };
    expect(await authorizeSharedDriveHits(hits, resolve)).toEqual(hits);
    expect(max).toBeLessThanOrEqual(8);
  });
});
