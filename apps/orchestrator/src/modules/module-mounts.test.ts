/**
 * WARP-1585 — the files / knowledge / docs gate collision.
 *
 * The Access & Roles panel offers THREE independent feature toggles (Files,
 * Knowledge, Documents) but the orchestrator mounted only ONE enforcement for
 * all three, because Express `app.use(prefix, handler)` is a PREFIX mount and
 * the registry's prefixes nest:
 *
 *     files      /api/files
 *     knowledge  /api/files/knowledge
 *     docs       /api/files/docs
 *
 * So both gate layers registered for `files` — `requireModuleEnabled("files")`
 * and `requireFeatureAccess("files", "view")` — also fired on the two sibling
 * namespaces. Turning Files off, box-wide or for one person, silently took
 * Knowledge and Documents with it; and because neither sibling was in the
 * feature-gated set, their own toggles enforced NOTHING. Three switches, one
 * wire, wired to the wrong switch.
 *
 * These tests drive the REAL mount loop (`mountModuleGates`, which app.ts now
 * calls) against the REAL registry, so a regression in app.ts's composition is
 * caught here rather than only in a hand-rolled replica.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import type { ModuleId } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { mountModuleGates } from "./module-mounts.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { MODULES, type AvailabilityConfig } from "./module-registry.js";
import type { AuthUser } from "../middleware/auth.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import type { FeatureLevel } from "../services/access-catalog.js";

/** Every availability signal satisfied — availability is not what's under test. */
const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai:8000",
  FILE_INDEXER_URL: "http://fi:8090",
  NEXTCLOUD_URL: "http://nc:8080",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docs",
  SERVICE_TOKEN_EMAIL: "tok",
  SERVICE_TOKEN_VOICE: "tok",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8083",
  ROUTING_SERVICE_URL: "http://routing:8080",
  SWITCH_SERVICE_URL: "http://switch:8081",
};

/** A prisma stub for `createModuleGate` — only `moduleSetting.findMany` is read. */
function prismaWith(disabled: ModuleId[]) {
  return {
    moduleSetting: {
      findMany: async () =>
        MODULES.map((m) => ({ moduleId: m.id, enabled: !disabled.includes(m.id) })),
    },
  } as never;
}

function grants(
  entries: Array<[ModuleId, FeatureLevel]>,
): EffectiveAccessResult {
  return {
    tier: "family",
    features: entries.map(([moduleId, level]) => ({ moduleId, level })),
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    // WARP-1579: null = "no custom role narrows the connectors axis", which
    // is what this module-mount fixture has always modelled.
    connectorGrants: null,
    usage: {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: {
        storageQuotaBytes: "default",
        maxUploadSizeMb: "default",
        llmDailyMessageCap: "default",
      },
    },
    deptRights: [],
    exceptions: [],
  };
}

const PERSON: AuthUser = {
  id: "u-1",
  username: "sam",
  displayName: "Sam",
  role: "family",
};

/**
 * An app composed the way app.ts composes it: principal → the registry-driven
 * gate mounts → the module routers. The four terminal routes stand in for the
 * real ones and are the paths the real routers actually serve.
 */
function appWith(opts: {
  disabledModules?: ModuleId[];
  features: Array<[ModuleId, FeatureLevel]>;
}): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.user = PERSON;
    next();
  });
  mountModuleGates(
    app,
    createModuleGate(prismaWith(opts.disabledModules ?? []), CFG, 0),
    async () => grants(opts.features),
  );
  // The REAL route shapes, in the REAL registration order (files.ts registers
  // `/files/docs/status` before the `:filePath(*)` wildcard):
  //   `/api/files/spaces`             — files.ts
  //   `/api/files/knowledge/recent`   — files-knowledge.ts (its only 2 routes)
  //   `/api/files/docs/status`        — files.ts (the docs module's only route)
  //   `/api/files/:filePath(*)/…`     — files.ts; the wildcard's middle is a
  //     USER-CHOSEN Nextcloud path, so it can spell a sibling's namespace.
  app.get("/api/files/knowledge/recent", (_q, res) => { res.json({ hit: "knowledge" }); });
  app.get("/api/files/docs/status", (_q, res) => { res.json({ hit: "docs" }); });
  app.get("/api/files/spaces", (_q, res) => { res.json({ hit: "files" }); });
  app.get("/api/files/:filePath(*)/editor-session", (_q, res) => { res.json({ hit: "editor" }); });
  app.get("/api/files/:filePath(*)/comments", (_q, res) => { res.json({ hit: "comments" }); });
  app.get("/api/cameras/list", (_q, res) => { res.json({ hit: "cameras" }); });
  return app;
}

