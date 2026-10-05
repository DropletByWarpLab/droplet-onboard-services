/**
 * WARP-3528 (ADR-069 §1) — the DB-less half of "the `pm` grant is never a way
 * into a customer conversation".
 *
 * The real proof — every PM route, driven against a real Postgres — is
 * pm-service-desk-isolation.pg.test.ts. This file pins what that cannot cheaply
 * reach: the shape of the queries the chat context pins make (the assistant's
 * prompt must never name a ticket), and the one guard every PM reader shares.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const mockGetEffectiveModuleIds = vi.fn();
vi.mock("../services/modules.service.js", () => ({
  getEffectiveModuleIds: (...a: unknown[]) => mockGetEffectiveModuleIds(...a),
}));

import { isServiceDesk } from "../services/pm/pm.service.js";
import {
  checkBusinessPinTarget,
  resolveBusinessPinTargets,
  type PinTargetReadClient,
} from "../services/context-pin-targets.service.js";

describe("isServiceDesk — the one guard every PM reader shares", () => {
  it("is true for a desk and false for a project, whatever else the row carries", () => {
    expect(isServiceDesk({ kind: "SERVICE_DESK" })).toBe(true);
    expect(isServiceDesk({ kind: "PROJECT" })).toBe(false);
  });

  it("is false for a row that is not there — absence is the caller's own 404, not this guard's", () => {
    expect(isServiceDesk(null)).toBe(false);
    expect(isServiceDesk(undefined)).toBe(false);
  });
});

describe("chat context pins never reach a desk or a ticket", () => {
  const prismaFake = () => ({
    crmCompany: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    crmDeal: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    pmProject: {
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
      findUnique: vi.fn(async (_args: unknown) => null as unknown),
    },
    pmWorkItem: {
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
      findUnique: vi.fn(async (_args: unknown) => null as unknown),
    },
  });

  beforeEach(() => {
    mockGetEffectiveModuleIds.mockReset();
    mockGetEffectiveModuleIds.mockResolvedValue(new Set(["chat", "crm", "projects"]));
  });

  const ctx = { scope: null, tier: "family" };

  it("resolves a project pin against projects only, so a desk's name cannot reach a prompt", async () => {
    const p = prismaFake();
    await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "pin1", kind: "project", ref: "desk-uuid" }],
      ctx,
    );
    expect(p.pmProject.findMany).toHaveBeenCalledTimes(1);
    expect(p.pmProject.findMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ["desk-uuid"] }, kind: "PROJECT" },
    });
  });

  it("resolves a work-item pin against items in projects only, so a ticket's subject cannot reach a prompt", async () => {
    const p = prismaFake();
    await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "pin2", kind: "work_item", ref: "ticket-uuid" }],
      ctx,
    );
    expect(p.pmWorkItem.findMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ["ticket-uuid"] }, project: { kind: "PROJECT" } },
    });
  });

  it("refuses to CREATE a pin on a desk or a ticket, answering exactly as for an unknown id", async () => {
    const p = prismaFake();
    const project = await checkBusinessPinTarget(p as unknown as PinTargetReadClient, "project", "desk-uuid", ctx);
    const item = await checkBusinessPinTarget(p as unknown as PinTargetReadClient, "work_item", "ticket-uuid", ctx);
    expect(project).toEqual({ ok: false, reason: "not_found" });
    expect(item).toEqual({ ok: false, reason: "not_found" });
    expect(p.pmProject.findUnique.mock.calls[0]![0]).toMatchObject({
      where: { id: "desk-uuid", kind: "PROJECT" },
    });
    expect(p.pmWorkItem.findUnique.mock.calls[0]![0]).toMatchObject({
      where: { id: "ticket-uuid", project: { kind: "PROJECT" } },
    });
  });
});

describe("the filing worker's project list", () => {
  // The worker is a long claim-processing function with no seam for its project
  // read, and the model it feeds is the very thing that must never see a desk's
  // name. A source tripwire is the proportionate guard; the pg suite covers the
  // routes and the CRM readers behaviourally.
  it("asks for projects only", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../services/filing/worker.ts"),
      "utf8",
    );
    const call = src.slice(src.indexOf("prisma.pmProject.findMany"));
    expect(call.slice(0, 260)).toMatch(/kind:\s*"PROJECT"/);
  });
});
