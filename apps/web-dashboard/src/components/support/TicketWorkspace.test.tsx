/**
 * WARP-3528 — the ticket workspace: what an agent sees and changes on one
 * ticket, the customer card, linked work, and escalation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => React.createElement("a", { href, ...props }, children),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const auth = { role: "family" };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", username: "ada", displayName: "Ada", role: auth.role }, isLoading: false }),
  authFetch: vi.fn(),
}));

const departmentsRef: { current: unknown[] | undefined } = { current: undefined };
const projectsRef: { current: { projects?: unknown[]; error?: unknown; isLoading: boolean } } = {
  current: { projects: [], isLoading: false },
};
vi.mock("@/components/projects/usePm", () => ({
  useDepartments: () => ({ departments: departmentsRef.current }),
  useProjects: () => projectsRef.current,
}));

const updateTicket = vi.fn();
const escalate = vi.fn();
const mutateTicket = vi.fn();
const mutateConvo = vi.fn();
const revalidate = vi.fn();
const ticketRef: { current: { ticket?: unknown; error?: unknown; isLoading: boolean } } = {
  current: { isLoading: false },
};
const requesterTickets: { current: { tickets?: unknown[]; total: number } } = { current: { tickets: [], total: 0 } };
vi.mock("./useSupport", async () => {
  const actual = await vi.importActual<typeof import("./useSupport")>("./useSupport");
  return {
    ...actual,
    useTicket: () => ({ ...ticketRef.current, mutate: mutateTicket }),
    useConversation: () => ({
      conversation: { entries: [], truncated: false },
      error: undefined,
      isLoading: false,
      mutate: mutateConvo,
    }),
    useRequesterTickets: () => requesterTickets.current,
    useRevalidateSupport: () => revalidate,
    supportActions: () => ({ updateTicket, escalate, sendReply: vi.fn(), addNote: vi.fn() }),
  };
});

import { TicketWorkspace } from "./TicketWorkspace";
import { SupportRequestError } from "./useSupport";
import { STATES, makeDesk, makeSummary, makeTicket } from "./support.test-fixtures";

const AGENTS = [
  { id: "u-1", displayName: "Ada" },
  { id: "u-2", displayName: "Bo" },
];

const mount = (over: Partial<React.ComponentProps<typeof TicketWorkspace>> = {}) => {
  const props = {
    ticketRef: "SUP-1",
    desks: [makeDesk()],
    agents: AGENTS,
    onClose: vi.fn(),
    onSelectTicket: vi.fn(),
    onChanged: vi.fn(),
    ...over,
  };
  render(<TicketWorkspace {...props} />);
  return props;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "family";
  departmentsRef.current = undefined;
  projectsRef.current = { projects: [], isLoading: false };
  ticketRef.current = { ticket: makeTicket(), isLoading: false };
  requesterTickets.current = { tickets: [], total: 0 };
  updateTicket.mockResolvedValue({});
  escalate.mockResolvedValue({ workItem: { key: "ENG-12" }, ticket: {} });
});

describe("the header", () => {
  it("names the ticket, its desk, how it arrived and its status and priority", () => {
    ticketRef.current = { ticket: makeTicket({ priority: "high", channel: "PHONE", reopenCount: 2 }), isLoading: false };
    mount();
    const region = screen.getByLabelText("Ticket SUP-1");
    expect(within(region).getByRole("heading", { level: 2, name: "Printer jams on page two" })).toBeInTheDocument();
    expect(within(region).getByText("SUP-1")).toHaveClass("pm-mono");
    expect(within(region).getByText("· Phone call")).toBeInTheDocument();
    expect(within(region).getByText("· reopened 2×")).toBeInTheDocument();
    // The priority label in the header (the select below also lists "High").
    expect(within(region.querySelector("header") as HTMLElement).getByText("High")).toBeInTheDocument();
  });

  it("shows the request when there is one, and omits the section when there is not", () => {
    mount();
    expect(screen.getByText("It keeps jamming.")).toBeInTheDocument();
    cleanupAndRemount({ descriptionHtml: null });
    expect(screen.queryByText("The request")).toBeNull();
  });

  it("closes with Back to tickets", () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole("button", { name: /Back to tickets/ }));
    expect(onClose).toHaveBeenCalled();
  });
});

function cleanupAndRemount(over: Partial<ReturnType<typeof makeTicket>>) {
  document.body.innerHTML = "";
  ticketRef.current = { ticket: makeTicket(over), isLoading: false };
  mount();
}

describe("changing a property", () => {
  it("offers the desk's statuses and saves the one chosen", async () => {
    const { onChanged } = mount();
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(within(status).getAllByRole("option").map((o) => o.textContent)).toEqual(STATES.map((s) => s.name));
    expect(status.value).toBe("st-new");
    fireEvent.change(status, { target: { value: "st-pending" } });
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith("t-1", { stateId: "st-pending" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mutateTicket).toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalled();
  });

  it("saves priority, and an assignee as a one-person set — or the empty set to unassign", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "urgent" } });
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith("t-1", { priority: "urgent" }));
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "u-2" } });
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith("t-1", { assigneeIds: ["u-2"] }));
  });

  it("unassigns with an empty set", async () => {
    ticketRef.current = {
      ticket: makeTicket({ assignees: [{ id: "u-2", displayName: "Bo" }] }),
      isLoading: false,
    };
    mount();
    expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("u-2");
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "" } });
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith("t-1", { assigneeIds: [] }));
  });

  it("keeps a current assignee selectable even when they no longer hold the grant", () => {
    ticketRef.current = {
      ticket: makeTicket({ assignees: [{ id: "u-9", displayName: "Former member" }] }),
      isLoading: false,
    };
    mount();
    const select = screen.getByLabelText("Assignee") as HTMLSelectElement;
    expect(select.value).toBe("u-9");
    expect(within(select).getByRole("option", { name: "Former member" })).toBeInTheDocument();
  });

  it("changes the type by replacing the type label and keeping any other", async () => {
    ticketRef.current = {
      ticket: makeTicket({
        labels: [
          { id: "lb-q", name: "Question", color: null, isType: true },
          { id: "lb-x", name: "Billing", color: null, isType: false },
        ],
      }),
      isLoading: false,
    };
    mount();
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("lb-q");
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "lb-i" } });
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith("t-1", { labelIds: ["lb-x", "lb-i"] }));
    // The save callback disables every property control until its refresh settles.
    // Waiting for the mutation call alone can fire the next change while disabled.
    await waitFor(() => expect(screen.getByLabelText("Type")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "" } });
    await waitFor(() => expect(updateTicket).toHaveBeenLastCalledWith("t-1", { labelIds: ["lb-x"] }));
  });

  it("shows labels that are not a type as read-only tags beside the controls", () => {
    ticketRef.current = {
      ticket: makeTicket({
        labels: [
          { id: "lb-q", name: "Question", color: null, isType: true },
          { id: "lb-x", name: "Billing", color: null, isType: false },
        ],
      }),
      isLoading: false,
    };
    mount();
    const labels = screen.getByLabelText("Labels");
    expect(within(labels).getByText("Billing")).toBeInTheDocument();
    expect(within(labels).queryByText("Question")).toBeNull();
  });

  it("offers a department only when the box has some, never the household, and clears with null", async () => {
    departmentsRef.current = [
      { id: "dp-1", name: "Front desk", kind: "DEPARTMENT" },
      { id: "dp-h", name: "Workspace", kind: "HOUSEHOLD" },
    ];
    ticketRef.current = {
      ticket: makeTicket({ department: { id: "dp-1", name: "Front desk", kind: "DEPARTMENT", parentId: null, source: "item" } }),
      isLoading: false,
    };
    mount();
    const select = screen.getByLabelText("Department") as HTMLSelectElement;
    expect(within(select).queryByRole("option", { name: "Workspace" })).toBeNull();
    expect(select.value).toBe("dp-1");
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith("t-1", { departmentId: null }));
  });

  it("says the department comes from the desk when it does", () => {
    departmentsRef.current = [{ id: "dp-1", name: "Front desk", kind: "DEPARTMENT" }];
    ticketRef.current = {
      ticket: makeTicket({ department: { id: "dp-9", name: "IT", kind: "DEPARTMENT", parentId: null, source: "project" } }),
      isLoading: false,
    };
    mount();
    expect(screen.getByRole("option", { name: "Desk's department (IT)" })).toBeInTheDocument();
  });

  it("hides the department control on a box with no departments", () => {
    mount();
    expect(screen.queryByLabelText("Department")).toBeNull();
  });

  it("explains a refusal in plain words and re-reads the ticket", async () => {
    updateTicket.mockRejectedValue(new SupportRequestError("invalid_assignee", 422, "invalid_assignee"));
    mount();
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "u-2" } });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toMatch(/access to Support/);
    expect(toast.mock.calls[0]![0]).not.toMatch(/invalid_assignee/);
    expect(mutateTicket).toHaveBeenCalled();
  });
});

describe("a person who can read but not write", () => {
  it("sees the ticket with every control disabled and no composer or escalate button", () => {
    auth.role = "guest";
    mount();
    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Priority")).toBeDisabled();
    expect(screen.queryByLabelText("Write a message")).toBeNull();
    expect(screen.queryByRole("button", { name: /Escalate/ })).toBeNull();
    expect(screen.getByText("You can read this ticket but not change it.")).toBeInTheDocument();
  });
});

describe("the customer card", () => {
  it("shows the live contact, links the customer record and lists their other tickets", () => {
    requesterTickets.current = {
      tickets: [makeSummary({ id: "t-1" }), makeSummary({ id: "t-2", key: "SUP-2", subject: "Scanner offline" })],
      total: 2,
    };
    const { onSelectTicket } = mount();
    const card = screen.getByLabelText("Customer");
    expect(within(card).getByText("Dana Reyes")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "dana@example.test" })).toHaveAttribute("href", "mailto:dana@example.test");
    expect(within(card).getByRole("link", { name: "Acme" })).toHaveAttribute("href", "/customers/co-1");
    expect(within(card).getByText("Other tickets from this customer · 1")).toBeInTheDocument();
    expect(within(card).queryByText("Printer jams on page two")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /Scanner offline/ }));
    expect(onSelectTicket).toHaveBeenCalledWith("SUP-2");
  });

  it("says when the contact is gone and shows the intake snapshot", () => {
    ticketRef.current = {
      ticket: makeTicket({
        requesterCard: {
          kind: "CONTACT", id: "c-9", name: "Dana Reyes", email: "dana@example.test", gone: true,
          organization: null, phone: null, company: null,
        },
      }),
      isLoading: false,
    };
    mount();
    expect(screen.getByText(/No longer in contacts/)).toBeInTheDocument();
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
  });

  it("labels a staff requester as a member of the team", () => {
    ticketRef.current = {
      ticket: makeTicket({
        requesterCard: { kind: "USER", id: "u-5", name: "Eli", email: null, gone: false, organization: null, phone: null, company: null },
      }),
      isLoading: false,
    };
    mount();
    expect(screen.getByText("Requested by")).toBeInTheDocument();
    expect(screen.getByText("Member of your team")).toBeInTheDocument();
  });
});

describe("linked work", () => {
  it("says nothing is linked yet", () => {
    mount();
    expect(screen.getByText("Nothing linked yet.")).toBeInTheDocument();
  });

  it("shows a linked item's key, name, project and state", () => {
    ticketRef.current = {
      ticket: makeTicket({
        linkedItems: [
          { relationId: "r-1", restricted: false, id: "w-1", key: "ENG-12", name: "Fix the driver", projectName: "Engineering", state: { name: "In Progress", group: "started" } },
        ],
      }),
      isLoading: false,
    };
    mount();
    const card = screen.getByLabelText("Linked work");
    expect(within(card).getByText("ENG-12")).toHaveClass("pm-mono");
    expect(within(card).getByText(/Fix the driver/)).toBeInTheDocument();
    expect(within(card).getByText("Engineering · In Progress")).toBeInTheDocument();
  });

  it("degrades to 'Linked item (no access)' and names nothing for someone without Projects", () => {
    ticketRef.current = {
      ticket: makeTicket({
        linkedItems: [{ relationId: "r-1", restricted: true, id: null, key: null, name: null, projectName: null, state: null }],
      }),
      isLoading: false,
    };
    mount();
    const card = screen.getByLabelText("Linked work");
    expect(within(card).getByText("Linked item (no access)")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/ENG-|Engineering/);
  });
});

describe("escalation", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: /Escalate to a project/ }));

  it("shares only the title, and says so", () => {
    projectsRef.current = { projects: [{ id: "p-1", name: "Engineering", identifier: "ENG" }], isLoading: false };
    mount();
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Only the title below is shared with the project — not the conversation or the customer/)).toBeInTheDocument();
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Printer jams on page two");
  });

  it("creates the work item with the chosen project and the agent's title", async () => {
    projectsRef.current = { projects: [{ id: "p-1", name: "Engineering", identifier: "ENG" }], isLoading: false };
    const { onChanged } = mount();
    open();
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Escalate" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Project"), { target: { value: "p-1" } });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Driver crash on jam" } });
    fireEvent.click(submit);
    await waitFor(() => expect(escalate).toHaveBeenCalledWith("t-1", { projectId: "p-1", title: "Driver crash on jam" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Escalated as ENG-12", "success");
  });

  it("explains that escalating needs Projects access when the project list is refused", () => {
    projectsRef.current = { projects: undefined, error: new Error("nope"), isLoading: false };
    mount();
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Escalating needs access to Projects. Ask an owner or admin.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Escalate" })).toBeDisabled();
  });

  it("keeps the dialog open and names the problem when the server refuses", async () => {
    escalate.mockRejectedValue(new SupportRequestError("project_not_found", 404, "project_not_found"));
    projectsRef.current = { projects: [{ id: "p-1", name: "Engineering", identifier: "ENG" }], isLoading: false };
    mount();
    open();
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Project"), { target: { value: "p-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Escalate" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeInTheDocument());
    expect(within(dialog).getByRole("alert")).toHaveTextContent("That project isn't available anymore. Pick another one.");
  });
});

describe("loading and failing", () => {
  it("shows a busy skeleton while the ticket loads", () => {
    ticketRef.current = { ticket: undefined, isLoading: true };
    mount();
    expect(screen.getByLabelText("Loading the ticket")).toHaveAttribute("aria-busy", "true");
  });

  it("says a missing ticket isn't available, with no retry that cannot help", () => {
    ticketRef.current = { ticket: undefined, error: new SupportRequestError("ticket_not_found", 404, "ticket_not_found"), isLoading: false };
    mount();
    expect(screen.getByText("That ticket isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers Try again when the appliance cannot be reached", () => {
    ticketRef.current = { ticket: undefined, error: new Error("network"), isLoading: false };
    mount();
    expect(screen.getByText("Couldn't load this ticket.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutateTicket).toHaveBeenCalled();
  });
});
