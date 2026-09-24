/**
 * WARP-2900 (ADR-056 slice H2) — the extension lifecycle.
 *
 *   - preflight BLOCKS a duplicate name (inside the manifest, against the
 *     catalog, against another extension or attached server) and memory over
 *     budget, and only ADVISES on a name that resembles a catalog tool;
 *   - every start re-verifies the stored statement: tampered bytes or a box
 *     key that changed since promote (a rebuilt disk) mark the extension
 *     `failed` and start nothing;
 *   - every start rotates the bearer, and the row holds only its hash;
 *   - the reconciler reinstalls what the sandbox lost (after re-verifying),
 *     leaves a running one alone, dials nothing with no rows, and stands down
 *     while process supervision is off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t" } }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null) }));

import {
  createExtensionLifecycle,
  EXTENSION_MAX_RECONCILE_RESTARTS,
  hashExtensionToken,
  installedExtensionIds,
  mintExtensionToken,
  preflightExtension,
  reconcileRestartCounts,
} from "./extension-lifecycle.service.js";
import { ExtensionSandboxError, type SandboxExtensionStatus } from "./extension-sandbox.client.js";
import {
  buildExtensionStatement,
  manifestSha256,
  parseExtensionManifest,
} from "./extension-manifest.js";
import { EXTENSION_STATEMENT_PREFIX } from "./update-agent/extension-verify.js";
import {
  COMMIT,
  TREE,
  extensionPrisma,
  fakeSandbox,
  fakeSidecar,
  manifestBytes,
} from "../__tests__/helpers/extension-test-kit.js";
import type { ActivityActor } from "./activity.service.js";

const OWNER: ActivityActor = { type: "user", id: "u-owner" };
const BUDGET = { ceilingMb: 512, source: "env" as const, transformHeadroomMb: 256, installedMb: 0, availableMb: 200 };

function parsed(bytes: Buffer) {
  const r = parseExtensionManifest(bytes);
  if (!r.ok) throw new Error(r.detail);
  return r.manifest;
}

describe("preflightExtension", () => {
  const base = { slug: "wc", budget: BUDGET, currentMemoryMb: 0, otherExtensionTools: new Map<string, string>() };

  it("passes a clean manifest", () => {
    const r = preflightExtension({ ...base, manifest: parsed(manifestBytes({ id: "wc" })), catalogToolNames: ["get_weather"], runtimeToolNames: [] });
    expect(r).toMatchObject({ ok: true, blocking: [], advisory: [] });
  });

  it("blocks catalog, extension and attached-server collisions and a duplicate", () => {
    // MUTATION: drop the catalogSet check and the first finding disappears.
    const manifest = parsed(manifestBytes({ id: "wc", tools: [{ name: "get_weather" }, { name: "shout" }, { name: "jira_search" }] }));
    manifest.provides.tools.push({ ...manifest.provides.tools[1] });
    const r = preflightExtension({
      ...base,
      manifest,
      catalogToolNames: ["get_weather"],
      otherExtensionTools: new Map([["shout", "ext-other"]]),
      runtimeToolNames: [{ serverId: "atlassian", name: "atlassian__jira_search" }],
    });
    expect(r.ok).toBe(false);
    expect(r.blocking.map((b) => b.code)).toEqual([
      "tool_name_collides_with_catalog",
      "tool_name_collides_with_extension",
      "tool_name_collides_with_extension",
      "tool_name_duplicated",
    ]);
  });

  it("does not count this extension's own attached tools as a collision", () => {
    const r = preflightExtension({
      ...base,
      manifest: parsed(manifestBytes({ id: "wc" })),
      catalogToolNames: [],
      runtimeToolNames: [{ serverId: "ext-wc", name: "ext-wc__word_count" }],
    });
    expect(r.ok).toBe(true);
  });

  it("blocks memory over what is left, counting what a reinstall frees", () => {
    const manifest = parsed(manifestBytes({ id: "wc", memoryMb: 250 }));
    const over = preflightExtension({ ...base, manifest, catalogToolNames: [], runtimeToolNames: [] });
    expect(over.blocking.map((b) => b.code)).toEqual(["memory_over_budget"]);
    const reinstall = preflightExtension({ ...base, manifest, currentMemoryMb: 64, catalogToolNames: [], runtimeToolNames: [] });
    expect(reinstall.ok).toBe(true);
  });

  it("only advises on a name that resembles a catalog tool", () => {
    const r = preflightExtension({
      ...base,
      manifest: parsed(manifestBytes({ id: "wc", tools: [{ name: "count_words" }] })),
      catalogToolNames: ["word_count_file", "list_devices"],
      runtimeToolNames: [],
    });
    expect(r.ok).toBe(true);
    expect(r.advisory.map((a) => a.code)).toEqual(["resembles_catalog_tool"]);
  });
});

describe("the bearer", () => {
  it("is dxt_ + 32 random bytes, hashed with sha256", () => {
    const a = mintExtensionToken();
    const b = mintExtensionToken();
    expect(a.token).toMatch(/^dxt_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashExtensionToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Seed a signed extension row the way a promote leaves it. */
