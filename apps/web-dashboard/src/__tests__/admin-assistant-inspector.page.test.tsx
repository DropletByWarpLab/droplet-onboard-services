/**
 * /admin/prompt — the assistant inspector.
 *
 * The verdicts belong to the orchestrator and are pinned there. What this file
 * holds is the half a page can get wrong on its own:
 *
 *   - the two probes degrade independently, so a failed prompt read does not
 *     blank the tool table (the console's own rule, `app/admin/page.tsx`);
 *   - "no role narrowing" is not rendered as "unrestricted" — the trap the
 *     service's own doc warns about, and the one that would tell an admin a
 *     family account can change settings it demonstrably cannot;
 *   - an unresolvable person reads as a state, not as a count of zero;
 *   - the gate behind every absence is on screen, because a page that shows
 *     "132 withheld" with no reason is the page this slice replaced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { NAV_GROUPS, visibleItems } from "@/components/nav-config";

const fetchUsersMock = vi.fn();
const fetchToolInspectMock = vi.fn();
const fetchPromptInspectMock = vi.fn();

// A PARTIAL mock. The shell this page renders inside pulls other fetchers off
// the same module, and replacing the whole module wholesale turns an unrelated
// import into a failure that reads like a bug in this page.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  fetchToolInspect: (...a: any[]) => fetchToolInspectMock(...a),
  fetchPromptInspect: (...a: any[]) => fetchPromptInspectMock(...a),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: "owner" }, loading: false }),
  authFetch: vi.fn(),
}));

import AssistantInspectorPage from "@/app/admin/prompt/page";

const TOOLS = {
  targetUserId: "u1",
  tier: "family",
  unresolved: null,
  noRoleNarrowing: false,
  counts: {
    registered: 139,
    advertised: 6,
    withheld: 133,
    byGate: {
      write_tier: 40,
      role_grant: 20,
      interview_strip: 0,
      off_lan_withhold: 0,
      chat_policy: 54,
      turn_relevance: 19,
    },
  },
  rows: [
    {
      name: "read_file",
      domain: "files",
      homeDescription: "Read a file",
      requiresWrite: false,
      requiresConfirmation: false,
      advertised: true,
      gate: null,
      reason: null,
      alsoWithheldBy: [],
    },
    {
      name: "set_wifi_ssid",
      domain: "network",
      homeDescription: "Rename the Wi-Fi",
      requiresWrite: true,
      requiresConfirmation: true,
      advertised: false,
      gate: "write_tier",
      reason: "It changes something, and family is not owner or admin.",
      alsoWithheldBy: ["role_grant", "turn_relevance"],
    },
  ],
};

const PROMPT = {
  targetUserId: "u1",
  tier: "family",
  unresolved: null,
  blocks: [
    {
      key: "identity",
      label: "Who Droplet is",
      status: "present",
      text: "IDENTITY",
      chars: 8,
      cap: 4000,
      neverDropped: true,
    },
    {
      key: "persona",
      label: "Personality",
      status: "errored",
      text: null,
      chars: 0,
      cap: 1200,
      neverDropped: false,
      note: "This block could not be composed (TypeError).",
    },
  ],
  assembled: "IDENTITY and the rest of it",
  assembledChars: 27,
  erroredBlocks: ["persona"],
};

const selectPerson = async () => {
  const select = await screen.findByLabelText("Person");
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(select, { target: { value: "u1" } });
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchUsersMock.mockResolvedValue({
    users: [{ userId: "u1", username: "sam", displayName: "Sam" }],
  });
  fetchToolInspectMock.mockResolvedValue(TOOLS);
  fetchPromptInspectMock.mockResolvedValue(PROMPT);
});

describe("the assistant inspector", () => {
  it("asks for a person before inspecting anybody", async () => {
    // A page that auto-selected the first person in the roster would write an
    // audit row about somebody nobody asked about, every time it loaded.
    render(<AssistantInspectorPage />);
    await screen.findByLabelText("Person");
    expect(fetchToolInspectMock).not.toHaveBeenCalled();
    expect(fetchPromptInspectMock).not.toHaveBeenCalled();
  });

  it("shows the gate behind an absence, not just a count", async () => {
    render(<AssistantInspectorPage />);
    await selectPerson();

    await screen.findByText("Rename the Wi-Fi");
    // The group heading is the gate, in the person's language.
    expect(screen.getByText("Not owner or admin")).toBeTruthy();
    expect(
      screen.getByText(/It changes something, and family is not owner or admin/),
    ).toBeTruthy();
  });

  it("says how many OTHER reasons hold a tool back", async () => {
    // One gate means one grant away; three means the grant is not the problem.
    render(<AssistantInspectorPage />);
    await selectPerson();
    expect(await screen.findByText("+2 other reasons")).toBeTruthy();
  });

  it("🔴 does not render `no role narrowing` as `unrestricted`", async () => {
    // The trap the service's own doc calls out. A role-less family user has no
    // §3 narrowing AND still loses every write tool to the tier gate; a page
    // that translated the flag into "unrestricted" would be telling an admin
    // the opposite of what the box does.
    fetchToolInspectMock.mockResolvedValue({
      ...TOOLS,
      tier: "family",
      noRoleNarrowing: true,
    });
    render(<AssistantInspectorPage />);
    await selectPerson();

    await screen.findByText(/No custom role assigned/);
    expect(screen.getByText(/Tools that change things are still withheld/)).toBeTruthy();
    expect(screen.queryByText(/unrestricted/i)).toBeNull();
  });

  it("says `no role limits apply` only for the owner", async () => {
    fetchToolInspectMock.mockResolvedValue({
      ...TOOLS,
      tier: "owner",
      noRoleNarrowing: true,
    });
    render(<AssistantInspectorPage />);
    await selectPerson();
    expect(await screen.findByText(/Owner — no role limits apply/)).toBeTruthy();
  });

  it("🔴 reports an unresolvable person as a state, not as zero tools", async () => {
    fetchToolInspectMock.mockResolvedValue({
      ...TOOLS,
      tier: null,
      unresolved: "user_deactivated",
      counts: { ...TOOLS.counts, advertised: 0, withheld: 139 },
      rows: TOOLS.rows.map((r) => ({ ...r, advertised: false, gate: "role_grant" })),
    });
    render(<AssistantInspectorPage />);
    await selectPerson();

    expect(await screen.findByText("No assistant runs for this person")).toBeTruthy();
    expect(screen.getByText(/deactivated/)).toBeTruthy();
  });

  it("🔴 a failed prompt read does not blank the tool table", async () => {
    // Independent probes. The console's rule is that each half degrades alone
    // — a page that shows nothing when it could show half is a page an admin
    // stops opening.
    fetchPromptInspectMock.mockRejectedValue(new Error("brain unreachable"));
    render(<AssistantInspectorPage />);
    await selectPerson();

    expect(await screen.findByText("Read a file")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/Could not read the prompt/)).toBeTruthy(),
    );
  });

  it("🔴 a failed tool read does not blank the prompt", async () => {
    fetchToolInspectMock.mockRejectedValue(new Error("nope"));
    render(<AssistantInspectorPage />);
    await selectPerson();

    await waitFor(() =>
      expect(screen.getByText(/Could not read the tool list/)).toBeTruthy(),
    );
    expect(await screen.findByText("Who Droplet is")).toBeTruthy();
  });

  it("🔴 surfaces a block that failed to compose, rather than showing it as unset", async () => {
    // The whole reason the endpoint does not inherit the turn's fail-open.
    render(<AssistantInspectorPage />);
    await selectPerson();

    expect(await screen.findByText("Broken")).toBeTruthy();
    expect(screen.getByText("Some of the prompt could not be built")).toBeTruthy();
  });

  it("shows the prompt itself, not a description of it", async () => {
    render(<AssistantInspectorPage />);
    await selectPerson();
    expect(await screen.findByText("IDENTITY and the rest of it")).toBeTruthy();
  });
});

describe("nav", () => {
  const CAPS = { claudeActivity: true, ragEval: true };
  const ALL_MODULES_ON = () => true;

  it("puts Assistant in the operator nav and nowhere else", async () => {
    const seen = (role: string) =>
      NAV_GROUPS.flatMap((g) =>
        visibleItems(g.items, role as never, CAPS, ALL_MODULES_ON),
      );

    expect(seen("owner").some((i) => i.href === "/admin/prompt")).toBe(true);
    expect(seen("admin").some((i) => i.href === "/admin/prompt")).toBe(true);
    expect(seen("family").some((i) => i.href === "/admin/prompt")).toBe(false);
    expect(seen("guest").some((i) => i.href === "/admin/prompt")).toBe(false);
  });

  it("🔴 stays visible with every module switched OFF", async () => {
    // The reason it carries no `requiresModule`. A console page that explains
    // why the assistant cannot reach a module must not be gated on that
    // module — the box where it disappears is the box you needed it on.
    const off = NAV_GROUPS.flatMap((g) =>
      visibleItems(g.items, "owner" as never, CAPS, () => false),
    );
    expect(off.some((i) => i.href === "/admin/prompt")).toBe(true);
  });

  it("carries no module requirement", async () => {
    // A page whose job is explaining why the assistant cannot reach something
    // must not itself vanish when a module is switched off.
    const item = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.href === "/admin/prompt",
    );
    expect(item).toBeTruthy();
    expect(item!.requiresModule).toBeUndefined();
  });
});
