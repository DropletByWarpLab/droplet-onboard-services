import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import type { AvailabilityConfig } from "../modules/module-registry.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { createCreationCapabilitiesRouter } from "./creation-capabilities.js";
import type { probeCreationService } from "../services/creation-readiness.service.js";

vi.mock("../middleware/rate-limit.js", () => ({ createRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../middleware/auth.js", () => ({ recordAccessDenied: vi.fn() }));
const cfg = {
  DOC_RENDER_URL: "http://doc-render:8020", DOC_RENDER_SERVICE_TOKEN: "secret-doc",
  SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "secret-sandbox",
  WEB_FETCH_URL: "http://web-fetch:8010", WEB_FETCH_SERVICE_TOKEN: "secret-web",
  MEDIA_GEN_URL: "http://media-gen:8040", MEDIA_GEN_SERVICE_TOKEN: "secret-media", TTS_URL: "tcp://kokoro-tts:10200",
};
const availability = { NEXTCLOUD_URL: "http://nextcloud" } as AvailabilityConfig;
function access(tier = "family", domains = ["files", "data"], level = "act") {
  return { tier, features: [{ moduleId: "files", level }], toolDomains: domains } as EffectiveAccessResult;
}
function harness(role: string | undefined = "family", id?: string) {
  const policy = vi.fn().mockResolvedValue({ enabled: true });
  const user = vi.fn().mockResolvedValue([{ id: "person-id", username: "person", role: "family", displayName: "Person", email: null, directoryStatus: "ACTIVE" }]);
  const prisma = { offLanAllowlistChannel: { findUnique: policy }, user: { findMany: user } } as unknown as PrismaClient;
  const probe = vi.fn<typeof probeCreationService>(async (url: string) => ({ state: "ready" as const, data:
    url.includes("doc-render") ? { version: 1, formats: ["pdf", "docx", "xlsx", "pptx"], office: true }
    : url.includes("sandbox") ? { version: 1, analysisEligible: true, busy: false }
    : url.includes("media-gen") ? { version: 1, image: true, video: true, busy: false, inferenceVerified: true, internalPath: "/models/private", token: "secret" }
    : { version: 1, fetch: true, search: true },
  }));
  const options = {
    config: cfg, probe, speech: vi.fn().mockResolvedValue({ state: "ready", data: { installed: true } }),
    access: vi.fn().mockResolvedValue(access(role)), modules: vi.fn().mockResolvedValue(new Set(["files"])),
    fileToken: vi.fn().mockResolvedValue("secret-user-token"), serviceFileToken: vi.fn().mockResolvedValue("secret-user-token"),
    auditReady: vi.fn().mockReturnValue(true), timeoutMs: 40,
  };
  function app() {
    const result = express();
    result.use((req, _res, next) => { if (role) req.user = { id: id ?? (role === "service" ? "_service:mcp" : "human-id"), username: "person", role } as RequestUser; next(); });
    result.use("/api", createCreationCapabilitiesRouter(prisma, availability, options));
    return result;
  }
  return { options, app, policy, user };
}
type RequestUser = NonNullable<express.Request["user"]>;
const rows = (response: { body: { capabilities: Array<{ id: string; state: string; reason: string; inferenceVerified?: boolean }> } }) => new Map(response.body.capabilities.map((row) => [row.id, row]));

describe("creation readiness", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires authentication before reads or local probes", async () => {
    const h = harness(""); const response = await request(h.app()).get("/api/capabilities/creation");
    expect(response.status).toBe(401); expect(h.options.access).not.toHaveBeenCalled(); expect(h.options.probe).not.toHaveBeenCalled();
  });
  it("reports local services while never claiming model/key provisioning verifies inference/provider access", async () => {
    const h = harness(); const response = await request(h.app()).get("/api/capabilities/creation");
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store"); expect(response.body.capabilities).toHaveLength(11);
    expect(rows(response).get("pdf")?.state).toBe("ready");
    expect(rows(response).get("image")).toMatchObject({ state: "unverified", inferenceVerified: false });
    expect(rows(response).get("analysis")).toMatchObject({ state: "unverified", reason: "analysis_runtime_unverified" });
    expect(rows(response).get("web_search")?.state).toBe("unverified");
    expect(JSON.stringify(response.body)).not.toMatch(/secret|\/models|localhost|nextcloud|tcp:/);
  });
  it("does not probe file services for a workspace-disabled module", async () => {
    const h = harness(); h.options.modules.mockResolvedValue(new Set());
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(rows(response).get("pdf")).toMatchObject({ state: "disabled", reason: "files_module_disabled" });
    expect(h.options.probe.mock.calls.every(([url]) => url.includes("web-fetch"))).toBe(true);
    expect(h.options.speech).not.toHaveBeenCalled(); expect(h.options.fileToken).not.toHaveBeenCalled();
  });
  it.each([access("admin", ["data"], "manage"), access("family", ["files", "data"], "view"), access("guest")])("narrows readiness by actual person grants/tier", async (grants) => {
    const h = harness(grants.tier); h.options.access.mockResolvedValue(grants);
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(rows(response).get("workbook")?.state).toBe("restricted");
    expect(h.options.speech).not.toHaveBeenCalled(); expect(h.options.fileToken).not.toHaveBeenCalled();
  });
  it("requires a current File Store credential without forwarding it to a probe", async () => {
    const h = harness(); h.options.fileToken.mockResolvedValue(null);
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(rows(response).get("analysis")).toMatchObject({ state: "unavailable", reason: "file_access_disconnected" });
    expect(h.options.speech).not.toHaveBeenCalled();
  });
  it.each([false, null, new Error("DB secret /data/key")])("closes public web readiness on absent/off/unreadable privacy policy", async (value) => {
    const h = harness();
    if (value instanceof Error) h.policy.mockRejectedValue(value); else h.policy.mockResolvedValue(value === false ? { enabled: false } : null);
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(rows(response).get("web_fetch")?.state).toBe(value instanceof Error ? "unavailable" : "disabled");
    expect(h.options.probe.mock.calls.some(([url]) => url.includes("web-fetch"))).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("DB secret");
  });
  it("keeps web probes blocked when the signed auditor is unavailable", async () => {
    const h = harness(); h.options.auditReady.mockReturnValue(false);
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(rows(response).get("web_fetch")?.reason).toBe("audit_unavailable");
    expect(h.options.probe.mock.calls.some(([url]) => url.includes("web-fetch"))).toBe(false);
  });
  it("distinguishes busy/missing prerequisites and malformed peer metadata", async () => {
    const h = harness(); h.options.probe.mockImplementation(async (url) => ({ state: "ready", data: url.includes("media") ? { version: 1, image: true, video: false, busy: true } : url.includes("sandbox") ? { version: 1, analysisEligible: false, busy: false } : { version: 1, formats: "pdf", office: true } }));
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(rows(response).get("image")?.state).toBe("busy");
    expect(rows(response).get("video")?.reason).toBe("model_missing");
    expect(rows(response).get("analysis")?.state).toBe("unavailable");
    expect(rows(response).get("pdf")?.state).toBe("offline");
  });
  it("bounds even uncooperative probes and returns the completed status rows", async () => {
    const h = harness(); h.options.speech.mockImplementation(() => new Promise(() => {}));
    const started = Date.now(); const response = await request(h.app()).get("/api/capabilities/creation");
    expect(Date.now() - started).toBeLessThan(1000); expect(response.status).toBe(200);
    expect(rows(response).get("speech")?.state).toBe("offline"); expect(rows(response).get("pdf")?.state).toBe("ready");
  });
  it("fails closed on stalled authorization rather than probing", async () => {
    const h = harness(); h.options.access.mockImplementation(() => new Promise(() => {}));
    const response = await request(h.app()).get("/api/capabilities/creation");
    expect(response.status).toBe(503); expect(h.options.probe).not.toHaveBeenCalled();
  });
  it("resolves pinned MCP acting person before checking their grants, ignores supplied file token", async () => {
    const h = harness("service"); h.options.access.mockResolvedValue(access());
    const response = await request(h.app()).get("/api/capabilities/creation").set("X-Nextcloud-User", "person-id").set("X-Nextcloud-Token", "attacker");
    expect(response.status).toBe(200); expect(h.options.access.mock.calls[0][0]).toMatchObject({ user: { id: "person-id", role: "family" } });
    expect(h.options.serviceFileToken).toHaveBeenCalledWith("person-id"); expect(h.options.fileToken).not.toHaveBeenCalled();
  });
  it.each([{ people: [] }, { people: [{ id: "person-id", role: "owner", directoryStatus: "DEACTIVATED" }] }, { people: [{ id: "person-id", role: "owner" }, { id: "other-person", role: "owner" }] }])("rejects absent, ambiguous or deactivated asserted people without probes", async ({ people }) => {
    const h = harness("service"); h.user.mockResolvedValue(people);
    const response = await request(h.app()).get("/api/capabilities/creation").set("X-Nextcloud-User", "person-id");
    expect(response.status).toBe(403); expect(h.options.probe).not.toHaveBeenCalled();
  });
  it("rejects another service principal before resolving a supplied acting header", async () => {
    const h = harness("service", "_service:voice");
    const response = await request(h.app()).get("/api/capabilities/creation").set("X-Nextcloud-User", "owner");
    expect(response.status).toBe(403); expect(h.user).not.toHaveBeenCalled(); expect(h.options.probe).not.toHaveBeenCalled();
  });
  it("ignores a human caller's acting-person and credential headers", async () => {
    const h = harness("family");
    const response = await request(h.app()).get("/api/capabilities/creation").set("X-Nextcloud-User", "owner").set("X-Nextcloud-Token", "attacker");
    expect(response.status).toBe(200); expect(h.user).not.toHaveBeenCalled();
    expect(h.options.access.mock.calls[0][0]).toMatchObject({ user: { id: "human-id", role: "family" } });
    expect(h.options.serviceFileToken).not.toHaveBeenCalled();
  });
});