function seedSigned(
  db: ReturnType<typeof extensionPrisma>,
  identity: ReturnType<typeof fakeSidecar>,
  opts: { slug?: string; status?: string; tamper?: boolean } = {},
) {
  const slug = opts.slug ?? "wc";
  const manifest = manifestBytes({ id: slug });
  const statement = buildExtensionStatement({
    extensionId: slug,
    workspaceId: slug,
    version: "0.1.0",
    commit: COMMIT,
    tree: TREE,
    manifestSha256: manifestSha256(manifest),
  });
  // Sign with the sidecar's current key, through its own envelope.
  return identity.signExtensionManifest(statement).then((signed) => {
    const vid = `v-${slug}`;
    db.versions.set(vid, {
      id: vid,
      extensionId: slug,
      version: "0.1.0",
      tag: "proposal/0.1.0",
      commit: COMMIT,
      tree: TREE,
      manifestBytes: opts.tamper ? manifestBytes({ id: slug, memoryMb: 65 }) : manifest,
      manifestSha256: manifestSha256(manifest),
      statementBytes: statement,
      signature: Buffer.from(signed.signature).toString("base64"),
      signer: "box",
      keyFingerprint: signed.keyFingerprint,
      promotedByUserId: "u-owner",
      createdAt: new Date(),
    });
    db.extensions.set(slug, {
      id: slug,
      workspaceId: slug,
      name: "Word counter",
      installedByUserId: "u-owner",
      status: opts.status ?? "signed",
      operatorDomain: null,
      currentVersionId: vid,
      serviceTokenHash: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
}

function kit() {
  const db = extensionPrisma();
  const sandbox = fakeSandbox();
  const identity = fakeSidecar();
  const audit = vi.fn(async (_p: unknown) => null);
  const attach = { attach: vi.fn(async (_s: string) => {}), detach: vi.fn(async (_s: string) => {}) };
  const lifecycle = createExtensionLifecycle({ prisma: db.prisma, sandbox: sandbox.client, identity, audit, attach });
  return { db, sandbox, identity, audit, attach, lifecycle };
}

beforeEach(() => {
  installedExtensionIds.clear();
  reconcileRestartCounts.clear();
});

/** What the fake sandbox reports for a process that is up. */
function running(slug: string): SandboxExtensionStatus {
  return {
    slug, workspaceId: slug, version: "0.1.0", runtime: "python312", memoryMb: 64, port: 18001,
    running: true, process: { state: "running", restarts: 0, exitCode: null },
  };
}

describe("install re-verifies and rotates", () => {
  it("installs a verified extension with a fresh bearer, attaches, audits", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity);
    const row = await k.lifecycle.install("wc", OWNER);
    expect(row.status).toBe("installed");
    const token = k.sandbox.installs[0].req.token;
    expect(k.db.extensions.get("wc")?.serviceTokenHash).toBe(hashExtensionToken(token));
    expect(k.attach.attach).toHaveBeenCalledWith("wc");
    expect(installedExtensionIds.has("ext-wc")).toBe(true);
    expect(k.audit.mock.calls[0][0]).toMatchObject({ kind: "tool_run", refs: { extensionId: "wc", op: "install" } });
    await k.lifecycle.install("wc", OWNER);
    expect(k.sandbox.installs[1].req.token).not.toBe(token);
  });

  it("tampered stored bytes → failed, nothing started", async () => {
    // MUTATION: skip the `if (!check.ok)` branch and the sandbox is asked to
    // run bytes nobody signed.
    const k = kit();
    await seedSigned(k.db, k.identity, { tamper: true });
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "verify_failed", httpStatus: 409 });
    expect(k.sandbox.installs).toEqual([]);
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "failed", serviceTokenHash: null });
    expect(String(k.db.extensions.get("wc")?.failureReason)).toMatch(/^extension_digest_mismatch/);
  });

  it("a box key that changed since promote (a rebuilt disk) → extension_key_changed, re-promote", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity);
    k.identity.rotateKey();
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "verify_failed" });
    expect(String(k.db.extensions.get("wc")?.failureReason)).toMatch(/^extension_key_changed/);
    expect(k.sandbox.installs).toEqual([]);
  });

  // Review #2323 blocker 2: the signature covers the statement, not the
  // row's plain columns. The sandbox must run what was signed, and a row
  // whose columns say otherwise is refused, not quietly corrected.
  it.each([
    ["commit", (k: ReturnType<typeof kit>) => { k.db.versions.get("v-wc")!.commit = "f".repeat(40); }],
    ["tree", (k: ReturnType<typeof kit>) => { k.db.versions.get("v-wc")!.tree = "e".repeat(40); }],
    ["version", (k: ReturnType<typeof kit>) => { k.db.versions.get("v-wc")!.version = "0.1.1"; }],
    ["workspaceId", (k: ReturnType<typeof kit>) => { k.db.extensions.get("wc")!.workspaceId = "other"; }],
  ])("a tampered %s column is refused, nothing starts", async (field, tamper) => {
    // MUTATION: drop the statement-vs-row comparison in install() and the
    // sandbox is asked to run whatever the columns now say (or, building
    // from the statement, the tamper goes unnoticed).
    const k = kit();
    await seedSigned(k.db, k.identity);
    tamper(k);
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "verify_failed", httpStatus: 409 });
    expect(k.sandbox.installs).toEqual([]);
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "failed", serviceTokenHash: null });
    expect(String(k.db.extensions.get("wc")?.failureReason)).toBe(
      `statement_mismatch: the stored ${field} is not the signed ${field}`,
    );
  });

  it("a row carrying another extension's validly signed statement is refused", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { slug: "wc" });
    await seedSigned(k.db, k.identity, { slug: "other" });
    const mine = k.db.versions.get("v-wc")!;
    const theirs = k.db.versions.get("v-other")!;
    // Everything signed comes from `other`; the row stays wc's.
    for (const key of ["statementBytes", "signature", "manifestBytes", "manifestSha256", "keyFingerprint"]) {
      mine[key] = theirs[key];
    }
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "verify_failed" });
    expect(k.sandbox.installs).toEqual([]);
    expect(String(k.db.extensions.get("wc")?.failureReason)).toBe(
      "statement_mismatch: the statement is for extension other, not wc",
    );
  });

  it("the sandbox is sent the signed statement's workspace, version, commit and tree", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity);
    await k.lifecycle.install("wc", OWNER);
    const statement = JSON.parse(Buffer.from(k.db.versions.get("v-wc")!.statementBytes as Buffer).toString("utf8"));
    expect(k.sandbox.installs[0].req).toMatchObject({
      workspaceId: statement.workspaceId,
      version: statement.version,
      commit: statement.commit,
      tree: statement.tree,
    });
  });

  it("an extension with no signed version is 409, unknown is 404", async () => {
    const k = kit();
    await expect(k.lifecycle.install("nope", OWNER)).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });

  it("a sandbox with supervision off is 503 supervision_off, and the row says failed", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity);
    k.sandbox.state.supervisionOff = true;
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "supervision_off", httpStatus: 503 });
    expect(k.db.extensions.get("wc")?.status).toBe("failed");
  });
});

