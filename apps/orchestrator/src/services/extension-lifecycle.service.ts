/**
 * WARP-2900 (ADR-056 slice H2): what happens to a promoted extension after
 * it is signed — preflight, install, disable, enable, uninstall, and the
 * reconciler that reinstalls one the sandbox lost.
 *
 * EVERY START RE-VERIFIES. Before the sandbox is asked to run anything, the
 * stored statement bytes, signature and manifest bytes are verified again
 * (update-agent/extension-verify.ts) with the signer and key fingerprint
 * recorded at promote as the expectation. A statement that no longer
 * verifies — a rebuilt boot disk means a new box extension key
 * (extension_key_changed) — marks the extension `failed` with the reason and
 * starts nothing; the owner re-promotes. The sandbox is then sent the
 * SIGNED statement's workspace, version, commit and tree, never the row's
 * columns, and a row whose columns disagree with its statement (or that
 * carries another extension's statement) is refused the same way
 * (statement_mismatch, review #2323).
 *
 * EVERY START ROTATES THE BEARER. The extension's call-back bearer (`dxt_`
 * + 32 random bytes) is minted here, its sha256 stored on the row, and the
 * plaintext handed to the sandbox ONLY in the install request, which puts it
 * in the child's environment and nowhere else. A stop clears the hash. The
 * orchestrator side of the call-back (resolving `dxt_` to the
 * `_service:ext:<slug>` principal) is WARP-2900 H3.
 *
 * EVERY WRITE IS CLAIMED. An install takes up to four minutes (export, tsc,
 * start, ready ping), and the owner's disable or uninstall may land in the
 * middle of it. So each of install()'s writes — the bearer hash, the final
 * `installed`, a `failed` — is an updateMany whose WHERE still carries the
 * statuses the install started from. If the row has left them, the owner
 * won: the install stops (or removes) whatever the sandbox started, and
 * answers 409 wrong_state instead of reviving the extension. An install that
 * FAILS stops what the sandbox may still start too: a TIMEOUT or UNREACHABLE
 * is this side giving up, not the sandbox (review #2323).
 *
 * THE KILL SWITCH IS RETRYABLE. A disable or uninstall claims its row first
 * (so an install in flight loses), then asks the sandbox. If that call fails
 * the row already says `disabled` / `uninstalled`, and a retry of the same
 * transition acts on it again while the sandbox still runs (holds) the
 * extension, instead of answering 409.
 *
 * THE RECONCILER GOES BOTH WAYS. It reinstalls a row that should run and
 * does not (through install(), so re-verified and with a new bearer), and it
 * stops a process the sandbox runs for a row that should not: a kill switch
 * whose sandbox call failed, an install that outlived its caller. A dead
 * process is reinstalled at most EXTENSION_MAX_RECONCILE_RESTARTS times: the
 * sandbox never restarts an extension itself (restart "never"), because the
 * files it would restart from are writable by the same uid as every
 * workspace run.
 *
 * `installedExtensionIds` is the set of multiplexer server ids
 * (`ext-<slug>`) this process considers installed. H3's
 * mcp-client.singleton reads it to decide which extension servers may
 * attach; it is maintained here, from the database, never from env.
 *
 * LIVE MEANS ATTACHED (H3). `installed` is "the sandbox runs it"; `live` is
 * "and its tools are in this orchestrator's runtime layer". After a start
 * the attach port (extension-attach.service) lists the extension's tools
 * through the relay and checks them against the signed manifest. A listing
 * that differs is refused for good: the row goes `failed` and the process
 * is stopped. An extension that does not answer yet stays `installed` and
 * the reconciler attaches it on a later tick — the same tick that
 * re-attaches every running extension after an orchestrator restart, since
 * the attachment lives in this process's memory and the sandbox's process
 * outlives it. Re-attached as it runs is only the process install() started
 * (`restarts` 0): one the sandbox restarted in place, or one with no process
 * record, is reinstalled through install() first (review #2325).
 *
 * AUDIT: every transition writes a `tool_run` activity row with
 * `refs.extensionId` and `refs.op` — no new activity kind.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";
import { createLogger } from "../lib/logger.js";
import type { ActivityActor, RecordParams } from "./activity.service.js";
import { recordActivity } from "./activity.singleton.js";
import {
  parseExtensionManifest,
  type ExtensionManifest,
  type ExtensionStatement,
} from "./extension-manifest.js";
import {
  ExtensionSandboxError,
  type ExtensionSandboxClient,
  type SandboxBudget,
  type SandboxExtensionStatus,
  type SandboxHeldExtension,
} from "./extension-sandbox.client.js";
import { runtimeToolRegistry } from "./runtime-tool-registry.service.js";
import { verifyExtensionStatement, type ExtensionSigner } from "./update-agent/extension-verify.js";
import { EXTENSION_SERVER_PREFIX, EXTENSION_TOKEN_PREFIX, hashExtensionToken } from "./extension-token.js";

export { EXTENSION_SERVER_PREFIX, EXTENSION_TOKEN_PREFIX, hashExtensionToken };

const logger = createLogger("extension-lifecycle");

export const EXTENSION_RECONCILE_LOCK_KEY = "droplet:extension-reconciler";
export const EXTENSION_TICKET = "WARP-2900";

/** Statuses whose process should be running. */
export const RUNNING_EXTENSION_STATUSES = ["installed", "live"] as const;

