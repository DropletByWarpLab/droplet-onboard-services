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
  hashExtensionToken,
  installedExtensionIds,
  mintExtensionToken,
  preflightExtension,
} from "./extension-lifecycle.service.js";
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

beforeEach(() => installedExtensionIds.clear());

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
  it("dials nothing when there is nothing to run", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "disabled" });
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 0, restarted: [], failed: [] });
    expect(k.sandbox.calls).toEqual([]);
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
    expect(report).toEqual({ checked: 2, restarted: ["lost"], failed: [] });
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
    expect(report).toEqual({ checked: 1, restarted: [], failed: ["bad"] });
    expect(k.sandbox.installs).toEqual([]);
    expect(k.db.extensions.get("bad")?.status).toBe("failed");
  });

  it("stands down while process supervision is off", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    k.sandbox.state.supervisionOff = true;
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: [], failed: [], skipped: "supervision_off" });
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
    expect(await reconciling).toEqual({ checked: 1, restarted: [], failed: ["wc"] });
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

describe("the reconciler does not rebuild a process that keeps dying", () => {
  it("a process the sandbox reports failed after its restarts is marked failed, not reinstalled", async () => {
    // MUTATION: treat every not-running status as lost and the extension is
    // rebuilt (export, tsc, new bearer, audit row) every tick.
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    k.sandbox.installed.set("wc", {
      slug: "wc", workspaceId: "wc", version: "0.1.0", runtime: "python312", memoryMb: 64, port: 18001,
      running: false, process: { state: "failed", restarts: 5, exitCode: 1 },
    });
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: [], failed: ["wc"] });
    expect(k.sandbox.installs).toEqual([]);
    expect(k.db.extensions.get("wc")).toMatchObject({ status: "failed", serviceTokenHash: null });
    expect(String(k.db.extensions.get("wc")?.failureReason)).toMatch(/^process_failed: exit code 1 after 5 restarts/);
    expect(k.audit.mock.calls.map((c) => (c[0] as { severity: string; refs: { op: string } }).refs.op)).toEqual(["reconcile"]);
    // The next tick has nothing to do: the row is no longer one that should run.
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 0, restarted: [], failed: [] });
  });

  it("a stopped process (the sandbox kept it, nothing is running it) is restarted", async () => {
    const k = kit();
    await seedSigned(k.db, k.identity, { status: "installed" });
    k.sandbox.installed.set("wc", {
      slug: "wc", workspaceId: "wc", version: "0.1.0", runtime: "python312", memoryMb: 64, port: 18001,
      running: false, process: { state: "stopped", restarts: 0, exitCode: -15 },
    });
    expect(await k.lifecycle.reconcile()).toEqual({ checked: 1, restarted: ["wc"], failed: [] });
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

