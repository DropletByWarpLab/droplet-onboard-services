/**
 * WARP-3533 — the OpenAPI document for /api/pm stays honest.
 *
 * The repo has no generator, so `docs/openapi/pm.openapi.json` is written by
 * hand; this suite is what makes that safe:
 *   - COVERAGE, both directions: every route mounted by routes/pm/*.ts (found by
 *     walking the routers' stacks) is documented, and every documented operation
 *     is a real route;
 *   - STRUCTURE: valid enough that a client generator will not choke — unique
 *     operation ids, every path parameter declared, every `$ref` resolves,
 *     every security scheme named exists, a body wherever the code parses one;
 *   - SCOPES: the document says `pm:read` for reads and `pm:write` for the rest,
 *     which is exactly what the server's scope guard enforces;
 *   - PARITY: the copy the orchestrator serves is byte-identical to the
 *     canonical one in docs/;
 *   - SERVED: GET /api/pm/openapi.json returns it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import type { Router } from "express";
import { createPmNativeRouter } from "./native.js";
import { createPmRelationsRouter } from "./relations.js";
import { createPmOpenApiRouter } from "./openapi.js";
import { repoPath, packagePath } from "../../__tests__/helpers/test-paths.js";
import { requiredScope } from "../../services/pm/pm-api-token.service.js";

const DOCS_PATH = repoPath("docs", "openapi", "pm.openapi.json");
const EMBEDDED_PATH = packagePath("src", "routes", "pm", "pm.openapi.json");

type Json = Record<string, unknown>;
const doc = JSON.parse(readFileSync(DOCS_PATH, "utf8")) as Json & {
  openapi: string;
  info: Json;
  paths: Record<string, Record<string, Json>>;
  components: Json;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** `METHOD /api/pm/...` for every route a router registers, `:id` written `{id}`. */
function mountedRoutes(router: Router): string[] {
  const out: string[] = [];
  for (const layer of (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push(`${method.toUpperCase()} /api${layer.route.path.replace(/:([A-Za-z]+)/g, "{$1}")}`);
    }
  }
  return out;
}

const stub = {} as never;
const MOUNTED = [createPmNativeRouter(stub), createPmRelationsRouter(stub), createPmOpenApiRouter()].flatMap(mountedRoutes).sort();
const DOCUMENTED = Object.entries(doc.paths)
  .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
  .sort();

const HOW_TO_FIX =
  "Edit docs/openapi/pm.openapi.json, then copy it over apps/orchestrator/src/routes/pm/pm.openapi.json " +
  "(the orchestrator serves that copy; a parity test keeps the two identical).";

describe("the PM OpenAPI document — coverage (WARP-3533)", () => {
  it("found the routes it is meant to cover (so an empty walk can never pass)", () => {
    expect(MOUNTED.length).toBeGreaterThanOrEqual(31);
    expect(MOUNTED).toContain("GET /api/pm/projects");
    expect(MOUNTED).toContain("POST /api/pm/work-items/{id}/relations");
    expect(MOUNTED).toContain("GET /api/pm/openapi.json");
  });

  it("documents every route that routes/pm/*.ts mounts", () => {
    const missing = MOUNTED.filter((r) => !DOCUMENTED.includes(r));
    expect(missing, `mounted but not in the OpenAPI document: ${missing.join(", ")}. ${HOW_TO_FIX}`).toEqual([]);
  });

  it("documents no route that is not mounted", () => {
    const stale = DOCUMENTED.filter((r) => !MOUNTED.includes(r));
    expect(stale, `documented but no longer mounted: ${stale.join(", ")}. ${HOW_TO_FIX}`).toEqual([]);
  });
});

