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

import { runDevelopmentSync } from "./pm-development.service.js";

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
