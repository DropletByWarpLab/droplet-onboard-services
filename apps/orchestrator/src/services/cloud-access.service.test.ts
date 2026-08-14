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

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  decideCloudTurn,
  isLocalProvider,
  providerForModelName,
  LOCAL_MODEL_PREFIXES,
  CLOUD_MODEL_PREFIXES,
  LOCAL_PROVIDERS,
  LOCAL_PROVIDER,
} from "./cloud-access.service.js";
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

// ── the drift gate on the duplicated routing knowledge ──────────────
//
// This module mirrors two tables that live in the ai-gateway, which this
// ticket must not touch. Restating them in a comment is what rots; PARSING
// the source at test time is what fails CI when someone adds a provider or a
// prefix on the Python side. Both parses assert they found something before
// comparing, so a refactor that moves the tables fails loudly rather than
// vacuously passing on an empty match.
describe("parity with services/ai-gateway (drift gate)", () => {
  /**
   * Resolve a repo-relative path by walking up from the working directory.
   * `import.meta.url` would be the obvious tool, but the orchestrator's tsc
   * target is CommonJS and rejects it (TS1470) — and hard-coding a depth
   * breaks the moment the suite is invoked from the repo root instead of
   * apps/orchestrator. Throws rather than skipping: a parity test that
   * quietly stops running is worse than no parity test.
   */
  function repoFile(relative: string): string {
    let dir = process.cwd();
    for (;;) {
      const candidate = resolve(dir, relative);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`could not locate ${relative} from ${process.cwd()}`);
      dir = parent;
    }
  }

  const ROUTER_PY = repoFile("services/ai-gateway/router.py");
  const GATING_PY = repoFile("services/ai-gateway/middleware/off_lan_gating.py");

  /** Parse `PROVIDER_PREFIXES = { "name": [ "a", "b" ], ... }` out of router.py. */
  function parseProviderPrefixes(src: string): Array<[string, string[]]> {
    const block = /PROVIDER_PREFIXES\s*=\s*\{([\s\S]*?)\n\}/.exec(src);
    if (!block) throw new Error(`PROVIDER_PREFIXES not found in ${ROUTER_PY}`);
    const out: Array<[string, string[]]> = [];
    const entry = /"([a-z_]+)"\s*:\s*\[([\s\S]*?)\]/g;
    let m: RegExpExecArray | null;
    while ((m = entry.exec(block[1])) !== null) {
      const prefixes = [...m[2].matchAll(/"([^"]+)"/g)].map((p) => p[1]);
      out.push([m[1], prefixes]);
    }
    return out;
  }

  it("PROVIDER_PREFIXES: every provider and prefix is mirrored, in the same order", () => {
    const parsed = parseProviderPrefixes(readFileSync(ROUTER_PY, "utf8"));
    expect(parsed.length).toBeGreaterThan(0);

    const mirrored = new Map<string, readonly string[]>([
      // WARP-1926 — the local key is `local`, not `ollama`. It names WHERE
      // inference runs, not which daemon serves it; both DMR and Ollama
      // answer here. This assertion is what fails if router.py drifts.
      [LOCAL_PROVIDER, LOCAL_MODEL_PREFIXES],
      ...CLOUD_MODEL_PREFIXES,
    ]);
    // Same providers, and — because resolve_provider returns the FIRST match
    // and the dict iterates in insertion order — the same order too.
    expect(parsed.map(([name]) => name)).toEqual([...mirrored.keys()]);
    for (const [name, prefixes] of parsed) {
      expect(prefixes).toEqual([...mirrored.get(name)!]);
    }
  });

  it("LOCAL_PROVIDERS: the off-LAN gate's exempt set is mirrored exactly", () => {
    const src = readFileSync(GATING_PY, "utf8");
    const block = /LOCAL_PROVIDERS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/.exec(src);
    if (!block) throw new Error(`LOCAL_PROVIDERS not found in ${GATING_PY}`);
    const parsed = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(parsed.length).toBeGreaterThan(0);
    expect([...parsed].sort()).toEqual([...LOCAL_PROVIDERS].sort());
  });
});

