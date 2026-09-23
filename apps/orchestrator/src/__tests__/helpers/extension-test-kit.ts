/**
 * WARP-2900 H2 test kit: an in-process "sidecar" with a real ECDSA-P256
 * extension key (the sidecar's envelope, so every verification is real), a
 * recording fake of the sandbox's extension routes, a small in-memory Prisma
 * for the Extension / ExtensionVersion / WorkshopWorkspace calls the H2
 * services make, and a manifest builder.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { extensionKeyFingerprint } from "../../services/extension-manifest.js";
import { EXTENSION_STATEMENT_PREFIX } from "../../services/update-agent/extension-verify.js";
import type { ExtensionSignResult } from "../../services/device-identity.client.js";
import type {
  ExtensionInstallRequest,
  ExtensionSandboxClient,
  ProposalManifest,
  SandboxBudget,
  SandboxExtensionStatus,
} from "../../services/extension-sandbox.client.js";
import { ExtensionSandboxError } from "../../services/extension-sandbox.client.js";

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const TREE = "89abcdef0123456789abcdef0123456789abcdef";

// ─── manifests ───────────────────────────────────────────────────────────

export interface ManifestOpts {
  id: string;
  version?: string;
  tools?: Array<{ name: string; description?: string; requiresWrite?: boolean }>;
  memoryMb?: number;
  summary?: string;
  runtime?: "node20" | "python312";
}

export function manifestObject(o: ManifestOpts): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: o.id,
    name: "Word counter",
    version: o.version ?? "0.1.0",
    kind: "extension",
    runtime: o.runtime ?? "python312",
    entrypoint: o.runtime === "node20" ? "dist/index.js" : "tool.py",
    provides: {
      tools: (o.tools ?? [{ name: "word_count" }]).map((t) => ({
        name: t.name,
        description: t.description ?? "Count the words in a piece of text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        export: "run",
        classificationProposal: {
          requiresWrite: t.requiresWrite ?? false,
          requiresConfirmation: t.requiresWrite ?? false,
        },
      })),
      routineDrafts: [],
      proposedGrants: [],
    },
    resources: { memoryMb: o.memoryMb ?? 64, processes: 1 },
    egress: "none",
    ...(o.summary !== undefined ? { summary: o.summary } : {}),
  };
}

export const manifestBytes = (o: ManifestOpts): Buffer =>
  Buffer.from(JSON.stringify(manifestObject(o), null, 2) + "\n", "utf8");

// ─── the sidecar ─────────────────────────────────────────────────────────

type SignFn = (statement: Uint8Array) => Promise<ExtensionSignResult>;

export function fakeSidecar(opts: { provisioned?: boolean } = {}) {
  let { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = () => new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const identity = {
    provisioned: opts.provisioned ?? true,
    getDeviceIdentityStatus: vi.fn(async () => ({ provisioned: identity.provisioned })),
    signExtensionManifest: vi.fn<SignFn>(async (statement: Uint8Array) => {
      const prefix = Buffer.from(EXTENSION_STATEMENT_PREFIX, "utf8");
      return {
        signature: new Uint8Array(sign("sha256", Buffer.concat([prefix, statement]), privateKey)),
        algorithm: "ECDSA-P256-SHA256",
        extensionSpkiDer: spki(),
        keyFingerprint: extensionKeyFingerprint(spki()),
      };
    }),
    getExtensionPublicKey: vi.fn(async () => ({ spkiDer: spki(), fingerprint: extensionKeyFingerprint(spki()) })),
    /** A rebuilt boot disk: the sidecar now holds a different extension key. */
    rotateKey() {
      ({ privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }));
    },
  };
  return identity;
}

// ─── the sandbox ─────────────────────────────────────────────────────────

