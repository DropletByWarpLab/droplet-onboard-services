/**
 * WARP-2118 — tests for the Graph resource table.
 *
 * These pin VENDOR FACTS, not behaviour, and the reason is that every one of
 * them fails silently. Graph does not reject an unrecognised delta parameter or
 * an endpoint that has no delta form — it starts a fresh enumeration, or
 * returns a plain collection — so the connector keeps working, keeps reporting
 * success, and full-scans the customer's mailbox on every tick.
 *
 * A test that asserts "this endpoint path is what Microsoft documents" is
 * therefore not ceremony. It is the only place a future refactor can be caught
 * turning an incremental sync into a permanent full scan.
 */
import { describe, expect, it } from "vitest";

import { GRAPH_API_BASE_URL } from "./graph-client.js";
import {
  CALENDAR_WINDOW,
  GRAPH_RESOURCES,
  M365_WORKLOADS,
  asWorkload,
  deltaTokenParamFor,
  discoveryUrlFor,
  initialUrlFor,
  redactDeltaTokens,
} from "./graph-resources.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

describe("deltaTokenParamFor — the parameter is NOT uniform across Graph", () => {
  it("uses a bare `token` for driveItem, not $deltatoken", () => {
    // 🔴 The single highest-damage fact in this module. Sending $deltatoken to
    // /me/drive/root/delta does not error — it starts a fresh enumeration of
    // the customer's entire OneDrive, on every tick, reported as incremental.
    expect(deltaTokenParamFor("files")).toBe("token");
  });

  it.each(["mail", "calendar", "contacts", "todo"] as const)(
    "uses $deltatoken for %s (Outlook and To Do resources)",
    (workload) => {
      expect(deltaTokenParamFor(workload)).toBe("$deltatoken");
    },
  );

  it("keeps the two families genuinely distinct", () => {
    // Mutation guard: collapsing this to one constant makes every workload
    // agree, which is exactly the bug. If this ever passes with a single
    // return value, the function has stopped deciding anything.
    const params = new Set(M365_WORKLOADS.map(deltaTokenParamFor));
    expect(params).toEqual(new Set(["$deltatoken", "token"]));
  });
});