describe("transitions are claimed in one statement (no read-then-write race)", () => {
  it("two concurrent disables: one wins, the other is 409", async () => {
    // MUTATION: go back to findUnique -> check -> update in disable() and
    // both requests pass the check.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    const results = await Promise.allSettled([
      k.lifecycle.disable("wc", OWNER),
      k.lifecycle.disable("wc", OWNER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "wrong_state", httpStatus: 409 });
    expect(k.sandbox.calls.filter((c) => c === "stop wc")).toHaveLength(1);
  });

  it("two concurrent enables start the extension once", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    const results = await Promise.allSettled([k.lifecycle.enable("wc", OWNER), k.lifecycle.enable("wc", OWNER)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(k.sandbox.installs).toHaveLength(1);
  });

  it("unknown is 404, already-uninstalled is 409", async () => {
    const k = kit();
    await expect(k.lifecycle.disable("nope", OWNER)).rejects.toMatchObject({ httpStatus: 404 });
    await seedSigned(k.db, k.identity, { status: "uninstalled" });
    await expect(k.lifecycle.uninstall("wc", OWNER)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(k.lifecycle.disable("wc", OWNER)).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("the reconciler", () => {
  it("dials nothing on a box with no extension at all", async () => {
    const k = kit();
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 0, restarted: [], failed: [], stopped: [] });
    expect(k.sandbox.calls).toEqual([]);
  });

  it("stops what the sandbox runs for a row that must not run (review #2323 (c))", async () => {
    // A disable or uninstall whose sandbox call failed, an install the
    // caller gave up on, a row left `signed` by an orchestrator restart
    // mid-install, or no row at all. MUTATION: read only installed/live rows
    // (the one-way reconciler) and every one of these keeps running.
    const k = kit();
    for (const [slug, status] of [["off", "disabled"], ["broke", "failed"], ["gone", "uninstalled"], ["stale", "signed"], ["idle", "disabled"]]) {
      await seedSigned(k.db, k.identity, { slug, status });
    }
    for (const slug of ["off", "broke", "gone", "stale", "orphan"]) k.sandbox.installed.set(slug, running(slug));
    k.sandbox.installed.set("idle", { ...running("idle"), running: false });
    const report = await k.lifecycle.reconcile();
    expect({ ...report, stopped: [...report.stopped].sort() }).toEqual({
      checked: 0, restarted: [], failed: [], stopped: ["broke", "gone", "off", "orphan", "stale"],
    });
    // A row that still exists keeps its sandbox copy (stopped); an uninstalled
    // row, or none, loses it (the uninstall the owner asked for).
    expect(k.sandbox.calls.filter((c) => c !== "list").sort()).toEqual(
      ["stop broke", "stop off", "stop stale", "uninstall gone", "uninstall orphan"],
    );
    for (const slug of ["off", "broke", "stale"]) expect(k.sandbox.installed.get(slug)?.running).toBe(false);
    expect(k.sandbox.installed.has("gone") || k.sandbox.installed.has("orphan")).toBe(false);
    const audits = k.audit.mock.calls.map((c) => c[0] as { severity: string; refs: { op: string; extensionId: string } });
    expect(audits.map((a) => a.refs.extensionId).sort()).toEqual(["broke", "gone", "off", "orphan", "stale"]);
    expect(audits.every((a) => a.severity === "warn" && a.refs.op === "reconcile")).toBe(true);
    // Nothing is left running that should not: the next tick stops nothing.
    expect((await k.lifecycle.reconcile()).stopped).toEqual([]);
  });

  it("leaves alone a process whose install is in flight (the row is `signed` until it lands)", async () => {
    // MUTATION: drop the in-flight check from the stray sweep and the
    // reconciler stops an enable (or a promote) half-way, failing it.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    const release = holdInstall(k);
    const enabling = k.lifecycle.enable("wc", OWNER);
    await untilSandboxInstall(k);
    k.sandbox.installed.set("wc", running("wc")); // the sandbox has started it, the row says signed
    expect((await k.lifecycle.reconcile()).stopped).toEqual([]);
    release();
    await expect(enabling).resolves.toMatchObject({ status: "installed" });
    expect(k.sandbox.calls).not.toContain("stop wc");
  });

  it("reinstalls what the sandbox lost, leaves a running one alone", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { slug: "lost", status: "installed" });
    await seedSigned(k.db, k.identity, { slug: "alive", status: "live" });
    k.sandbox.installed.set("alive", {
      slug: "alive", workspaceId: "alive", version: "0.1.0", runtime: "python312", memoryMb: 64, port: 18001,
      running: true, process: { state: "running", restarts: 0, exitCode: null },
    });
    const report = await k.lifecycle.reconcile();
    expect(report).toEqual({ checked: 2, restarted: ["lost"], failed: [], stopped: [] });
    expect(k.sandbox.installs.map((i) => i.slug)).toEqual(["lost"]);
    expect(k.audit.mock.calls.map((c) => (c[0] as { refs: { op: string } }).refs.op)).toEqual(["reconcile"]);
    expect([...installedExtensionIds].sort()).toEqual(["ext-alive", "ext-lost"]);
  });

  it("re-verifies before a restart: a statement that no longer verifies is not started", async () => {
    // MUTATION: call sandbox.install directly from reconcile() instead of
    // install() and the tampered extension is restarted.
    const k = kit();
    await seedSigned(k.db, k.identity, { slug: "bad", status: "installed", tamper: true });
    const report = await k.lifecycle.reconcile();
    expect(report).toEqual({ checked: 1, restarted: [], failed: ["bad"], stopped: [] });
    expect(k.sandbox.installs).toEqual([]);
    expect(k.db.extensions.get("bad")?.status).toBe("failed");
  });

  it("stands down while process supervision is off", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    k.sandbox.state.supervisionOff = true;
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: [], failed: [], stopped: [], skipped: "supervision_off" });
    expect(k.sandbox.installs).toEqual([]);
  });

  it("refreshInstalledIds mirrors the rows that should be running", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { slug: "a", status: "installed" });
    await seedSigned(k.db, k.identity, { slug: "b", status: "disabled" });
    installedExtensionIds.add("ext-stale");
    await k.lifecycle.refreshInstalledIds();
    expect([...installedExtensionIds]).toEqual(["ext-a"]);
  });
});

