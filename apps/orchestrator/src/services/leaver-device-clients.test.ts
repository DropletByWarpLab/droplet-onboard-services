/**
 * WARP-3384 — Deactivate and Delete revoke every device client the person
 * paired, end to end through the real lifecycle post-effects and the real
 * device-client sweep (only the edges are stubbed: Prisma, Nextcloud, the
 * session/denylist/VPN/token services, the audit recorder).
 *
 * Offboarding is Deactivate first, and company files must never walk out with
 * an account (Romain, WARP-3113): a leaver's file-sync app passwords and
 * Finder / File Explorer drive logins must stop working with the account.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { ncDeleteMock, recordActivityMock } = vi.hoisted(() => ({
  ncDeleteMock: vi.fn(),
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("./nextcloud.client.js", () => ({ ncDeleteAppPassword: ncDeleteMock }));
vi.mock("./encryption.service.js", () => ({
  decryptSecret: vi.fn((s: string) => s.replace(/^enc:/, "")),
}));
vi.mock("./mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("./session.service.js", () => ({ revokeAllSessions: vi.fn().mockResolvedValue(0) }));
vi.mock("./auth-denylist.service.js", () => ({ denylistUser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./vpn-peer-revoke.service.js", () => ({
  revokeUserVpnDevices: vi.fn().mockResolvedValue({ revoked: 0, failed: 0, hqPending: 0, pendingDenied: 0 }),
  revokeOverlayDevicesForUser: vi.fn().mockResolvedValue({ revoked: 0, failed: 0, hqPending: 0, pendingDenied: 0 }),
}));
vi.mock("./model-access-token.service.js", () => ({
  revokeModelAccessTokensForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: vi.fn(),
  ncRemoveUserFromGroup: vi.fn(),
}));
vi.mock("./department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));

import { initDeviceClientRevoke } from "./device-client-revoke.service.js";
import { runDisablePostEffects, runRemovalPostEffects } from "./role-mutation-guard.service.js";

const ADMIN = { type: "user" as const, id: "admin-1" };

function makeRows() {
  return [
    { id: "app", userId: "alice", kind: "app_pairing", status: "active", ncAppPassword: "enc:pw-app" },
    { id: "drive", userId: "alice", kind: "personal_drive", status: "active", ncAppPassword: "enc:pw-drive" },
    { id: "bobs", userId: "bob", kind: "app_pairing", status: "active", ncAppPassword: "enc:pw-bob" },
  ];
}

function wire(rows: ReturnType<typeof makeRows>) {
  initDeviceClientRevoke({
    deviceClient: {
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter((r) => r.userId === where.userId && r.status === where.status),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        rows.find((r) => r.id === where.id)!.status = data.status;
      }),
    },
  } as never);
}

const sweepRow = () =>
  recordActivityMock.mock.calls.map((c) => c[0]).find((r) => r.refs?.event === "device_clients_revoked");

beforeEach(() => {
  vi.clearAllMocks();
  ncDeleteMock.mockResolvedValue(true);
});

describe("Deactivate (runDisablePostEffects)", () => {
  it("revokes every paired device of the person, deletes the app passwords, and audits actor, person and count", async () => {
    const rows = makeRows();
    wire(rows);

    await runDisablePostEffects({ targetUserId: "u-alice", username: "alice", actor: ADMIN, ncMirror: "synced" });

    expect(rows.filter((r) => r.userId === "alice").map((r) => r.status)).toEqual(["revoked", "revoked"]);
    expect(rows.find((r) => r.id === "bobs")!.status).toBe("active");
    expect(ncDeleteMock.mock.calls.map((c) => c[0]).sort()).toEqual(["pw-app", "pw-drive"]);
    expect(sweepRow()).toMatchObject({
      what: "Paired devices revoked",
      actor: ADMIN,
      sub: "alice: deactivation",
      refs: { targetUsername: "alice", reason: "deactivation", revoked: 2, appPasswordsNotDeleted: 0, failed: 0 },
    });
  });

  it("an app password Nextcloud did not delete is recorded on the audit row, not hidden", async () => {
    ncDeleteMock.mockResolvedValue(false);
    wire(makeRows());

    await runDisablePostEffects({ targetUserId: "u-alice", username: "alice", actor: ADMIN });

    expect(sweepRow()).toMatchObject({
      severity: "warn",
      refs: { revoked: 2, appPasswordsNotDeleted: 2 },
    });
  });
});

describe("Delete (runRemovalPostEffects)", () => {
  it("revokes every paired device of the person as a removal", async () => {
    const rows = makeRows();
    wire(rows);

    await runRemovalPostEffects({
      targetUserId: "u-alice",
      targetUsername: "alice",
      targetRole: "family",
      actorUsername: "admin",
      actor: ADMIN,
    });

    expect(rows.filter((r) => r.userId === "alice").every((r) => r.status === "revoked")).toBe(true);
    expect(rows.find((r) => r.id === "bobs")!.status).toBe("active");
    expect(sweepRow()).toMatchObject({
      actor: ADMIN,
      sub: "alice: removal",
      refs: { targetUsername: "alice", reason: "removal", revoked: 2 },
    });
  });
});
