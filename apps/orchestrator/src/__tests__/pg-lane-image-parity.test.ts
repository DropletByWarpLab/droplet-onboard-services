/**
 * WARP-1541 — Postgres-image parity between the local pg lane and CI.
 * WARP-1586 — re-expressed against the step-started container.
 *
 * scripts/test-orchestrator-pg.sh (Docker backend) and the `pg-integration`
 * job in .github/workflows/orchestrator-tests.yml both apply the full
 * Prisma migration set, which includes
 * 20260412000000_add_file_content_index (`CREATE EXTENSION IF NOT EXISTS
 * vector`). Plain postgres:16 does not ship the pgvector extension, so
 * `prisma migrate deploy` fails on it — the image must be
 * pgvector/pgvector:pg16 in BOTH places, and must stay the SAME string so
 * "works locally" keeps meaning "works in CI".
 *
 * WHY THIS FILE CHANGED SHAPE (WARP-1586)
 * ---------------------------------------
 * The original version read the image out of `jobs.pg-integration.services
 * .postgres.image`. WARP-1586 moved Postgres out of the `services:` block
 * and into an explicit step, because a service-container image pull fails in
 * "Initialize containers" — before any step runs — so a Docker Hub rate-limit
 * (which took out two PRs during the WARP-1522 epic) was structurally
 * un-retryable. The lane now resolves a GHCR mirror with a Docker Hub
 * fallback and starts the container itself.
 *
 * The old assertion "the job declares a service image" was a MECHANICAL
 * extraction guard, not an invariant worth keeping — it only existed so the
 * helper couldn't silently return garbage. That specific shape is genuinely
 * moot now. What it was PROTECTING is not, so all of it is re-expressed
 * below and then some. This file still fails if:
 *
 *   - the image stops being a pgvector build (migrations need the extension);
 *   - the image reference stops being pinned to an explicit tag or digest,
 *     or drifts to a floating tag like `latest`;
 *   - the lane starts pulling from a registry other than the expected two
 *     (implicit Docker Hub for upstream, ghcr.io for the mirror) — the whole
 *     point of WARP-1586 is WHERE the bytes come from;
 *   - the GHCR mirror stops being scoped to this repository, i.e. someone
 *     points it at a namespace we don't control;
 *   - the Postgres startup disappears from the job entirely;
 *   - scripts/test-orchestrator-pg.sh and CI drift apart.
 *
 * Parsed structurally with `yaml` rather than regexed out of the raw text:
 * the previous regex silently matched the FIRST `image:` key after the job
 * header, which is exactly the kind of thing that turns into a false green
 * when the file is restructured.
 *
 * Same file-text-regression discipline as access-role.schema.test.ts: no DB
 * needed, runs in the default DB-less vitest lane. The parity assert is
 * self-updating — it extracts the image from the workflow and requires the
 * script to match, so a future CI bump (e.g. pg17) fails here until the
 * script follows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "./helpers/test-paths.js";

// Both files live at the repo root, reached from this test file rather than
// from the runner's cwd (WARP-2654).
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "orchestrator-tests.yml",
);
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "test-orchestrator-pg.sh");

/**
 * Registry hosts the pg lane is allowed to pull from. Docker Hub is implicit
 * (an image with no host, e.g. `pgvector/pgvector:pg16`) and so never appears
 * here. Adding to this set is a deliberate supply-chain decision.
 */
const ALLOWED_REGISTRY_HOSTS = new Set(["ghcr.io"]);

interface PgJob {
  env?: Record<string, string>;
  services?: Record<string, { image?: string }>;
  steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
}

function pgJob(): PgJob {
  const workflow = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as {
    jobs?: Record<string, PgJob>;
  };
  const job = workflow.jobs?.["pg-integration"];
  expect(job, "orchestrator-tests.yml must declare a pg-integration job").toBeTruthy();
  return job!;
}

/**
 * The upstream Postgres image the lane boots. WARP-1586 moved this from the
 * service container to the job's `PG_UPSTREAM_IMAGE` env — the GHCR mirror is
 * a cache of THIS reference, so this is still the single source of truth for
 * "which Postgres does the pg lane run".
 */
