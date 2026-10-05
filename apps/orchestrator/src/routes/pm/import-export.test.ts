/**
 * WARP-3527 — route tests for project import and export.
 *
 * The real `requireRole` guard runs (the stub auth only sets `req.user`), the
 * real multer limits run, and the import/export SERVICES are mocked: what is
 * under test here is who may do what, what is refused at the boundary, and
 * what the HTTP surface says. The services have their own suites (unit +
 * `pm-import-export.pg.test.ts` against a real database).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import http from "node:http";
import type { AddressInfo } from "node:net";

const svc = vi.hoisted(() => ({
  createImportJob: vi.fn(),
  getImportJob: vi.fn(),
  listImportJobs: vi.fn(),
  updateImportJob: vi.fn(),
  startImportJob: vi.fn(),
  cancelImportJob: vi.fn(),
  exportCsvChunks: vi.fn(),
  exportJsonChunks: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock("../../services/pm/pm-import.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/pm/pm-import.service.js")>(
    "../../services/pm/pm-import.service.js",
  );
  return {
    ...actual,
    createImportJob: svc.createImportJob,
    getImportJob: svc.getImportJob,
    listImportJobs: svc.listImportJobs,
    updateImportJob: svc.updateImportJob,
    startImportJob: svc.startImportJob,
    cancelImportJob: svc.cancelImportJob,
  };
});
vi.mock("../../services/pm/pm-export.service.js", () => ({
  exportCsvChunks: svc.exportCsvChunks,
  exportJsonChunks: svc.exportJsonChunks,
}));
vi.mock("../../services/pm/pm.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/pm/pm.service.js")>("../../services/pm/pm.service.js");
  return { ...actual, getProject: svc.getProject };
});
vi.mock("../../services/pm/pm-department.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/pm/pm-department.js")>("../../services/pm/pm-department.js");
  return {
    ...actual,
    resolveDepartmentFilter: vi.fn(async (_p: unknown, v: string | undefined) => (v === undefined ? undefined : v)),
  };
});

import { InvalidImportMappingError, PM_IMPORT_ERRORS } from "../../services/pm/pm-import.service.js";
import { ImportParseError } from "../../services/pm/import/csv.js";
import { createPmImportExportRouter } from "./import-export.js";

const OWNER = "u-owner";
const LEAD = "u-lead";
let leadId: string | null = LEAD;
let projectExists = true;

const prisma = {
  pmProject: {
    findUnique: vi.fn(async () => (projectExists ? { leadId } : null)),
  },
};

let user: AuthUser | undefined;
function app() {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = user;
    next();
  });
  a.use("/api", createPmImportExportRouter(prisma as never));
  a.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "error" });
  });
  return a;
}
const as = (id: string, role: string) => {
  user = { id, username: id, role } as AuthUser;
};

const JOB = { id: "job-1", projectId: "p1", status: "PREVIEWED" };
const CSV_BYTES = Buffer.from("Title\nA\n");

beforeEach(() => {
  vi.clearAllMocks();
  leadId = LEAD;
  projectExists = true;
  user = undefined;
  svc.createImportJob.mockResolvedValue({ job: JOB, analysis: { totalRows: 1 } });
  svc.getImportJob.mockResolvedValue(JOB);
  svc.listImportJobs.mockResolvedValue([JOB]);
  svc.updateImportJob.mockResolvedValue({ job: JOB, analysis: { totalRows: 1 } });
  svc.startImportJob.mockResolvedValue({ ...JOB, status: "PENDING" });
  svc.cancelImportJob.mockResolvedValue({ ...JOB, status: "CANCELLED" });
  svc.getProject.mockImplementation(async () => {
    if (!projectExists) throw new Error("project_not_found");
    return { id: "p1", identifier: "INBOX", leadId };
  });
  svc.exportCsvChunks.mockImplementation(async function* () {
    yield "key,title\r\n";
    yield "INBOX-1,One\r\n";
  });
  svc.exportJsonChunks.mockImplementation(async function* () {
    yield '{"items":[';
    yield "]}";
  });
});

const upload = (over: { name?: string; body?: Buffer; fields?: Record<string, string> } = {}) => {
  let r = request(app()).post("/api/pm/projects/p1/import");
  for (const [k, v] of Object.entries(over.fields ?? {})) r = r.field(k, v);
  return r.attach("file", over.body ?? CSV_BYTES, { filename: over.name ?? "export.csv", contentType: "text/csv" });
};

describe("who may import", () => {
  it("an owner cannot import into a Service Desk, and the guard runs before multipart parsing", async () => {
    as(OWNER, "owner");
    svc.getProject.mockRejectedValue(new Error("project_not_found"));
    const res = await request(app()).post("/api/pm/projects/p1/import")
      .set("Content-Type", "multipart/form-data").send("missing boundary");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "project_not_found" });
    expect(svc.createImportJob).not.toHaveBeenCalled();
  });
  it.each([
    ["owner", OWNER, "owner"],
    ["admin", "u-admin", "admin"],
    ["the project's lead", LEAD, "family"],
  ])("%s may upload", async (_label, id, role) => {
    as(id, role);
    const res = await upload();
    expect(res.status).toBe(201);
    expect(svc.createImportJob).toHaveBeenCalledWith(prisma, id, "p1", expect.objectContaining({ fileName: "export.csv" }));
  });

  it.each([
    ["a family member who is not the lead", "u-other", "family"],
    ["a guest", "u-guest", "guest"],
    ["a service principal", "_service:mcp", "service"],
  ])("%s may not", async (_label, id, role) => {
    as(id, role);
    const res = await upload();
    expect(res.status).toBe(403);
    expect(svc.createImportJob).not.toHaveBeenCalled();
  });

  it("a project with no lead is importable only by owner/admin", async () => {
    leadId = null;
    as("u-other", "family");
    expect((await upload()).status).toBe(403);
    as(OWNER, "owner");
    expect((await upload()).status).toBe(201);
  });

  it("no session at all is refused", async () => {
    expect((await upload()).status).toBe(403);
  });

  it("is decided BEFORE the body is read: a non-lead with no file is a 403, not a 400", async () => {
    as("u-other", "family");
    const res = await request(app()).post("/api/pm/projects/p1/import");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("import_forbidden");
  });

  it("an unknown project is a 404, not a 403", async () => {
    projectExists = false;
    as(OWNER, "owner");
    const res = await upload();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("project_not_found");
  });

  it("every job route checks the caller against the JOB's project", async () => {
    as("u-other", "family"); // not the lead of p1
    const calls = [
      request(app()).get("/api/pm/import-jobs/job-1"),
      request(app()).patch("/api/pm/import-jobs/job-1").send({ source: "CSV" }),
      request(app()).post("/api/pm/import-jobs/job-1/run").send({}),
      request(app()).post("/api/pm/import-jobs/job-1/cancel").send({}),
      request(app()).get("/api/pm/projects/p1/import-jobs"),
    ];
    for (const r of calls) expect((await r).status).toBe(403);
    expect(svc.updateImportJob).not.toHaveBeenCalled();
    expect(svc.startImportJob).not.toHaveBeenCalled();
    expect(svc.cancelImportJob).not.toHaveBeenCalled();
  });
});

describe("the upload boundary", () => {
  beforeEach(() => as(OWNER, "owner"));

  it("refuses a request with no file", async () => {
    const res = await request(app()).post("/api/pm/projects/p1/import").field("source", "CSV");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_file");
  });

  it("cuts a file over 10 MB off at the limit with a 413 that says the limit", async () => {
    const res = await upload({ body: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "file_too_large", maxBytes: 10 * 1024 * 1024 });
    expect(svc.createImportJob).not.toHaveBeenCalled();
  });

  it("accepts a file of exactly 10 MB", async () => {
    const res = await upload({ body: Buffer.alloc(10 * 1024 * 1024, 0x61) });
    expect(res.status).toBe(201);
  });

  it("refuses a second file, an unknown source, and passes a real source through", async () => {
    const two = await request(app())
      .post("/api/pm/projects/p1/import")
      .attach("file", CSV_BYTES, "a.csv")
      .attach("file", CSV_BYTES, "b.csv");
    expect(two.status).toBe(400);
    expect(two.body.error).toBe("invalid_upload");

    expect((await upload({ fields: { source: "EXCEL" } })).status).toBe(400);
    expect((await upload({ fields: { source: "JIRA_CSV" } })).status).toBe(201);
    expect(svc.createImportJob).toHaveBeenLastCalledWith(prisma, OWNER, "p1", expect.objectContaining({ source: "JIRA_CSV" }));
  });

  it("answers a file we cannot read with 422, the code and a plain sentence", async () => {
    svc.createImportJob.mockRejectedValue(new ImportParseError("too_many_rows", "This file has more than 20,000 rows.", { max: 20000 }));
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "too_many_rows", message: expect.stringContaining("20,000"), max: 20000 });
  });
});

describe("the job routes", () => {
  beforeEach(() => as(OWNER, "owner"));

  it("GET returns the job (progress is polled from here)", async () => {
    const res = await request(app()).get("/api/pm/import-jobs/job-1");
    expect(res.status).toBe(200);
    expect(res.body.job).toEqual(JOB);
  });

  it("PATCH takes a source and/or a mapping, strictly", async () => {
    const mapping = { columns: { name: ["Title"] }, dateOrder: "DMY", statuses: { done: { kind: "state", stateId: "s1" } }, people: { x: null } };
    expect((await request(app()).patch("/api/pm/import-jobs/job-1").send({ source: "ASANA_CSV", mapping })).status).toBe(200);
    expect(svc.updateImportJob).toHaveBeenLastCalledWith(prisma, "job-1", expect.objectContaining({ source: "ASANA_CSV" }));
    for (const bad of [
      {},
      { source: "EXCEL" },
      { mapping: { columns: { bogusField: ["x"] } } },
      { mapping: { dateOrder: "YYYY" } },
      { mapping: { statuses: { done: { kind: "create", name: "", group: "started" } } } },
      { mapping: { statuses: { done: { kind: "create", name: "x", group: "sideways" } } } },
      { mapping: { priorities: { low: "huge" } } },
      { mapping: { listSeparator: ",," } },
      { mapping: { surprise: true } },
      { surprise: true },
    ]) {
      const res = await request(app()).patch("/api/pm/import-jobs/job-1").send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
  });

  it("PATCH bounds the size of a mapping", async () => {
    const huge = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`s${i}`, { kind: "default" }]));
    const res = await request(app()).patch("/api/pm/import-jobs/job-1").send({ mapping: { statuses: huge } });
    expect(res.status).toBe(400);
  });

  it("run is 202 Accepted: it returns the PENDING job and does not wait for the import", async () => {
    const res = await request(app()).post("/api/pm/import-jobs/job-1/run").send({ mapping: { createMissingStates: false } });
    expect(res.status).toBe(202);
    expect(res.body.job.status).toBe("PENDING");
    expect(svc.startImportJob).toHaveBeenCalledWith(prisma, "job-1", { mapping: { createMissingStates: false } });
  });

  it("passes the reviewed timestamp to the guarded run and refuses malformed preconditions", async () => {
    const expectedUpdatedAt = "2026-10-05T20:00:00.123Z";
    const res = await request(app()).post("/api/pm/import-jobs/job-1/run").send({ expectedUpdatedAt });
    expect(res.status).toBe(202);
    expect(svc.startImportJob).toHaveBeenLastCalledWith(prisma, "job-1", { mapping: undefined, expectedUpdatedAt });
    svc.startImportJob.mockClear();
    for (const bad of [null, 42, "yesterday", "2026-10-05", "2026-10-05T20:00:00+02:00"]) {
      const rejected = await request(app()).post("/api/pm/import-jobs/job-1/run").send({ expectedUpdatedAt: bad });
      expect(rejected.status).toBe(400);
    }
    expect(svc.startImportJob).not.toHaveBeenCalled();
  });

  it("cancel returns the cancelled job", async () => {
    const res = await request(app()).post("/api/pm/import-jobs/job-1/cancel").send({});
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe("CANCELLED");
  });

  it("lists a project's recent jobs", async () => {
    const res = await request(app()).get("/api/pm/projects/p1/import-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([JOB]);
  });

  it.each([
    [PM_IMPORT_ERRORS.JOB_NOT_FOUND, 404],
    [PM_IMPORT_ERRORS.NOT_EDITABLE, 409],
    [PM_IMPORT_ERRORS.NOT_STARTABLE, 409],
    [PM_IMPORT_ERRORS.CHANGED, 409],
    [PM_IMPORT_ERRORS.IN_PROGRESS, 409],
    [PM_IMPORT_ERRORS.NOT_CANCELLABLE, 409],
    [PM_IMPORT_ERRORS.FILE_EXPIRED, 410],
  ])("maps %s to %i, with a sentence for the person", async (code, status) => {
    svc.startImportJob.mockRejectedValue(new Error(code));
    const res = await request(app()).post("/api/pm/import-jobs/job-1/run").send({});
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    if (status !== 404) expect(typeof res.body.message).toBe("string");
  });

  it("an unreadable file on a source change, and a mapping that names nothing real, are 422s", async () => {
    svc.updateImportJob.mockRejectedValueOnce(new ImportParseError("wrong_format", "Trello JSON needs the board's JSON export, but this file is CSV."));
    let res = await request(app()).patch("/api/pm/import-jobs/job-1").send({ source: "TRELLO_JSON" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("wrong_format");
    svc.updateImportJob.mockRejectedValueOnce(new InvalidImportMappingError(['There is no column named "X" in this file.']));
    res = await request(app()).patch("/api/pm/import-jobs/job-1").send({ mapping: { columns: { name: ["X"] } } });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_import_mapping", problems: ['There is no column named "X" in this file.'] });
  });

  it("an unexpected failure is a 500, not a leaked stack", async () => {
    svc.getImportJob.mockRejectedValue(new Error("connection reset"));
    const res = await request(app()).get("/api/pm/import-jobs/job-1");
    expect(res.status).toBe(500);
  });
});

describe("export", () => {
  it("releases a backpressured export generator when its client disconnects", async () => {
    as("u-reader", "family");
    const released = vi.fn();
    svc.exportCsvChunks.mockImplementation(async function* () {
      try {
        for (let i = 0; i < 100; i += 1) yield "x".repeat(2 * 1024 * 1024);
      } finally { released(); }
    });
    const server = app().listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/pm/projects/p1/export.csv`, (res) => {
          res.once("data", () => { res.destroy(); req.destroy(); resolve(); });
        });
        req.on("error", reject);
      });
      await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("CSV: any reader gets the file, streamed, with download headers", async () => {
    as("u-reader", "family"); // not owner, not lead
    const res = await request(app()).get("/api/pm/projects/p1/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="INBOX-work-items-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.text).toBe("key,title\r\nINBOX-1,One\r\n");
  });

  it("CSV: passes the list filters through, and 'me' means the caller", async () => {
    as("u-reader", "family");
    await request(app()).get("/api/pm/projects/p1/export.csv?state=done&assignee=me&label=l1&priority=high&q=pipe&department=none");
    expect(svc.exportCsvChunks).toHaveBeenCalledWith(prisma, "p1", {
      stateId: "done",
      assignee: "u-reader",
      labelId: "l1",
      priority: "high",
      departmentId: "none",
      q: "pipe",
    });
  });

  it("CSV: a bad filter is a 400 before any byte is written", async () => {
    as("u-reader", "family");
    const res = await request(app()).get("/api/pm/projects/p1/export.csv?priority=huge");
    expect(res.status).toBe(400);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("an unknown project is a clean 404 for both formats", async () => {
    as("u-reader", "family");
    svc.getProject.mockRejectedValue(new Error("project_not_found"));
    for (const path of ["export.csv", "export.json"]) {
      const res = await request(app()).get(`/api/pm/projects/p1/${path}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("project_not_found");
    }
  });

  it("JSON: streamed with its own type and name", async () => {
    as("u-reader", "family");
    const res = await request(app()).get("/api/pm/projects/p1/export.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json; charset=utf-8/);
    expect(res.headers["content-disposition"]).toMatch(/INBOX-project-\d{4}-\d{2}-\d{2}\.json/);
    expect(JSON.parse(res.text)).toEqual({ items: [] });
  });

  it("a failure BEFORE the first byte is an ordinary 500, with no download headers left behind", async () => {
    as("u-reader", "family");
    svc.exportCsvChunks.mockImplementation(async function* () {
      throw new Error("db went away");
      yield "unreachable";
    });
    const res = await request(app()).get("/api/pm/projects/p1/export.csv");
    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("a failure after the first byte cuts the connection instead of ending a short file as if whole", async () => {
    as("u-reader", "family");
    svc.exportCsvChunks.mockImplementation(async function* () {
      yield "key,title\r\n";
      throw new Error("db went away");
    });
    const outcome = await request(app())
      .get("/api/pm/projects/p1/export.csv")
      .then(
        (r) => ({ ok: true as const, text: r.text }),
        (e: unknown) => ({ ok: false as const, error: e }),
      );
    // either the client sees the socket die, or (if the first chunk raced the destroy) a body that is NOT the full file
    if (outcome.ok) expect(outcome.text.endsWith("INBOX-1,One\r\n")).toBe(false);
    else expect(outcome.error).toBeTruthy();
  });
});
