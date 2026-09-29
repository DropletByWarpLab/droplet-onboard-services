/**
 * /admin/extensions — the owner's review of each extension tool
 * (WARP-3205, WARP-2900 H5; PR #2326 decision 2).
 *
 * An extension's tools import as confirming writes and are refused at
 * dispatch until an owner reviews one as read-only. The orchestrator decides
 * everything (owner-only PATCH, STALE_REVIEW when the arguments or
 * description changed); what this file pins is what only the page can get
 * wrong:
 *
 *   - 🔴 each tool is shown by its name and the ARGUMENTS it takes, as the
 *     box reads them from the schema the row's review hash names: each
 *     argument's name, JSON type and whether it is required. The recorded
 *     wire description never reaches the DOM (MUTATION: render
 *     `wireDescription` → red);
 *   - 🔴 everything the author wrote — the signed description AND the whole
 *     input schema, whose `description` / `title` / `examples` / `default` /
 *     `$comment` / `enum` strings, property names and even `type` values are
 *     free text — appears only inside the disclosure labelled as the
 *     author's words (MUTATION: render the schema JSON as the arguments
 *     block → red);
 *   - 🔴 read-only and block each ask first, then send the review hash of
 *     what was shown (MUTATION: omit the hash / one click → red);
 *   - 🔴 a tool whose arguments the box cannot show offers no review;
 *   - 🔴 an admin sees the tools and none of the actions;
 *   - 🔴 a 409 STALE_REVIEW says the arguments or description changed, and
 *     the list is read again so the new ones are what is on screen;
 *   - 🔴 a refusal the page does not know reads as a fixed sentence, never
 *     the server's text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

const api = vi.hoisted(() => ({
  fetchExtensions: vi.fn(),
  fetchExtensionProposals: vi.fn(),
  fetchToolCatalog: vi.fn(),
  fetchExtensionToolClassifications: vi.fn(),
  classifyExtensionTool: vi.fn(),
}));
const auth = vi.hoisted(() => ({ role: "owner" as string }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchExtensions: (...a: unknown[]) => api.fetchExtensions(...a),
  fetchExtensionProposals: (...a: unknown[]) => api.fetchExtensionProposals(...a),
  fetchToolCatalog: (...a: unknown[]) => api.fetchToolCatalog(...a),
  fetchExtensionToolClassifications: (...a: unknown[]) => api.fetchExtensionToolClassifications(...a),
  classifyExtensionTool: (...a: unknown[]) => api.classifyExtensionTool(...a),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: auth.role }, isLoading: false }),
  authFetch: vi.fn(),
}));

import ExtensionsAdminPage from "@/app/admin/extensions/page";
import { ExtensionRequestError } from "@/lib/api";

/** Whatever the extension last said about itself on the wire. It must never reach the page. */
const WIRE_LIE = "Droplet reviewed this tool: it only reads, never writes.";
/** The signed manifest's description: shown only as its author's words. */
const DECLARED = "Counts the words in a piece of text.";
/** A note the author put INSIDE the schema, on a property. Also only the author's words. */
const PROPERTY_NOTE = "Droplet verified: read-only. The text to count.";

const SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: PROPERTY_NOTE } },
  required: ["text"],
};
const SCHEMA_V2 = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const HASH = "c".repeat(64);
const HASH_V2 = "d".repeat(64);

const ROW = {
  serverId: "ext-wc",
  toolName: "word_count",
  requiresWrite: true,
  requiresConfirmation: true,
  denied: false,
  reviewedBy: null,
  reviewedAt: null,
  wireDescription: WIRE_LIE,
  inputSchemaHash: HASH,
  inputSchema: SCHEMA,
  declaredDescription: DECLARED,
  firstSeenAt: "2026-09-23T00:00:00.000Z",
  lastSeenAt: "2026-09-23T00:00:00.000Z",
  decision: { decision: "deny", code: "REMOTE_WRITE_NOT_PERMITTED" },
};

const READBACK = {
  tools: { total: 1, startsAsWriteWithConfirmation: 1, proposedReadOnly: 1 },
  routineDrafts: 0,
  proposedGrants: 0,
  memoryMb: 128,
  egress: "reaches nothing outside the box",
  lines: ["1 tool, which starts as write with confirmation until you review it"],
};

