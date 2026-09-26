/**
 * WARP-3117 — which Nextcloud login does the person behind an `_service:mcp`
 * call act as?
 *
 * The header names the person (`User.username` on stdio, `User.id` over HTTP),
 * never their Nextcloud login. The person is resolved exactly as
 * `resolveAssertedUser` resolves them; their login is `nextcloudUsername`, and
 * a person without one (every SSO / SCIM row) has no Nextcloud account to act
 * in.
 */
import { describe, it, expect } from "vitest";
import { resolveAssertedNextcloudLogin } from "./asserted-nextcloud-login.service.js";
import { userDirectory, type DirectoryUser } from "../__tests__/helpers/user-directory.js";

// A Nextcloud login that differs from the handle, as ADR-013 allows: proves
// the answer is `nextcloudUsername`, not whichever column the header matched.
const BOB: DirectoryUser = { id: "u-bob", username: "bob", nextcloudUsername: "bob.nc", role: "family" };
// SSO / SCIM-provisioned: no Nextcloud account was ever created.
const CAROL: DirectoryUser = { id: "u-carol", username: "carol", nextcloudUsername: null, role: "owner" };

const prismaOf = (users: DirectoryUser[]) => ({ user: userDirectory(users) }) as never;

describe("resolveAssertedNextcloudLogin", () => {
  it("maps a User.id (the HTTP transport) to the person's Nextcloud login", async () => {
    expect(await resolveAssertedNextcloudLogin(prismaOf([BOB, CAROL]), "u-bob")).toEqual({
      ok: true,
      login: "bob.nc",
      userId: "u-bob",
    });
  });

  it("maps a username (stdio) to the Nextcloud login, not the username", async () => {
    expect(await resolveAssertedNextcloudLogin(prismaOf([BOB, CAROL]), "bob")).toEqual({
      ok: true,
      login: "bob.nc",
      userId: "u-bob",
    });
  });

  it("refuses an SSO / SCIM person: no Nextcloud account, and no fallback to the username", async () => {
    expect(await resolveAssertedNextcloudLogin(prismaOf([BOB, CAROL]), "u-carol")).toEqual({
      ok: false,
      reason: "no_nextcloud_account",
    });
    expect(await resolveAssertedNextcloudLogin(prismaOf([BOB, CAROL]), "carol")).toEqual({
      ok: false,
      reason: "no_nextcloud_account",
    });
  });

  it("treats an empty nextcloudUsername as no account", async () => {
    const blank: DirectoryUser = { ...BOB, nextcloudUsername: "" };
    expect(await resolveAssertedNextcloudLogin(prismaOf([blank]), "u-bob")).toEqual({
      ok: false,
      reason: "no_nextcloud_account",
    });
  });

  it("refuses a value naming two people, before any login is read", async () => {
    // "bob.nc" is BOB's login and this row's username.
    const lookalike: DirectoryUser = { id: "u-other", username: "bob.nc", nextcloudUsername: "other", role: "owner" };
    expect(await resolveAssertedNextcloudLogin(prismaOf([BOB, lookalike]), "bob.nc")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("refuses a deactivated person", async () => {
    const gone: DirectoryUser = { ...BOB, directoryStatus: "DEACTIVATED" };
    expect(await resolveAssertedNextcloudLogin(prismaOf([gone]), "u-bob")).toEqual({
      ok: false,
      reason: "deactivated",
    });
  });

  it("refuses a value naming nobody", async () => {
    expect(await resolveAssertedNextcloudLogin(prismaOf([BOB]), "u-nobody")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