/** Server ids (`ext-<slug>`) this process treats as installed. */
export const installedExtensionIds = new Set<string>();

/**
 * Slugs with an install() in flight, counted (a promote and a reconcile may
 * overlap). Module state, like installedExtensionIds: the routes' lifecycle
 * and the reconciler's are two instances in one process, and the stray sweep
 * must not stop what a promote or an enable is starting (its row is `signed`
 * until the start lands).
 */
const installsInFlight = new Map<string, number>();

/** How many times in a row the reconciler may reinstall a dead process. */
export const EXTENSION_MAX_RECONCILE_RESTARTS = 5;

/**
 * Reinstalls the reconciler has spent on each slug's dead process since the
 * owner last started it. Module state for the same reason as above: an
 * owner's install or enable (the routes' instance) resets it.
 */
export const reconcileRestartCounts = new Map<string, number>();

export function extensionServerId(slug: string): string {
  return `${EXTENSION_SERVER_PREFIX}${slug}`;
}

export function mintExtensionToken(): { token: string; hash: string } {
  const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashExtensionToken(token) };
}

// ─── preflight ───────────────────────────────────────────────────────────

export type PreflightCode =
  | "memory_over_budget"
  | "tool_name_duplicated"
  | "tool_name_collides_with_catalog"
  | "tool_name_collides_with_extension"
  | "resembles_catalog_tool";

export interface PreflightFinding {
  code: PreflightCode;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  blocking: PreflightFinding[];
  advisory: PreflightFinding[];
  budget: { availableMb: number; requestedMb: number; ceilingMb: number };
}

/** Name words, singularised crudely ("words" ~ "word") for the overlap test. */
const words = (name: string): Set<string> =>
  new Set(
    name
      .split(/[_\-\s]+/)
      .filter((w) => w.length > 1)
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );

function resembles(a: string, b: string): boolean {
  if (a === b) return false; // an exact match is a blocking collision, not advice
  if (a.includes(b) || b.includes(a)) return true;
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / new Set([...wa, ...wb]).size >= 0.5;
}

export interface PreflightInput {
  slug: string;
  manifest: ExtensionManifest;
  budget: SandboxBudget;
  /** Memory this slug's running version already holds (freed by a reinstall). */
  currentMemoryMb: number;
  /** Tool names other extensions provide (bare names from their manifests). */
  otherExtensionTools: ReadonlyMap<string, string>;
  catalogToolNames?: readonly string[];
  runtimeToolNames?: ReadonlyArray<{ serverId: string; name: string }>;
}

/**
 * BLOCKS on: memory over what the sandbox has left, a duplicate tool name
 * inside the manifest, a name the static catalog already has, or a name
 * another extension or attached server already provides. ADVISES (never
 * blocks) on a name that resembles a catalog tool — possible duplicated
 * functionality the owner should know about.
 */
export function preflightExtension(input: PreflightInput): PreflightResult {
  const blocking: PreflightFinding[] = [];
  const advisory: PreflightFinding[] = [];
  const requestedMb = input.manifest.resources.memoryMb;
  const availableMb = input.budget.availableMb + input.currentMemoryMb;
  if (requestedMb > availableMb) {
    blocking.push({
      code: "memory_over_budget",
      detail: `asks for ${requestedMb} MB; ${availableMb} MB is left of the sandbox's ${input.budget.ceilingMb} MB (${input.budget.transformHeadroomMb} MB is kept for transforms)`,
    });
  }
  const catalog = input.catalogToolNames ?? TOOL_CATALOG.map((t) => t.name);
  const catalogSet = new Set(catalog);
  const serverId = extensionServerId(input.slug);
  const runtimeBare = new Map<string, string>();
  for (const t of input.runtimeToolNames ?? runtimeToolRegistry.list()) {
    if (t.serverId === serverId) continue;
    const bare = t.name.includes("__") ? t.name.slice(t.name.lastIndexOf("__") + 2) : t.name;
    runtimeBare.set(bare, t.serverId);
  }
  const seen = new Set<string>();
  for (const tool of input.manifest.provides.tools) {
    if (seen.has(tool.name)) {
      blocking.push({ code: "tool_name_duplicated", detail: `${tool.name} is declared twice` });
      continue;
    }
    seen.add(tool.name);
    if (catalogSet.has(tool.name)) {
      blocking.push({
        code: "tool_name_collides_with_catalog",
        detail: `${tool.name} is already a built-in tool`,
      });
    }
    const owner = input.otherExtensionTools.get(tool.name) ?? runtimeBare.get(tool.name);
    if (owner) {
      blocking.push({
        code: "tool_name_collides_with_extension",
        detail: `${tool.name} is already provided by ${owner}`,
      });
    }
    const alike = catalog.filter((c) => resembles(tool.name, c));
    if (alike.length > 0) {
      advisory.push({
        code: "resembles_catalog_tool",
        detail: `${tool.name} resembles built-in ${alike.slice(0, 3).join(", ")}; it may duplicate what the box already does`,
      });
    }
  }
  return {
    ok: blocking.length === 0,
    blocking,
    advisory,
    budget: { availableMb, requestedMb, ceilingMb: input.budget.ceilingMb },
  };
}