describe("a statement signed by a key the box never held", () => {
  it("is refused at install: the recorded fingerprint is the box key's, the signature is not", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const v = k.db.versions.get("v-wc")!;
    const forged = sign(
      "sha256",
      Buffer.concat([Buffer.from(EXTENSION_STATEMENT_PREFIX, "utf8"), v.statementBytes as Buffer]),
      privateKey,
    );
    v.signature = forged.toString("base64");
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "verify_failed" });
    expect(k.sandbox.installs).toEqual([]);
  });
});

/** A sandbox install that stays in flight (a long tsc) until released. */
function holdInstall(k: ReturnType<typeof kit>): () => void {
  let release: () => void = () => {};
  k.sandbox.state.installHold = new Promise<void>((r) => {
    release = r;
  });
  return release;
}

/** Let the pending install reach the sandbox (and park on the hold). */
async function untilSandboxInstall(k: ReturnType<typeof kit>, slug = "wc"): Promise<void> {
  for (let i = 0; i < 50 && !k.sandbox.calls.includes(`install ${slug}`); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(k.sandbox.calls).toContain(`install ${slug}`);
}

describe("an owner's kill switch beats an install in flight", () => {
  it("disable during an enable's install: the row stays disabled and the late process is stopped", async () => {
    // MUTATION: write the final `installed` with an unconditional update and
    // the row flips back to installed with the process running.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    const release = holdInstall(k);
    const enabling = k.lifecycle.enable("wc", OWNER).catch((e: unknown) => e);
    await untilSandboxInstall(k);
    await k.lifecycle.disable("wc", OWNER);
    release();
    expect(await enabling).toMatchObject({ code: "wrong_state", httpStatus: 409 });
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "disabled", serviceTokenHash: null });
    expect(installedExtensionIds.has("ext-wc")).toBe(false);
    expect(k.attach.attach).not.toHaveBeenCalled();
    // The process the sandbox started after the disable's stop is stopped again.
    const after = k.sandbox.calls.slice(k.sandbox.calls.indexOf("installed wc"));
    expect(after).toContain("stop wc");
    expect(k.sandbox.installed.get("wc")?.running).toBe(false);
  });

  it("uninstall during a reconcile restart: the row stays uninstalled and the sandbox copy is removed", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    const release = holdInstall(k);
    const reconciling = k.lifecycle.reconcile();
    await untilSandboxInstall(k);
    await k.lifecycle.uninstall("wc", OWNER);
    release();
    expect(await reconciling).toEqual({ checked: 1, restarted: [], failed: ["wc"], stopped: [] });
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "uninstalled", serviceTokenHash: null });
    const after = k.sandbox.calls.slice(k.sandbox.calls.indexOf("installed wc"));
    expect(after).toContain("uninstall wc");
    expect(k.sandbox.installed.has("wc")).toBe(false);
    expect(installedExtensionIds.has("ext-wc")).toBe(false);
  });

  it("a failed install does not overwrite a disable that landed meanwhile", async () => {
    // MUTATION: make markFailed an unconditional update and the disabled row
    // turns `failed` (and enable-able from a state the owner never chose).
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    const release = holdInstall(k);
    k.sandbox.state.failInstall = new Error("the TypeScript build failed");
    const enabling = k.lifecycle.enable("wc", OWNER).catch((e: unknown) => e);
    await untilSandboxInstall(k);
    await k.lifecycle.disable("wc", OWNER);
    release();
    expect(await enabling).toMatchObject({ code: "wrong_state", httpStatus: 409 });
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "disabled", failureReason: null });
  });

  it("an install the caller gave up on (TIMEOUT) is failed AND stopped: the late process does not run", async () => {
    // Review #2323 (a): the client stops waiting before the sandbox's worst
    // case, and the sandbox goes on to start the process. MUTATION: drop the
    // best-effort stop from install()'s failure branch and it keeps running
    // under a `failed` row.
    const k = kit();
    await seedSigned(k.db, k.identity);
    k.sandbox.state.startThenFail = new ExtensionSandboxError("the sandbox did not answer within 240000 ms", 504, "TIMEOUT");
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "install_failed", httpStatus: 502 });
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "failed", serviceTokenHash: null });
    expect(k.sandbox.calls.slice(k.sandbox.calls.indexOf("installed wc"))).toContain("stop wc");
    expect(k.sandbox.installed.get("wc")?.running).toBe(false);
  });

  it.each([
    ["disable", "disabled", "stop wc"],
    ["uninstall", "uninstalled", "uninstall wc"],
  ] as const)("a %s that lands while an install then fails (UNREACHABLE): the row stands and the late process is taken down", async (op, status, cleanup) => {
    // Review #2323 (a), the overtaken branch. MUTATION: `throw await
    // overtaken()` there (no cleanup) and the process runs under a row the
    // owner turned off.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    const release = holdInstall(k);
    k.sandbox.state.startThenFail = new ExtensionSandboxError("the sandbox could not be reached", 502, "UNREACHABLE");
    const enabling = k.lifecycle.enable("wc", OWNER).catch((e: unknown) => e);
    await untilSandboxInstall(k);
    await k.lifecycle[op]("wc", OWNER);
    release();
    expect(await enabling).toMatchObject({ code: "wrong_state", httpStatus: 409 });
    expect(k.db.extensions.get("wc")).toMatchObject({ status, serviceTokenHash: null });
    expect(k.sandbox.calls.slice(k.sandbox.calls.indexOf("installed wc"))).toContain(cleanup);
    expect(k.sandbox.installed.get("wc")?.running ?? false).toBe(false);
  });

  it("an install of a row that is not in an installable state touches nothing", async () => {
    // MUTATION: drop the early from-state check and a disabled row is
    // re-verified against the sidecar before the bearer write refuses it.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "wrong_state", httpStatus: 409 });
    expect(k.identity.getExtensionPublicKey).not.toHaveBeenCalled();
    expect(k.sandbox.calls).toEqual([]);
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "disabled", serviceTokenHash: null });
  });

  it("the bearer is not written for a row that left the install's state before it started", async () => {
    // MUTATION: write serviceTokenHash with update() and a disabled row gets
    // a live bearer back.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    const findUnique = k.db.raw.extension.findUnique;
    // The disable lands between install()'s read and its bearer write.
    findUnique.mockImplementationOnce(async (args: { where: { id: string } }) => {
      const row = await findUnique.getMockImplementation()!(args);
      k.db.extensions.get("wc")!.status = "disabled";
      return row;
    });
    await expect(k.lifecycle.install("wc", OWNER)).rejects.toMatchObject({ code: "wrong_state" });
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "disabled", serviceTokenHash: null });
    expect(k.sandbox.installs).toEqual([]);
  });
});

