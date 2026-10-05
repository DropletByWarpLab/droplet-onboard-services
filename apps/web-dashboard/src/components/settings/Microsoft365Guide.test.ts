/**
 * WARP-3538 — the Microsoft 365 setup guide says what the card does about
 * SharePoint, in the card's own words.
 *
 * The guide is read by a business owner or whoever administers their Microsoft
 * tenant, often side by side with Settings. Two things go wrong quietly: the
 * guide names a switch, a limit or a line the card no longer has, or it softens
 * the one fact that stops a sign-in cold (that an administrator MUST approve the
 * permissions on Microsoft's default setting). Neither fails any build on its
 * own, so they are pinned here.
 *
 * `check-setup-guides.sh` does not cover this guide's content (Microsoft 365 is
 * per person and signs in rather than taking a pasted key, so it is not in
 * CLOUD_PROVIDERS and has no fact pins there); this file is its gate. What is
 * pinned is what a customer ACTS on, not the prose around it.
 *
 * Every pin reads the card's own exported constant where the card has one, never
 * a second copy of its text: a copy would stay green when the card changed.
 */
import { describe, it, expect } from "vitest";

import { INTEGRATION_GUIDES } from "@/lib/integration-guides";
import { SHAREPOINT_CONSENT_LINE, SHAREPOINT_LIBRARY_LIMIT, SHAREPOINT_SWITCH_LABEL } from "./Microsoft365Files";

const guide = INTEGRATION_GUIDES["microsoft-365"]!;
const lines = guide.split(/\r?\n/);

/** The six numbered sections the guide has always had. */
const SECTIONS = [
  "## 1. Who obtains this credential",
  "## 2. Click-path",
  "## 3. Plan prerequisite",
  "## 4. Scopes / permissions to tick",
  "## 5. What it costs the customer",
  "## 6. Rotation and expiry",
];

/** The text under one heading, up to the next heading of the same or a higher level. */
function section(heading: string): string {
  const start = lines.findIndex((l) => l.trim() === heading);
  expect(start, `the guide has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+)\s/);
    return m !== null && m[1]!.length <= level;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** One row of the permissions table, found by its permission. */
function row(permission: string): string {
  const found = lines.find((l) => l.startsWith(`| \`${permission}\` |`));
  expect(found, `the permissions table has no row for ${permission}`).toBeDefined();
  return found!;
}

describe("the guide's shape", () => {
  it("keeps its six numbered sections, in order", () => {
    const h2 = lines.filter((l) => l.startsWith("## ")).map((l) => l.trim());
    expect(h2.filter((h) => SECTIONS.includes(h))).toEqual(SECTIONS);
  });
});

describe("the permissions", () => {
  it("lists Sites.Read.All as needed only if SharePoint is on, and says it reads names and dates, not contents", () => {
    const r = row("Sites.Read.All");
    expect(r).toMatch(/Only if you turn on SharePoint/);
    expect(r).toMatch(/sites and document libraries you can open/);
    expect(r).toMatch(/names and dates, not contents/);
  });

  it("says Files.ReadWrite.All now covers the SharePoint libraries' file lists as well as OneDrive's", () => {
    const r = row("Files.ReadWrite.All");
    expect(r).toMatch(/OneDrive/);
    expect(r).toMatch(/SharePoint document libraries/);
    expect(r).toMatch(/names and dates, not contents/);
  });

  it("tells the administrator to include Sites.Read.All when ticking permissions, if anyone will use SharePoint", () => {
    expect(section("## 2. Click-path")).toMatch(/Include `Sites\.Read\.All` if anyone will use SharePoint/);
  });

  it("does not claim every permission is asked for as one set: Sites.Read.All is the exception", () => {
    expect(section("## 4. Scopes / permissions to tick")).toMatch(/every permission above except `Sites\.Read\.All`/);
  });
});

describe("admin consent", () => {
  // 🔴 The fact a sign-in stops on. Under Microsoft's default consent setting
  // people cannot approve these permissions themselves, so "if your organisation
  // requires" is wrong for a new tenant: it is the case, not an option.
  it("names Microsoft's default consent setting and says an administrator must select Grant admin consent", () => {
    const clickPath = section("## 2. Click-path");
    expect(clickPath).toMatch(/Let Microsoft manage your consent settings/);
    expect(clickPath).toMatch(/administrator must select \*\*Grant admin consent\*\*/);
  });

  it("no longer presents administrator approval as something only some organisations need", () => {
    expect(guide).not.toMatch(/If your organisation requires an administrator to approve apps/);
  });
});

describe("the SharePoint paragraph", () => {
  const text = () => section("### SharePoint libraries (optional)");

  it("names the card's switch exactly as the card labels it", () => {
    expect(text()).toContain(`**${SHAREPOINT_SWITCH_LABEL}**`);
  });

  it("says what is read, and what never is", () => {
    expect(text()).toMatch(/names, folders, locations and dates of the files/);
    expect(text()).toMatch(/never reads what is inside the files/);
    expect(text()).toMatch(/never reads anyone else's personal OneDrive/);
  });

  it("says the library limit the card says", () => {
    expect(text()).toContain(`at most ${SHAREPOINT_LIBRARY_LIMIT} libraries`);
  });

  it("says how to stop, and what stopping deletes", () => {
    expect(text()).toMatch(/switch the same setting off/);
    expect(text()).toMatch(/deletes the list of SharePoint files it kept/);
  });

  it("quotes the line the card shows while Microsoft has not approved SharePoint, and the button that follows", () => {
    expect(text()).toContain(`**${SHAREPOINT_CONSENT_LINE}**`);
    expect(text()).toMatch(/selects \*\*Sign in again\*\*/);
  });
});
