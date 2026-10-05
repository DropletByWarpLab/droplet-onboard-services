/**
 * WARP-3510 — adopting a camera: the operator's side of "which row is the real
 * camera".
 *
 * POST /api/cameras upserted by NAME alone. It never looked for the discovery
 * placeholder camera-discovery had already filed for the same device, so every
 * manual add of a discovered camera minted a second row — and the next
 * discovery merge, which kept the OLDEST row, kept the placeholder and deleted
 * the operator's live one.
 *
 * `adoptCameraRow` is the explicit transition: it finds the row for the device
 * (by name, MAC, then IP), takes the oldest discovery placeholder in place
 * instead of minting a duplicate, and leaves the row ADOPTED under the Frigate
 * key. The Camera table here is an in-memory fake that EVALUATES where-clauses,
 * so a dropped predicate changes what these tests see.
 */
import { describe, it, expect } from "vitest";

import {
  adoptCameraRow,
  isPlaceholderName,
  rankForSurvival,
  readCameraKeySnapshot,
  realMac,
  sameDeviceRows,
} from "./camera-adoption.service.js";
import { makeFakeTable } from "../__tests__/helpers/fake-table.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

type Row = Record<string, unknown>;

function makeDb() {
  const table = makeFakeTable(() => ({
    displayName: "",
    manufacturer: null,
    model: null,
    ipAddress: "",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    adoption: "CANDIDATE",
    lastSeen: new Date("2026-08-10T00:00:00Z"),
  }));
  const prisma: Record<string, unknown> = { camera: table.delegate };
  const seam = createTransactionSeam({ client: () => prisma, stores: { cameras: table.rows } });
  prisma.$transaction = seam.$transaction;
  return { table, prisma: prisma as never };
}

const rowsOf = (t: ReturnType<typeof makeDb>["table"]) => t.rows as Row[];
const day = (d: number) => new Date(`2026-08-${String(d).padStart(2, "0")}T00:00:00Z`);

/** A placeholder camera-discovery filed for the Hanwha at .219. */
const placeholder = (over: Row = {}): Row => ({
  name: "camera_192_168_9_219",
  displayName: "Camera 192 168 9 219",
  ipAddress: "192.168.9.219",
  macAddress: "e4:30:22:50:2a:fd",
  enabled: false,
  autoDiscovered: true,
  adoption: "CANDIDATE",
  createdAt: day(10),
  ...over,
});

const ADD = {
  key: "warp_lab_office",
  displayName: "Warp Lab Office",
  ipAddress: "192.168.9.219",
};

