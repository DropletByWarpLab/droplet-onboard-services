/**
 * WARP-3538 — which Microsoft permissions a sign-in asks for, and which a silent
 * refresh may.
 *
 * Both rules fail without a symptom the person can name. A sign-in that asks for
 * a scope the tenant administrator has not approved fails the WHOLE sign-in
 * ("Need admin approval") — mail and calendar included — for a person who never
 * touched SharePoint. A refresh that asks for a scope the connection never held
 * pushes a healthy connection into NEEDS_RECONNECT. Pinned here, in pure
 * functions, so the guard is not a side effect of anything else.
 */
import { describe, it, expect } from "vitest";

import {
  M365_BASE_SCOPES,
  M365_SHAREPOINT_SCOPE,
  scopesForRefresh,
  scopesForSignIn,
} from "./scopes.js";

/** What Microsoft returns for a connection signed in with the base set (offline_access is not echoed). */
const GRANTED_BASE =
  "Mail.ReadWrite Files.ReadWrite.All Calendars.ReadWrite Contacts.ReadWrite Mail.Send User.Read profile openid email";

describe("the scope sets", () => {
  it("the base set is exactly the seven the connector has always asked for, in this order", () => {
    // Pinned: an added scope is a consent prompt for every connected person's
    // administrator, and a changed order is a diff nobody asked for. Both must be
    // a deliberate edit of THIS line.
    expect([...M365_BASE_SCOPES]).toEqual([
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "Files.ReadWrite.All",
    ]);
  });

  it("SharePoint's scope is Sites.Read.All and is NOT in the base set", () => {
    // Files.ReadWrite.All can read a drive but cannot find one, and a base set
    // that carried Sites.Read.All would ask every existing connection's
    // administrator for it.
    expect(M365_SHAREPOINT_SCOPE).toBe("Sites.Read.All");
    expect(M365_BASE_SCOPES).not.toContain("Sites.Read.All");
  });
});

describe("scopesForSignIn", () => {
  it("asks for the base set when the person has not opted in to SharePoint", () => {
    // Mutation: return the SharePoint scope for `false` too, and a tenant that
    // has not approved Sites.Read.All fails every sign-in, mail included.
    expect(scopesForSignIn(false)).toEqual([...M365_BASE_SCOPES]);
  });

  it("adds Sites.Read.All, and only that, when they have", () => {
    expect(scopesForSignIn(true)).toEqual([...M365_BASE_SCOPES, "Sites.Read.All"]);
  });

  it("hands back a fresh array each time, so a caller cannot edit the shared set", () => {
    const a = scopesForSignIn(false);
    a.push("Mail.Send.Shared");
    expect(scopesForSignIn(false)).toEqual([...M365_BASE_SCOPES]);
    expect(scopesForSignIn(false)).not.toBe(scopesForSignIn(false));
  });
});

describe("scopesForRefresh — only what the connection already holds", () => {
  it.each([
    ["null (a legacy row)", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["blank", "   "],
  ])("asks for the base set when the grant is %s", (_label, granted) => {
    // That is what such a connection was signed in with; asking for LESS would
    // narrow what the next response records as granted.
    expect(scopesForRefresh(granted)).toEqual([...M365_BASE_SCOPES]);
  });

  it("asks for offline_access plus the held members of the base set — and never Sites.Read.All the grant does not carry", () => {
    // 🔴 The person turned SharePoint on after connecting and has not signed in
    // again. Asking for Sites.Read.All now would fail the refresh with a consent
    // error and mark a healthy connection NEEDS_RECONNECT.
    // (Mutation: add the SharePoint scope unconditionally and this goes red.)
    const asked = scopesForRefresh(GRANTED_BASE);
    expect(asked).toEqual([...M365_BASE_SCOPES]);
    expect(asked).not.toContain("Sites.Read.All");
  });

  it("includes Sites.Read.All once the grant carries it", () => {
    expect(scopesForRefresh(`${GRANTED_BASE} Sites.Read.All`)).toEqual([...M365_BASE_SCOPES, "Sites.Read.All"]);
  });

  it("matches case-insensitively and tolerates resource-qualified names, as Entra does", () => {
    const granted = "https://graph.microsoft.com/mail.readwrite https://graph.microsoft.com/Sites.Read.All FILES.READWRITE.ALL";
    expect(scopesForRefresh(granted)).toEqual(["offline_access", "Mail.ReadWrite", "Files.ReadWrite.All", "Sites.Read.All"]);
  });

  it("never requests a scope that is not in the connector's own set, even if the grant carries it", () => {
    // Tasks.ReadWrite is To Do's, which the connector does not request; a grant
    // that happens to name it must not make a refresh ask for it.
    expect(scopesForRefresh(`${GRANTED_BASE} Tasks.ReadWrite Sites.ReadWrite.All`)).toEqual([...M365_BASE_SCOPES]);
  });

  it("asks for only the held members when the grant is narrower than the base set", () => {
    // A person (or a tenant) who consented to less: refreshing with more would
    // fail, and refreshing with exactly what is held keeps the grant stable.
    expect(scopesForRefresh("Mail.ReadWrite User.Read")).toEqual(["offline_access", "User.Read", "Mail.ReadWrite"]);
  });

  it("always starts with offline_access, whether or not the grant echoes it, and never repeats a scope", () => {
    const asked = scopesForRefresh("offline_access Mail.ReadWrite Mail.ReadWrite mail.readwrite");
    expect(asked[0]).toBe("offline_access");
    expect(asked.filter((s) => s === "offline_access")).toHaveLength(1);
    expect(new Set(asked.map((s) => s.toLowerCase())).size).toBe(asked.length);
  });

  it("has a stable order: offline_access, then the base order, then Sites.Read.All", () => {
    expect(scopesForRefresh("Sites.Read.All Files.ReadWrite.All Mail.Send User.Read")).toEqual([
      "offline_access",
      "User.Read",
      "Mail.Send",
      "Files.ReadWrite.All",
      "Sites.Read.All",
    ]);
  });
});
