/**
 * WARP-456 — GET /api/activity + POST /api/activity/export.
 *
 * Both routes are owner/admin-only. The list route paginates and
 * filters; the export route streams a sealed JSON-Lines bundle that
 * an offline verifier can replay the chain through.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createActivityRouter } from "../routes/activity.js";
import {
  createHmacSigner,
  _setDefaultSignerForTests,
} from "../services/audit-signing.service.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";

interface FakeRow {
  id: bigint;
  at: Date;
  severity: "ok" | "warn" | "err" | "info";
  sourceIcon: string;
  what: string;
  sub: string | null;
  kind: string;
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
}

function makeRow(over: Partial<FakeRow>, id: number): FakeRow {
  return {
    id: BigInt(id),
    at: new Date(`2026-05-25T${10 + id}:00:00.000Z`),
    severity: "info",
    sourceIcon: "info",
    what: "event",
    sub: null,
    kind: "system",
    refs: null,
    signature: `sig-${id}`,
    prevSignatureHash: id === 1 ? "" : `hash-${id - 1}`,
    ...over,
  };
}

const KEY = Buffer.from("warp-456-test-key-bytes-must-be-long", "utf8");

function makeApp(rows: FakeRow[]) {
  const prisma = {
    activityRow: {
      async findMany({ where, orderBy, take }: any) {
        let filtered = [...rows];
        if (where?.kind) {
          filtered = filtered.filter((r) => r.kind === where.kind);
        }
        if (where?.at) {
          if (where.at.gte) {
            filtered = filtered.filter((r) => r.at >= where.at.gte);
          }
          if (where.at.lt) {
            filtered = filtered.filter((r) => r.at < where.at.lt);
          }
        }
        if (where?.OR) {
          // q-substring filter — both clauses share the same substring
          const needle = (where.OR[0].what?.contains ?? "").toLowerCase();
          filtered = filtered.filter(
            (r) =>
              r.what.toLowerCase().includes(needle) ||
              (r.sub?.toLowerCase().includes(needle) ?? false),
          );
        }
        if (where?.id?.lt) {
          filtered = filtered.filter((r) => r.id < where.id.lt);
        }
        if (where?.id?.gt) {
          filtered = filtered.filter((r) => r.id > where.id.gt);
        }
        if (orderBy?.id === "desc") {
          filtered.sort((a, b) => (b.id > a.id ? 1 : -1));
        } else if (orderBy?.id === "asc") {
          filtered.sort((a, b) => (a.id > b.id ? 1 : -1));
        }
        return take ? filtered.slice(0, take) : filtered;
      },
    },
  };

  const app = express();
  app.use(express.json());
  // Stub auth middleware: every request is owner.
  app.use((req, _res, next) => {
    (req as any).user = { id: "alice", role: "owner", username: "alice" };
    next();
  });
  app.use("/api", createActivityRouter(prisma as never));
  return app;
}

describe("GET /api/activity", () => {
  beforeEach(() => {
    const signer = createHmacSigner(KEY);
    _setDefaultSignerForTests(signer);
    _setActivityRecorderForTests(null, signer);
  });

  it("returns rows in descending id order", async () => {
    const rows = [makeRow({}, 1), makeRow({}, 2), makeRow({}, 3)];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0].id).toBe("3");
    expect(res.body.items[2].id).toBe("1");
  });

  it("filters by kind", async () => {
    const rows = [
      makeRow({ kind: "chat" }, 1),
      makeRow({ kind: "file" }, 2),
      makeRow({ kind: "chat" }, 3),
    ];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity?kind=chat");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((r: any) => r.kind === "chat")).toBe(true);
  });

  it("filters by [from, to)", async () => {
    const rows = [
      makeRow({ at: new Date("2026-05-25T11:00:00Z") }, 1),
      makeRow({ at: new Date("2026-05-25T12:00:00Z") }, 2),
      makeRow({ at: new Date("2026-05-25T13:00:00Z") }, 3),
    ];
    const app = makeApp(rows);
    const res = await request(app).get(
      "/api/activity?from=2026-05-25T11:30:00Z&to=2026-05-25T12:30:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("2");
  });

  it("substring search on what / sub via q", async () => {
    const rows = [
      makeRow({ what: "Alice signed in", sub: "from 10.0.0.1" }, 1),
      makeRow({ what: "Tool list_files", sub: "for bob" }, 2),
    ];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity?q=ALICE");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("1");
  });

  it("paginates with cursor + limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({}, i + 1));
    const app = makeApp(rows);
    const page1 = await request(app).get("/api/activity?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBe("4"); // tail of desc page
    const page2 = await request(app).get(
      `/api/activity?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items.map((r: any) => r.id)).toEqual(["3", "2"]);
  });

  it("returns 400 on invalid kind", async () => {
    const app = makeApp([]);
    const res = await request(app).get("/api/activity?kind=bogus");
    expect(res.status).toBe(400);
  });

  it("serializes BigInt id as string", async () => {
    const app = makeApp([makeRow({}, 1)]);
    const res = await request(app).get("/api/activity");
    expect(typeof res.body.items[0].id).toBe("string");
    expect(res.body.items[0].id).toBe("1");
  });
});

describe("POST /api/activity/export", () => {
  beforeEach(() => {
    const signer = createHmacSigner(KEY);
    _setDefaultSignerForTests(signer);
    _setActivityRecorderForTests(null, signer);
  });

  it("returns a JSON-Lines body with manifest + rows in ascending id order", async () => {
    const rows = [makeRow({}, 1), makeRow({}, 2), makeRow({}, 3)];
    const app = makeApp(rows);
    const res = await request(app).post("/api/activity/export").send({});
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4); // manifest + 3 rows
    expect(lines[0].type).toBe("droplet.activity-bundle.v1");
    expect(lines[0].algorithm).toBe("HMAC-SHA256");
    expect(lines[0].publicKey).not.toBeNull();
    expect(lines[1].id).toBe("1");
    expect(lines[2].id).toBe("2");
    expect(lines[3].id).toBe("3");
  });

  it("respects the filter shape in the request body", async () => {
    const rows = [
      makeRow({ kind: "chat" }, 1),
      makeRow({ kind: "auth" }, 2),
    ];
    const app = makeApp(rows);
    const res = await request(app)
      .post("/api/activity/export")
      .send({ kind: "auth" });
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2); // manifest + 1 row
    expect(lines[1].kind).toBe("auth");
  });

  it("returns 400 on an invalid filter", async () => {
    const app = makeApp([]);
    const res = await request(app)
      .post("/api/activity/export")
      .send({ kind: "totally-made-up" });
    expect(res.status).toBe(400);
  });

  it("ships the signer's public bytes so an offline verifier can replay", async () => {
    const signer = createHmacSigner(KEY);
    _setActivityRecorderForTests(null, signer);
    const app = makeApp([makeRow({}, 1)]);
    const res = await request(app).post("/api/activity/export").send({});
    const manifest = JSON.parse(res.text.trim().split("\n")[0]!);
    const publicKey = Buffer.from(manifest.publicKey, "base64");
    // The HMAC implementation returns the raw key bytes.
    expect(publicKey.toString("utf8")).toBe(
      "warp-456-test-key-bytes-must-be-long",
    );
  });
});