export function fakeSandbox(init: { proposals?: Record<string, Buffer | null>; availableMb?: number } = {}) {
  const proposals = new Map<string, Buffer | null>(Object.entries(init.proposals ?? {}));
  const installed = new Map<string, SandboxExtensionStatus>();
  const installs: Array<{ slug: string; req: ExtensionInstallRequest }> = [];
  const calls: string[] = [];
  const state = { supervisionOff: false, availableMb: init.availableMb ?? 200, failInstall: null as Error | null };
  const gate = () => {
    if (state.supervisionOff) {
      throw new ExtensionSandboxError("extensions are not enabled on this box", 503, "SUPERVISION_OFF");
    }
  };
  const client: ExtensionSandboxClient = {
    proposalManifest: vi.fn(async (workspaceId: string, version: string): Promise<ProposalManifest> => {
      calls.push(`manifest ${workspaceId} ${version}`);
      gate();
      if (!proposals.has(workspaceId)) throw new ExtensionSandboxError(`no workspace ${workspaceId}`, 404, "SANDBOX_ERROR");
      return { workspaceId, tag: `proposal/${version}`, commit: COMMIT, tree: TREE, manifest: proposals.get(workspaceId) ?? null };
    }),
    budget: vi.fn(async (): Promise<SandboxBudget> => {
      calls.push("budget");
      gate();
      return { ceilingMb: 512, source: "env", transformHeadroomMb: 256, installedMb: 0, availableMb: state.availableMb };
    }),
    status: vi.fn(async (slug: string) => {
      calls.push(`status ${slug}`);
      gate();
      return installed.get(slug) ?? null;
    }),
    install: vi.fn(async (slug: string, req: ExtensionInstallRequest) => {
      calls.push(`install ${slug}`);
      gate();
      if (state.failInstall) throw state.failInstall;
      installs.push({ slug, req });
      const st: SandboxExtensionStatus = {
        slug,
        workspaceId: req.workspaceId,
        version: req.version,
        runtime: req.runtime,
        memoryMb: req.memoryMb,
        port: 18000,
        running: true,
        process: { state: "running", restarts: 0, exitCode: null },
      };
      installed.set(slug, st);
      return st;
    }),
    stop: vi.fn(async (slug: string) => {
      calls.push(`stop ${slug}`);
      gate();
      const st = installed.get(slug);
      if (st) installed.set(slug, { ...st, running: false });
    }),
    uninstall: vi.fn(async (slug: string) => {
      calls.push(`uninstall ${slug}`);
      gate();
      installed.delete(slug);
    }),
    rpc: vi.fn(async () => ({ status: 200, json: {} })),
  };
  return { client, proposals, installed, installs, calls, state };
}

// ─── Prisma ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in && !c.in.includes(v)) return false;
      if ("not" in c && v === c.not) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

export class P2002 extends Error {
  code = "P2002";
}

export function extensionPrisma(init: { workspaces?: Array<{ id: string; userId?: string; proposedTag?: string | null }> } = {}) {
  const extensions = new Map<string, Row>();
  const versions = new Map<string, Row>();
  const workspaces = new Map<string, Row>();
  for (const w of init.workspaces ?? []) {
    workspaces.set(w.id, {
      id: w.id,
      name: w.id,
      userId: w.userId ?? "u-owner",
      proposedTag: w.proposedTag === undefined ? "proposal/0.1.0" : w.proposedTag,
      proposedAt: new Date("2026-09-22T10:00:00Z"),
      status: "proposed",
    });
  }
  let seq = 0;
  const withVersion = (e: Row | undefined) =>
    e ? { ...e, currentVersion: e.currentVersionId ? (versions.get(e.currentVersionId as string) ?? null) : null } : null;

  const prisma = {
    extension: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => withVersion(extensions.get(where.id))),
      findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
        [...extensions.values()].filter((e) => matches(e, where)).map((e) => withVersion(e) as Row),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const e = extensions.get(where.id);
        if (!e) throw new Error(`no extension ${where.id}`);
        Object.assign(e, data, { updatedAt: new Date() });
        return { ...e };
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { id: string }; create: Row; update: Row }) => {
        const e = extensions.get(where.id);
        if (e) {
          Object.assign(e, update, { updatedAt: new Date() });
          return { ...e };
        }
        const row: Row = {
          status: "signed",
          operatorDomain: null,
          currentVersionId: null,
          serviceTokenHash: null,
          failureReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        extensions.set(where.id, row);
        return { ...row };
      }),
    },
    extensionVersion: {
      findUnique: vi.fn(async ({ where }: { where: { extensionId_version: { extensionId: string; version: string } } }) => {
        const { extensionId, version } = where.extensionId_version;
        return [...versions.values()].find((v) => v.extensionId === extensionId && v.version === version) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const dup = [...versions.values()].some((v) => v.extensionId === data.extensionId && v.version === data.version);
        if (dup) throw new P2002("unique");
        const row = { id: `v-${++seq}`, createdAt: new Date(), ...data };
        versions.set(row.id, row);
        return { ...row };
      }),
    },
    workshopWorkspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => workspaces.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where?: { proposedTag?: { not: null } } } = {}) =>
        [...workspaces.values()].filter((w) => (where?.proposedTag ? w.proposedTag !== null : true)),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    raw: prisma,
    extensions,
    versions,
    workspaces,
  };
}
