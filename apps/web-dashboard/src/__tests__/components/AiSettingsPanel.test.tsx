/**
 * WARP-2979 (ADR-059 P4 §8) — "Droplet's AI" on /security/settings: the three
 * linking choices and the summaries switch at manage, sent together with the
 * version they were read at; text only below manage (never rendered and then
 * refused); a 409 re-reads and says the other person's choice is shown; a
 * failed read is an error with Retry, never the defaults.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { SecurityAiSettingsView } from "@/lib/types";

const h = vi.hoisted(() => ({
  level: "manage" as "none" | "view" | "act" | "manage",
  toast: vi.fn(),
  getSecurityAiSettings: vi.fn(),
  putSecurityAiSettings: vi.fn(),
}));

vi.mock("@/lib/hooks/useModuleGate", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks/useModuleGate")>()),
  useModuleLevel: (moduleId: string) => (moduleId === "security" ? h.level : "none"),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getSecurityAiSettings: h.getSecurityAiSettings,
  putSecurityAiSettings: h.putSecurityAiSettings,
}));

import { AI_COPY, AiSettingsPanel } from "@/components/security/AiSettingsPanel";

const fresh = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

function renderPanel() {
  return render(<AiSettingsPanel />, { wrapper: fresh });
}

const V = (over: Partial<SecurityAiSettingsView> = {}): SecurityAiSettingsView => ({
  linking: "link_and_suggest",
  summaries: "on",
  version: 4,
  ...over,
});

beforeEach(() => {
  h.level = "manage";
  h.toast.mockReset();
  h.getSecurityAiSettings.mockReset().mockResolvedValue(V());
  h.putSecurityAiSettings.mockReset();
});

describe("AiSettingsPanel", () => {
  it("at manage: the three linking choices (the current one checked), and Save disabled until something changes", async () => {
    renderPanel();
    const radio = await screen.findByRole("radio", { name: AI_COPY.linking.link_and_suggest });
    expect(radio).toBeChecked();
    expect(screen.getByRole("radio", { name: AI_COPY.linking.suggest_only })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: AI_COPY.linking.off })).not.toBeChecked();
    // Review #2418: aria-disabled, never `disabled` — it keeps focus, and a press does nothing.
    expect(screen.getByRole("button", { name: AI_COPY.save })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: AI_COPY.save })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: AI_COPY.save }));
    expect(h.putSecurityAiSettings).not.toHaveBeenCalled();
  });

  it("in flight: Save stays focusable (aria-disabled) and a second press is refused", async () => {
    let release!: () => void;
    h.putSecurityAiSettings.mockImplementation(() => new Promise((r) => (release = () => r({ linking: "off", summaries: "on", version: 5, changed: true }))));
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: AI_COPY.linking.off }));
    const save = screen.getByRole("button", { name: AI_COPY.save });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(h.putSecurityAiSettings).toHaveBeenCalledTimes(1);
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).not.toBeDisabled();
    release();
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(AI_COPY.saved, "success"));
  });

  it("Save sends the whole choice with the version it was read at, then confirms", async () => {
    h.putSecurityAiSettings.mockResolvedValue({ linking: "suggest_only", summaries: "on", version: 5, changed: true });
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: AI_COPY.linking.suggest_only }));
    fireEvent.click(screen.getByRole("button", { name: AI_COPY.save }));
    // The summaries setting is sent back exactly as read (review #2418: nothing in PR-1 reads it, so it is not shown).
    await waitFor(() => expect(h.putSecurityAiSettings).toHaveBeenCalledWith({ linking: "suggest_only", summaries: "on", expectedVersion: 4 }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(AI_COPY.saved, "success"));
  });

  it("a 409 re-reads and shows the conflict banner — the other person's choice is what's on screen", async () => {
    h.putSecurityAiSettings.mockRejectedValue(Object.assign(new Error("conflict"), { code: "VERSION_CONFLICT", status: 409 }));
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: AI_COPY.linking.off }));
    h.getSecurityAiSettings.mockResolvedValue(V({ linking: "suggest_only", version: 5 }));
    fireEvent.click(screen.getByRole("button", { name: AI_COPY.save }));
    expect(await screen.findByText(AI_COPY.conflict)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: AI_COPY.linking.suggest_only })).toBeChecked());
    expect(h.toast).not.toHaveBeenCalled();
  });

  it.each(["view", "act"] as const)("below manage (%s): the choices as text and who can change them — no controls", async (level) => {
    h.level = level;
    h.getSecurityAiSettings.mockResolvedValue(V({ linking: "suggest_only", summaries: "off" }));
    renderPanel();
    expect(await screen.findByText(AI_COPY.linking.suggest_only)).toBeInTheDocument();
    expect(screen.getByText(AI_COPY.readOnly)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: AI_COPY.save })).toBeNull();
  });

  it("a failed read is an error with Retry — never the defaults", async () => {
    h.getSecurityAiSettings.mockRejectedValue(Object.assign(new Error("db down"), { code: "AI_SETTINGS_UNAVAILABLE", status: 503 }));
    renderPanel();
    expect(await screen.findByText(AI_COPY.loadError)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText(AI_COPY.linking.link_and_suggest)).toBeNull();
    h.getSecurityAiSettings.mockResolvedValue(V());
    fireEvent.click(screen.getByRole("button", { name: AI_COPY.retry }));
    expect(await screen.findByRole("radio", { name: AI_COPY.linking.link_and_suggest })).toBeChecked();
  });
});

// Review #2418 (finding 8, spec §11: no half-built feature) — nothing reads the summaries setting until P4 PR-2
// builds the writer, so PR-1 shows no switch and no line about it, at any level. PR-2 brings them back.
describe("AiSettingsPanel — no summaries control before the summaries exist", () => {
  it.each(["manage", "view"] as const)("%s: no summaries switch, and no words about summaries", async (level) => {
    h.level = level;
    h.getSecurityAiSettings.mockResolvedValue(V({ summaries: "off" }));
    renderPanel();
    expect(await screen.findByText(AI_COPY.linking.link_and_suggest)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/summar/i)).toBeNull();
  });

  it("Save still sends back the stored summaries setting untouched", async () => {
    h.getSecurityAiSettings.mockResolvedValue(V({ summaries: "off" }));
    h.putSecurityAiSettings.mockResolvedValue({ linking: "off", summaries: "off", version: 5, changed: true });
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: AI_COPY.linking.off }));
    fireEvent.click(screen.getByRole("button", { name: AI_COPY.save }));
    await waitFor(() => expect(h.putSecurityAiSettings).toHaveBeenCalledWith({ linking: "off", summaries: "off", expectedVersion: 4 }));
  });
});
