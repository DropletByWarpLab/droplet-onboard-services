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
  it("a Microsoft workload whose grant stopped working asks for a fresh sign-in and offers Reconnect, never the raw error", async () => {
    views.microsoft.mockResolvedValue({ state: "CONNECTED", accountUpn: "member", mail: { enabled: true, state: "CONNECTED" }, calendar: { enabled: true, state: "ERROR", lastError: "SECRET_ERROR" }, sharePoint: { enabled: true } });
    const result = await buildConnectionsOverview(db() as never, { id: "person-id", username: "person", role: "family" });
    const row = result.connected.find((r) => r.provider === "m365");
    expect(row).toMatchObject({ status: "needs_attention", statusDetail: "Calendar sync is paused — sign in again to resume", canReconnect: true });
    expect(JSON.stringify(row)).not.toContain("SECRET_ERROR");
  });
  it("a Microsoft workload that only backs off says Droplet will retry and offers no Reconnect", async () => {
    views.microsoft.mockResolvedValue({ state: "CONNECTED", accountUpn: "member", mail: { enabled: true, state: "CONNECTED" }, calendar: { enabled: true, state: "CONNECTED" }, sharePoint: { enabled: true } });
    const result = await buildConnectionsOverview(db() as never, { id: "person-id", username: "person", role: "family" });
    expect(result.connected.find((r) => r.provider === "m365")).toMatchObject({ status: "needs_attention", statusDetail: "Files sync is paused — Droplet will retry", canReconnect: false });
  });
  it("gives each guest a fresh empty overview, not a shared one", async () => {
    const first = await buildConnectionsOverview(db() as never, { id: "g1", username: "g1", role: "guest" });
    first.connected.push({} as never);
    first.counts.connected = 9;
    const second = await buildConnectionsOverview(db() as never, { id: "g2", username: "g2", role: "guest" });
    expect(second.connected).toEqual([]);
    expect(second.counts.connected).toBe(0);
  });
});
