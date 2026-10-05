/**
 * WARP-3528 — filing a ticket by hand, and choosing who it is for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const createTicket = vi.fn();
const createContact = vi.fn();
const searchRef: { current: Array<ReturnType<typeof candidate>> } = { current: [] };
const searched: string[] = [];
vi.mock("./useSupport", async () => {
  const actual = await vi.importActual<typeof import("./useSupport")>("./useSupport");
  return {
    ...actual,
    supportActions: () => ({ createTicket, createContact }),
    useContactSearch: (q: string) => {
      searched.push(q);
      return { contacts: q.trim().length >= 2 ? searchRef.current : [], isLoading: false };
    },
  };
});

import { NewTicketModal } from "./NewTicketModal";
import { SupportRequestError } from "./useSupport";
import { candidate, makeDesk, makeTicket } from "./support.test-fixtures";

const AGENTS = [{ id: "u-2", displayName: "Bo" }];

const mount = (over: Partial<React.ComponentProps<typeof NewTicketModal>> = {}) => {
  const props = {
    desks: [makeDesk()],
    defaultDeskId: "desk-1",
    agents: AGENTS,
    onClose: vi.fn(),
    onCreated: vi.fn(),
    ...over,
  };
  render(<NewTicketModal {...props} />);
  return props;
};

const subject = (text: string) => fireEvent.change(screen.getByLabelText("Subject"), { target: { value: text } });
const create = () => fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));

beforeEach(() => {
  vi.clearAllMocks();
  searched.length = 0;
  searchRef.current = [candidate()];
  createTicket.mockResolvedValue({ ticket: makeTicket({ key: "SUP-5" }) });
  createContact.mockResolvedValue({ contact: candidate({ id: "c-new", name: "Eli Park" }) });
});

describe("filing a ticket for yourself", () => {
  it("refuses an empty subject in words and sends nothing", () => {
    mount();
    create();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a subject.");
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("creates it with the caller as the requester and tells the agent the real key", async () => {
    const { onCreated, onClose } = mount();
    subject("  Printer jams  ");
    create();
    await waitFor(() => expect(createTicket).toHaveBeenCalledTimes(1));
    expect(createTicket.mock.calls[0]![0]).toEqual({
      deskId: "desk-1",
      subject: "Printer jams",
      requester: { kind: "USER" },
      channel: "INTERNAL",
      priority: "none",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ key: "SUP-5" })));
    expect(onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Ticket SUP-5 created", "success");
  });

  it("sends the details as escaped paragraphs, and the priority, channel, assignee and type chosen", async () => {
    mount();
    subject("Wi-Fi down");
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: "Floor 2 <urgent>\n\nSince 9am" } });
    fireEvent.change(screen.getByLabelText("How did it arrive?"), { target: { value: "PHONE" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "u-2" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "lb-i" } });
    create();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(createTicket.mock.calls[0]![0]).toMatchObject({
      descriptionHtml: "<p>Floor 2 &lt;urgent&gt;</p><p>Since 9am</p>",
      channel: "PHONE",
      priority: "high",
      assigneeIds: ["u-2"],
      labelIds: ["lb-i"],
    });
  });

  it("offers only the two channels a person can file by hand", () => {
    mount();
    const options = within(screen.getByLabelText("How did it arrive?")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Added by the team", "Phone call"]);
  });
});

describe("the desk", () => {
  it("offers a choice only with more than one desk, and resets the type when it changes", async () => {
    const other = makeDesk({ id: "desk-2", name: "IT", identifier: "IT", labels: [{ id: "lb-z", name: "Task", color: null, isType: true }] });
    const { rerender } = render(
      <NewTicketModal desks={[makeDesk()]} defaultDeskId="desk-1" agents={[]} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.queryByLabelText("Desk")).toBeNull();
    rerender(<NewTicketModal desks={[makeDesk(), other]} defaultDeskId="desk-1" agents={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "lb-i" } });
    fireEvent.change(screen.getByLabelText("Desk"), { target: { value: "desk-2" } });
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("");
    subject("On the IT desk");
    create();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(createTicket.mock.calls[0]![0]).toMatchObject({ deskId: "desk-2" });
    expect(createTicket.mock.calls[0]![0]).not.toHaveProperty("labelIds");
  });
});

describe("filing on behalf of a customer", () => {
  const chooseCustomer = () => fireEvent.click(screen.getByRole("radio", { name: "A customer" }));

  it("will not submit until a customer is chosen", () => {
    mount();
    chooseCustomer();
    subject("Customer called");
    expect(screen.getByRole("button", { name: "Create ticket" })).toBeDisabled();
  });

  it("searches after a pause, selects with the keyboard and files on their behalf", async () => {
    mount();
    chooseCustomer();
    const box = screen.getByRole("combobox", { name: "Search customers" });
    fireEvent.change(box, { target: { value: "dan" } });
    const option = await screen.findByRole("option", { name: /Dana Reyes/ });
    expect(option).toHaveTextContent("dana@example.test · Acme · Your contact");
    expect(box).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Search customers" })).toBeNull();

    subject("Printer jams");
    create();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(createTicket.mock.calls[0]![0]).toMatchObject({ requester: { kind: "CONTACT", contactId: "c-1" } });
  });

  it("does not search for fewer than two characters", async () => {
    mount();
    chooseCustomer();
    fireEvent.change(screen.getByRole("combobox", { name: "Search customers" }), { target: { value: "d" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("listbox", { name: "Customers" })).toBeNull();
  });

  it("lets the agent change their mind", async () => {
    mount();
    chooseCustomer();
    fireEvent.change(screen.getByRole("combobox", { name: "Search customers" }), { target: { value: "dan" } });
    fireEvent.click(await screen.findByRole("option", { name: /Dana Reyes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("combobox", { name: "Search customers" })).toBeInTheDocument();
  });

  it("adds a new person through the address-book route and selects them", async () => {
    mount();
    chooseCustomer();
    fireEvent.click(screen.getByRole("button", { name: "Add a new person" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Eli Park" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "eli@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({ displayName: "Eli Park", email: "eli@example.test", phone: undefined }),
    );
    await waitFor(() => expect(screen.getByText("Eli Park")).toBeInTheDocument());
    subject("Walk-in");
    create();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(createTicket.mock.calls[0]![0].requester).toEqual({ kind: "CONTACT", contactId: "c-new" });
  });

  it("uses the contact that already holds an address instead of failing", async () => {
    createContact.mockRejectedValue(
      new SupportRequestError("contact_email_exists", 409, "contact_email_exists", { contactId: "c-existing" }),
    );
    mount();
    chooseCustomer();
    fireEvent.click(screen.getByRole("button", { name: "Add a new person" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(await screen.findByText("That address is already in your contacts — using them.")).toBeInTheDocument();
    subject("Again");
    create();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(createTicket.mock.calls[0]![0].requester).toEqual({ kind: "CONTACT", contactId: "c-existing" });
  });

  it("will not add a person with no name and no email", () => {
    mount();
    chooseCustomer();
    fireEvent.click(screen.getByRole("button", { name: "Add a new person" }));
    expect(screen.getByRole("button", { name: "Add person" })).toBeDisabled();
  });
});

describe("when the server refuses", () => {
  it("keeps the form open with a plain-words strip and lets the agent try again", async () => {
    createTicket.mockRejectedValue(new SupportRequestError("desk_archived", 409, "desk_archived"));
    const { onClose, onCreated } = mount();
    subject("Too late");
    create();
    const strip = await screen.findByRole("alert");
    expect(strip).toHaveTextContent(/archived/i);
    expect(strip).not.toHaveTextContent("desk_archived");
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create ticket" })).toBeEnabled();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Too late");
  });
});
