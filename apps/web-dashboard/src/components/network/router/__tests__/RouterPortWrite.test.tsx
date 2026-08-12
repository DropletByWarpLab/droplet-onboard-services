/**
 * Click-a-port write parity for the router — WARP-1907.
 *
 * The switch panel has had a port drawer since WARP-1674; the router's map was
 * read-only. These pin the half of the feature that lives in the browser:
 *
 *   - a jack opens a drawer (faceplate cell AND table row), for everyone;
 *   - the ACTIONS inside it are owner/admin only — a family member sees the
 *     facts and no buttons at all, the same RBAC shape SwitchPortDrawer uses;
 *   - the confirm choreography escalates. An ordinary jack takes one confirm.
 *     A guarded jack takes a SECOND, destructive one, and ONLY that second
 *     acknowledgement sends `force: true` — the flag the routing service
 *     demands before it will cut the WAN or a live management jack;
 *   - the escalated copy is the SERVER's `disable_guard.reason`, verbatim. The
 *     dashboard cannot re-derive it: whether a jack is a management jack
 *     depends on DROPLET_MGMT_INTERFACES, which is deployment configuration.
 *     Rendering our own sentence would be a second, drifting copy of the rule —
 *     and the two refusals differ on a load-bearing fact (a management jack
 *     reverts itself after a minute; the WAN jack never does).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { RouterPort, RouterPortMap } from "@/lib/types/router-ports";
import type { UseRouterPortsResult } from "@/lib/hooks/useRouterPorts";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const useRouterPortsMock = vi.fn();
vi.mock("@/lib/hooks/useRouterPorts", () => ({
  useRouterPorts: () => useRouterPortsMock(),
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
  authFetch: vi.fn(),
}));

const toastMock = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { RouterPortsPanel } from "../RouterPortsPanel";
import { RouterPortDrawer } from "../RouterPortDrawer";
import { RouterPortRefusedError } from "@/lib/api";

function port(over: Partial<RouterPort> & { id: string }): RouterPort {
  return {
    role: "lan",
    networks: ["lan", "guest"],
    present: true,
    admin_up: true,
    link_up: false,
    speed: null,
    duplex: null,
    mac: null,
    is_sfp: false,
    traffic: null,
    status: "offline",
    disable_guard: null,
    ...over,
  };
}

const WAN = port({
  id: "p1",
  role: "wan",
  networks: ["wan", "wan6"],
  link_up: true,
  speed: "2.5 Gb",
  duplex: "full",
  status: "online",
  disable_guard: {
    code: "WAN_PORT",
    reason: "This is the jack your internet comes in on. Nothing puts it back for you.",
  },
});

const LIVE_LAN = port({
  id: "p2",
  link_up: true,
  speed: "1 Gb",
  duplex: "full",
  status: "online",
  disable_guard: {
    code: "MANAGEMENT_PORT",
    reason: "This is the jack this dashboard reaches your appliance through.",
  },
});

const EMPTY_LAN = port({ id: "p5" });
const DISABLED = port({ id: "p6", admin_up: false, status: "disabled" });

const MAP: RouterPortMap = {
  supported: true,
  detail: null,
  model: "MikroTik RB5009",
  ports: [WAN, LIVE_LAN, EMPTY_LAN, DISABLED],
};

const setPortEnabled = vi.fn().mockResolvedValue(undefined);

function mockHook(over: Partial<UseRouterPortsResult> = {}) {
  useRouterPortsMock.mockReturnValue({
    map: MAP,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
    setPortEnabled,
    ...over,
  });
}

function asRole(role: string) {
  useAuthMock.mockReturnValue({
    user: { id: "u1", username: "ada", displayName: "Ada", role },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useRouterPortsMock.mockReset();
  setPortEnabled.mockClear().mockResolvedValue(undefined);
  mockHook();
  asRole("owner");
});

/**
 * Open the drawer for a jack from the port table.
 *
 * Scoped, because the panel renders BOTH layouts in the DOM at once — the table
 * is the `md:hidden` mirror of the faceplate, so an unscoped query for "port p5"
 * matches two buttons. That is a real property of the markup, not a test
 * artefact: whichever one the viewport shows must open the same drawer.
 */
async function openDrawer(id: string) {
  render(<RouterPortsPanel />);
  const table = screen.getByRole("region", { name: /router port table/i });
  fireEvent.click(within(table).getByRole("button", { name: new RegExp(`port ${id}\\b`, "i") }));
  return await screen.findByRole("dialog");
}

