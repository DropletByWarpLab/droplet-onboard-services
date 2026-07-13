/**
 * WARP-1274 (T21) — ADR-029 security checklist automation, part 3: the §8
 * checklist lines that are grep-shaped invariants rather than runtime
 * behavior, expressed as tests so a regression fails CI instead of waiting
 * for the next manual audit.
 *
 *   (f1) `isBusiness` never reaches an authz decision under
 *        apps/orchestrator/src — "Client-forged isBusiness flag | Never
 *        consulted for authz — membership/role only" (brief §3.6).
 *   (f2) POST /api/departments/:id/members rejects a non-UUID `userId`
 *        at the zod-schema layer, BEFORE any Prisma lookup runs.
 *   (f3) `DepartmentShare.createdById` is written from `req.user.id`
 *        alone, everywhere it's set — never from client-supplied body/
 *        query data (the "true creator" column brief §2 relies on for
 *        share-mutation authz would be spoofable otherwise).
 *   (f4) heuristic scan: no `res.json(...)`/`res.send(...)` call anywhere
 *        under routes/ embeds the NC admin credential (env var names or
 *        `adminBasicToken()`/an `adminToken` identifier) in its argument
 *        text. Documented limitation below (f4) — this is a textual
 *        proximity heuristic, not a data-flow analysis.
 *
 * See docs/security/ADR-029-checklist.md for the full §8 checklist → test
 * mapping.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../middleware/auth.js";

const SRC_DIR = path.resolve(__dirname, "..");
const ROUTES_DIR = path.resolve(SRC_DIR, "routes");

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      listTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// ── (f1) isBusiness never reaches authz ─────────────────────────────────

describe("(f1) grep gate: 'isBusiness' never reaches authz", () => {
  it("no non-test source file under apps/orchestrator/src references an isBusiness identifier", () => {
    const files = listTsFiles(SRC_DIR);
    const offenders: string[] = [];
    // Word-boundary match: must NOT flag `isBusinessType` (a real, unrelated
    // module-registry type guard — "isBusiness" is a strict prefix of it,
    // so a naive substring match would false-positive there).
    const pattern = /\bisBusiness\b/;
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      if (pattern.test(content)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it("sanity-checks the pattern itself: isBusinessType is NOT a false positive", () => {
    expect(/\bisBusiness\b/.test("export function isBusinessType(v: string)")).toBe(false);
    expect(/\bisBusiness\b/.test("const isBusiness = true;")).toBe(true);
    expect(/\bisBusiness\b/.test("if (req.body.isBusiness) {")).toBe(true);
  });
});

// ── (f2) non-UUID userId rejected before any DB lookup ──────────────────

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "test-voice-token-32chars-padding-xyz",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_SHARED_FOLDER_NAME: "Household",
  },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: vi.fn(),
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  gfListFolders: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
}));

import { createDepartmentsRouter } from "../routes/departments.js";

function mkOwner(): AuthUser {
  return { id: "owner-id", username: "owner-user", displayName: "Owner", role: "owner" };
}

describe("(f2) POST /api/departments/:id/members rejects a non-UUID userId pre-DB", () => {
  it("400s a malformed userId without ever calling into Prisma", async () => {
    // Deliberately NOT a working Prisma client — any method call throws, so
    // a passing test proves the schema rejection happens strictly before
    // the route would ever need to touch the database. `departmentManagerOrAdmin`
    // short-circuits true for role=owner without any Prisma call, so the
    // ONLY thing standing between this request and a Prisma touch is the
    // zod `addMemberSchema` — exactly what this test pins.
    const explodingPrisma = new Proxy(
      {},
      {
        get() {
          throw new Error("Prisma must not be touched for a request that fails validation");
        },
      },
    );

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: AuthUser }).user = mkOwner();
      next();
    });
    app.use("/api", createDepartmentsRouter(explodingPrisma as never));

    const res = await request(app)
      .post("/api/departments/22222222-2222-4222-8222-222222222222/members")
      .send({ userId: "not-a-uuid", right: "contributor" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("accepts a syntactically valid UUID (regression guard — the 400 above is about shape, not existence)", async () => {
    // Same exploding Prisma — this proves the reverse: a well-formed UUID
    // clears validation and DOES proceed to touch Prisma (and 500s here
    // because the exploding stub throws), never a false-positive 400.
    const explodingPrisma = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: AuthUser }).user = mkOwner();
      next();
    });
    app.use("/api", createDepartmentsRouter(explodingPrisma as never));

    const res = await request(app)
      .post("/api/departments/22222222-2222-4222-8222-222222222222/members")
      .send({ userId: "33333333-3333-4333-8333-333333333333", right: "contributor" });

    expect(res.status).not.toBe(400);
  });
});

// ── (f3) DepartmentShare.createdById is server-derived, never client input ──

describe("(f3) grep gate: DepartmentShare.createdById is always req.user.id", () => {
  it("prisma.departmentShare.create(...)'s createdById field reads from req.user, never req.body/req.query/req.params", () => {
    const filesRouteSrc = readFileSync(path.join(ROUTES_DIR, "files.ts"), "utf-8");

    // Scope to the WRITE call sites specifically (`prisma.departmentShare.
    // create({...})`) — a generic "createdById:" grep also matches Prisma
    // `select`/`where` clauses (`createdById: true`, `where: {createdById:
    // callerId}`), which are reads/projections, not the value actually
    // persisted for a new row, and would produce false positives/negatives
    // either way.
    const createCalls = extractBalancedCallArgs(filesRouteSrc, "prisma.departmentShare.create(");
    // The call site must still exist — a rename would silently vacuous-pass
    // this whole gate otherwise.
    expect(createCalls.length).toBeGreaterThan(0);

    for (const callArgs of createCalls) {
      const match = callArgs.match(/createdById:\s*([^,\n]+)/);
      expect(match).not.toBeNull();
      const rhs = match![1].trim();
      expect(rhs).toMatch(/^req\.user[!?]?\.id$/);
      expect(rhs).not.toMatch(/req\.body/);
      expect(rhs).not.toMatch(/req\.query/);
      expect(rhs).not.toMatch(/req\.params/);
    }
  });
});

// ── (f4) heuristic: NC admin credential never lands in a res.json/res.send ──
//
// LIMITATION (documented per the ticket): this is a textual proximity
// check on the literal argument expression passed to res.json/res.send —
// it does NOT do data-flow analysis. A value laundered through an
// intermediate variable with an innocuous name before being spread into a
// response object would NOT be caught. It catches the crude, most
// damaging mistake (echoing the admin token/credential env vars directly),
// not a deliberately obfuscated leak. Treat a pass here as "no obvious
// leak", not a proof of absence.

function extractBalancedCallArgs(src: string, callPrefix: string): string[] {
  const out: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = src.indexOf(callPrefix, searchFrom);
    if (idx === -1) break;
    let depth = 1;
    let i = idx + callPrefix.length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(src.slice(start, i - 1));
    searchFrom = i;
  }
  return out;
}

describe("(f4) heuristic scan: NC admin credential never embedded in a res.json/res.send argument", () => {
  const FORBIDDEN = [
    "NEXTCLOUD_ADMIN_PASSWORD",
    "NEXTCLOUD_ADMIN_USER",
    "adminBasicToken()",
    "adminToken",
  ];

  it("no res.json(...) or res.send(...) call in routes/ embeds an NC admin credential identifier", () => {
    const files = listTsFiles(ROUTES_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const prefix of ["res.json(", "res.send("]) {
        for (const args of extractBalancedCallArgs(content, prefix)) {
          for (const forbidden of FORBIDDEN) {
            if (args.includes(forbidden)) {
              offenders.push(`${path.relative(ROUTES_DIR, file)}: ${prefix}${args.slice(0, 80)}…`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sanity-checks the extractor against a synthetic nested-paren example", () => {
    const src = 'res.json({ ok: true, value: compute(a, b) });\nres.send("safe");';
    const jsonArgs = extractBalancedCallArgs(src, "res.json(");
    expect(jsonArgs).toEqual(["{ ok: true, value: compute(a, b) }"]);
    const sendArgs = extractBalancedCallArgs(src, "res.send(");
    expect(sendArgs).toEqual(['"safe"']);
  });
});