describe("GRAPH_RESOURCES — endpoint shapes Microsoft actually documents", () => {
  it("scopes mail delta to a FOLDER — there is no /me/messages/delta", () => {
    const url = initialUrlFor("mail", "AAMkAD", NOW);
    expect(url).toBe(`${GRAPH_API_BASE_URL}/me/mailFolders/AAMkAD/messages/delta`);
    // The whole-mailbox form does not exist. A cursor grain built on it would
    // silently sync nothing.
    expect(url).not.toContain("/me/messages/delta");
  });

  it("discovers mail folders INCLUDING HIDDEN ONES, not via the root-only delta", () => {
    // 🔴 Regression guard. `/me/mailFolders/delta` looks like the obvious
    // discovery call and is the wrong one: Microsoft documents that listing
    // this collection returns "only the child folders of the root folder" and,
    // by default, no hidden folders. Using it registers top-level cursors only,
    // so mail in any nested folder is never enumerated — and nothing reports a
    // fault, because the cursors that do exist keep succeeding.
    expect(discoveryUrlFor("mail")).toBe(
      `${GRAPH_API_BASE_URL}/me/mailFolders?includeHiddenFolders=true`,
    );
    expect(discoveryUrlFor("mail")).not.toContain("/mailFolders/delta");
  });

  it("declares a child collection for every workload whose folders nest", () => {
    // The recursion is only possible where this is declared, so its presence
    // is the property worth pinning — absence would silently flatten the walk.
    expect(GRAPH_RESOURCES.mail.childCollectionPath?.("f1")).toBe(
      "/me/mailFolders/f1/childFolders",
    );
    expect(GRAPH_RESOURCES.contacts.childCollectionPath?.("c1")).toBe(
      "/me/contactFolders/c1/childFolders",
    );
    // Singleton workloads have no tree to walk.
    expect(GRAPH_RESOURCES.files.childCollectionPath).toBeUndefined();
    expect(GRAPH_RESOURCES.calendar.childCollectionPath).toBeUndefined();
  });

  it("puts calendar delta on calendarView with BOTH required window bounds", () => {
    const url = initialUrlFor("calendar", "-", NOW)!;
    // Delta is on calendarView, not on /me/events, and the bounds are mandatory.
    expect(url).toContain("/me/calendarView/delta");
    expect(url).not.toContain("/me/events/delta");
    expect(url).toContain("startDateTime=");
    expect(url).toContain("endDateTime=");
  });

  it("spans a wide calendar window, because rolling it forces a full re-enumeration", () => {
    const url = initialUrlFor("calendar", "-", NOW)!;
    const start = decodeURIComponent(url.match(/startDateTime=([^&]+)/)![1]);
    const end = decodeURIComponent(url.match(/endDateTime=([^&]+)/)![1]);
    expect(Date.parse(start)).toBe(NOW.getTime() - CALENDAR_WINDOW.backMs);
    expect(Date.parse(end)).toBe(NOW.getTime() + CALENDAR_WINDOW.forwardMs);
    // A narrow window would roll constantly, and each roll is a fresh full scan.
    expect(CALENDAR_WINDOW.backMs).toBeGreaterThanOrEqual(180 * 24 * 60 * 60 * 1000);
  });

  it("scopes contacts to a contact FOLDER", () => {
    expect(initialUrlFor("contacts", "folder1", NOW)).toBe(
      `${GRAPH_API_BASE_URL}/me/contactFolders/folder1/contacts/delta`,
    );
  });

  it("uses the drive ROOT delta and needs no discovery", () => {
    expect(initialUrlFor("files", "-", NOW)).toBe(`${GRAPH_API_BASE_URL}/me/drive/root/delta`);
    expect(discoveryUrlFor("files")).toBeNull();
  });

  it("scopes To Do to a list", () => {
    expect(initialUrlFor("todo", "list1", NOW)).toBe(
      `${GRAPH_API_BASE_URL}/me/todo/lists/list1/tasks/delta`,
    );
  });

  it("escapes a resource id rather than interpolating it raw", () => {
    // Outlook folder ids are base64url-ish and routinely carry characters that
    // change a path if pasted in unescaped.
    const url = initialUrlFor("mail", "a/b?c=d", NOW)!;
    expect(url).toContain(encodeURIComponent("a/b?c=d"));
  });

  it("never reaches /beta", () => {
    for (const w of M365_WORKLOADS) {
      expect(initialUrlFor(w, "x", NOW)).not.toContain("/beta");
    }
  });

  it("records the least-privileged scope, and flags To Do as the one write exception", () => {
    expect(GRAPH_RESOURCES.mail.leastPrivilegeScope).toBe("Mail.ReadBasic");
    expect(GRAPH_RESOURCES.calendar.leastPrivilegeScope).toBe("Calendars.Read");
    expect(GRAPH_RESOURCES.contacts.leastPrivilegeScope).toBe("Contacts.Read");
    expect(GRAPH_RESOURCES.files.leastPrivilegeScope).toBe("Files.Read");
    // Microsoft's todoTaskList delta lists Tasks.Read as "Not available" for
    // delegated access, so read-only is genuinely not on offer here.
    expect(GRAPH_RESOURCES.todo.leastPrivilegeScope).toBe("Tasks.ReadWrite");
  });

  it("asks for no write scope on any workload that offers a read-only one", () => {
    const writeScoped = M365_WORKLOADS.filter((w) =>
      GRAPH_RESOURCES[w].leastPrivilegeScope.includes("ReadWrite"),
    );
    expect(writeScoped).toEqual(["todo"]);
  });
});

describe("asWorkload / initialUrlFor — an unknown workload is refused, never guessed", () => {
  it("returns null rather than falling back to a default enumeration", () => {
    // Absence is never a silent success: a row written by a newer build must
    // surface as a fault on the cursor, not quietly sync the wrong resource.
    expect(asWorkload("teams")).toBeNull();
    expect(initialUrlFor("teams", "x", NOW)).toBeNull();
    expect(discoveryUrlFor("teams")).toBeNull();
  });

  it("admits exactly the five shipped workloads", () => {
    expect([...M365_WORKLOADS]).toEqual(["mail", "calendar", "contacts", "files", "todo"]);
  });
});

describe("redactDeltaTokens", () => {
  it("redacts the driveItem `token=` form the existing cursor regex misses", () => {
    // The gap this closes: delta-cursor.service.ts strips $deltatoken/$skiptoken
    // only, so the OneDrive form — the largest blast radius — would have leaked.
    const out = redactDeltaTokens("GET /me/drive/root/delta?token=SECRETVALUE failed");
    expect(out).not.toContain("SECRETVALUE");
    expect(out).toContain("token=[redacted]");
  });

  it.each(["$deltatoken", "$skiptoken"])("redacts the %s form", (param) => {
    const out = redactDeltaTokens(`https://graph.microsoft.com/v1.0/me?${param}=SECRETVALUE`);
    expect(out).not.toContain("SECRETVALUE");
  });

  it("redacts a token in the middle of a query string", () => {
    const out = redactDeltaTokens("/me/delta?$top=50&$deltatoken=SECRETVALUE&$select=id");
    expect(out).not.toContain("SECRETVALUE");
    expect(out).toContain("$select=id");
  });

  it("leaves a string with no token untouched", () => {
    expect(redactDeltaTokens("plain message")).toBe("plain message");
  });
});