describe("adoptCameraRow", () => {
  it("creates an ADOPTED, enabled, manually-added row when the device is unknown", async () => {
    const { table, prisma } = makeDb();

    const res = await adoptCameraRow(prisma, { ...ADD, manufacturer: "Hanwha", model: "XNV-C8083R" });

    expect(res).toMatchObject({ created: true, absorbed: [] });
    expect(rowsOf(table)).toHaveLength(1);
    expect(rowsOf(table)[0]).toMatchObject({
      name: "warp_lab_office",
      displayName: "Warp Lab Office",
      ipAddress: "192.168.9.219",
      manufacturer: "Hanwha",
      model: "XNV-C8083R",
      enabled: true,
      autoDiscovered: false,
      adoption: "ADOPTED",
    });
  });

  it("stores a real MAC lower-cased, and no MAC for a synthetic sweep key", async () => {
    const withMac = makeDb();
    await adoptCameraRow(withMac.prisma, { ...ADD, macAddress: "E4:30:22:50:2A:FD" });
    expect(rowsOf(withMac.table)[0].macAddress).toBe("e4:30:22:50:2a:fd");

    const synthetic = makeDb();
    await adoptCameraRow(synthetic.prisma, { ...ADD, macAddress: "ip:192.168.9.219" });
    expect(rowsOf(synthetic.table)[0].macAddress).toBeNull();
  });

  it("re-adding under the same name updates that row in place, new address included", async () => {
    const { table, prisma } = makeDb();
    table.seed({
      name: "warp_lab_office",
      displayName: "Office",
      ipAddress: "192.168.9.50",
      adoption: "ADOPTED",
      createdAt: day(10),
    });

    const res = await adoptCameraRow(prisma, ADD);

    expect(res.created).toBe(false);
    expect(rowsOf(table)).toHaveLength(1);
    expect(rowsOf(table)[0]).toMatchObject({
      name: "warp_lab_office",
      displayName: "Warp Lab Office",
      ipAddress: "192.168.9.219",
      adoption: "ADOPTED",
      enabled: true,
    });
  });

  it("takes the discovery placeholder for the device IN PLACE — no duplicate row", async () => {
    // The WARP-3510 sequence: discovery filed R1 (never adopted) for the
    // device, then the operator added it by hand under another name.
    const { table, prisma } = makeDb();
    const r1 = table.seed(placeholder());

    const res = await adoptCameraRow(prisma, ADD);

    expect(res).toMatchObject({ created: false, id: r1.id, absorbed: [] });
    expect(rowsOf(table)).toHaveLength(1);
    expect(rowsOf(table)[0]).toMatchObject({
      id: r1.id,
      name: "warp_lab_office",
      displayName: "Warp Lab Office",
      adoption: "ADOPTED",
      enabled: true,
      // Keeps what discovery learned and the operator did not type.
      macAddress: "e4:30:22:50:2a:fd",
      autoDiscovered: true,
    });
  });

  it("matches the placeholder by the MAC the request carries when the address differs", async () => {
    const { table, prisma } = makeDb();
    const r1 = table.seed(placeholder({ ipAddress: "192.168.9.99" }));

    await adoptCameraRow(prisma, { ...ADD, macAddress: "E4:30:22:50:2A:FD" });

    expect(rowsOf(table)).toHaveLength(1);
    expect(rowsOf(table)[0]).toMatchObject({ id: r1.id, name: "warp_lab_office", ipAddress: "192.168.9.219" });
  });

  it("folds extra placeholders for the same device into the one it adopts", async () => {
    const { table, prisma } = makeDb();
    const oldest = table.seed(placeholder({ createdAt: day(10) }));
    table.seed(placeholder({ name: "xnv_c8083r", createdAt: day(11) }));

    const res = await adoptCameraRow(prisma, ADD);

    expect(res.id).toBe(oldest.id);
    expect(res.absorbed).toEqual(["xnv_c8083r"]);
    expect(rowsOf(table).map((r) => r.name)).toEqual(["warp_lab_office"]);
  });

  it("never touches an ADOPTED row of the same device — a second camera is a second stream", async () => {
    const { table, prisma } = makeDb();
    const main = table.seed(placeholder({ name: "office_main", adoption: "ADOPTED", enabled: true }));

    const res = await adoptCameraRow(prisma, { ...ADD, key: "office_sub" });

    expect(res.created).toBe(true);
    expect(res.id).not.toBe(main.id);
    expect(rowsOf(table).map((r) => [r.name, r.adoption]).sort()).toEqual([
      ["office_main", "ADOPTED"],
      ["office_sub", "ADOPTED"],
    ]);
  });

  it("leaves a different device that happens to hold the same address alone (DHCP recycles addresses)", async () => {
    const { table, prisma } = makeDb();
    const other = table.seed(placeholder({ macAddress: "aa:bb:cc:dd:ee:ff" }));

    const res = await adoptCameraRow(prisma, { ...ADD, macAddress: "E4:30:22:50:2A:FD" });

    expect(res.created).toBe(true);
    expect(rowsOf(table)).toHaveLength(2);
    expect(rowsOf(table).find((r) => r.id === other.id)).toMatchObject({
      name: "camera_192_168_9_219",
      adoption: "CANDIDATE",
    });
  });

  it("never deletes a row that was adopted after the placeholder list was read", async () => {
    // The status check is in the DELETE itself, not in the code that read the
    // row: another request adopted it between the read and the delete.
    const { table, prisma } = makeDb();
    table.seed(placeholder({ createdAt: day(10) }));
    const racing = table.seed(placeholder({ name: "xnv_c8083r", createdAt: day(11) }));
    const realFindMany = table.delegate.findMany.getMockImplementation()!;
    table.delegate.findMany.mockImplementationOnce(async (args) => {
      const stale = await realFindMany(args);
      // Mutate AFTER the read: now ADOPTED in the table, still CANDIDATE in the list we hold.
      (racing as Row).adoption = "ADOPTED";
      return stale;
    });

    await adoptCameraRow(prisma, ADD);

    expect(rowsOf(table).find((r) => r.id === racing.id)).toMatchObject({ name: "xnv_c8083r", adoption: "ADOPTED" });
  });

  it("retries once when another writer created the row between its read and its insert", async () => {
    // Discovery's own upsert of the same camera lands within milliseconds of an
    // accept. The loser used to fail the whole request — after the camera was
    // already in Frigate.
    const { table, prisma } = makeDb();
    const theirs = table.seed(placeholder({ name: "warp_lab_office", ipAddress: "192.168.9.219" }));
    table.delegate.findMany.mockResolvedValueOnce([]); // the first read predates their commit
    table.delegate.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));

    const res = await adoptCameraRow(prisma, ADD);

    expect(res).toMatchObject({ id: theirs.id, created: false });
    expect(rowsOf(table)).toHaveLength(1);
    expect(rowsOf(table)[0]).toMatchObject({ name: "warp_lab_office", adoption: "ADOPTED", enabled: true });
  });

  it("does not swallow any other failure", async () => {
    const { table, prisma } = makeDb();
    table.delegate.create.mockRejectedValueOnce(new Error("connection reset"));

    await expect(adoptCameraRow(prisma, ADD)).rejects.toThrow("connection reset");
    expect(table.delegate.create).toHaveBeenCalledTimes(1);
  });

  it("is atomic: a failed write leaves the placeholders it was about to fold in", async () => {
    const { table, prisma } = makeDb();
    table.seed(placeholder({ createdAt: day(10) }));
    table.seed(placeholder({ name: "xnv_c8083r", createdAt: day(11) }));
    table.delegate.update.mockRejectedValueOnce(new Error("connection reset"));

    await expect(adoptCameraRow(prisma, ADD)).rejects.toThrow("connection reset");

    expect(rowsOf(table).map((r) => r.name).sort()).toEqual(["camera_192_168_9_219", "xnv_c8083r"]);
  });
});