describe("the PM OpenAPI document — structure", () => {
  const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => ({ path, method, op })),
  );

  it("is OpenAPI 3.1 with a title and a version", () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info.title).toEqual(expect.any(String));
    expect(doc.info.version).toEqual(expect.any(String));
  });

  it("lives under /api/pm and uses only the methods the routers use", () => {
    for (const { path, method } of operations) {
      expect(path.startsWith("/api/pm/"), path).toBe(true);
      expect(METHODS as readonly string[], `${method} ${path}`).toContain(method);
    }
  });

  it("gives every operation a unique id, a summary, a tag, a 2xx response and security", () => {
    const ids = new Set<string>();
    for (const { path, method, op } of operations) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(typeof op.operationId, where).toBe("string");
      expect(ids.has(op.operationId as string), `duplicate operationId ${String(op.operationId)}`).toBe(false);
      ids.add(op.operationId as string);
      expect(typeof op.summary, where).toBe("string");
      expect((op.tags as string[]).length, where).toBeGreaterThan(0);
      expect(Object.keys(op.responses as Json).some((c) => /^2\d\d$/.test(c)), where).toBe(true);
      expect((op.security as unknown[]).length, where).toBeGreaterThan(0);
    }
  });

  it("declares every {path parameter} as a required `in: path` parameter on its operation", () => {
    for (const { path, method, op } of operations) {
      const declared = ((op.parameters as Array<{ name: string; in: string; required?: boolean }> | undefined) ?? []).filter(
        (p) => p.in === "path",
      );
      const wanted = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();
      expect(declared.map((p) => p.name).sort(), `${method.toUpperCase()} ${path}`).toEqual(wanted);
      for (const p of declared) expect(p.required, `${path} ${p.name}`).toBe(true);
    }
  });

  it("resolves every $ref inside the document", () => {
    const unresolved: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") {
          const target = v
            .replace(/^#\//, "")
            .split("/")
            .reduce<unknown>((n, seg) => (n as Json | undefined)?.[seg], doc);
          if (target === undefined) unresolved.push(v);
        } else walk(v);
      }
    };
    walk(doc);
    expect(unresolved).toEqual([]);
  });

  it("only names security schemes that it defines", () => {
    const schemes = Object.keys((doc.components as { securitySchemes: Json }).securitySchemes);
    expect(schemes).toEqual(expect.arrayContaining(["bearerAuth", "sessionCookie"]));
    for (const { path, op } of operations) {
      for (const requirement of op.security as Array<Json>) {
        for (const name of Object.keys(requirement)) expect(schemes, path).toContain(name);
      }
    }
  });

  it("declares a JSON request body on every operation whose handler parses one", () => {
    // POST/PATCH routes in native.ts + relations.ts that take a zod-validated body.
    const withBody = new Set([
      "POST /api/pm/projects",
      "PATCH /api/pm/projects/{id}",
      "POST /api/pm/projects/{id}/states",
      "PATCH /api/pm/states/{id}",
      "POST /api/pm/projects/{id}/labels",
      "PATCH /api/pm/labels/{id}",
      "POST /api/pm/projects/{id}/work-items",
      "PATCH /api/pm/work-items/{id}",
      "POST /api/pm/work-items/{id}/transition",
      "POST /api/pm/work-items/{id}/comments",
      "POST /api/pm/work-items/{id}/relations",
    ]);
    for (const { path, method, op } of operations) {
      const where = `${method.toUpperCase()} ${path}`;
      if (withBody.has(where)) {
        const body = op.requestBody as { required?: boolean; content?: Record<string, unknown> } | undefined;
        expect(body?.content?.["application/json"], where).toBeDefined();
        expect(body?.required, where).toBe(true);
        // …and a 400 for it.
        expect(Object.keys(op.responses as Json), where).toContain("400");
      } else {
        expect(op.requestBody, where).toBeUndefined();
      }
    }
  });

  it("documents the shared error responses on every operation", () => {
    for (const { path, method, op } of operations) {
      const codes = Object.keys(op.responses as Json);
      for (const code of ["401", "403", "404", "429"]) expect(codes, `${method.toUpperCase()} ${path}`).toContain(code);
    }
  });
});

describe("the PM OpenAPI document — scopes mirror the server's scope guard", () => {
  it("every read needs pm:read and every other method pm:write, on the bearer scheme", () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const want = requiredScope("pm", method);
        const bearer = (op.security as Array<Record<string, string[]>>).find((r) => "bearerAuth" in r);
        expect(bearer?.bearerAuth, `${method.toUpperCase()} ${path}`).toEqual([want]);
      }
    }
  });
});

describe("the PM OpenAPI document — the served copy", () => {
  it("is byte-identical to the canonical one in docs/", () => {
    const canonical = readFileSync(DOCS_PATH, "utf8");
    const embedded = readFileSync(EMBEDDED_PATH, "utf8");
    expect(embedded === canonical, `the embedded copy drifted from docs/openapi/pm.openapi.json. ${HOW_TO_FIX}`).toBe(true);
  });

  it("is what GET /api/pm/openapi.json returns", async () => {
    const app = express();
    app.use("/api", createPmOpenApiRouter());
    const res = await request(app).get("/api/pm/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual(doc);
  });
});