describe("providerForModelName — mirrors router.py::resolve_provider", () => {
  it("routes the cloud families the catalogue does not list", () => {
    expect(providerForModelName("gpt-5")).toBe("openai");
    expect(providerForModelName("o1-preview")).toBe("openai");
    expect(providerForModelName("o3-mini")).toBe("openai");
    expect(providerForModelName("claude-opus-4-20250514")).toBe("anthropic");
  });

  it("gives the local families precedence, gpt-oss over gpt included", () => {
    expect(providerForModelName("gpt-oss:20b")).toBe(LOCAL_PROVIDER);
    expect(providerForModelName("llama3:8b")).toBe(LOCAL_PROVIDER);
    expect(providerForModelName("deepseek-r1:7b")).toBe(LOCAL_PROVIDER);
  });

  it("returns the CANONICAL local name, never the legacy `ollama` spelling", () => {
    // WARP-1926 regression guard: this value is written to
    // ChatMessage.provider on every on-box turn. Emitting `ollama` from a
    // Docker-Model-Runner box is the lie this ticket removed.
    expect(LOCAL_PROVIDER).toBe("local");
    expect(providerForModelName("llama3:8b")).not.toBe("ollama");
  });

  it("still ACCEPTS the legacy spellings — persisted rows predate the rename", () => {
    // ChatSession.provider / ChatMessage.provider are persisted columns, so
    // history written before WARP-1926 carries `ollama`. If these stop being
    // local, replaying that history 451s.
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("ollama_local")).toBe(true);
    expect(isLocalProvider("local")).toBe(true);
    expect(isLocalProvider("openai")).toBe(false);
  });

  it("is case-insensitive and returns undefined when nothing matches", () => {
    expect(providerForModelName("GPT-5")).toBe("openai");
    expect(providerForModelName("mystery:1b")).toBeUndefined();
    expect(providerForModelName("")).toBeUndefined();
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

  it("treats a model no rule matches as not-cloud — the gateway's own `return self.ollama` default", async () => {
    mockGetModelProvider.mockResolvedValue(undefined);
    const d = await decideCloudTurn({ user: PERSON, model: "mystery:1b" });
    expect(d.kind).toBe("allowed");
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });
});

// ── the uncatalogued-model bypass (QA finding, WARP-1530) ────────────
//
// The gateway's cloud catalogue is SIX hardcoded ids, but routing is by
// prefix and the cloud providers hand any string straight to litellm. Every
// model below therefore reaches a real cloud provider while resolving to
// nothing in the catalogue. Classing them "local" let a cloud-denied person
// out with one crafted model string, and the ai-gateway 451 provably could
// not catch it: that gate is workspace-scoped, and per-person denial only
// matters while the workspace escape is ON.
describe("decideCloudTurn — uncatalogued models still route to a cloud provider", () => {
  beforeEach(() => {
    // The catalogue knows none of these — the whole point.
    mockGetModelProvider.mockResolvedValue(undefined);
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: role(false), cloudEscapeEnabled: true }),
    );
  });

  it.each([
    ["gpt-5", "openai"],
    ["gpt-4.1", "openai"],
    ["gpt-4o-2024-08-06", "openai"],
    ["o1-preview", "openai"],
    ["o3-mini", "openai"],
    ["claude-opus-4-20250514", "anthropic"],
  ])("refuses %s (prefix-routes to %s) for a cloud-denied person", async (model, provider) => {
    const d = await decideCloudTurn({ user: PERSON, model });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") {
      expect(d.status).toBe(451);
      expect(d.body.provider).toBe(provider);
    }
  });

  it("still lets the SAME models through when the person is allowed cloud", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(
      realAccess({ tier: "family", accessRole: role(true), cloudEscapeEnabled: true }),
    );
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-5" });
    expect(d.kind).toBe("allowed");
  });

  it("keeps gpt-oss LOCAL — the local prefixes win, as they do in router.py", async () => {
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-oss:20b" });
    expect(d.kind).toBe("allowed");
    // Never even asked: a local turn does not consult the resolver.
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it.each(["llama3:8b", "mistral:7b-instruct", "qwen2.5:14b", "deepseek-r1:7b", "phi4:latest"])(
    "keeps the local family %s local",
    async (model) => {
      const d = await decideCloudTurn({ user: PERSON, model });
      expect(d.kind).toBe("allowed");
      expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
    },
  );

  it("honours LLM_MODEL as an outright local override, exactly as resolve_provider does", async () => {
    const prev = process.env.LLM_MODEL;
    process.env.LLM_MODEL = "gpt-4o-my-local-finetune";
    try {
      const d = await decideCloudTurn({ user: PERSON, model: "gpt-4o-my-local-finetune" });
      expect(d.kind).toBe("allowed");
      expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = prev;
    }
  });

  it("lets the catalogue win when it DOES resolve (a pulled local model beats the prefix table)", async () => {
    mockGetModelProvider.mockResolvedValue("ollama");
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-something-local" });
    expect(d.kind).toBe("allowed");
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("falls through to the prefix mirror when the catalogue lookup THROWS (never a bypass)", async () => {
    mockGetModelProvider.mockRejectedValue(new Error("gateway unreachable"));
    const d = await decideCloudTurn({ user: PERSON, model: "gpt-5" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.body.provider).toBe("openai");
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