describe("the owner's kill switch survives a sandbox call that fails (review #2323 (b))", () => {
  it("a disable whose stop failed can be retried while the process runs, and the retry stops it", async () => {
    // MUTATION: keep disable's claim strict (no retry from `disabled`) and
    // the retry is a 409 while the process keeps running.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    k.sandbox.installed.set("wc", running("wc"));
    k.sandbox.state.failStop = new ExtensionSandboxError("the sandbox could not be reached", 502, "UNREACHABLE");
    await expect(k.lifecycle.disable("wc", OWNER)).rejects.toMatchObject({ code: "UNREACHABLE" });
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "disabled", serviceTokenHash: null });
    expect(k.sandbox.installed.get("wc")?.running).toBe(true);
    const failed = k.audit.mock.calls.at(-1)?.[0] as { severity: string; refs: { op: string } };
    expect(failed).toMatchObject({ severity: "warn", refs: { op: "disable" } });

    k.sandbox.state.failStop = null;
    await expect(k.lifecycle.disable("wc", OWNER)).resolves.toMatchObject({ status: "disabled" });
    expect(k.sandbox.installed.get("wc")?.running).toBe(false);
    // Nothing left to stop: now a disable is the ordinary 409.
    await expect(k.lifecycle.disable("wc", OWNER)).rejects.toMatchObject({ code: "wrong_state", httpStatus: 409 });
  });

  it("an uninstall whose sandbox call failed can be retried while the sandbox holds the extension", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    k.sandbox.installed.set("wc", { ...running("wc"), running: false });
    k.sandbox.state.failStop = new ExtensionSandboxError("boom", 502, "SANDBOX_ERROR");
    await expect(k.lifecycle.uninstall("wc", OWNER)).rejects.toMatchObject({ code: "SANDBOX_ERROR" });
    expect(k.db.extensions.get("wc")?.status).toBe("uninstalled");
    k.sandbox.state.failStop = null;
    await expect(k.lifecycle.uninstall("wc", OWNER)).resolves.toMatchObject({ status: "uninstalled" });
    expect(k.sandbox.installed.has("wc")).toBe(false);
    await expect(k.lifecycle.uninstall("wc", OWNER)).rejects.toMatchObject({ code: "wrong_state", httpStatus: 409 });
  });
});

