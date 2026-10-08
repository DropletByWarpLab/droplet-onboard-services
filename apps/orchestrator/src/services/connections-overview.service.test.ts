import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerDescriptors, parseConnectionsOverview } from "@droplet/shared-types";
const views = vi.hoisted(() => ({ google: vi.fn(), microsoft: vi.fn() }));
vi.mock("./google/google-auth.service.js", () => ({ getGoogleConnectionView: views.google }));
vi.mock("./m365/m365-auth.service.js", () => ({ getConnectionView: views.microsoft }));
import { buildConnectionsOverview, connectInputFor, isCatalogAvailable } from "./connections-overview.service.js";

function db() {
  return {
    user: { findUnique: vi.fn() },
    emailAccount: { findMany: vi.fn(async () => [{ id: "box-mail", address: "desk", imapStatus: "error", lastIdleAt: null }]) },
    calendarSource: { findMany: vi.fn(async () => [{ id: "cal", name: "Personal", url: "https://calendar.invalid/private?token=NEVER_RETURN", lastSyncError: "SECRET_VENDOR_ERROR", lastSyncAt: null }]) },
    integrationConnection: { findMany: vi.fn(async () => [
      { provider: "stripe", status: "ERROR", apiCredentialsEnc: "SECRET_CIPHERTEXT", providerTokensEnc: null, lastHealthyAt: null },
      { provider: "hubspot", status: "DISABLED", apiCredentialsEnc: null, providerTokensEnc: null, lastHealthyAt: null },
    ]) },
    m365DeltaCursor: { findMany: vi.fn(async () => [{ workload: "files" }]) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  views.google.mockResolvedValue({ state: "ERROR", accountAddress: "person", mailEnabled: true, calendarEnabled: false, lastError: "SECRET_GOOGLE_ERROR", calendar: { state: "DISCONNECTED", lastSyncAt: null } });
  views.microsoft.mockResolvedValue({ state: "DISCONNECTED" });
});

describe("connection overview visibility and metadata", () => {
  it("members see only their personal rows and no hidden box totals", async () => {
    const prisma = db();
    const result = await buildConnectionsOverview(prisma as never, { id: "member-id", username: "member-handle", role: "family" });
    expect(result.connected.map((row) => row.id)).toEqual(["google:me", "calendar:cal"]);
    expect(result.boxWideVisible).toBe(false);
    expect(result.counts.connected).toBe(2);
    expect(result.available.map((row) => row.provider)).toEqual(["m365", "calendar"]);
    expect(prisma.calendarSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "member-handle", authMode: { in: ["none", "basic"] } } }));
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.integrationConnection.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|NEVER_RETURN|private\?token/);
  });
  it("owners see live box connections and every connectable catalog provider", async () => {
    const prisma = db();
    const result = await buildConnectionsOverview(prisma as never, { id: "owner-id", username: "owner", role: "owner" });
    expect(result.connected.map((row) => row.id)).toContain("integration:stripe");
    expect(result.connected.map((row) => row.id)).not.toContain("integration:hubspot");
    const available = result.available.map((row) => row.provider);
    for (const descriptor of providerDescriptors().filter((item) => isCatalogAvailable(item) && connectInputFor(item) && item.id !== "stripe")) {
      expect(available, descriptor.id).toContain(descriptor.id);
    }
    expect(parseConnectionsOverview(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_|NEVER_RETURN/);
  });
  it.each(["guest", "service"])("role %s reads no connection tables", async (role) => {
    const prisma = db();
    expect((await buildConnectionsOverview(prisma as never, { id: "outsider", role })).counts).toEqual({ connected: 0, needsAttention: 0, available: 0 });
    expect(views.google).not.toHaveBeenCalled();
    expect(prisma.calendarSource.findMany).not.toHaveBeenCalled();
  });
  it("reports paused Microsoft workloads with fixed copy, not raw errors", async () => {
    views.microsoft.mockResolvedValue({ state: "CONNECTED", accountUpn: "member", mail: { enabled: true, state: "CONNECTED" }, calendar: { enabled: true, state: "ERROR", lastError: "SECRET_ERROR" }, sharePoint: { enabled: true } });
    const result = await buildConnectionsOverview(db() as never, { id: "person-id", username: "person", role: "family" });
    expect(result.connected.find((row) => row.provider === "m365")).toMatchObject({ status: "needs_attention", statusDetail: "Calendar and files sync is paused — Droplet will retry" });
  });
});