// ─── lifecycle ───────────────────────────────────────────────────────────

export type ExtensionLifecycleErrorCode =
  | "not_found"
  | "preflight_blocked"
  | "not_promoted"
  | "wrong_state"
  | "verify_failed"
  | "install_failed"
  | "supervision_off"
  | "attach_refused";

export class ExtensionLifecycleError extends Error {
  constructor(
    readonly code: ExtensionLifecycleErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ExtensionLifecycleError";
  }
}

/**
 * The multiplexer attach/detach (extension-attach.service, H3). `attach`
 * throws {@link ExtensionAttachError}; `isAttached` lets the reconciler find
 * a running extension this process has not attached (an orchestrator
 * restart). Without `isAttached` the reconciler never re-attaches.
 */
export interface ExtensionAttachPort {
  attach(slug: string): Promise<unknown>;
  detach(slug: string): Promise<void>;
  isAttached?(slug: string): boolean;
}

export type ExtensionAttachErrorCode =
  | "sandbox_url_refused"
  | "not_promoted"
  | "listing_unavailable"
  | "listing_mismatch"
  | "attach_rejected"
  /** The review could not be recorded or re-read: transient, retried. */
  | "classification_unavailable"
  /** The stored statement no longer verifies, or the row disagrees with it. */
  | "statement_unverified"
  /** The box's extension key could not be read (the sidecar): transient. */
  | "statement_unavailable";

/**
 * Why an attach did not happen. `permanent` is the lifecycle's switch: a
 * permanent refusal (the listing is not what was signed, the server is not
 * allowed) fails the extension and stops its process; a transient one (it
 * did not answer) leaves it `installed` for the reconciler to retry.
 */
export class ExtensionAttachError extends Error {
  constructor(
    readonly code: ExtensionAttachErrorCode,
    readonly permanent: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionAttachError";
  }
}

export interface ExtensionKeySource {
  getExtensionPublicKey(): Promise<{ spkiDer: Uint8Array; fingerprint: string } | null>;
}

export interface ExtensionLifecycleDeps {
  prisma: PrismaClient;
  sandbox: ExtensionSandboxClient;
  identity: ExtensionKeySource;
  attach?: ExtensionAttachPort;
  audit?: (params: RecordParams) => Promise<unknown>;
  /** Handed to the child as DROPLET_ORCHESTRATOR_URL (the H3 call-back). */
  orchestratorUrl?: string;
}

export type LifecycleOp = "promote" | "install" | "disable" | "enable" | "uninstall" | "reconcile";

type ExtensionStatusName = "signed" | "installed" | "live" | "disabled" | "failed" | "uninstalled";

type InstallOp = "install" | "enable" | "reconcile";

/**
 * The statuses each install path may start from — and must still find at
 * every write. A promote installs a freshly signed row (or reinstalls a
 * running one); an enable has claimed the row to `signed`; the reconciler
 * restarts rows that should be running.
 */
const INSTALL_FROM: Record<InstallOp, readonly ExtensionStatusName[]> = {
  install: ["signed", "installed", "live"],
  enable: ["signed"],
  reconcile: ["installed", "live"],
};

/**
 * Why the row is not what was signed, or null. The statement names the
 * extension (its slug), the workspace, the version, the commit and the tree;
 * the row's copies of them are plain columns no signature covers.
 */
export function statementMismatch(
  slug: string,
  workspaceId: string,
  row: { version: string; commit: string; tree: string },
  signed: Pick<ExtensionStatement, "extensionId" | "workspaceId" | "version" | "commit" | "tree">,
): string | null {
  if (signed.extensionId !== slug) return `the statement is for extension ${signed.extensionId}, not ${slug}`;
  if (signed.workspaceId !== workspaceId) return "the stored workspaceId is not the signed workspaceId";
  for (const field of ["version", "commit", "tree"] as const) {
    if (row[field] !== signed[field]) return `the stored ${field} is not the signed ${field}`;
  }
  return null;
}