describe("the reconciler does not rebuild a process that keeps dying", () => {
  it("a dead process is reinstalled through install() at most EXTENSION_MAX_RECONCILE_RESTARTS times, then marked failed", async () => {
    // Review #2323 item 5: the sandbox never restarts an extension itself
    // (restart "never"); install() is the only way back, and it re-verifies
    // and rotates the bearer every time. MUTATIONS: no bound -> rebuilt every
    // tick; no restart -> the first death is final.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    const die = () =>
      k.sandbox.installed.set("wc", { ...running("wc"), running: false, process: { state: "failed", restarts: 0, exitCode: 1 } });
    for (let i = 0; i < EXTENSION_MAX_RECONCILE_RESTARTS; i += 1) {
      die();
      expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: ["wc"], failed: [], stopped: [] });
    }
    const tokens = new Set(k.sandbox.installs.map((i) => i.req.token));
    expect(tokens.size).toBe(EXTENSION_MAX_RECONCILE_RESTARTS);
    die();
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: [], failed: ["wc"], stopped: [] });
    expect(k.sandbox.installs).toHaveLength(EXTENSION_MAX_RECONCILE_RESTARTS);
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "failed", serviceTokenHash: null });
    expect(String(k.db.extensions.get("wc")?.failureReason)).toBe(
      `process_failed: exit code 1 after ${EXTENSION_MAX_RECONCILE_RESTARTS} restarts`,
    );
    // The next tick has nothing to do: the row is no longer one that should run.
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 0, restarted: [], failed: [], stopped: [] });
  });

  it("the owner's disable and enable give it a whole budget again", async () => {
    // MUTATION: drop the reset in install() for an owner's start and the
    // restarts spent before the owner stepped in still count.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    const die = () =>
      k.sandbox.installed.set("wc", { ...running("wc"), running: false, process: { state: "exited", restarts: 0, exitCode: 0 } });
    for (let i = 0; i < EXTENSION_MAX_RECONCILE_RESTARTS - 1; i += 1) {
      die();
      expect((await k.lifecycle.reconcile()).restarted).toEqual(["wc"]);
    }
    await k.lifecycle.disable("wc", OWNER);
    await k.lifecycle.enable("wc", OWNER);
    for (let i = 0; i < EXTENSION_MAX_RECONCILE_RESTARTS; i += 1) {
      die();
      expect((await k.lifecycle.reconcile()).restarted).toEqual(["wc"]);
    }
  });

  it("a stopped process (the sandbox kept it, nothing is running it) is restarted", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    k.sandbox.installed.set("wc", {
      slug: "wc", workspaceId: "wc", version: "0.1.0", runtime: "python312", memoryMb: 64, port: 18001,
      running: false, process: { state: "stopped", restarts: 0, exitCode: -15 },
    });
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: ["wc"], failed: [], stopped: [] });
  });
});

describe("enable preflights like a promote", () => {
  it("a tool name another extension took while this one was disabled blocks the enable, and nothing moves", async () => {
    // MUTATION: drop the preflight from enable() and two servers offer word_count.
    const k = kit();
    await seedSigned(k.db, k.identity, { slug: "wc", status: "disabled" });
    await seedSigned(k.db, k.identity, { slug: "other", status: "installed" });
    await expect(k.lifecycle.enable("wc", OWNER)).rejects.toMatchObject({
      code: "preflight_blocked",
      httpStatus: 422,
      body: { preflight: { ok: false, blocking: [{ code: "tool_name_collides_with_extension" }] } },
    });
    expect(k.db.extensions.get("wc")?.status).toBe("disabled");
    expect(k.sandbox.installs).toEqual([]);
  });
});