function ciPgImage(): string {
  const job = pgJob();
  // Tolerate either shape so the parity contract survives a future revert to
  // a service container without going quietly vacuous.
  const fromService = job.services?.postgres?.image;
  const fromEnv = job.env?.PG_UPSTREAM_IMAGE;
  const image = fromService ?? fromEnv;
  expect(
    image,
    "pg-integration must declare its Postgres image — either services.postgres.image " +
      "or the PG_UPSTREAM_IMAGE job env that the WARP-1586 resolver mirrors",
  ).toBeTruthy();
  return image!;
}

/** Every `run:` body in the job, concatenated — where the pulls actually live. */
function jobShellText(): string {
  const job = pgJob();
  return (job.steps ?? []).map((s) => s.run ?? "").join("\n");
}

/** The body of the script's Docker backend, where the cold-volume race lives. */
function scriptDockerBackend(): string {
  const script = readFileSync(SCRIPT_PATH, "utf-8");
  const fn = script.match(/^run_with_docker\(\) \{[\s\S]*?^\}/m);
  expect(
    fn,
    "test-orchestrator-pg.sh must define run_with_docker() — the backend that mirrors CI",
  ).not.toBeNull();
  return fn![0];
}

/** The image the script's Docker backend boots (last arg of `docker run`). */
function scriptPgImage(): string {
  const script = readFileSync(SCRIPT_PATH, "utf-8");
  const runBlock = script.match(/docker run[\s\S]*?>\/dev\/null/);
  expect(
    runBlock,
    "test-orchestrator-pg.sh must boot its throwaway Postgres via docker run",
  ).not.toBeNull();
  const image = runBlock![0].match(/(\S+)\s+>\/dev\/null/);
  expect(image, "docker run must end with the image argument").not.toBeNull();
  return image![1]!;
}

describe("WARP-1541 pg-lane image parity (script vs CI)", () => {
  it("CI's pg-integration job boots a pgvector image (migration set runs CREATE EXTENSION vector)", () => {
    expect(ciPgImage()).toMatch(/pgvector/);
  });

  it("test-orchestrator-pg.sh boots the exact CI image — no silent divergence", () => {
    expect(scriptPgImage()).toBe(ciPgImage());
  });
});

describe("WARP-1586 pg-lane image provenance", () => {
  it("pins the Postgres image to an explicit tag or digest", () => {
    const image = ciPgImage();
    // `name@sha256:...` or `name:tag`. A bare `name` resolves to :latest, and
    // an explicit :latest is a moving target — both defeat the point of a
    // reproducible lane.
    expect(
      /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image) || /^[^\s@]+:[^\s:@/]+$/.test(image),
      `Postgres image "${image}" must carry an explicit :tag or @sha256 digest`,
    ).toBe(true);
    expect(image, "the pg lane must not float on :latest").not.toMatch(/:latest$/);
  });

  it("starts Postgres inside the job — the container must not silently vanish", () => {
    const shell = jobShellText();
    expect(
      shell,
      "pg-integration must start its own Postgres container (WARP-1586 removed the " +
        "services: block precisely so the pull is retryable)",
    ).toMatch(/docker\s+run\b[\s\S]*--name/);
    // The started container must be the one the rest of the job talks to.
    expect(shell).toMatch(/\$(\{)?PG_CONTAINER(\})?/);
  });

  it("resolves the image before starting it, and can fall back", () => {
    const shell = jobShellText();
    expect(shell, "the resolver must consult the GHCR mirror").toMatch(/docker pull[\s\S]*mirror/);
    expect(shell, "the resolver must retain a Docker Hub fallback").toMatch(/upstream/);
  });

  it("pulls only from allowed registries", () => {
    const job = pgJob();
    const haystack = [jobShellText(), JSON.stringify(job.env ?? {})].join("\n");
    // Any `host.tld/path` token — registry references always carry a dotted host.
    const hosts = new Set(
      [...haystack.matchAll(/\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/[A-Za-z0-9._$@{}/-]+/g)].map(
        (m) => m[1]!,
      ),
    );
    // The DATABASE_URL host and similar non-registry noise are not dotted
    // hosts followed by a path in practice, but filter defensively.
    const registryHosts = [...hosts].filter((h) => h !== "localhost");
    for (const host of registryHosts) {
      expect(
        ALLOWED_REGISTRY_HOSTS.has(host),
        `pg-integration references registry host "${host}", which is not in the ` +
          `allowlist [${[...ALLOWED_REGISTRY_HOSTS].join(", ")}]. WARP-1586 exists to ` +
          "control WHERE the Postgres bytes come from — widening this is a " +
          "supply-chain decision, not a refactor.",
      ).toBe(true);
    }
  });

  it("scopes the GHCR mirror to this repository", () => {
    const shell = jobShellText();
    // Whole line, not a token: the mirror ref embeds a `$(echo "…" | tr …)`
    // substitution, so anything that stops at the first quote truncates it
    // and would pass vacuously.
    const mirror = shell.match(/^.*ghcr\.io\/.*$/m);
    expect(mirror, "the lane must define a ghcr.io mirror reference").not.toBeNull();
    // Built from $GITHUB_REPOSITORY, not a hardcoded namespace someone else owns.
    expect(
      mirror![0],
      "the GHCR mirror must be derived from $GITHUB_REPOSITORY so it can only ever " +
        "resolve inside this repo's package namespace",
    ).toMatch(/\$\(echo "\$GITHUB_REPOSITORY"/);
  });
});