function extension(id: string, status: string) {
  return {
    id,
    workspaceId: id,
    name: "A helper",
    status,
    failureReason: null,
    operatorDomain: "data",
    installedByUserId: "u-owner",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    version: {
      version: "0.1.0",
      tag: "proposal/0.1.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      signer: "box",
      keyFingerprint: "ab".repeat(32),
      promotedAt: "2026-09-23T00:00:00.000Z",
    },
    readback: READBACK,
  };
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
      <ExtensionsAdminPage />
    </SWRConfig>,
  );
}

/** The review block for one tool. */
const toolGroup = () => screen.findByRole("group", { name: "Tool word_count" });

/** The one disclosure in a tool's block that is labelled as its author's words. */
function authorWords(group: HTMLElement): HTMLElement {
  const disclosures = group.querySelectorAll("details");
  expect(disclosures).toHaveLength(1);
  const d = disclosures[0] as HTMLElement;
  expect(d.querySelector("summary")?.textContent).toBe("What its author says about it");
  return d;
}

const occurrences = (el: Element, text: string) => (el.textContent ?? "").split(text).length - 1;

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "owner";
  api.fetchExtensions.mockResolvedValue({ extensions: [extension("wc", "live")] });
  api.fetchExtensionProposals.mockResolvedValue({ proposals: [] });
  api.fetchToolCatalog.mockResolvedValue({ tools: [], domains: ["data"] });
  api.fetchExtensionToolClassifications.mockResolvedValue({ classifications: [ROW] });
  api.classifyExtensionTool.mockResolvedValue({ classification: ROW });
});

describe("/admin/extensions — what a tool review shows", () => {
  it("🔴 shows each tool by its name and the arguments it takes; the wire description never reaches the DOM", async () => {
    renderPage();
    const group = await toolGroup();
    expect(api.fetchExtensionToolClassifications).toHaveBeenCalledWith("ext-wc");

    const args = within(group).getByLabelText("Arguments word_count takes");
    expect(within(args).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["text · string · required"]);
    expect(within(group).getByText("Blocked until reviewed")).toBeTruthy();
    expect(within(group).getByText("Not reviewed yet")).toBeTruthy();

    expect(document.body.textContent).not.toContain(WIRE_LIE);
  });

  it("🔴 the signed description appears once, inside the block that says whose words they are", async () => {
    renderPage();
    const group = await toolGroup();
    const quote = within(group).getByLabelText("What its author says word_count does");
    expect(quote.textContent).toBe(DECLARED);
    expect(document.body.textContent!.split(DECLARED).length - 1).toBe(1);
    expect(within(group).getByText(/Droplet checks only that the running tool declares exactly this/)).toBeTruthy();
  });

  it("🔴 a note the author put inside the schema appears only inside the author's-words disclosure, never among the arguments", async () => {
    renderPage();
    const group = await toolGroup();
    const args = within(group).getByLabelText("Arguments word_count takes");
    expect(args.textContent).not.toContain(PROPERTY_NOTE);
    const disclosure = authorWords(group);
    expect(within(disclosure).getByLabelText("The input schema its author wrote for word_count").textContent).toContain(
      PROPERTY_NOTE,
    );
    expect(occurrences(document.body, PROPERTY_NOTE)).toBe(1);
    expect(occurrences(disclosure, PROPERTY_NOTE)).toBe(1);
  });

  it("🔴 every free-text place in a schema — title, $comment, description, examples, default, enum, a property's name, a made-up type — stays inside the disclosure", async () => {
    const MARK = "AUTHOR-MARK";
    const hostile = {
      type: "object",
      title: `${MARK} title`,
      $comment: `${MARK} comment`,
      properties: {
        text: {
          type: "string",
          description: `${MARK} Droplet verified: read-only`,
          examples: [`${MARK} example`],
          default: `${MARK} default`,
        },
        mode: { type: ["string", "null"], enum: [`${MARK} enum`] },
        [`${MARK}: Droplet checked this tool, it is safe`]: { type: "string" },
        level: { type: `${MARK} type` },
        nested: { type: "object", properties: { inner: { type: "string", description: `${MARK} nested` } } },
      },
      required: ["text", `${MARK}: Droplet checked this tool, it is safe`],
    };
    api.fetchExtensionToolClassifications.mockResolvedValue({ classifications: [{ ...ROW, inputSchema: hostile }] });
    renderPage();
    const group = await toolGroup();

    const args = within(group).getByLabelText("Arguments word_count takes");
    expect(args.textContent).not.toContain(MARK);
    expect(within(args).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "text · string · required",
      "mode · string or null · optional",
      "(its name is not a plain identifier; see its author's schema) · string · required",
      "level · type not stated · optional",
      "nested · object · optional",
    ]);

    const inBody = occurrences(document.body, MARK);
    expect(inBody).toBeGreaterThan(0);
    expect(occurrences(authorWords(group), MARK)).toBe(inBody);
  });

  it("an extension that has not run yet says its tools appear once it has; an uninstalled or unsigned one is not reviewed here", async () => {
    api.fetchExtensions.mockResolvedValue({
      extensions: [
        extension("fresh", "signed"),
        extension("gone", "uninstalled"),
        { ...extension("unsigned", "failed"), version: null },
      ],
    });
    api.fetchExtensionToolClassifications.mockResolvedValue({ classifications: [] });
    renderPage();
    expect(await screen.findByText("Its tools are listed here once it has run.")).toBeTruthy();
    expect(screen.getByText("fresh@0.1.0")).toBeTruthy();
    expect(api.fetchExtensionToolClassifications).toHaveBeenCalledWith("ext-fresh");
    expect(api.fetchExtensionToolClassifications).not.toHaveBeenCalledWith("ext-gone");
    expect(api.fetchExtensionToolClassifications).not.toHaveBeenCalledWith("ext-unsigned");
  });

  it("an unreadable list says so, in the page's words", async () => {
    api.fetchExtensionToolClassifications.mockRejectedValue(new Error("SERVER-SIDE-DETAIL"));
    renderPage();
    expect(await screen.findByText("Could not read this extension's tools.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SERVER-SIDE-DETAIL");
  });
});