// ---------------------------------------------------------------------------
// Drawer, in isolation
// ---------------------------------------------------------------------------
describe("RouterPortDrawer", () => {
  const noop = () => {};

  it("shows the facts to everyone", () => {
    render(
      <RouterPortDrawer port={WAN} canWrite={false} onClose={noop} onAction={noop} />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("p1");
    expect(screen.getByRole("dialog")).toHaveTextContent("2.5 Gb");
  });

  it("hides every action from a member who cannot write", () => {
    render(
      <RouterPortDrawer port={EMPTY_LAN} canWrite={false} onClose={noop} onAction={noop} />,
    );
    expect(screen.queryByRole("button", { name: /turn (off|on) this port/i })).toBeNull();
  });

  it("offers Turn off for a live jack", () => {
    render(
      <RouterPortDrawer port={EMPTY_LAN} canWrite onClose={noop} onAction={noop} />,
    );
    expect(screen.getByRole("button", { name: /turn off this port/i })).toBeInTheDocument();
  });

  it("offers Turn on for a jack an operator already shut", () => {
    render(<RouterPortDrawer port={DISABLED} canWrite onClose={noop} onAction={noop} />);
    expect(screen.getByRole("button", { name: /turn on this port/i })).toBeInTheDocument();
  });

  it("surfaces the server's guard in the drawer, before anything is clicked", () => {
    /* The warning belongs where the decision is made, not only in the dialog
       that follows it. */
    render(<RouterPortDrawer port={WAN} canWrite onClose={noop} onAction={noop} />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/internet comes in on/i);
  });

  it("emits an action carrying the port, the direction and the server's guard", () => {
    const onAction = vi.fn();
    render(<RouterPortDrawer port={WAN} canWrite onClose={noop} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ port: WAN, enabled: false, guard: WAN.disable_guard }),
    );
  });

  it("carries NO guard when re-enabling a guarded jack", () => {
    /* Restoring the internet must not be harder than cutting it. */
    const onAction = vi.fn();
    const off = { ...WAN, admin_up: false, status: "disabled" as const };
    render(<RouterPortDrawer port={off} canWrite onClose={noop} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /turn on this port/i }));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, guard: null }),
    );
  });

  it("names WHAT goes dark, not just 'whatever is plugged in'", () => {
    /* The switch drawer names the device. A RouterPort has no device join, but
       it does know what the jack is FOR and which interfaces ride it — both
       already on screen as Facts. This is the only sentence an unguarded live
       jack (guest / other) shows before it is cut. */
    const onAction = vi.fn();
    const guest = port({
      id: "p6", role: "guest", networks: ["guest"], link_up: true,
      speed: "1 Gb", status: "online",
    });
    render(<RouterPortDrawer port={guest} canWrite onClose={noop} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    const { blast } = onAction.mock.calls[0][0];
    expect(blast).toContain("Guest");
    expect(blast).toContain("guest");
    expect(blast).not.toMatch(/whatever is plugged into/i);
  });

  it("promises a manual restore ONLY where that is the truth", () => {
    /* An unguarded jack really does stay off until someone turns it back on. A
       live management jack does not — safe_apply puts it back after a minute,
       which the escalation dialog says. Claiming both would contradict step 2. */
    const onAction = vi.fn();
    const unguarded = port({
      id: "p6", role: "other", networks: ["iot"], link_up: true, status: "online",
    });
    render(<RouterPortDrawer port={unguarded} canWrite onClose={noop} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    expect(onAction.mock.calls[0][0].blast).toMatch(/until you turn the port back on/i);

    onAction.mockClear();
    render(<RouterPortDrawer port={LIVE_LAN} canWrite onClose={noop} onAction={onAction} />);
    fireEvent.click(screen.getAllByRole("button", { name: /turn off this port/i })[1]);
    expect(onAction.mock.calls[0][0].blast).not.toMatch(/until you turn/i);
  });

  it("the guard banner shows the reason and NOT the 'confirm again' instruction", () => {
    /* The banner renders where nothing has been confirmed yet, so an
       instruction to confirm again is telling the user to do something nobody
       has asked them to do. The instruction is a separate server-side field. */
    render(<RouterPortDrawer port={WAN} canWrite onClose={noop} onAction={noop} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/internet comes in on/i);
    expect(dialog.textContent).not.toMatch(/confirm again/i);
  });

  it("explains a jack with no reading to EVERYONE, not just owners", () => {
    /* It is a fact about the hardware, not an action. A member used to get the
       bare "no module" chip with no account of what it meant. */
    const cage = port({
      id: "sfp", role: "unused", networks: [], present: false,
      admin_up: null, is_sfp: true, status: "absent",
    });
    render(<RouterPortDrawer port={cage} canWrite={false} onClose={noop} onAction={noop} />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/no module in it/i);
  });

  it("has no action at all for a jack with no reading", () => {
    /* An empty SFP cage reports no netifd device. There is nothing to shut, and
       writing `enabled 0` for a device netifd never realised would stage a
       section that does nothing and report success. */
    const cage = port({
      id: "sfp", role: "unused", networks: [], present: false,
      admin_up: null, is_sfp: true, status: "absent",
    });
    render(<RouterPortDrawer port={cage} canWrite onClose={noop} onAction={noop} />);
    expect(screen.queryByRole("button", { name: /turn (off|on) this port/i })).toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent(/no reading/i);
  });
});