/**
 * WARP-1571 / WARP-1575 — readiness parity.
 *
 * The image parity above is only half of "works locally means works in CI".
 * Both lanes also have to agree on HOW they decide Postgres is ready, and on
 * a cold volume that is not a detail: the postgres docker-entrypoint's first
 * boot runs a TEMPORARY init server with `listen_addresses=''`, reachable
 * over the unix socket ONLY. It creates POSTGRES_DB mid-phase, stops, and
 * only then starts the real server. A socket `pg_isready` answers "accepting
 * connections" during that window, so the next client lands mid-shutdown
 * ("the database system is shutting down" / "database ... does not exist").
 * Load-dependent, so it passes on a warm cache and bites under load.
 *
 * The temp server never binds TCP, so `-h 127.0.0.1` cannot match it: the
 * first successful probe is the real server. (`pg_isready` also exits
 * non-zero while a server is still in recovery, so one TCP success suffices.)
 *
 * Only the Docker backend is at risk. The native backend runs `initdb`
 * itself, before pg_ctl start — there is no temp-server phase to race — and
 * it already probes `-h localhost -p <port>`.
 *
 * Shipping image parity while the readiness probe silently diverges would
 * leave "works locally" unreliable in exactly the way WARP-1571 was filed to
 * stop, and a flake here burns a developer's afternoon with no CI log to
 * read afterwards.
 */
describe("WARP-1571 pg-lane readiness parity (script vs CI)", () => {
  it("CI's readiness gate probes over TCP, never the unix socket", () => {
    const shell = jobShellText();
    expect(
      shell,
      "the pg-integration lane must gate on pg_isready -h 127.0.0.1",
    ).toMatch(/pg_isready\s+-h\s+127\.0\.0\.1/);
    const socketOnly = [...shell.matchAll(/^.*\bpg_isready\b.*$/gm)].filter(
      (m) => !/-h\s+127\.0\.0\.1/.test(m[0]),
    );
    expect(
      socketOnly.map((m) => m[0].trim()),
      "every pg_isready in the pg-integration job must be TCP-gated — a socket probe " +
        "reports healthy during the initdb temp server",
    ).toEqual([]);
  });

  it("test-orchestrator-pg.sh's Docker backend probes over TCP, never the unix socket", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(
      script,
      "the local Docker backend must gate on pg_isready -h 127.0.0.1, like CI does",
    ).toMatch(/pg_isready\s+-h\s+127\.0\.0\.1/);
  });

  it("the Docker backend never inlines a pg_isready that bypasses the shared probe", () => {
    const backend = scriptDockerBackend();
    const inlined = [...backend.matchAll(/^.*\bpg_isready\b.*$/gm)].map((m) => m[0].trim());
    expect(
      inlined,
      "run_with_docker() must use the $PG_READY_PROBE constant — an inline pg_isready " +
        "can silently drop the -h flag and reopen the cold-volume race",
    ).toEqual([]);
  });
});
