/**
 * WARP-2899 (ADR-056 slice L, AC3) — NOTHING on the box loads a connector
 * draft at runtime.
 *
 * A workshop run can draft an ADR-046 REST profile into the git store. That
 * draft is DATA: it ships only through a Warp Lab PR. So the paths by which it
 * could become a live connector are pinned shut, structurally:
 *
 *   (b) `connectorFactoryFor` reads its profile through `lookupRestProfile`,
 *       which is `restProfileFor` (the static, compiled registry) unless a TEST
 *       swaps it with `__setRestProfileLookupForTest`. That seam is the only
 *       thing a store-backed lookup could ride, so: it is assigned only there,
 *       nothing outside a test file calls the setter, and erp-provider.ts
 *       names nothing of the sandbox or the workspace store.
 *   (c) only the sandbox image carries `extensions/`; the orchestrator image
 *       copies no whole build context; neither the orchestrator's nor the
 *       connector's tsconfig can compile anything outside `src/`; and no
 *       non-test source imports from `extensions/templates`.
 *   (d) the store's two volumes are mounted by the sandbox service and no other.
 *
 * (a) — the registry file itself — is pinned in services/erp-connector
 * (`rest-profile-no-store-path.test.ts`).
 *
 * Mutations (each turns this suite red): a non-test file calling the setter;
 * `lookupRestProfile = somethingElse` in erp-provider.ts; `COPY extensions/…`
 * in apps/orchestrator/Dockerfile; workspace-git mounted on the orchestrator;
 * an import from `../../extensions/templates/…` in a src file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT, readRepoFile, repoPath } from "./helpers/test-paths.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".next", ".turbo", "__tests__", "__mocks__", ".git"]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Every non-test source file under apps/, services/ and packages/, repo-relative. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(path.relative(REPO_ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  for (const top of ["apps", "services", "packages"]) walk(repoPath(top));
  return out;
}

/** Every Dockerfile in the repo, repo-relative. */
function dockerfiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") walk(path.join(dir, entry.name));
      } else if (/^Dockerfile/.test(entry.name)) {
        out.push(path.relative(REPO_ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(REPO_ROOT);
  return out;
}

/** The source paths of each COPY in a Dockerfile (stage copies excluded). */
function copySources(text: string): string[] {
  const sources: string[] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^(COPY|ADD)\s/i.test(line)) continue;
    const words = line.split(/\s+/).slice(1);
    if (words.some((w) => w.startsWith("--from="))) continue;
    const args = words.filter((w) => !w.startsWith("--"));
    sources.push(...args.slice(0, -1));
  }
  return sources;
}

describe("the REST profile lookup has no store-backed path (b)", () => {
  const erpProvider = readRepoFile("apps/orchestrator/src/services/erp-provider.ts");

  it("lookupRestProfile is assigned only the static registry, or inside the test seam", () => {
    // The optional `: <type>` is lazy so an arrow type's `=>` is not the assignment.
    const assignments = [...erpProvider.matchAll(/\blookupRestProfile\b(?:\s*:[^;]*?)?\s*=(?![=>])\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(assignments).toEqual(["restProfileFor", "lookup ?? restProfileFor"]);
    const seam = /export function __setRestProfileLookupForTest\([\s\S]*?\n\}/.exec(erpProvider)?.[0] ?? "";
    expect(seam).toContain("lookupRestProfile = lookup ?? restProfileFor;");
  });

  it("nothing outside a test file calls the test seam", () => {
    const callers = sourceFiles().filter(
      (f) => f !== "apps/orchestrator/src/services/erp-provider.ts" && readFileSync(repoPath(f), "utf8").includes("__setRestProfileLookupForTest"),
    );
    expect(callers).toEqual([]);
  });

  it("erp-provider.ts names nothing of the sandbox or the workspace store", () => {
    // AC3(b): no `sandbox`, no `workspace` — any case, anywhere (a
    // `./workshop-workspace.js` import or a WORKSPACE_GIT_DIR read included).
    const text = erpProvider.toLowerCase();
    for (const needle of ["sandbox_url", "workspace.service", "connector-draft", "/git/", "extensions/templates", "sandbox", "workspace"]) {
      expect(text.includes(needle), needle).toBe(false);
    }
  });
});

describe("only the sandbox image carries extensions/ (c)", () => {
  it("no Dockerfile but the sandbox's COPYs from extensions/", () => {
    const carriers = dockerfiles().filter((f) =>
      copySources(readFileSync(repoPath(f), "utf8")).some((s) => /^(\.\/)?extensions(\/|$)/.test(s)),
    );
    expect(carriers).toEqual(["services/sandbox/Dockerfile"]);
  });

  it("the orchestrator image copies no whole build context", () => {
    const sources = copySources(readRepoFile("apps/orchestrator/Dockerfile"));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((s) => s === "." || s === "./" || s === "*")).toEqual([]);
  });

  it("the orchestrator's and the connector's tsconfig compile only their own src/", () => {
    for (const pkg of ["apps/orchestrator", "services/erp-connector"]) {
      const tsconfig = JSON.parse(readRepoFile(`${pkg}/tsconfig.json`)) as {
        compilerOptions?: { rootDir?: string };
        include?: string[];
      };
      expect(tsconfig.compilerOptions?.rootDir?.replace(/^\.\//, ""), pkg).toBe("src");
      for (const inc of tsconfig.include ?? []) expect(inc.startsWith("src/"), `${pkg}: ${inc}`).toBe(true);
    }
  });

  it("no non-test source imports from extensions/templates", () => {
    // `from "…"`, a bare side-effect `import "…"`, `import("…")`, `require("…")`.
    const spec = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'`]([^"'`]*extensions\/templates[^"'`]*)["'`]/;
    const importers = sourceFiles().filter((f) => spec.test(readFileSync(repoPath(f), "utf8")));
    expect(importers).toEqual([]);
  });
});

describe("the store's volumes are the sandbox's alone (d)", () => {
  it("workspace-git and workspace-checkouts are mounted by the sandbox service and no other", () => {
    const compose = parseYaml(readRepoFile("docker/docker-compose.yml")) as {
      services: Record<string, { volumes?: Array<string | { source?: string }> }>;
    };
    const mounters = Object.entries(compose.services)
      .filter(([, svc]) =>
        (svc.volumes ?? []).some((v) => {
          const source = typeof v === "string" ? v.split(":")[0] : v.source;
          return source === "workspace-git" || source === "workspace-checkouts";
        }),
      )
      .map(([name]) => name);
    expect(mounters).toEqual(["sandbox"]);
  });
});

// The walkers must see real trees, or every assertion above passes vacuously.
describe("the guard reads the real tree", () => {
  it("finds erp-provider.ts among the sources and the sandbox Dockerfile among the images", () => {
    expect(sourceFiles()).toContain("apps/orchestrator/src/services/erp-provider.ts");
    expect(dockerfiles()).toContain("apps/orchestrator/Dockerfile");
    expect(statSync(repoPath("services/sandbox/Dockerfile")).isFile()).toBe(true);
  });
});