describe("readCameraKeySnapshot", () => {
  it("names every row and says which ones are ADOPTED", async () => {
    const { table, prisma } = makeDb();
    table.seed({ name: "front_door", adoption: "ADOPTED" });
    table.seed({ name: "camera_192_168_9_5", adoption: "CANDIDATE" });

    expect(await readCameraKeySnapshot(prisma)).toEqual({
      names: ["front_door", "camera_192_168_9_5"],
      adopted: ["front_door"],
    });
  });
});

describe("device matching helpers", () => {
  it("realMac drops synthetic sweep keys and lower-cases the rest", () => {
    expect(realMac("E4:30:22:50:2A:FD")).toBe("e4:30:22:50:2a:fd");
    expect(realMac("ip:192.168.9.219")).toBeNull();
    expect(realMac("onvif_192.168.9.219")).toBeNull();
    expect(realMac("")).toBeNull();
    expect(realMac(undefined)).toBeNull();
  });

  it("isPlaceholderName recognises discovery's camera_<ip> fallback and nothing else", () => {
    expect(isPlaceholderName("camera_192_168_9_219")).toBe(true);
    expect(isPlaceholderName("xnv_c8083r")).toBe(false);
    expect(isPlaceholderName("camera_front")).toBe(false);
  });

  it("sameDeviceRows: a shared IP is not proof when both sides carry different real MACs", () => {
    const rows = [
      { name: "a", macAddress: "aa:aa:aa:aa:aa:aa" },
      { name: "b", macAddress: null },
      { name: "c", macAddress: "bb:bb:bb:bb:bb:bb" },
    ];
    expect(sameDeviceRows(rows, "x", "bb:bb:bb:bb:bb:bb").map((r) => r.name)).toEqual(["b", "c"]);
    // A row that already owns the name is always the same device.
    expect(sameDeviceRows(rows, "a", "bb:bb:bb:bb:bb:bb").map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("rankForSurvival puts ADOPTED rows first, then the oldest", () => {
    const rows = [
      { id: "old-candidate", adoption: "CANDIDATE" as const, createdAt: day(1) },
      { id: "new-adopted", adoption: "ADOPTED" as const, createdAt: day(5) },
      { id: "older-adopted", adoption: "ADOPTED" as const, createdAt: day(3) },
      { id: "new-candidate", adoption: "CANDIDATE" as const, createdAt: day(4) },
    ];
    expect(rankForSurvival(rows).map((r) => r.id)).toEqual([
      "older-adopted",
      "new-adopted",
      "old-candidate",
      "new-candidate",
    ]);
  });
});
