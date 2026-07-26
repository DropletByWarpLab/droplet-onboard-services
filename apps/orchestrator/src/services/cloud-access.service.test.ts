/**
 * WARP-1530 (RBAC v2 T6) — the cloud-access decision helper.
 *
 * This is the ONE place the orchestrator turns "is this turn cloud-bound?"
 * + the T3 resolver's `cloud` verdict into an allow / refuse. The tests
 * below pin the two things a reviewer must be able to trust:
 *
 *   • the verdict is the resolver's AND-gated `cloud` field — NOT a
 *     re-derivation of either limb (role flag, workspace escape). The
 *     matrix here drives the REAL `computeEffectiveAccess` so an
 *     "allowed by role, workspace escape off" person is still refused;
 *   • a person with no `accessRole` (every user in production today)
 *     resolves exactly as today: the workspace escape alone decides.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveEffectiveAccess = vi.fn();
vi.mock("./effective-access.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("./effective-access.service.js")>();
  return {
    ...actual,
    resolveEffectiveAccess: (...a: unknown[]) => mockResolveEffectiveAccess(...a),
  };
});

const mockGetModelProvider = vi.fn();
vi.mock("./ai-gateway.client.js", () => ({
  getModelProvider: (...a: unknown[]) => mockGetModelProvider(...a),
}));

import { decideCloudTurn, isLocalProvider } from "./cloud-access.service.js";
import {
  computeEffectiveAccess,
  type AccessRoleGrantRows,
  type EffectiveAccessInputs,
} from "./effective-access.service.js";
import type { Role } from "./jwt.service.js";

function role(cloudModelsAllowed: boolean): AccessRoleGrantRows {
  return {
    mayOperateLocks: false,
    cloudModelsAllowed,
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
    featureGrants: [],
    toolGrants: [],
    connectorGrants: [],
  };
}

/** Real §3 composition — no DB, no re-derivation of the cloud limbs. */
function realAccess(args: {
  tier: Role;
  accessRole: AccessRoleGrantRows | null;
  cloudEscapeEnabled: boolean;
}) {
  const inputs: EffectiveAccessInputs = {
    user: { id: "u1", role: args.tier, accessRole: args.accessRole },
    exceptions: [],
    workspaceModuleIds: new Set(),
    cloudEscapeEnabled: args.cloudEscapeEnabled,
    connections: [],
    usagePolicy: null,
    deptRights: [],
  };
  return computeEffectiveAccess(inputs);
}

const PERSON = { id: "u1", role: "family" };

beforeEach(() => {
  mockResolveEffectiveAccess.mockReset();
  mockGetModelProvider.mockReset().mockResolvedValue("openai");
});

describe("isLocalProvider", () => {
  it("mirrors ai-gateway's LOCAL_PROVIDERS allowlist (case-insensitive)", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("ollama_local")).toBe(true);
    expect(isLocalProvider("Ollama")).toBe(true);
    expect(isLocalProvider("openai")).toBe(false);
    expect(isLocalProvider("anthropic")).toBe(false);
  });
});

describe("decideCloudTurn — AND-gate consumption (WARP-1530)", () => {
  it("refuses when the role denies cloud even though the workspace escape is ON", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: role(false), cloudEscapeEnabled: true }),
    );
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.status).toBe(451);
  });

  it("refuses when the role ALLOWS cloud but the workspace escape is OFF (the AND-gate)", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: role(true), cloudEscapeEnabled: false }),
    );
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.status).toBe(451);
  });

  it("allows only when BOTH limbs are on", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: role(true), cloudEscapeEnabled: true }),
    );
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" });
    expect(d.kind).toBe("allowed");
  });

  it("a person with NO accessRole resolves exactly as today — the workspace escape alone decides", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: null, cloudEscapeEnabled: true }),
    );
    await expect(
      decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({ kind: "allowed" });

    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: null, cloudEscapeEnabled: false }),
    );
    await expect(
      decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({ kind: "refused" });
  });

  it("an owner is still bound by the workspace escape (the resolver stays honest for owners)", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "owner", accessRole: null, cloudEscapeEnabled: false }),
    );
    const d = await decideCloudTurn({
      user: { id: "u1", role: "owner" },
      model: "gpt-4o",
      provider: "openai",
    });
    expect(d.kind).toBe("refused");
  });
});

describe("decideCloudTurn — when the gate does NOT engage", () => {
  it("skips a local turn without touching the resolver", async () => {
    mockGetModelProvider.mockResolvedValue("ollama");
    const d = await decideCloudTurn({ user: PERSON, model: "llama3:8b", provider: "ollama" });
    expect(d.kind).toBe("allowed");
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("skips service principals — §3 keeps them on their dedicated paths", async () => {
    const d = await decideCloudTurn({
      user: { id: "_service:voice", role: "service" },
      model: "gpt-4o",
      provider: "openai",
    });
    expect(d.kind).toBe("allowed");
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("skips when the session carries no person id (nothing to resolve)", async () => {
    const d = await decideCloudTurn({
      user: { role: "family" },
      model: "gpt-4o",
      provider: "openai",
    });
    expect(d.kind).toBe("allowed");
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("treats an unresolvable model as not-cloud — the gateway catalog only lists reachable providers", async () => {
    mockGetModelProvider.mockResolvedValue(undefined);
    const d = await decideCloudTurn({ user: PERSON, model: "mystery:1b" });
    expect(d.kind).toBe("allowed");
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });
});

describe("decideCloudTurn — fail-closed", () => {
  it("refuses with 503 when the resolver throws", async () => {
    mockResolveEffectiveAccess.mockRejectedValue(new Error("db down"));
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") {
      expect(d.status).toBe(503);
      expect(d.body.error).toBe("access_gate_unavailable");
    }
  });

  it("refuses with 503 when the person no longer resolves (deleted user)", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(null);
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-4o", provider: "openai" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.status).toBe(503);
  });
});
