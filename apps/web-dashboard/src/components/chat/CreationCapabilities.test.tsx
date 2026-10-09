import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
const authFetch = vi.fn();
let role = "family";
let userId = "person-a";
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args), useAuth: () => ({ user: userId ? { id: userId, role } : null }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
import { CreationCapabilitiesPopover } from "./CreationCapabilities";
import { CreationCapabilitiesCard } from "../settings/CreationCapabilitiesCard";
import { parseCreationCapabilities } from "@/lib/hooks/useCreationCapabilities";
const ids = ["pdf", "slides", "workbook", "office", "analysis", "artifact", "web_fetch", "web_search", "speech", "image", "video"];
function status() {
  return { version: 1, checkedAt: "2026-10-08T20:00:00Z", capabilities: ids.map((id) => ({
    id, label: id === "pdf" ? "PDF documents" : id === "image" ? "Image creation and editing" : id === "web_fetch" ? "Public web pages" : id,
    state: id === "image" ? "unverified" : id === "web_fetch" ? "disabled" : "ready",
    reason: id === "web_fetch" ? "web_policy_disabled" : "local_service_ready",
    detail: id === "image" ? "Local model files are installed. GPU inference is unverified." : "Local status.",
    ...((id === "image" || id === "video") ? { inferenceVerified: false } : {}),
  })) };
}
beforeEach(() => { authFetch.mockReset(); role = "family"; userId = "person-a"; authFetch.mockResolvedValue({ ok: true, json: async () => status() }); });

describe("creation readiness UI", () => {
  it("does not probe until the chat user opens it, and makes unverified inference explicit", async () => {
    render(<CreationCapabilitiesPopover />);
    expect(authFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Creation capabilities" }));
    await screen.findByText("PDF documents");
    expect(screen.getByText("Configured, unverified")).toBeInTheDocument();
    expect(screen.getByText(/GPU inference is unverified/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Privacy settings" })).toBeNull();
    expect(authFetch).toHaveBeenCalledWith("/api/capabilities/creation", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it("offers the operator a concrete policy setup link and closes on Escape", async () => {
    role = "owner"; render(<CreationCapabilitiesPopover />);
    const trigger = screen.getByRole("button", { name: "Creation capabilities" }); fireEvent.click(trigger);
    expect(await screen.findByRole("link", { name: "Privacy settings" })).toHaveAttribute("href", "/network?tab=privacy");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
  });
  it("refresh failures do not leave a stale Available claim on screen", async () => {
    render(<CreationCapabilitiesPopover />); fireEvent.click(screen.getByRole("button", { name: "Creation capabilities" }));
    await screen.findByText("PDF documents"); authFetch.mockRejectedValueOnce(new Error("secret internal error"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Creation status is unavailable. Refresh to try again.");
    expect(screen.queryByText("PDF documents")).toBeNull(); expect(screen.queryByText(/secret internal error/)).toBeNull();
  });
  it("aborts pending readiness reads when the popover closes", async () => {
    authFetch.mockImplementation((_path, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))));
    render(<CreationCapabilitiesPopover />); fireEvent.click(screen.getByRole("button", { name: "Creation capabilities" }));
    const signal = authFetch.mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(signal.aborted).toBe(true); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("renders the settings card only for operators", async () => {
    const view = render(<CreationCapabilitiesCard />); expect(view.container).toBeEmptyDOMElement(); expect(authFetch).not.toHaveBeenCalled();
    role = "admin"; view.rerender(<CreationCapabilitiesCard />);
    await waitFor(() => expect(screen.getByText("PDF documents")).toBeInTheDocument());
  });
  it.each(["account", "role"])("hides previous availability immediately and reloads when the authenticated %s changes", async (change) => {
    const view = render(<CreationCapabilitiesPopover />);
    fireEvent.click(screen.getByRole("button", { name: "Creation capabilities" }));
    await screen.findByText("PDF documents");
    let finish!: (value: unknown) => void;
    authFetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    if (change === "account") userId = "person-b"; else role = "guest";
    view.rerender(<CreationCapabilitiesPopover />);
    expect(screen.queryByText("PDF documents")).toBeNull();
    expect(screen.getByText("Checking local services…")).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledTimes(2);
    const restricted = status(); restricted.capabilities.forEach((row) => { row.state = "restricted"; row.detail = "Current account access."; });
    await act(async () => { finish({ ok: true, json: async () => restricted }); });
    await screen.findByText("PDF documents");
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.getAllByText("Access restricted")).toHaveLength(11);
  });
  it("aborts a previous person's request and ignores its late body after the new person's response", async () => {
    let oldBody!: (value: unknown) => void;
    authFetch.mockResolvedValueOnce({ ok: true, json: () => new Promise((resolve) => { oldBody = resolve; }) });
    const view = render(<CreationCapabilitiesPopover />);
    fireEvent.click(screen.getByRole("button", { name: "Creation capabilities" }));
    await waitFor(() => expect(oldBody).toBeTypeOf("function"));
    const oldSignal = authFetch.mock.calls[0][1].signal;
    userId = "person-b";
    const current = status(); current.capabilities.forEach((row) => { row.state = "restricted"; row.detail = "Current account access."; });
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => current });
    view.rerender(<CreationCapabilitiesPopover />);
    expect(oldSignal.aborted).toBe(true);
    await screen.findByText("PDF documents");
    const previous = status(); previous.capabilities.forEach((row) => { row.detail = "Previous account access."; });
    await act(async () => { oldBody(previous); });
    expect(screen.queryByText("Previous account access.")).toBeNull();
    expect(screen.getAllByText("Current account access.")).toHaveLength(11);
    userId = ""; view.rerender(<CreationCapabilitiesPopover />);
    expect(screen.queryByText("PDF documents")).toBeNull();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed, duplicate or overclaimed status DTOs", () => {
    const valid = status(); expect(parseCreationCapabilities(valid).capabilities).toHaveLength(11);
    expect(() => parseCreationCapabilities({ ...valid, version: 2 })).toThrow();
    expect(() => parseCreationCapabilities({ ...valid, capabilities: [...valid.capabilities.slice(1), valid.capabilities[1]] })).toThrow();
    expect(() => parseCreationCapabilities({ ...valid, capabilities: valid.capabilities.map((row) => row.id === "image" ? { ...row, inferenceVerified: true } : row) })).toThrow();
  });
});
