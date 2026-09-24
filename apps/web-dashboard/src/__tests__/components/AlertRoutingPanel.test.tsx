/**
 * WARP-2978 (ADR-059 P3 §8, D25, D26) — "Who's told about alerts" on
 * /security/settings.
 *
 *   · at manage: one row per person the box returned, with a switch, the
 *     role, the `Manages the Security department` suggestion and how they'd
 *     hear; an ineligible person's switch is off and inert;
 *   · below manage: the viewer's own line only — no switches, ever (the level
 *     fails closed, and the box's own `level` must say manage too);
 *   · a switch in flight is aria-disabled, never disabled: it keeps focus and
 *     refuses a second press; it shows the chosen state until the box answers
 *     and goes back when the box refuses;
 *   · a refusal is `translateError(err, "security")` — NO_RECIPIENT above all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act as rtlAct, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { AlertRoutingPerson, AlertRoutingView } from "@/lib/types";

const h = vi.hoisted(() => ({
  level: "manage" as "none" | "view" | "act" | "manage",
  toast: vi.fn(),
  getAlertRouting: vi.fn(),
  putAlertRouting: vi.fn(),
  getSecurityHealth: vi.fn(),
}));

vi.mock("@/lib/hooks/useModuleGate", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks/useModuleGate")>()),
  useModuleLevel: (moduleId: string) => (moduleId === "security" ? h.level : "none"),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getAlertRouting: h.getAlertRouting,
  putAlertRouting: h.putAlertRouting,
  getSecurityHealth: h.getSecurityHealth,
}));

import { AlertRoutingPanel, ROUTING_COPY } from "@/components/security/AlertRoutingPanel";

function person(over: Partial<AlertRoutingPerson> = {}): AlertRoutingPerson {
  return {
    userId: "u-stefan",
    name: "Stefan",
    role: "owner",
    state: "receiving",
    origin: "owner_default",
    version: 0,
    eligible: true,
    ineligibleReason: null,
    managesSecurityDepartment: false,
    delivery: "push",
    ...over,
  };
}

function manageView(people: AlertRoutingPerson[], fallbackActive = false): AlertRoutingView {
  return { level: "manage", people, fallbackActive };
}

function typedError(code: string, status: number): Error {
  return Object.assign(new Error(`raw server text for ${code}`), { code, status });
}

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const PEOPLE = [
  person(),
  person({ userId: "u-maria", name: "Maria", role: "admin", state: "not_receiving", origin: null, version: null, managesSecurityDepartment: true, delivery: "in_app_only" }),
  person({ userId: "u-jordan", name: "Jordan", role: "family", state: "not_receiving", origin: null, version: null, eligible: false, ineligibleReason: "no_access" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  h.level = "manage";
  h.getAlertRouting.mockResolvedValue(manageView(PEOPLE));
  h.getSecurityHealth.mockResolvedValue({ sources: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const row = (name: string) => screen.getByText(name, { selector: ".nm span" }).closest("li")!;

describe("at manage", () => {
  it("explains what alerts are, then one row per person with a switch, the role and how they'd hear", async () => {
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    expect(screen.getByText(ROUTING_COPY.explainer)).toBeInTheDocument();
    expect(ROUTING_COPY.explainer).toBe(
      "Droplet sends an alert when someone is seen in an area marked Inside or Staff only while the site is closed or set to away. Each person only hears about cameras they're allowed to see.",
    );
    const stefan = await waitFor(() => row("Stefan"));
    expect(within(stefan).getByRole("switch", { name: "Tell Stefan about alerts" })).toHaveAttribute("aria-checked", "true");
    expect(stefan).toHaveTextContent("Owner");
    expect(stefan).toHaveTextContent("Notifications on their phone");
    const maria = row("Maria");
    expect(within(maria).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(maria).toHaveTextContent("Only in Droplet while it's open");
    // A suggestion, not a grant (D26).
    expect(within(maria).getByText("Manages the Security department")).toBeInTheDocument();
  });

  it("an ineligible person: can't be told, and the switch is off and inert", async () => {
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    const jordan = await waitFor(() => row("Jordan"));
    expect(jordan).toHaveTextContent("Can't be told: no longer has access to Security");
    const sw = within(jordan).getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(sw);
    expect(h.putAlertRouting).not.toHaveBeenCalled();
  });

  it("turning someone on PUTs receiving with the version it read (null = no row yet), then re-reads", async () => {
    h.putAlertRouting.mockResolvedValue({ person: person({ userId: "u-maria", name: "Maria", version: 0 }) });
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    const sw = within(await waitFor(() => row("Maria"))).getByRole("switch");
    const reads = h.getAlertRouting.mock.calls.length;
    fireEvent.click(sw);
    await waitFor(() => expect(h.putAlertRouting).toHaveBeenCalledWith("u-maria", { state: "receiving", expectedVersion: null }));
    await waitFor(() => expect(h.getAlertRouting.mock.calls.length).toBeGreaterThan(reads));
  });

  it("turning someone off PUTs not_receiving with their row's version", async () => {
    h.putAlertRouting.mockResolvedValue({ person: person({ state: "not_receiving", version: 1 }) });
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    fireEvent.click(within(await waitFor(() => row("Stefan"))).getByRole("switch"));
    await waitFor(() => expect(h.putAlertRouting).toHaveBeenCalledWith("u-stefan", { state: "not_receiving", expectedVersion: 0 }));
  });

  it("in flight: the switch shows the choice, is aria-disabled (never disabled), keeps focus, and refuses a second press", async () => {
    let finish!: (v: unknown) => void;
    h.putAlertRouting.mockReturnValue(new Promise((r) => (finish = r)));
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    const sw = within(await waitFor(() => row("Maria"))).getByRole("switch");
    sw.focus();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-disabled", "true"));
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).not.toBeDisabled();
    expect(sw).toHaveFocus();
    fireEvent.click(sw);
    fireEvent.click(within(row("Stefan")).getByRole("switch"));
    expect(h.putAlertRouting).toHaveBeenCalledTimes(1);
    await rtlAct(async () => finish({ person: person({ userId: "u-maria", name: "Maria" }) }));
  });

  it("the last person told can't be switched off: the friendly NO_RECIPIENT copy, and the switch goes back", async () => {
    h.putAlertRouting.mockRejectedValue(typedError("NO_RECIPIENT", 409));
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    const sw = within(await waitFor(() => row("Stefan"))).getByRole("switch");
    fireEvent.click(sw);
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    const [message, type] = h.toast.mock.calls[0]!;
    expect(type).toBe("error");
    expect(message).toMatch(/Someone who can open Security has to be told about alerts/);
    expect(message).not.toContain("raw server text");
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(sw).not.toHaveAttribute("aria-disabled");
  });

  it("the fallback banner when nobody chosen can be told", async () => {
    h.getAlertRouting.mockResolvedValue(manageView(PEOPLE, true));
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    expect(await screen.findByText(ROUTING_COPY.fallback)).toBeInTheDocument();
  });

  it("the box answering below manage wins over the module level: the viewer's own line, no switches", async () => {
    h.getAlertRouting.mockResolvedValue({ level: "act", self: { state: "receiving", eligible: true } });
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    expect(await screen.findByText(ROUTING_COPY.selfTold)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("below manage", () => {
  it("no switches — even when the box sent the list (the level fails closed)", async () => {
    h.level = "act";
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    await waitFor(() => expect(h.getAlertRouting).toHaveBeenCalled());
    await rtlAct(async () => {});
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("told: You're told about alerts.", async () => {
    h.level = "act";
    h.getAlertRouting.mockResolvedValue({ level: "act", self: { state: "receiving", eligible: true } });
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    expect(await screen.findByText("You're told about alerts.")).toBeInTheDocument();
  });

  it("not told (or told but can't be): who chooses", async () => {
    h.level = "view";
    h.getAlertRouting.mockResolvedValue({ level: "view", self: { state: "receiving", eligible: false } });
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    expect(await screen.findByText("You're not told about alerts. People who manage Security choose who is.")).toBeInTheDocument();
  });
});

describe("reading", () => {
  it("a failed read says so, with Retry — never an empty list", async () => {
    h.getAlertRouting.mockRejectedValue(typedError("ROUTING_UNAVAILABLE", 503));
    render(<AlertRoutingPanel />, { wrapper: Wrap });
    expect(await screen.findByRole("alert")).toHaveTextContent(ROUTING_COPY.loadError);
    h.getAlertRouting.mockResolvedValue(manageView(PEOPLE));
    fireEvent.click(screen.getByRole("button", { name: ROUTING_COPY.retry }));
    await waitFor(() => expect(row("Stefan")).toBeTruthy());
  });
});
