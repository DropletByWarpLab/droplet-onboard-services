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
  FOLLOWED_SITES_PATH,
  GRAPH_RESOURCES,
  M365_WORKLOADS,
  ONEDRIVE_DRIVE_PATH,
  SHAREPOINT_SITE_SEARCH_PATH,
  asWorkload,
  deltaTokenParamFor,
  discoveryUrlFor,
  grantCovers,
  initialUrlFor,
  parseOneDrive,
  parseSharePointLibrary,
  parseSharePointSite,
  redactDeltaTokens,
  siteDrivesPath,
} from "./graph-resources.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

describe("deltaTokenParamFor — the parameter is NOT uniform across Graph", () => {
  it.each(["files", "sharepoint"] as const)(
    "uses a bare `token` for %s — every driveItem workload, not just OneDrive",
    (workload) => {
      // 🔴 The single highest-damage fact in this module. Sending $deltatoken to
      // /me/drive/root/delta does not error — it starts a fresh enumeration of
      // the customer's entire OneDrive, on every tick, reported as incremental.
      //
      // WARP-3538 added a SECOND driveItem workload, and the reader used to be
      // `workload === "files" ? "token" : "$deltatoken"`: a new drive workload
      // would have inherited the Outlook parameter and full-scanned every
      // SharePoint library on every tick with nothing reporting a fault. The
      // `sharepoint` case is the one that goes red if that shape comes back.
      expect(deltaTokenParamFor(workload)).toBe("token");
    },
  );

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

  it("is declared on the spec and read from it — one place decides", () => {
    // The parameter is a property of the RESOURCE (driveItem vs Outlook), so
    // it sits on the descriptor beside the path it belongs to. The reader is
    // only a lookup: it cannot disagree with the spec because it has no
    // opinion of its own.
    for (const workload of M365_WORKLOADS) {
      expect(deltaTokenParamFor(workload)).toBe(GRAPH_RESOURCES[workload].deltaTokenParam);
    }
  });

  it("gives `token` to every workload whose delta lives on a drive — by shape, not by list", () => {
    // Structural guard for the NEXT drive workload (a group drive, a Teams
    // channel's files): anything whose first URL is a /drive or /drives/{id}
    // path is a driveItem delta, and driveItem's continuation is `token`.
    // Deriving "is a drive workload" from the path rather than from an
    // allow-list is what stops this test needing to be remembered.
    const driveShaped = M365_WORKLOADS.filter((w) =>
      /\/drives?\//.test(GRAPH_RESOURCES[w].initialPath("x", NOW)),
    );
    expect(driveShaped).toEqual(["files", "sharepoint"]);
    for (const workload of driveShaped) expect(deltaTokenParamFor(workload)).toBe("token");
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

  it("scopes SharePoint to a DRIVE — one cursor per document library, on /drives/{id}/root/delta", () => {
    // WARP-3538. A document library is a drive, and `/drives/{drive-id}/root/delta`
    // is the same driveItem delta as OneDrive's, addressed by id (driveitem-delta,
    // 2026-06-06). The resource id is the DRIVE id, never a site id or a path:
    // Graph is explicit that drive items are tracked by id.
    expect(initialUrlFor("sharepoint", "b!rK3-qL_9zE", NOW)).toBe(
      `${GRAPH_API_BASE_URL}/drives/b!rK3-qL_9zE/root/delta`,
    );
  });

  it("escapes a drive id rather than interpolating it raw", () => {
    const url = initialUrlFor("sharepoint", "b!a/b?c=d", NOW)!;
    expect(url).toBe(`${GRAPH_API_BASE_URL}/drives/${encodeURIComponent("b!a/b?c=d")}/root/delta`);
    expect(url).not.toContain("a/b?c=d");
  });

  it("does not name discovery for SharePoint as a single URL — it is a walk over sites", () => {
    // `discoveryUrlFor` answers "is there ONE collection to list". For SharePoint
    // there is not: sites come from two collections and each site's libraries
    // from a third, so a non-null here would send the folder walk down the wrong
    // road. The discriminant below is what tells the engine which road it is.
    expect(discoveryUrlFor("sharepoint")).toBeNull();
    expect(GRAPH_RESOURCES.sharepoint.childCollectionPath).toBeUndefined();
  });

  it("declares HOW each workload is discovered, so a null path cannot mean two things", () => {
    // Before WARP-3538 `discoveryPath: null` meant "one implicit resource", and
    // the engine read it that way. SharePoint is also null (its discovery is
    // custom), so reading the path alone would register ONE bogus cursor for it
    // and nothing would fail. The discriminant makes the two cases different
    // facts rather than different readings of the same null.
    expect(
      Object.fromEntries(M365_WORKLOADS.map((w) => [w, GRAPH_RESOURCES[w].discovery])),
    ).toEqual({
      mail: "folders",
      calendar: "singleton",
      contacts: "folders",
      files: "singleton",
      todo: "folders",
      sharepoint: "sites",
    });
  });

  it("keeps the path and the discriminant in agreement for every workload", () => {
    // A `folders` workload without a path would walk nothing; a path on a
    // singleton or sites workload would never be read. Either is silent.
    for (const workload of M365_WORKLOADS) {
      const spec = GRAPH_RESOURCES[workload];
      expect(spec.discoveryPath !== null, workload).toBe(spec.discovery === "folders");
    }
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
    // Site discovery is what needs it: site-search and followedSites both list
    // delegated Sites.Read.All as the least-privileged permission (2026-06-19,
    // 2026-03-07), and the drive reads it unlocks are covered by the same grant.
    expect(GRAPH_RESOURCES.sharepoint.leastPrivilegeScope).toBe("Sites.Read.All");
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

  it("admits exactly the six shipped workloads", () => {
    // WARP-3538 appended `sharepoint`. Appended, not inserted: the order is the
    // order discovery runs in and the order every `notGranted` list reads in.
    expect([...M365_WORKLOADS]).toEqual([
      "mail",
      "calendar",
      "contacts",
      "files",
      "todo",
      "sharepoint",
    ]);
  });

  it("gives every workload a spec — the Record is total", () => {
    expect(Object.keys(GRAPH_RESOURCES).sort()).toEqual([...M365_WORKLOADS].sort());
  });
});

describe("SharePoint discovery — vendor facts (WARP-3538)", () => {
  it("lists sites by search and by what the person follows — the two delegated collections", () => {
    // site-search (updated 2026-06-19) and sites-list-followed (2026-03-07) are
    // the only collections Microsoft documents for DELEGATED site discovery:
    // `GET /sites` and `getAllSites` are application-permission only.
    expect(SHAREPOINT_SITE_SEARCH_PATH).toBe("/sites?search=*");
    expect(FOLLOWED_SITES_PATH).toBe("/me/followedSites");
    // Never the application-only forms, which would 403 on a delegated token.
    for (const path of [SHAREPOINT_SITE_SEARCH_PATH, FOLLOWED_SITES_PATH]) {
      expect(path).not.toContain("getAllSites");
      expect(path).not.toMatch(/^\/sites$/);
    }
  });

  it("lists a site's document libraries from /sites/{id}/drives", () => {
    expect(siteDrivesPath("contoso.sharepoint.com,da60e844-ba1d-49bc-b4d4-d5e36bae9019,712a596e-90a1-49e3-9b48-bfa80bee8740")).toBe(
      "/sites/contoso.sharepoint.com,da60e844-ba1d-49bc-b4d4-d5e36bae9019,712a596e-90a1-49e3-9b48-bfa80bee8740/drives",
    );
  });

  it("keeps the commas of a composite site id literal and escapes anything that could change the path", () => {
    // A site id is `hostname,siteCollectionId,webId`, and Microsoft documents the
    // commas literally. Escaping them is not known to be safe on this router, and
    // a 404 on every site would read as "this person has no libraries". But the
    // id comes out of a response body, so a `/` or `?` in it must not become a
    // path segment or a query.
    expect(siteDrivesPath("h.example,a,b")).toBe("/sites/h.example,a,b/drives");
    const hostile = siteDrivesPath("h,a/../../me/messages?x=1#y");
    expect(hostile).toBe("/sites/h,a%2F..%2F..%2Fme%2Fmessages%3Fx%3D1%23y/drives");
    expect(hostile.split("/")).toHaveLength(4); // "", "sites", id, "drives"
  });
});

describe("parseSharePointSite — which discovered sites a person's libraries may come from (WARP-3538)", () => {
  const site = (over: Record<string, unknown> = {}) => ({
    id: "contoso.sharepoint.com,aaa,bbb",
    displayName: "Front desk",
    name: "frontdesk",
    webUrl: "https://contoso.sharepoint.com/sites/frontdesk",
    ...over,
  });

  it("keeps an ordinary team or communication site", () => {
    expect(parseSharePointSite(site())).toEqual({
      id: "contoso.sharepoint.com,aaa,bbb",
      displayName: "Front desk",
      webUrl: "https://contoso.sharepoint.com/sites/frontdesk",
    });
  });

  it("falls back to `name`, then to the URL's last segment, for a display name", () => {
    expect(parseSharePointSite(site({ displayName: undefined }))?.displayName).toBe("frontdesk");
    expect(parseSharePointSite(site({ displayName: "  ", name: undefined }))?.displayName).toBe("frontdesk");
  });

  it("excludes a personal site flagged isPersonalSite", () => {
    // Somebody's OneDrive is not a "SharePoint library the person can open": it
    // is reached through the `files` workload for the person it belongs to, and
    // other people's personal OneDrives are never read (the setup guide says so).
    expect(parseSharePointSite(site({ isPersonalSite: true }))).toBeNull();
    expect(parseSharePointSite(site({ isPersonalSite: false }))).not.toBeNull();
  });

  it("excludes a personal site by its host even when the flag is absent", () => {
    // Search results are documented as shortened, and the example response
    // carries no isPersonalSite at all. The `-my` host is the second witness.
    expect(
      parseSharePointSite(site({ webUrl: "https://contoso-my.sharepoint.com/personal/sam_contoso_com" })),
    ).toBeNull();
    expect(
      parseSharePointSite(site({ webUrl: "https://CONTOSO-MY.SharePoint.com/personal/sam" })),
    ).toBeNull();
  });

  it("does not mistake a site that merely mentions `my` in its path for a personal one", () => {
    expect(
      parseSharePointSite(site({ webUrl: "https://contoso.sharepoint.com/sites/my.sharepoint.com-notes" })),
    ).not.toBeNull();
  });

  it("refuses a site it cannot place — no id, or no usable https URL", () => {
    // Without a webUrl the personal-site check cannot be made, and a person's
    // OneDrive must not slip through on an absence. Refusing is the safe side.
    expect(parseSharePointSite(site({ id: undefined }))).toBeNull();
    expect(parseSharePointSite(site({ id: "" }))).toBeNull();
    expect(parseSharePointSite(site({ webUrl: undefined }))).toBeNull();
    expect(parseSharePointSite(site({ webUrl: "not a url" }))).toBeNull();
    expect(parseSharePointSite(site({ webUrl: "http://contoso.sharepoint.com/sites/x" }))).toBeNull();
  });

  it("refuses a removed entry and anything that is not an object", () => {
    expect(parseSharePointSite(site({ "@removed": { reason: "deleted" } }))).toBeNull();
    expect(parseSharePointSite(null as never)).toBeNull();
  });
});

describe("parseSharePointLibrary — which of a site's drives are document libraries (WARP-3538)", () => {
  const SITE = { id: "contoso.sharepoint.com,aaa,bbb", displayName: "Front desk", webUrl: "https://contoso.sharepoint.com/sites/frontdesk" };
  const drive = (over: Record<string, unknown> = {}) => ({
    id: "b!rK3-qL_9zE",
    name: "Documents",
    driveType: "documentLibrary",
    webUrl: "https://contoso.sharepoint.com/sites/frontdesk/Shared Documents",
    ...over,
  });

  it("keeps a document library", () => {
    expect(parseSharePointLibrary(drive(), SITE)).toEqual({
      driveId: "b!rK3-qL_9zE",
      name: "Documents",
      webUrl: "https://contoso.sharepoint.com/sites/frontdesk/Shared Documents",
    });
  });

  it.each(["business", "personal", "documentLibrary ", "", undefined])(
    "keeps ONLY driveType documentLibrary — refuses %j",
    (driveType) => {
      // drive-list (2025-07-23) hides system drives unless `$select=system`, but
      // a list can still carry a personal or business drive, and the type is the
      // documented discriminator. A near miss ("documentLibrary ") is not it.
      expect(parseSharePointLibrary(drive({ driveType }), SITE)).toBeNull();
    },
  );

  it("skips anything carrying a `system` facet, whatever its type", () => {
    // Belt and braces over the documented default: the facet is the definition
    // of a system drive, so it wins over a driveType that says otherwise.
    expect(parseSharePointLibrary(drive({ system: {} }), SITE)).toBeNull();
    expect(parseSharePointLibrary(drive({ system: { anything: 1 } }), SITE)).toBeNull();
  });

  it("falls back to the site's URL for a library with no webUrl of its own", () => {
    expect(parseSharePointLibrary(drive({ webUrl: undefined }), SITE)?.webUrl).toBe(SITE.webUrl);
  });

  it("refuses a drive with no id, and falls back to the id for a nameless one", () => {
    expect(parseSharePointLibrary(drive({ id: undefined }), SITE)).toBeNull();
    expect(parseSharePointLibrary(drive({ id: "" }), SITE)).toBeNull();
    expect(parseSharePointLibrary(drive({ name: undefined }), SITE)?.name).toBe("b!rK3-qL_9zE");
  });
});

describe("parseOneDrive — the person's own OneDrive, from GET /me/drive (WARP-3538)", () => {
  const drive = (over: Record<string, unknown> = {}) => ({
    id: "b!rK3-qL_9zE-OneDrive",
    name: "OneDrive",
    driveType: "business",
    webUrl: "https://contoso-my.sharepoint.com/personal/sam_contoso_com/Documents",
    ...over,
  });

  it("is read from the drive resource Graph returns, at the documented path", () => {
    expect(ONEDRIVE_DRIVE_PATH).toBe("/me/drive");
    expect(parseOneDrive(drive())).toEqual({
      driveId: "b!rK3-qL_9zE-OneDrive",
      name: "OneDrive",
      webUrl: "https://contoso-my.sharepoint.com/personal/sam_contoso_com/Documents",
    });
  });

  it.each([null, undefined, "drive", 7, [], [drive()]])("refuses a body that is not one drive resource: %j", (body) => {
    expect(parseOneDrive(body)).toBeNull();
  });

  it("needs an id — with none there is nothing to file the person's items under", () => {
    expect(parseOneDrive(drive({ id: undefined }))).toBeNull();
    expect(parseOneDrive(drive({ id: "" }))).toBeNull();
    expect(parseOneDrive(drive({ id: "   " }))).toBeNull();
    expect(parseOneDrive(drive({ id: 12 }))).toBeNull();
  });

  it("falls back to \"OneDrive\" for a nameless drive rather than failing the registration", () => {
    expect(parseOneDrive(drive({ name: undefined }))?.name).toBe("OneDrive");
    expect(parseOneDrive(drive({ name: "" }))?.name).toBe("OneDrive");
  });

  it.each(["http://contoso-my.sharepoint.com/x", "javascript:alert(1)", "not a url", "", undefined, 3])(
    "drops a webUrl that is not https: %j",
    (webUrl) => {
      expect(parseOneDrive(drive({ webUrl }))?.webUrl).toBeNull();
    },
  );
});

describe("grantCovers (WARP-3059)", () => {
  it("covers a need with the same or a broader delegated grant", () => {
    expect(grantCovers(["Mail.ReadBasic"], "Mail.ReadBasic")).toBe(true);
    expect(grantCovers(["Mail.ReadWrite"], "Mail.ReadBasic")).toBe(true);
    expect(grantCovers(["Files.ReadWrite.All"], "Files.Read")).toBe(true);
    expect(grantCovers(["calendars.read"], "Calendars.Read")).toBe(true);
  });

  it("reads resource-qualified scopes by their last segment", () => {
    expect(grantCovers(["https://graph.microsoft.com/Contacts.ReadWrite"], "Contacts.Read")).toBe(true);
  });

  it("never covers a write need with a read grant, or a need from another resource", () => {
    expect(grantCovers(["Tasks.Read"], "Tasks.ReadWrite")).toBe(false);
    expect(grantCovers(["Mail.ReadWrite", "Calendars.ReadWrite"], "Tasks.ReadWrite")).toBe(false);
    expect(grantCovers(["Mail.Send"], "Mail.ReadBasic")).toBe(false);
    expect(grantCovers([], "Files.Read")).toBe(false);
  });

  it("matches what the connector requests by default: every workload but To Do and SharePoint", () => {
    // The base set (entra-client M365_BASE_SCOPES), as Microsoft returns it.
    // SharePoint is opt-in (WARP-3538) and To Do is never requested, so neither
    // is covered by what every connection holds.
    const granted = [
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "Files.ReadWrite.All",
    ];
    const covered = Object.values(GRAPH_RESOURCES)
      .filter((spec) => grantCovers(granted, spec.leastPrivilegeScope))
      .map((spec) => spec.workload);
    expect(covered).toEqual(["mail", "calendar", "contacts", "files"]);
  });

  it("covers SharePoint only with a Sites grant — Files.ReadWrite.All can read a drive but cannot find one", () => {
    // 🔴 This is what makes an EXISTING connection show "needs permission"
    // instead of silently attempting site discovery with a token that cannot
    // do it: the shipped scope set already reads drives (Files.ReadWrite.All),
    // but listing the sites a person can open is a different resource.
    const base = ["offline_access", "User.Read", "Mail.ReadWrite", "Files.ReadWrite.All"];
    const need = GRAPH_RESOURCES.sharepoint.leastPrivilegeScope;
    expect(grantCovers(base, need)).toBe(false);
    expect(grantCovers([...base, "Sites.Read.All"], need)).toBe(true);
    expect(grantCovers(["https://graph.microsoft.com/sites.read.all"], need)).toBe(true);
    // A broader Sites grant covers the narrower need; a scope that is not a
    // tenant-wide read (Sites.Selected) never does.
    expect(grantCovers(["Sites.ReadWrite.All"], need)).toBe(true);
    expect(grantCovers(["Sites.Selected"], need)).toBe(false);
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