// ---------------------------------------------------------------------------
// Opening the drawer from the map
// ---------------------------------------------------------------------------
describe("picking a port", () => {
  it("opens the drawer from a table row", async () => {
    const dialog = await openDrawer("p5");
    // The drawer's subtitle is one node ("p5 · RJ45 copper"), so match the node.
    expect(within(dialog).getByText(/^p5 ·/)).toBeInTheDocument();
  });

  it("opens the drawer from a faceplate cell", async () => {
    render(<RouterPortsPanel />);
    // Faceplate + table both render (the table is the md:hidden mirror), so
    // scope to the faceplate's own group.
    const faceplate = screen.getByRole("group", { name: /faceplate/i });
    fireEvent.click(within(faceplate).getByRole("button", { name: /port p5\b/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("still opens for a member — reads are for everyone", async () => {
    asRole("family");
    const dialog = await openDrawer("p5");
    expect(within(dialog).getByText(/^p5 ·/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /turn off this port/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The confirm choreography
// ---------------------------------------------------------------------------
describe("confirming a write", () => {
  it("an ordinary jack takes ONE confirm and dispatches without force", async () => {
    await openDrawer("p5");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm & apply/i }));
    await waitFor(() => expect(setPortEnabled).toHaveBeenCalledWith("p5", false, false));
  });

  it("a guarded jack does NOT dispatch on the first confirm", async () => {
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    // The second acknowledgement is now on screen and nothing has been sent.
    expect(await screen.findByText(/internet comes in on/i)).toBeInTheDocument();
    expect(setPortEnabled).not.toHaveBeenCalled();
  });

  it("the SECOND acknowledgement is what sends force:true", async () => {
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /i understand/i }));
    await waitFor(() => expect(setPortEnabled).toHaveBeenCalledWith("p1", false, true));
  });

  it("shows the WAN reason verbatim — never the management one", async () => {
    /* The two differ on a fact the user is relying on: a management jack comes
       back by itself, the WAN jack does not. */
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    const escalation = await screen.findByText(/internet comes in on/i);
    expect(escalation).toBeInTheDocument();
    expect(screen.queryByText(/reaches your appliance through/i)).toBeNull();
  });

  it("shows the MANAGEMENT reason for a live management jack", async () => {
    await openDrawer("p2");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/reaches your appliance through/i)).toBeInTheDocument();
  });

  it("cancelling the escalation sends nothing", async () => {
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/internet comes in on/i)).toBeNull());
    expect(setPortEnabled).not.toHaveBeenCalled();
  });

  it("re-enabling a guarded jack takes ONE confirm and no force", async () => {
    mockHook({
      map: { ...MAP, ports: [{ ...WAN, admin_up: false, status: "disabled" }] },
    });
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn on this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm & apply/i }));
    await waitFor(() => expect(setPortEnabled).toHaveBeenCalledWith("p1", true, false));
  });

  it("labels step 1 'Continue' on a guarded jack — it escalates, it does not apply", async () => {
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    expect(await screen.findByRole("button", { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm & apply/i })).toBeNull();
  });

  it("labels step 1 'Confirm & apply' on an ordinary jack — it really does apply", async () => {
    await openDrawer("p5");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    expect(await screen.findByRole("button", { name: /confirm & apply/i })).toBeInTheDocument();
  });

  it("escalates on a SERVER-side refusal the cached read didn't predict", async () => {
    /* 🔴 The race: `disable_guard` is read on a 10s poll, so a jack that was
       empty when the map loaded can have a cable in it by the time someone
       clicks. The server refuses; without this the user meets a bare 409 and
       retrying fails until the next poll. */
    setPortEnabled.mockRejectedValueOnce(
      new RouterPortRefusedError({
        code: "MANAGEMENT_PORT",
        reason: "Something got plugged into this jack a moment ago.",
      }),
    );
    await openDrawer("p5");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm & apply/i }));

    // The escalation appears, built from the SERVER's sentence, and nothing was
    // reported as a failure.
    expect(await screen.findByText(/plugged into this jack a moment ago/i)).toBeInTheDocument();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("the escalation raised by a server refusal is what finally sends force", async () => {
    setPortEnabled.mockRejectedValueOnce(
      new RouterPortRefusedError({ code: "WAN_PORT", reason: "A cable arrived." }),
    );
    await openDrawer("p5");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm & apply/i }));
    fireEvent.click(await screen.findByRole("button", { name: /i understand/i }));
    await waitFor(() => expect(setPortEnabled).toHaveBeenLastCalledWith("p5", false, true));
  });

  it("a refusal on the FORCED attempt is a real failure, not another escalation", async () => {
    /* Otherwise a server that keeps refusing would loop the user through the
       same dialog forever with nothing to show for it. */
    setPortEnabled.mockRejectedValue(
      new RouterPortRefusedError({ code: "WAN_PORT", reason: "still refused" }),
    );
    await openDrawer("p1");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /i understand/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), "error"));
  });

  it("surfaces a failed write as a toast instead of swallowing it", async () => {
    setPortEnabled.mockRejectedValueOnce(new Error("Router ports: 409"));
    await openDrawer("p5");
    fireEvent.click(screen.getByRole("button", { name: /turn off this port/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm & apply/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), "error"));
  });
});
