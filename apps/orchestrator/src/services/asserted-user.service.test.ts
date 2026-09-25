/**
 * WARP-3061 — who is the person behind an `_service:mcp` call?
 *
 * The header names them by `User.username` (stdio) or `User.id` (HTTP
 * transport). `nextcloudUsername` stays in the match so nothing that resolved
 * before stops resolving. One distinct ACTIVE row is a person; none, more
 * than one, or a deactivated one is nobody.
 */
import { describe, it, expect } from "vitest";
import { resolveAssertedUser } from "./asserted-user.service.js";
import { userDirectory, type DirectoryUser } from "../__tests__/helpers/user-directory.js";

const MARIA: DirectoryUser = {
  id: "u-maria",
  username: "maria",
  nextcloudUsername: null,
  role: "family",
  displayName: "Maria",
  email: "maria@acme.test",
};
const SAM: DirectoryUser = { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "owner", displayName: "Sam", email: null };
/** WARP-3098 — the person, with the fields the acting-user sites read off them. */
const MARIA_RESOLVED = { id: "u-maria", username: "maria", role: "family", displayName: "Maria", email: "maria@acme.test" };

const prismaOf = (users: DirectoryUser[]) => ({ user: userDirectory(users) }) as never;

describe("resolveAssertedUser", () => {
  it("resolves an SSO / SCIM row (nextcloudUsername NULL) by username", async () => {
    expect(await resolveAssertedUser(prismaOf([MARIA, SAM]), "maria")).toEqual({
      ok: true,
      user: MARIA_RESOLVED,
    });
  });

  it("resolves by User.id, which is what the HTTP transport sends", async () => {
    expect(await resolveAssertedUser(prismaOf([MARIA, SAM]), "u-maria")).toEqual({
      ok: true,
      user: MARIA_RESOLVED,
    });
  });

  it("resolves by nextcloudUsername when no username or id says otherwise", async () => {
    const renamed: DirectoryUser = { ...SAM, username: "samuel" };
    expect(await resolveAssertedUser(prismaOf([MARIA, renamed]), "sam")).toEqual({
      ok: true,
      user: { id: "u-sam", username: "samuel", role: "owner", displayName: "Sam", email: null },
    });
  });

  it("treats one row matched by several columns as one person", async () => {
    expect(await resolveAssertedUser(prismaOf([SAM]), "sam")).toEqual({
      ok: true,
      user: { id: "u-sam", username: "sam", role: "owner", displayName: "Sam", email: null },
    });
  });

  it("is ambiguous when one person's username is another's nextcloudUsername", async () => {
    const marianne: DirectoryUser = { id: "u-marianne", username: "marianne", nextcloudUsername: "maria", role: "owner" };
    expect(await resolveAssertedUser(prismaOf([MARIA, marianne]), "maria")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("is ambiguous when one person's id is another's username", async () => {
    const lookalike: DirectoryUser = { id: "u-other", username: "u-maria", nextcloudUsername: null, role: "family" };
    expect(await resolveAssertedUser(prismaOf([MARIA, lookalike]), "u-maria")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  describe("a deactivated person is nobody to act as", () => {
    // Deactivation only sets `directoryStatus`, so the row still matches
    // every arm it matched before; an assistant run still in flight must not
    // keep using that person's grants.
    const GONE: DirectoryUser = { ...MARIA, directoryStatus: "DEACTIVATED" };

    it("denies a DEACTIVATED row named by username", async () => {
      expect(await resolveAssertedUser(prismaOf([GONE, SAM]), "maria")).toEqual({
        ok: false,
        reason: "deactivated",
      });
    });

    it("denies a DEACTIVATED row named by User.id", async () => {
      expect(await resolveAssertedUser(prismaOf([GONE, SAM]), "u-maria")).toEqual({
        ok: false,
        reason: "deactivated",
      });
    });

    it("still counts a DEACTIVATED row toward ambiguity, never resolving to the active look-alike", async () => {
      // Dropping the deactivated row before counting would hand maria's
      // question to marianne, an owner.
      const marianne: DirectoryUser = { id: "u-marianne", username: "marianne", nextcloudUsername: "maria", role: "owner" };
      expect(await resolveAssertedUser(prismaOf([GONE, marianne]), "maria")).toEqual({
        ok: false,
        reason: "ambiguous",
      });
    });
  });

  it("names nobody when nothing matches", async () => {
    expect(await resolveAssertedUser(prismaOf([MARIA, SAM]), "nobody")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("asks the database once, for at most two rows of any status, and reads only the person's fields and status", async () => {
    // Two is the fewest rows that can tell "one person" from "more than one".
    // WARP-3098: username, displayName and email ride on the same read, so a
    // site that needs them does not look the person up a second time.
    const prisma = { user: userDirectory([MARIA]) };
    await resolveAssertedUser(prisma as never, "maria");
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { OR: [{ username: "maria" }, { nextcloudUsername: "maria" }, { id: "maria" }] },
      select: { id: true, username: true, role: true, displayName: true, email: true, directoryStatus: true },
      take: 2,
    });
  });
});