/** The signed columns of a stored ExtensionVersion. */
export interface StoredExtensionVersion {
  version: string;
  commit: string;
  tree: string;
  statementBytes: Uint8Array;
  signature: string;
  manifestBytes: Uint8Array;
  signer: ExtensionSigner;
  keyFingerprint: string;
}

export type StoredExtensionVersionCheck =
  | { ok: true; manifest: ExtensionManifest; statement: ExtensionStatement }
  | { ok: false; failureReason: string; detail: string };

/**
 * Re-verify a stored version: the statement's signature by the signer and
 * key recorded at promote, the manifest's digest against the statement, and
 * the row's plain columns against the statement ({@link statementMismatch}).
 * What install() starts and what the attach pins both come from here, never
 * from the row alone. `boxKey` is the box extension key now (null: none).
 */
export async function verifyStoredExtensionVersion(
  slug: string,
  workspaceId: string,
  v: StoredExtensionVersion,
  boxKey: { spkiDer: Uint8Array } | null,
): Promise<StoredExtensionVersionCheck> {
  const check = await verifyExtensionStatement({
    statement: v.statementBytes,
    signature: v.signature,
    manifest: v.manifestBytes,
    boxKey,
    recorded: { signer: v.signer, keyFingerprint: v.keyFingerprint },
  });
  if (!check.ok) return { ok: false, failureReason: check.failureReason, detail: check.detail };
  const mismatch = statementMismatch(slug, workspaceId, v, check.statement);
  if (mismatch) return { ok: false, failureReason: "statement_mismatch", detail: mismatch };
  return { ok: true, manifest: check.manifest, statement: check.statement };
}

/** Supervisor states that mean the process died: the sandbox never restarts one. */
const DEAD_PROCESS_STATES: ReadonlySet<string> = new Set(["failed", "exited"]);

const SYSTEM_ACTOR: ActivityActor = { type: "system", id: null };

export interface ReconcileReport {
  checked: number;
  restarted: string[];
  failed: string[];
  /** Running in the sandbox, attached again by this tick (H3). */
  reattached: string[];
  /** Processes the sandbox ran for a row that must not run, now stopped. */
  stopped: string[];
  skipped?: "supervision_off";
}