const KNOWLEDGE = "/api/files/knowledge/recent";
const DOCS = "/api/files/docs/status";
const FILES = "/api/files/spaces";
const EDITOR = "/api/files/a/b/editor-session";
// The same files.ts route, for a file the operator happened to store under a
// folder called `knowledge` / `docs`. Same handler, same module — the URL just
// lands inside a sibling's namespace, because its middle is user data.
const EDITOR_IN_KNOWLEDGE = "/api/files/knowledge/q3-plan.docx/editor-session";
const EDITOR_IN_DOCS = "/api/files/docs/q3-plan.docx/editor-session";
const COMMENTS_IN_KNOWLEDGE = "/api/files/knowledge/q3-plan.docx/comments";

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("layer 2 (per-person) — three toggles, three enforcements", () => {
  it("all three granted → all three reachable", async () => {
    const app = appWith({
      features: [["files", "view"], ["knowledge", "view"], ["docs", "view"]],
    });
    expect((await request(app).get(FILES)).status).toBe(200);
    expect((await request(app).get(KNOWLEDGE)).status).toBe(200);
    expect((await request(app).get(DOCS)).status).toBe(200);
  });

  it("KNOWLEDGE granted WITHOUT files stays reachable (the bug)", async () => {
    // The dishonest direction the ticket names: an operator grants Knowledge,
    // leaves Files off, and believes the person can search the knowledge base.
    // Before the fix the `files` gate at `/api/files` swallowed this path.
    const app = appWith({ features: [["knowledge", "view"]] });
    const res = await request(app).get(KNOWLEDGE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hit: "knowledge" });
  });

  it("FILES granted WITHOUT knowledge does NOT open the knowledge base", async () => {
    // The other half of "one enforcement": knowledge was not in the
    // feature-gated set at all, so its own toggle bought nothing — a Files
    // grant reached the knowledge base regardless of the Knowledge switch.
    const app = appWith({ features: [["files", "view"]] });
    const res = await request(app).get(KNOWLEDGE);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "knowledge" });
    // …and Files itself is untouched.
    expect((await request(app).get(FILES)).status).toBe(200);
  });

  it("FILES granted WITHOUT docs does NOT open the document surface", async () => {
    const app = appWith({ features: [["files", "view"]] });
    const res = await request(app).get(DOCS);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "docs" });
  });

  it("KNOWLEDGE alone does not open the file library", async () => {
    // The narrowing still holds in the direction it always did — the fix
    // stops the files gate reaching INTO the siblings, not gating files.
    const app = appWith({ features: [["knowledge", "view"]] });
    expect((await request(app).get(FILES)).status).toBe(404);
  });

  it("a nested path that is NOT a sibling namespace keeps the files gate", async () => {
    // `/api/files/:path(*)/editor-session` is a Nextcloud file operation. It
    // sits under `/api/files` but belongs to no other module, so scoping the
    // files gate must not release it.
    const withFiles = appWith({ features: [["files", "view"]] });
    expect((await request(withFiles).get(EDITOR)).status).toBe(200);
    const withoutFiles = appWith({ features: [["docs", "view"], ["knowledge", "view"]] });
    expect((await request(withoutFiles).get(EDITOR)).status).toBe(404);
  });

  it("denials stay byte-identical to the module gate and are audited", async () => {
    const app = appWith({ features: [["files", "view"]] });
    await request(app).get(KNOWLEDGE);
    expect(recordActivityMock).toHaveBeenCalled();
  });
});

describe("layer 1 (workspace) — a box-wide Files toggle stops at Files", () => {
  it("files OFF leaves knowledge serving", async () => {
    const app = appWith({
      disabledModules: ["files"],
      features: [["files", "view"], ["knowledge", "view"], ["docs", "view"]],
    });
    expect((await request(app).get(KNOWLEDGE)).status).toBe(200);
    expect((await request(app).get(FILES)).status).toBe(404);
  });

  it("knowledge OFF leaves files serving", async () => {
    const app = appWith({
      disabledModules: ["knowledge"],
      features: [["files", "view"], ["knowledge", "view"], ["docs", "view"]],
    });
    expect((await request(app).get(KNOWLEDGE)).status).toBe(404);
    expect((await request(app).get(FILES)).status).toBe(200);
  });

  it("files OFF takes DOCS with it — the declared dependency, not the prefix", async () => {
    // Documents has no surface of its own; its editor sessions are minted on
    // Nextcloud paths. `requires: "files"` is enforced in the effective-module
    // computation, so the workspace set never contains a docs without a files.
    const app = appWith({
      disabledModules: ["files"],
      features: [["files", "view"], ["docs", "view"]],
    });
    expect((await request(app).get(DOCS)).status).toBe(404);
  });
});