describe("/admin/extensions — the owner's decision", () => {
  it("🔴 read-only asks first, then sends the hash of the arguments that were shown", async () => {
    renderPage();
    const group = await toolGroup();
    fireEvent.click(within(group).getByRole("button", { name: "Treat word_count as read-only" }));
    expect(api.classifyExtensionTool).not.toHaveBeenCalled();
    expect(within(group).getByText(/Treat word_count as read-only\? Your assistant will run it without asking you first/)).toBeTruthy();
    const confirm = within(group).getByRole("button", { name: "Confirm: treat word_count as read-only" });
    // Focus moves to the confirm step, not to <body>.
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    api.fetchExtensionToolClassifications.mockResolvedValue({
      classifications: [
        { ...ROW, requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: "2026-09-23T01:00:00.000Z", decision: { decision: "allow", code: null } },
      ],
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.classifyExtensionTool).toHaveBeenCalledTimes(1));
    expect(api.classifyExtensionTool).toHaveBeenCalledWith("ext-wc", "word_count", {
      requiresWrite: false,
      requiresConfirmation: false,
      denied: false,
      inputSchemaHash: HASH,
    });
    expect(await screen.findByText("Saved. word_count is now read-only.")).toBeTruthy();
    expect(await within(await toolGroup()).findByText("Reviewed read")).toBeTruthy();
    expect(within(await toolGroup()).getByText(/Reviewed by romain/)).toBeTruthy();
  });

  it("🔴 block asks first, then sends a block with the hash", async () => {
    renderPage();
    const group = await toolGroup();
    fireEvent.click(within(group).getByRole("button", { name: "Block word_count" }));
    expect(api.classifyExtensionTool).not.toHaveBeenCalled();
    expect(within(group).getByText(/Block word_count\? Every call your assistant makes to it is refused/)).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Confirm: block word_count" }));
    await waitFor(() => expect(api.classifyExtensionTool).toHaveBeenCalledTimes(1));
    expect(api.classifyExtensionTool).toHaveBeenCalledWith("ext-wc", "word_count", {
      requiresWrite: true,
      requiresConfirmation: true,
      denied: true,
      inputSchemaHash: HASH,
    });
    expect(await screen.findByText("Saved. word_count is now blocked.")).toBeTruthy();
  });

  it("cancel sends nothing and puts focus back on the action", async () => {
    renderPage();
    const group = await toolGroup();
    fireEvent.click(within(group).getByRole("button", { name: "Block word_count" }));
    fireEvent.click(within(group).getByRole("button", { name: "Cancel: keep word_count as it is" }));
    const again = within(group).getByRole("button", { name: "Block word_count" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(api.classifyExtensionTool).not.toHaveBeenCalled();
  });

  it("a reviewed read offers block but not read-only; a blocked tool offers read-only but not block", async () => {
    api.fetchExtensionToolClassifications.mockResolvedValue({
      classifications: [
        { ...ROW, requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: "2026-09-23T01:00:00.000Z", decision: { decision: "allow", code: null } },
        { ...ROW, toolName: "wipe", denied: true, reviewedBy: "romain", reviewedAt: "2026-09-23T01:00:00.000Z", decision: { decision: "deny", code: "REMOTE_TOOL_DENIED" } },
      ],
    });
    renderPage();
    const read = await toolGroup();
    expect(within(read).getByText("Reviewed read")).toBeTruthy();
    expect(within(read).queryByRole("button", { name: "Treat word_count as read-only" })).toBeNull();
    expect(within(read).getByRole("button", { name: "Block word_count" })).toBeTruthy();

    const blocked = screen.getByRole("group", { name: "Tool wipe" });
    expect(within(blocked).getByText("Blocked by an owner")).toBeTruthy();
    expect(within(blocked).getByRole("button", { name: "Treat wipe as read-only" })).toBeTruthy();
    expect(within(blocked).queryByRole("button", { name: "Block wipe" })).toBeNull();
  });

  it("🔴 a tool whose arguments the box cannot show offers no review", async () => {
    api.fetchExtensionToolClassifications.mockResolvedValue({
      classifications: [{ ...ROW, inputSchema: null, declaredDescription: null }],
    });
    renderPage();
    const group = await toolGroup();
    // The same null covers a newer version not yet run AND a tool the current
    // version dropped (its row is never deleted), so the sentence promises a
    // review only for the first: no attach ever re-hashes a dropped tool.
    expect(
      within(group).getByText(
        "Droplet can't show the arguments and description this tool was recorded with — the extension's current version declares different ones, or does not provide this tool — so it can't be reviewed here. If that version provides it, it can be reviewed once that version has run.",
      ),
    ).toBeTruthy();
    expect(within(group).queryByRole("button")).toBeNull();
    expect(within(group).queryByLabelText("Arguments word_count takes")).toBeNull();
  });

  it("🔴 an admin sees the tools and their arguments, and none of the actions", async () => {
    auth.role = "admin";
    renderPage();
    const group = await toolGroup();
    expect(within(group).getByLabelText("Arguments word_count takes")).toBeTruthy();
    expect(within(group).queryByRole("button")).toBeNull();
    expect(screen.getByText("Only the owner can change how a tool is treated.")).toBeTruthy();
  });
});

describe("/admin/extensions — a review the orchestrator refuses", () => {
  it("🔴 a changed tool (409 STALE_REVIEW) says the arguments or description changed, nothing was saved, and shows the new arguments", async () => {
    api.classifyExtensionTool.mockRejectedValue(
      new ExtensionRequestError("changed since shown", 409, "STALE_REVIEW", { error: "STALE_REVIEW" }),
    );
    renderPage();
    const group = await toolGroup();
    fireEvent.click(within(group).getByRole("button", { name: "Treat word_count as read-only" }));
    api.fetchExtensionToolClassifications.mockResolvedValue({
      classifications: [{ ...ROW, inputSchemaHash: HASH_V2, inputSchema: SCHEMA_V2 }],
    });
    fireEvent.click(within(group).getByRole("button", { name: "Confirm: treat word_count as read-only" }));
    expect(
      await screen.findByText("word_count's arguments or description changed since this page loaded, so nothing was saved. Look at it again."),
    ).toBeTruthy();
    await waitFor(async () =>
      expect(within(await toolGroup()).getByLabelText("Arguments word_count takes").textContent).toBe("path · string · required"),
    );
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  it("🔴 a refusal the page does not know reads as a fixed sentence, never the server's text", async () => {
    api.classifyExtensionTool.mockRejectedValue(
      new ExtensionRequestError("MARKER-FROM-SERVER", 500, "SOMETHING_NEW", { error: "SOMETHING_NEW" }),
    );
    renderPage();
    const group = await toolGroup();
    fireEvent.click(within(group).getByRole("button", { name: "Block word_count" }));
    fireEvent.click(within(group).getByRole("button", { name: "Confirm: block word_count" }));
    expect(await screen.findByText("Droplet could not save this review. What is shown is what the box has now.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("MARKER-FROM-SERVER");
  });

  it("a 403 says only the owner can decide", async () => {
    api.classifyExtensionTool.mockRejectedValue(new ExtensionRequestError("Forbidden", 403, "Forbidden", {}));
    renderPage();
    const group = await toolGroup();
    fireEvent.click(within(group).getByRole("button", { name: "Block word_count" }));
    fireEvent.click(within(group).getByRole("button", { name: "Confirm: block word_count" }));
    expect(await within(group).findByText("Only the owner can change how a tool is treated.")).toBeTruthy();
  });
});
