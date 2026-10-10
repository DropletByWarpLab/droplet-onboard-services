/**
 * WARP-2416 - the repicker's own rules: ignore a row that backs nothing, one run at a
 * time per server, an event that lands mid-run is never dropped, and attach / re-pick
 * never overlap. The behaviour through the REAL wiring is in
 * `mcp-client.singleton.catalog-session.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogBackingRow, catalogCredentialKind, createCatalogRepicker, recordCatalog, withServerLock,
} from "./catalog-repick.js";

vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }) }));

const S = "atlassian";
const OWNER_ROW = "11111111-1111-1111-1111-111111111111";
const MEMBER_ROW = "33333333-3333-3333-3333-333333333333";

beforeEach(() => recordCatalog(S, null));

describe("recordCatalog", () => {
  it("remembers the row and kind, and an API token backs no row", () => {
    recordCatalog(S, { rowId: OWNER_ROW, kind: "member" });
    expect(catalogBackingRow(S)).toBe(OWNER_ROW);
    expect(catalogCredentialKind(S)).toBe("member");
    recordCatalog(S, { rowId: null, kind: "api-token" });
    expect(catalogBackingRow(S)).toBeUndefined();
    expect(catalogCredentialKind(S)).toBe("api-token");
    recordCatalog(S, null);
    expect(catalogCredentialKind(S)).toBeUndefined();
  });
});

describe("createCatalogRepicker", () => {
  it("ignores a row that does not back the catalog, runs for the one that does", async () => {
    const apply = vi.fn(async (_s: string) => {});
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, apply });
    recordCatalog(S, { rowId: OWNER_ROW, kind: "member" });
    await changed(S, MEMBER_ROW, "refreshed");
    expect(apply).not.toHaveBeenCalled();
    await changed(S, OWNER_ROW, "refreshed");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does nothing when an API token backs the catalog", async () => {
    const apply = vi.fn(async (_s: string) => {});
    recordCatalog(S, { rowId: null, kind: "api-token" });
    await createCatalogRepicker({ backingRow: catalogBackingRow, apply })(S, OWNER_ROW, "ended");
    expect(apply).not.toHaveBeenCalled();
  });

  it("is single-flight per server, but an event that lands mid-run makes it run once more", async () => {
    const releases: (() => void)[] = [];
    const apply = vi.fn(() => new Promise<void>((r) => { releases.push(r); }));
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, apply });
    recordCatalog(S, { rowId: OWNER_ROW, kind: "member" });
    const first = changed(S, OWNER_ROW, "refreshed");
    const second = changed(S, OWNER_ROW, "ended"); // lands mid-run
    const third = changed(S, OWNER_ROW, "ended"); // coalesces with the second
    expect(apply).toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    releases[1]!();
    await Promise.all([first, second, third]);
    expect(apply).toHaveBeenCalledTimes(2); // not three
  });

  it("a failed run is contained and the next event runs again", async () => {
    const apply = vi.fn(async (_s: string) => { throw new Error("x"); });
    const changed = createCatalogRepicker({ backingRow: catalogBackingRow, apply });
    recordCatalog(S, { rowId: OWNER_ROW, kind: "member" });
    await expect(changed(S, OWNER_ROW, "ended")).resolves.toBeUndefined();
    await changed(S, OWNER_ROW, "ended");
    expect(apply).toHaveBeenCalledTimes(2);
  });
});

describe("withServerLock", () => {
  it("runs jobs for one server strictly in order, and different servers independently", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const a = withServerLock("s1", async () => { order.push("a-start"); await new Promise<void>((r) => { releaseA = r; }); order.push("a-end"); });
    const b = withServerLock("s1", async () => { order.push("b"); });
    const other = withServerLock("s2", async () => { order.push("other"); });
    await other;
    expect(order).toEqual(["a-start", "other"]); // b waits for a
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "other", "a-end", "b"]);
  });

  it("a job that throws does not block the next one", async () => {
    await expect(withServerLock("s3", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withServerLock("s3", async () => "ok")).resolves.toBe("ok");
  });
});