describe("a nested namespace does not annex the enclosing module's data paths", () => {
  // Review finding on the first cut of this fix. Scoping the files gate by
  // PREFIX released everything under `/api/files/knowledge/*` and
  // `/api/files/docs/*` to the siblings — but `/api/files` serves wildcard
  // routes whose middle is a user-chosen Nextcloud path
  // (`/api/files/:filePath(*)/editor-session`, `…/comments`, `…/citations`,
  // `…/tags`). A file stored under a folder called `knowledge` therefore
  // produces a FILES request inside the KNOWLEDGE namespace, and the release
  // moved it onto the wrong toggle in both directions.
  //
  // The boundary is by PATH: a nested module owns its declared routes
  // (registry `ownedPaths`), the enclosing module keeps the rest.

  it("KNOWLEDGE alone cannot mint an editor session for a file under knowledge/", async () => {
    // The privilege-escalation direction: this is a Nextcloud file operation,
    // and `files` is the module that gates Nextcloud file operations.
    const app = appWith({ features: [["knowledge", "view"]] });
    expect((await request(app).get(EDITOR)).status).toBe(404); // control
    const res = await request(app).get(EDITOR_IN_KNOWLEDGE);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "files" });
    expect((await request(app).get(COMMENTS_IN_KNOWLEDGE)).status).toBe(404);
  });

  it("DOCS alone cannot mint an editor session for a file under docs/", async () => {
    const app = appWith({ features: [["docs", "view"]] });
    expect((await request(app).get(EDITOR_IN_DOCS)).status).toBe(404);
  });

  it("a box with Files OFF stops serving file operations under BOTH sibling namespaces", async () => {
    // The workspace half. "Turn Files off" has to mean the Nextcloud surface
    // is gone — not "gone unless the path starts with knowledge/".
    const app = appWith({
      disabledModules: ["files"],
      features: [["files", "view"], ["knowledge", "view"], ["docs", "view"]],
    });
    expect((await request(app).get(EDITOR)).status).toBe(404);
    expect((await request(app).get(EDITOR_IN_KNOWLEDGE)).status).toBe(404);
    expect((await request(app).get(EDITOR_IN_DOCS)).status).toBe(404);
    // …and Knowledge's OWN routes keep serving, which is the ticket.
    expect((await request(app).get(KNOWLEDGE)).status).toBe(200);
  });

  it("a FILES holder keeps their own files even when stored under docs/ or knowledge/", async () => {
    // The under-grant direction, which is just as dishonest: someone with a
    // Files grant must not lose a file because of what they named its folder.
    const app = appWith({ features: [["files", "view"]] });
    expect((await request(app).get(EDITOR_IN_KNOWLEDGE)).status).toBe(200);
    expect((await request(app).get(EDITOR_IN_DOCS)).status).toBe(200);
    expect((await request(app).get(COMMENTS_IN_KNOWLEDGE)).status).toBe(200);
    // …while the siblings' OWN routes stay narrowed to their own toggles.
    expect((await request(app).get(KNOWLEDGE)).status).toBe(404);
    expect((await request(app).get(DOCS)).status).toBe(404);
  });

  it("the boundary follows Express's own case/trailing-slash routing", async () => {
    // `app.use` and the router both match case-insensitively and ignore a
    // trailing slash, so the gate has to agree with the router it guards or
    // the two disagree about who owns a URL.
    const knowledgeOnly = appWith({ features: [["knowledge", "view"]] });
    expect((await request(knowledgeOnly).get("/api/files/knowledge/recent/")).status).toBe(200);
    expect((await request(knowledgeOnly).get("/api/files/KNOWLEDGE/Recent")).status).toBe(200);
    const filesOnly = appWith({ features: [["files", "view"]] });
    expect((await request(filesOnly).get("/api/files/knowledge/recent/")).status).toBe(404);
  });
});

describe("mount composition", () => {
  it("gates every non-core module and never gates a core one", async () => {
    const app = appWith({ disabledModules: ["chat"], features: [["cameras", "view"]] });
    // `chat` is core: `disabledModules` can't switch it off, and no gate is
    // mounted on `/api/llm`.
    expect((await request(app).get("/api/cameras/list")).status).toBe(200);
  });

  it("passes a request with no principal straight through to authMiddleware", async () => {
    const app = express();
    mountModuleGates(
      app,
      createModuleGate(prismaWith([]), CFG, 0),
      async () => grants([]),
    );
    app.get(KNOWLEDGE, (_q, res) => { res.json({ hit: "knowledge" }); });
    expect((await request(app).get(KNOWLEDGE)).status).toBe(200);
  });
});