export function createExtensionLifecycle(deps: ExtensionLifecycleDeps) {
  const { prisma, sandbox, identity } = deps;
  const audit = deps.audit ?? recordActivity;
  // No port → nothing is attached, and nothing claims to be: the row stays
  // `installed` (`live` is only ever written after a real attach).
  const attach: ExtensionAttachPort | null = deps.attach ?? null;

  async function record(
    op: LifecycleOp,
    slug: string,
    actor: ActivityActor,
    extra: { severity?: "info" | "warn"; what: string; sub?: string; refs?: Record<string, unknown> },
  ): Promise<void> {
    await audit({
      kind: "tool_run",
      severity: extra.severity ?? "info",
      sourceIcon: "puzzle",
      what: extra.what,
      sub: extra.sub ?? slug,
      actor,
      refs: { extensionId: slug, op, ticket: EXTENSION_TICKET, ...(extra.refs ?? {}) },
    });
  }

  async function load(slug: string) {
    const ext = await prisma.extension.findUnique({
      where: { id: slug },
      include: { currentVersion: true },
    });
    if (!ext) throw new ExtensionLifecycleError("not_found", 404, `no extension ${slug}`);
    return ext;
  }

  /**
   * `failed` only while the row is still in `from`; false when someone else
   * moved it. A failed extension is never left attached: a re-install of a
   * live one (a promote) that fails before its attach would otherwise leave
   * the previous version's tools in the multiplexer.
   */
  async function markFailed(slug: string, reason: string, from: readonly ExtensionStatusName[]): Promise<boolean> {
    installedExtensionIds.delete(extensionServerId(slug));
    if (attach) {
      await attach.detach(slug).catch((err: unknown) => logger.warn({ err, slug }, "extension_detach_on_failure_failed"));
    }
    const u = await prisma.extension.updateMany({
      where: { id: slug, status: { in: [...from] } },
      data: { status: "failed", failureReason: reason.slice(0, 1000), serviceTokenHash: null },
    });
    return u.count > 0;
  }

  /** A sandbox stop that must not fail the caller: logged, never thrown. */
  async function stopQuietly(slug: string, event: string): Promise<void> {
    try {
      await sandbox.stop(slug);
    } catch (err) {
      logger.warn({ err, slug }, event);
    }
  }

  async function overtaken(slug: string): Promise<ExtensionLifecycleError> {
    const now = await load(slug);
    return new ExtensionLifecycleError(
      "wrong_state",
      409,
      `extension ${slug} became ${now.status} while it was being installed; that stands`,
    );
  }

  /**
   * The owner's disable/uninstall won while the sandbox was starting the
   * process: take down what the sandbox started, the way the winning
   * transition would have if the process had existed when it ran.
   */
  async function undoOvertakenInstall(slug: string, actor: ActivityActor, op: InstallOp): Promise<never> {
    installedExtensionIds.delete(extensionServerId(slug));
    const now = await load(slug);
    try {
      if (now.status === "uninstalled") await sandbox.uninstall(slug);
      else await sandbox.stop(slug);
    } catch (e) {
      logger.warn({ err: e, slug, status: now.status }, "extension_overtaken_install_cleanup_failed");
    }
    await record(op, slug, actor, {
      severity: "warn",
      what: `Extension install stopped: it was ${now.status} meanwhile`,
      refs: { status: now.status },
    });
    throw new ExtensionLifecycleError(
      "wrong_state",
      409,
      `extension ${slug} became ${now.status} while it was being installed; that stands`,
    );
  }

  async function install(slug: string, actor: ActivityActor, op: InstallOp) {
    installsInFlight.set(slug, (installsInFlight.get(slug) ?? 0) + 1);
    try {
      return await installOnce(slug, actor, op);
    } finally {
      const n = (installsInFlight.get(slug) ?? 1) - 1;
      if (n > 0) installsInFlight.set(slug, n);
      else installsInFlight.delete(slug);
    }
  }

  async function installOnce(slug: string, actor: ActivityActor, op: InstallOp) {
    const from = INSTALL_FROM[op];
    const ext = await load(slug);
    if (!from.includes(ext.status as ExtensionStatusName)) {
      throw new ExtensionLifecycleError("wrong_state", 409, `extension ${slug} is ${ext.status}`);
    }
    const v = ext.currentVersion;
    if (!v) throw new ExtensionLifecycleError("not_promoted", 409, `extension ${slug} has no signed version`);

    // 1. Re-verify the stored bytes, the recorded signer and key.
    let boxKey: { spkiDer: Uint8Array } | null = null;
    if (v.signer === "box") {
      try {
        const k = await identity.getExtensionPublicKey();
        boxKey = k ? { spkiDer: k.spkiDer } : null;
      } catch (err) {
        logger.warn({ err, slug }, "extension_key_unavailable");
        boxKey = null;
      }
    }
    // The signature covers the statement, never the row's plain columns
    // (review #2323). A row whose workspace, version, commit or tree says
    // something the statement does not, or that carries another extension's
    // statement, is refused (statement_mismatch). What the sandbox is sent
    // comes from the statement alone.
    const check = await verifyStoredExtensionVersion(slug, ext.workspaceId, v, boxKey);
    if (!check.ok) {
      const reason = `${check.failureReason}: ${check.detail}`;
      if (!(await markFailed(slug, reason, from))) throw await overtaken(slug);
      await record(op, slug, actor, {
        severity: "warn",
        what:
          check.failureReason === "statement_mismatch"
            ? "Extension refused: its row is not what was signed"
            : "Extension refused: its signed statement no longer verifies",
        refs: { version: v.version, failureReason: check.failureReason },
      });
      throw new ExtensionLifecycleError("verify_failed", 409, reason);
    }
    const manifest = check.manifest;
    const signed = check.statement;

    // 2. Rotate the bearer BEFORE the start: the child may call back at once.
    const { token, hash } = mintExtensionToken();
    const claimed = await prisma.extension.updateMany({
      where: { id: slug, status: { in: [...from] } },
      data: { serviceTokenHash: hash },
    });
    if (claimed.count === 0) throw await overtaken(slug);

    // 3. Start it.
    try {
      await sandbox.install(slug, {
        workspaceId: signed.workspaceId,
        version: signed.version,
        commit: signed.commit,
        tree: signed.tree,
        runtime: manifest.runtime,
        entrypoint: manifest.entrypoint,
        memoryMb: manifest.resources.memoryMb,
        token,
        ...(deps.orchestratorUrl ? { orchestratorUrl: deps.orchestratorUrl } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // The owner's disable or uninstall landed meanwhile: take down what the
      // sandbox may have started, the way that transition would have.
      if (!(await markFailed(slug, `install_failed: ${reason}`, from))) return undoOvertakenInstall(slug, actor, op);
      // A TIMEOUT or UNREACHABLE is this side giving up, not the sandbox,
      // which may go on to start the process; the row is `failed`, so nothing
      // may run it. Best effort now; one the sandbox starts after this stop
      // is the reconciler's stray sweep's.
      await stopQuietly(slug, "extension_failed_install_cleanup_failed");
      await record(op, slug, actor, {
        severity: "warn",
        what: "Extension install failed",
        refs: { version: v.version, error: reason.slice(0, 300) },
      });
      if (err instanceof ExtensionSandboxError && err.code === "SUPERVISION_OFF") {
        throw new ExtensionLifecycleError("supervision_off", 503, reason);
      }
      throw new ExtensionLifecycleError("install_failed", 502, reason);
    }

    const done = await prisma.extension.updateMany({
      where: { id: slug, status: { in: [...from] } },
      data: { status: "installed", failureReason: null },
    });
    if (done.count === 0) return undoOvertakenInstall(slug, actor, op);
    // The owner started it: the reconciler's restart budget is whole again.
    if (op !== "reconcile") reconcileRestartCounts.delete(slug);
    installedExtensionIds.add(extensionServerId(slug));
    await record(op, slug, actor, {
      what: op === "enable" ? "Extension enabled" : op === "reconcile" ? "Extension restarted" : "Extension installed",
      refs: { version: v.version, runtime: manifest.runtime, memoryMb: manifest.resources.memoryMb },
    });
    if (attach) await goLive(attach, slug, actor, op);
    return load(slug);
  }

  /**
   * Attach a running extension and move it to `live`. A permanent refusal
   * fails it and stops the process; a transient one leaves it `installed`
   * (with the reason) for the reconciler. Only rows still running may go
   * live: a disable that landed meanwhile wins, and what this attached is
   * taken down again.
   */
  async function goLive(attach: ExtensionAttachPort, slug: string, actor: ActivityActor, op: InstallOp): Promise<void> {
    const from: readonly ExtensionStatusName[] = ["installed", "live"];
    try {
      await attach.attach(slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof ExtensionAttachError ? err.permanent : false;
      if (!permanent) {
        logger.warn({ err, slug }, "extension_attach_pending");
        await prisma.extension.updateMany({
          where: { id: slug, status: { in: [...from] } },
          data: { status: "installed", failureReason: `attach_pending: ${message}`.slice(0, 1000) },
        });
        // One row per owner action, not one per reconciler tick.
        if (op !== "reconcile") {
          await record(op, slug, actor, {
            severity: "warn",
            what: "Extension running, its tools not attached yet",
            refs: { error: message.slice(0, 300) },
          });
        }
        return;
      }
      await attach.detach(slug).catch(() => undefined);
      const failed = await markFailed(slug, `attach_refused: ${message}`, from);
      try {
        await sandbox.stop(slug);
      } catch (e) {
        logger.warn({ err: e, slug }, "extension_stop_after_refused_attach_failed");
      }
      if (!failed) return;
      await record(op, slug, actor, {
        severity: "warn",
        what: "Extension refused: its tools are not what was signed",
        refs: { error: message.slice(0, 300), code: err instanceof ExtensionAttachError ? err.code : null },
      });
      throw new ExtensionLifecycleError("attach_refused", 409, message);
    }
    const live = await prisma.extension.updateMany({
      where: { id: slug, status: { in: [...from] } },
      data: { status: "live", failureReason: null },
    });
    if (live.count === 0) {
      // Disabled or uninstalled while it was attaching: that stands.
      installedExtensionIds.delete(extensionServerId(slug));
      await attach.detach(slug);
    }
  }

  /**
   * Move `slug` from one of `from` to `to` in ONE statement (updateMany with
   * the status in the WHERE), so two tabs — or an owner and the reconciler —
   * cannot both pass a read-then-check. count 0 → 404 or 409 with the state
   * that won.
   */
  async function claim(
    slug: string,
    from: readonly ExtensionStatusName[],
    to: ExtensionStatusName,
    extra: { serviceTokenHash?: null } = {},
    stillToDo?: () => Promise<boolean>,
  ): Promise<{ retry: boolean }> {
    const u = await prisma.extension.updateMany({
      where: { id: slug, status: { in: [...from] } },
      data: { status: to, ...extra },
    });
    if (u.count > 0) return { retry: false };
    const ext = await load(slug);
    // The same transition already won, but its sandbox call failed and the
    // sandbox still has what it was meant to take down: act on it again
    // (review #2323) rather than answer 409 while it runs.
    if (ext.status === to && stillToDo && (await stillToDo())) return { retry: true };
    throw new ExtensionLifecycleError("wrong_state", 409, `extension ${slug} is ${ext.status}`);
  }

  async function stopAndDetach(slug: string): Promise<void> {
    installedExtensionIds.delete(extensionServerId(slug));
    if (attach) await attach.detach(slug);
  }

  return {
    install: (slug: string, actor: ActivityActor) => install(slug, actor, "install"),

    async enable(slug: string, actor: ActivityActor) {
      // The same preflight a promote runs: while this one was off, another
      // extension may have taken one of its tool names, or the memory.
      const ext = await load(slug);
      const parsed = ext.currentVersion ? parseExtensionManifest(ext.currentVersion.manifestBytes) : null;
      if (parsed?.ok) {
        const preflight = await preflightAgainstBox(prisma, sandbox, slug, parsed.manifest, 0);
        if (!preflight.ok) {
          throw new ExtensionLifecycleError(
            "preflight_blocked",
            422,
            preflight.blocking.map((b) => b.detail).join("; "),
            { preflight },
          );
        }
      }
      // Claimed to `signed` (not running yet) first: a second enable racing
      // this one finds `signed` and gets the 409.
      await claim(slug, ["disabled", "failed", "uninstalled"], "signed");
      return install(slug, actor, "enable");
    },

    async disable(slug: string, actor: ActivityActor) {
      // The row first, so an install in flight loses (it re-checks the row
      // at every write); then the process. A retry acts while it still runs.
      const { retry } = await claim(
        slug,
        ["signed", "installed", "live", "failed"],
        "disabled",
        { serviceTokenHash: null },
        async () => (await sandbox.status(slug))?.running === true,
      );
      await stopAndDetach(slug);
      try {
        await sandbox.stop(slug);
      } catch (err) {
        await record("disable", slug, actor, {
          severity: "warn",
          what: "Extension disabled, but its process could not be stopped yet",
          refs: { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
        });
        throw err;
      }
      await record("disable", slug, actor, { what: "Extension disabled", ...(retry ? { refs: { retry: true } } : {}) });
      return load(slug);
    },

    async uninstall(slug: string, actor: ActivityActor) {
      const { retry } = await claim(
        slug,
        ["signed", "installed", "live", "failed", "disabled"],
        "uninstalled",
        { serviceTokenHash: null },
        async () => (await sandbox.status(slug)) !== null,
      );
      await stopAndDetach(slug);
      try {
        await sandbox.uninstall(slug);
      } catch (err) {
        await record("uninstall", slug, actor, {
          severity: "warn",
          what: "Extension uninstalled, but the sandbox could not remove it yet",
          refs: { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
        });
        throw err;
      }
      await record("uninstall", slug, actor, {
        severity: "warn",
        what: "Extension uninstalled",
        ...(retry ? { refs: { retry: true } } : {}),
      });
      return load(slug);
    },

    /** installedExtensionIds := the rows that should be running. */
    async refreshInstalledIds(): Promise<void> {
      const rows = await prisma.extension.findMany({
        where: { status: { in: [...RUNNING_EXTENSION_STATUSES] } },
        select: { id: true },
      });
      installedExtensionIds.clear();
      for (const r of rows) installedExtensionIds.add(extensionServerId(r.id));
    },

    /**
     * Both directions (review #2323), on the one sanctioned clock.
     *
     * 1. STRAYS: stop what the sandbox runs for a row that must not run — a
     *    disable or uninstall whose sandbox call failed, an install that
     *    outlived its caller, a row left `signed` by an orchestrator restart
     *    mid-install, or no row at all. A row that still exists keeps its
     *    sandbox copy (stop); an uninstalled row, or none, loses it
     *    (uninstall). A slug with an install() in flight is left alone: its
     *    own claimed writes decide.
     * 2. MISSING: reinstall a row that should run and does not — the sandbox
     *    restarted and forgot it, or its process died. Every restart goes
     *    through install(): re-verify, rotate the bearer, start. A dead
     *    process gets EXTENSION_MAX_RECONCILE_RESTARTS reinstalls, then the
     *    row is marked `failed` and the owner re-enables.
     *
     * No Extension rows at all → no sandbox call.
     */
    async reconcile(): Promise<ReconcileReport> {
      const all = await prisma.extension.findMany({ select: { id: true, status: true } });
      const shouldRun = (status: string | undefined): boolean =>
        (RUNNING_EXTENSION_STATUSES as readonly string[]).includes(status ?? "");
      const rows = all.filter((r) => shouldRun(r.status));
      const report: ReconcileReport = { checked: rows.length, restarted: [], failed: [], stopped: [], reattached: [] };
      if (all.length === 0) return report;

      // ── 1. strays ──
      let held: SandboxHeldExtension[] = [];
      try {
        held = await sandbox.list();
      } catch (err) {
        if (err instanceof ExtensionSandboxError && err.code === "SUPERVISION_OFF") {
          return { ...report, skipped: "supervision_off" };
        }
        logger.warn({ err }, "extension_reconcile_list_failed");
      }
      const statusOf = new Map(all.map((r) => [r.id, r.status as string]));
      for (const { slug, running } of held) {
        const status = statusOf.get(slug);
        if (!running || shouldRun(status) || installsInFlight.has(slug)) continue;
        try {
          if (status === undefined || status === "uninstalled") await sandbox.uninstall(slug);
          else await sandbox.stop(slug);
        } catch (err) {
          logger.warn({ err, slug, status }, "extension_reconcile_stray_stop_failed");
          continue;
        }
        installedExtensionIds.delete(extensionServerId(slug));
        report.stopped.push(slug);
        await record("reconcile", slug, SYSTEM_ACTOR, {
          severity: "warn",
          what: `Extension process stopped: the extension is ${status ?? "unknown to this box"}`,
          refs: { status: status ?? null },
        });
      }

      // ── 2. missing ──
      for (const { id } of rows) {
        let st: SandboxExtensionStatus | null = null;
        try {
          st = await sandbox.status(id);
        } catch (err) {
          if (err instanceof ExtensionSandboxError && err.code === "SUPERVISION_OFF") {
            return { ...report, skipped: "supervision_off" };
          }
          logger.warn({ err, slug: id }, "extension_reconcile_status_failed");
          continue;
        }
        if (st?.running === true && st.process?.restarts === 0) {
          installedExtensionIds.add(extensionServerId(id));
          // Running, but not attached in THIS process: an orchestrator
          // restart, or an attach that did not answer last time. Only the
          // process install() re-verified and started (restarts 0) is
          // attached as it runs.
          if (attach?.isAttached && !attach.isAttached(id)) {
            try {
              await goLive(attach, id, SYSTEM_ACTOR, "reconcile");
              if (attach.isAttached(id)) report.reattached.push(id);
            } catch (err) {
              logger.warn({ err, slug: id }, "extension_reconcile_reattach_failed");
              report.failed.push(id);
            }
          }
          continue;
        }
        if (st?.running === true) {
          // Restarted in place (or no process record says otherwise): it runs
          // from files the same uid can rewrite, so it is not the code
          // install() verified (review #2325). Nothing of it stays attached;
          // it is reinstalled below, through install() — re-verified, a new
          // bearer, a fresh export — and attached from there, or failed.
          logger.warn({ slug: id, restarts: st.process?.restarts ?? null }, "extension_reconcile_restarted_in_place");
          installedExtensionIds.delete(extensionServerId(id));
          if (attach) {
            await attach.detach(id).catch((err: unknown) => logger.warn({ err, slug: id }, "extension_detach_before_reinstall_failed"));
          }
        }
        const proc = st?.process ?? null;
        if (proc && DEAD_PROCESS_STATES.has(proc.state)) {
          const spent = reconcileRestartCounts.get(id) ?? 0;
          if (spent >= EXTENSION_MAX_RECONCILE_RESTARTS) {
            // Reinstalling it every tick would loop (export, tsc, a new
            // bearer, an audit row per minute). The owner sees why and
            // re-enables, which starts the count again.
            reconcileRestartCounts.delete(id);
            const reason = `process_${proc.state}: exit code ${proc.exitCode ?? "unknown"} after ${spent} restarts`;
            if (await markFailed(id, reason, INSTALL_FROM.reconcile)) {
              await record("reconcile", id, SYSTEM_ACTOR, {
                severity: "warn",
                what: "Extension stopped: its process kept exiting",
                refs: { process: proc.state, exitCode: proc.exitCode, restarts: spent },
              });
            }
            report.failed.push(id);
            continue;
          }
          reconcileRestartCounts.set(id, spent + 1);
        }
        if (proc?.state === "starting") continue;
        try {
          await install(id, SYSTEM_ACTOR, "reconcile");
          report.restarted.push(id);
        } catch (err) {
          logger.warn({ err, slug: id }, "extension_reconcile_restart_failed");
          report.failed.push(id);
        }
      }
      return report;
    },
  };
}

export type ExtensionLifecycle = ReturnType<typeof createExtensionLifecycle>;

/** Bare tool names every OTHER extension's current version provides. */
export async function otherExtensionTools(
  prisma: PrismaClient,
  slug: string,
): Promise<Map<string, string>> {
  const rows = await prisma.extension.findMany({
    where: { id: { not: slug }, status: { not: "uninstalled" } },
    select: { id: true, currentVersion: { select: { manifestBytes: true } } },
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.currentVersion) continue;
    const parsed = parseExtensionManifest(r.currentVersion.manifestBytes);
    if (!parsed.ok) continue;
    for (const t of parsed.manifest.provides.tools) out.set(t.name, extensionServerId(r.id));
  }
  return out;
}

/**
 * Preflight `manifest` against the box as it is NOW: a fresh sandbox budget,
 * every other extension's tool names, the catalog and the attached servers.
 * `currentMemoryMb` is what this slug's running version holds (freed by a
 * reinstall). Promote runs it at both phases; enable runs it before it claims.
 */
export async function preflightAgainstBox(
  prisma: PrismaClient,
  sandbox: ExtensionSandboxClient,
  slug: string,
  manifest: ExtensionManifest,
  currentMemoryMb: number,
): Promise<PreflightResult> {
  const budget = await sandbox.budget();
  return preflightExtension({
    slug,
    manifest,
    budget,
    currentMemoryMb,
    otherExtensionTools: await otherExtensionTools(prisma, slug),
  });
}
