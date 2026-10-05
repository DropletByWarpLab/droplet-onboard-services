import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectorMock, activityMock } = vi.hoisted(() => ({
  connectorMock: { readDevelopment: vi.fn() },
  activityMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../erp-provider.js", () => ({
  cloudMaterialFromRow: vi.fn(() => ({ connectionId: "connection-1", cloudTokens: { resolveSaasSecret: vi.fn().mockResolvedValue("clear-token") } })),
  connectorForProvider: vi.fn(() => connectorMock),
}));
vi.mock("./pm-dev-egress.js", () => ({
  createDevelopmentFetch: vi.fn(() => ({ fetch: vi.fn(), get blocked() { return null; } })),
  DevelopmentEgressBlockedError: class DevelopmentEgressBlockedError extends Error { constructor() { super(); } },
  DevelopmentConnectionChangedError: class DevelopmentConnectionChangedError extends Error { constructor() { super(); } },
}));
vi.mock("./pm.service.js", () => ({ writeActivity: activityMock }));
vi.mock("./pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));

import { runDevelopmentSync } from "./pm-development.service.js";
import { nudgeOutbox } from "./pm-outbox.js";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

const REPO = {
  id: "repo-1", provider: "GITHUB", externalId: "42", apiRef: "acme/widget", fullName: "acme/widget",
  webUrl: "https://github.com/acme/widget", defaultBranch: "main", status: "OK", lastSyncedAt: new Date(),
  lastAttemptAt: null, nextSyncAt: new Date(0), lastError: null, consecutiveFailures: 0, credentialSeal: null,
  openPrsEtag: null, recentPrsEtag: null, commitsEtag: null, branchesEtag: null,
};
const output = (feed: string, extra: Record<string, unknown> = {}) => ({
  status: "ok", items: [], etag: `${feed}-etag`, truncated: false, skipped: 0, rateLimit: null, ...extra,
});

function fixture(opts: { branchesTruncated?: boolean; connection?: object | null } = {}) {
  const prisma = {
    integrationConnection: { findFirst: vi.fn().mockResolvedValue(opts.connection === undefined ? { id: "connection-1", provider: "github", providerConfig: null, providerTokensEnc: "sealed-token", status: "CONNECTED" } : opts.connection) },
    pmDevRepository: { findMany: vi.fn().mockResolvedValue([REPO]), update: vi.fn().mockResolvedValue({}) },
    pmDevRepositoryProject: { findMany: vi.fn().mockResolvedValue([]) },
    pmExternalLink: {
      findMany: vi.fn().mockResolvedValue([{ id: "old-branch", externalId: "42:feature/ABC-1", state: "OPEN" }]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  connectorMock.readDevelopment.mockImplementation(async ({ feed }: { feed: string }) => {
    if (feed === "branches") return output(feed, { truncated: opts.branchesTruncated ?? false });
    return output(feed);
  });
  return prisma;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("WARP-3535 sync completeness", () => {
  it.each([
    { name: "committed activity", existing: false, rejectCommit: false, wakes: 1 },
    { name: "unchanged link", existing: true, rejectCommit: false, wakes: 0 },
    { name: "rolled-back activity", existing: false, rejectCommit: true, wakes: 0 },
  ])("wakes the shared outbox only after $name", async ({ existing, rejectCommit, wakes }) => {
    const prisma = fixture();
    prisma.pmDevRepositoryProject.findMany.mockResolvedValue([{
      projectId: "project-1", onOpenedStateId: null, onMergedStateId: null,
      project: { id: "project-1", identifier: "ABC", kind: "PROJECT" },
    }]);
    const tx = {
      pmExternalLink: {
        findUnique: vi.fn().mockResolvedValue(existing ? { id: "link-1", state: "OPEN" } : null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const seam = createTransactionSeam({ client: () => tx });
    const transaction = vi.fn(async (...args: Parameters<typeof seam.$transaction>) => {
      const result = await seam.$transaction(...args);
      // A transaction may still fail to commit after its last activity write.
      expect(nudgeOutbox).not.toHaveBeenCalled();
      if (rejectCommit) throw new Error("commit failed");
      return result;
    });
    connectorMock.readDevelopment.mockImplementation(async ({ feed }: { feed: string }) => output(feed, {
      items: feed === "pullRequestsOpen" ? [{
        type: "pull_request", externalId: "pr-42", number: 42, state: "OPEN",
        url: "https://github.com/acme/widget/pull/42", title: "ABC-1 widget fix",
        body: null, branch: null, author: "author", updatedAt: new Date(),
      }] : [],
    }));
    await runDevelopmentSync({
      ...prisma,
      pmWorkItem: { findFirst: vi.fn().mockResolvedValue({ id: "item-1", stateId: "backlog-id" }) },
      $transaction: transaction,
    } as never);

    expect(nudgeOutbox).toHaveBeenCalledTimes(wakes);
    if (!existing) {
      expect(activityMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nudge: false }));
    }
    if (rejectCommit) {
      expect(prisma.pmDevRepository.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: "ERROR" }),
      }));
    }
  });

  it.each(["OPEN", "MERGED"] as const)("records canonical state IDs for %s automation", async (state) => {
    const prisma = fixture();
    prisma.pmDevRepositoryProject.findMany.mockResolvedValue([{
      projectId: "project-1", onOpenedStateId: "review-id", onMergedStateId: "completed-id",
      project: { id: "project-1", identifier: "ABC", kind: "PROJECT" },
    }]);
    const targetStateId = state === "OPEN" ? "review-id" : "completed-id";
    const tx = {
      pmExternalLink: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
      pmWorkItem: {
        findFirst: vi.fn().mockResolvedValue({ stateId: "backlog-id", completedAt: null, isCompleted: false }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      pmState: {
        findUnique: vi.fn().mockResolvedValue({ name: "Backlog" }),
        findFirst: vi.fn().mockResolvedValue({ name: state === "OPEN" ? "Review" : "Done", group: state === "OPEN" ? "started" : "completed" }),
      },
    };
    const transactionSeam = createTransactionSeam({ client: () => tx });
    connectorMock.readDevelopment.mockImplementation(async ({ feed }: { feed: string }) => output(feed, {
      items: feed === "pullRequestsOpen" ? [{
        type: "pull_request", externalId: "pr-42", number: 42, state,
        url: "https://github.com/acme/widget/pull/42", title: "ABC-1 widget fix",
        body: null, branch: "feature/ABC-1", author: "author", updatedAt: new Date(),
      }] : [],
    }));
    await runDevelopmentSync({
      ...prisma,
      pmWorkItem: { findFirst: vi.fn().mockResolvedValue({ id: "item-1", stateId: "backlog-id" }) },
      $transaction: transactionSeam.$transaction,
    } as never);

    expect(tx.pmWorkItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stateId: targetStateId }),
    }));
    // Timeline, notifications and historical charts resolve these values as
    // state IDs; human-readable names break that shared activity contract.
    expect(activityMock).toHaveBeenCalledWith(expect.objectContaining({
      pmExternalLink: expect.anything(),
      pmState: expect.anything(),
      pmWorkItem: expect.anything(),
    }), expect.objectContaining({
      workItemId: "item-1", verb: "state_changed", field: "state",
      oldValue: "backlog-id", newValue: targetStateId,
    }));
  });

  it("closes stale branches only after a complete inventory", async () => {
    const prisma = fixture();
    await runDevelopmentSync(prisma as never);
    expect(prisma.pmExternalLink.update).toHaveBeenCalledWith({ where: { id: "old-branch" }, data: { state: "CLOSED" } });
  });

  it("does not infer deletions from a capped/truncated branch page", async () => {
    const prisma = fixture({ branchesTruncated: true });
    await runDevelopmentSync(prisma as never);
    expect(prisma.pmExternalLink.findMany).not.toHaveBeenCalled();
    expect(prisma.pmExternalLink.update).not.toHaveBeenCalled();
    expect(prisma.pmDevRepository.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ branchesEtag: null }) }));
  });

  it("records a missing/disabled connection as disconnected without dialing", async () => {
    const prisma = fixture({ connection: null });
    await runDevelopmentSync(prisma as never);
    expect(connectorMock.readDevelopment).not.toHaveBeenCalled();
    expect(prisma.pmDevRepository.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "repo-1" }, data: expect.objectContaining({ status: "DISCONNECTED" }),
    }));
  });

  it("sends all feed requests through the guarded connector instance", async () => {
    const prisma = fixture();
    await runDevelopmentSync(prisma as never);
    expect(connectorMock.readDevelopment.mock.calls.map(([arg]) => arg.feed).sort()).toEqual([
      "branches", "commits", "pullRequestsOpen", "pullRequestsRecent",
    ]);
  });
});
