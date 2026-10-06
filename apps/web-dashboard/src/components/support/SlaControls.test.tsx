import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  canManage: true,
  saveDesk: vi.fn(), previewMacro: vi.fn(), applyMacro: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "admin" } }) }));
vi.mock("@/components/projects/usePm", () => ({ useDepartments: () => ({ departments: [] }) }));
vi.mock("./useSla", async () => ({
  ...await vi.importActual<typeof import("./useSla")>("./useSla"),
  useDeskSla: () => ({ data: { canManage: state.canManage, policy: null, assignment: { mode: "MANUAL", departmentId: null, memberIds: [] } }, mutate: vi.fn() }),
  useBusinessCalendars: () => ({ data: { calendars: [] }, mutate: vi.fn() }),
  useMacros: () => ({ data: { canManageShared: state.canManage, macros: [{ id: "m1", name: "On it", bodyHtml: "<p>Hello</p>", projectId: "d-1", ownerId: "u1", visibility: "SHARED", actions: {} }] }, mutate: vi.fn() }),
  slaActions: { saveDesk: state.saveDesk, previewMacro: state.previewMacro, applyMacro: state.applyMacro },
}));
import { SlaSettingsModal } from "./SlaSettingsModal";
import { MacroPicker } from "./MacroPicker";
import { MacroManager } from "./MacroManager";
import { macroDraftText } from "./useSla";
import { makeDesk, makeTicket } from "./support.test-fixtures";

beforeEach(() => {
  state.canManage = true;
  state.saveDesk.mockReset().mockResolvedValue({ policy: null, assignment: { mode: "MANUAL", departmentId: null, memberIds: [] } });
  state.previewMacro.mockReset().mockResolvedValue({ name: "On it", bodyHtml: "<p>Hello Dana</p>", changes: ["Priority: high"] });
  state.applyMacro.mockReset().mockResolvedValue({ ticket: makeTicket(), bodyHtml: "<p>Hello Dana</p>" });
});

describe("service level controls", () => {
  it("keeps role-only administrators read-only when their live grant denies management", () => {
    state.canManage = false;
    render(<SlaSettingsModal desk={makeDesk()} agents={[]} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Enable service levels")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save service levels" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show attainment" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save service levels" }));
    expect(state.saveDesk).not.toHaveBeenCalled();
  });

  it("saves a target and assignment pool through the structured API", async () => {
    const desk = makeDesk();
    render(<SlaSettingsModal desk={desk} agents={[{ id: "u1", displayName: "Alex" }]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Enable service levels"));
    fireEvent.change(document.getElementById("sla-urgent-firstResponse")!, { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Assignment"), { target: { value: "ROUND_ROBIN" } });
    expect(screen.getByRole("button", { name: "Save service levels" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Alex"));
    fireEvent.click(screen.getByRole("button", { name: "Save service levels" }));
    await waitFor(() => expect(state.saveDesk).toHaveBeenCalledWith(desk.id, expect.objectContaining({
      policy: expect.objectContaining({ enabled: true, targets: { urgent: { firstResponseMins: 30 } } }),
      assignment: { mode: "ROUND_ROBIN", departmentId: null, memberIds: ["u1"] },
    })));
  });

  it("hides shared macro editing without the live manage capability even for its owner", () => {
    state.canManage = false;
    render(<MacroManager desk={makeDesk()} agents={[]} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit On it" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New macro" })).toBeEnabled();
  });
});

describe("macro preview and apply", () => {
  it("requires preview and explicit apply before preparing a reply", async () => {
    const applied = vi.fn();
    render(<MacroPicker ticket={makeTicket()} desk={makeDesk()} agents={[]} onApplied={applied} />);
    fireEvent.change(screen.getByLabelText("Reply macro"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview macro" }));
    await screen.findByText("Priority: high");
    expect(state.applyMacro).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply fields and prepare reply" }));
    await waitFor(() => expect(applied).toHaveBeenCalledWith("Hello Dana"));
    expect(state.applyMacro).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Send reply" })).not.toBeInTheDocument();
  });

  it("keeps a failed apply open and never prepares an uncommitted draft", async () => {
    state.applyMacro.mockRejectedValue(new Error("unavailable"));
    const applied = vi.fn();
    render(<MacroPicker ticket={makeTicket()} desk={makeDesk()} agents={[]} onApplied={applied} />);
    fireEvent.change(screen.getByLabelText("Reply macro"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview macro" }));
    await screen.findByText("Priority: high");
    fireEvent.click(screen.getByRole("button", { name: "Apply fields and prepare reply" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(applied).not.toHaveBeenCalled();
  });

  it("makes HTML into inert readable draft text", () => {
    expect(macroDraftText('<p>Hello &lt;Dana&gt;</p><script>bad()</script><iframe>hidden</iframe><p>Next<br>line</p>')).toBe("Hello <Dana>\nNext\nline");
  });
});
