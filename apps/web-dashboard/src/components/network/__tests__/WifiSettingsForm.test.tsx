/**
 * Issue #12 — WifiSettingsForm: editable Wi-Fi provisioning in the Network tab.
 * Mirrors InternetStep's SSID→password→confirm→poll dance + calm error ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { WifiSettingsForm } from "../WifiSettingsForm";
import {
  setWifiSsid,
  setWifiPassword,
  confirmNetworkCommand,
  fetchNetworkOperation,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual, // keep real RouterStatusError + routerUnreachableNotice
    setWifiSsid: vi.fn(),
    setWifiPassword: vi.fn(),
    confirmNetworkCommand: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

const ssidMock = vi.mocked(setWifiSsid);
const pwMock = vi.mocked(setWifiPassword);
const confirmMock = vi.mocked(confirmNetworkCommand);
const opMock = vi.mocked(fetchNetworkOperation);

beforeEach(() => {
  ssidMock.mockReset();
  pwMock.mockReset();
  confirmMock.mockReset();
  opMock.mockReset();
  ssidMock.mockResolvedValue({ status: "ok", tier: 1 } as never);
  pwMock.mockResolvedValue({ status: "ok", tier: 1 } as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

function fill(ssid: string, pw: string) {
  fireEvent.change(screen.getByPlaceholderText(/studio fotonia/i), {
    target: { value: ssid },
  });
  fireEvent.change(screen.getByPlaceholderText(/wi-fi password/i), {
    target: { value: pw },
  });
}
async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /save wi-fi/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("WifiSettingsForm (issue #12)", () => {
  it("rejects a blank SSID client-side without hitting the API", async () => {
    render(<WifiSettingsForm />);
    fill("", "abcdefgh");
    await save();
    expect(screen.getByText(/enter a network name/i)).toBeInTheDocument();
    expect(ssidMock).not.toHaveBeenCalled();
  });

  it("rejects a password under 8 chars client-side", async () => {
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "short");
    await save();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(ssidMock).not.toHaveBeenCalled();
  });

  it("submits SSID then password and shows the applied banner on a Tier-1 save", async () => {
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(ssidMock).toHaveBeenCalledWith("Studio Fotonia");
    expect(pwMock).toHaveBeenCalledWith("supersecret");
    expect(ssidMock.mock.invocationCallOrder[0]).toBeLessThan(
      pwMock.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText(/wi-fi updated/i)).toBeInTheDocument();
  });

  it("auto-confirms + polls when the password POST returns 202 confirmation_required", async () => {
    pwMock.mockResolvedValue({
      status: "confirmation_required",
      operation: "set_wifi_password",
      tier: 2,
      confirmationToken: "tok-12",
    } as never);
    confirmMock.mockResolvedValue({ operationId: "op-12" });
    opMock.mockResolvedValue({
      id: "op-12",
      state: "applied",
      startedAt: 0,
      finishedAt: 1,
      reason: null,
    } as never);
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(confirmMock).toHaveBeenCalledWith("tok-12", "set_wifi_password");
    expect(opMock).toHaveBeenCalledWith("op-12");
    expect(await screen.findByText(/wi-fi updated/i)).toBeInTheDocument();
  });

  it("shows the actionable message in red on a 422 validation refusal", async () => {
    pwMock.mockRejectedValue(
      new RouterStatusError("UNKNOWN", "PSK contains invalid characters.", 422),
    );
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "badcontrolchars");
    await save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/invalid characters/i);
  });

  it("shows a calm amber notice (not the raw error) when the router is unreachable", async () => {
    ssidMock.mockRejectedValue(
      new RouterStatusError("UNREACHABLE", "ECONNREFUSED 192.168.50.1", 503),
    );
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(await screen.findByText(/isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("surfaces a rolled-back op.reason in red (plain Error from pollOperation)", async () => {
    pwMock.mockResolvedValue({
      status: "confirmation_required",
      operation: "set_wifi_password",
      tier: 2,
      confirmationToken: "tok-rb",
    } as never);
    confirmMock.mockResolvedValue({ operationId: "op-rb" });
    opMock.mockResolvedValue({
      id: "op-rb",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Reverted: lost connectivity to the AP.",
    } as never);
    render(<WifiSettingsForm />);
    fill("Studio Fotonia", "supersecret");
    await save();
    expect(
      await screen.findByText(/reverted: lost connectivity/i),
    ).toBeInTheDocument();
  });

  it("toggles password visibility", async () => {
    render(<WifiSettingsForm />);
    const pw = screen.getByPlaceholderText(
      /wi-fi password/i,
    ) as HTMLInputElement;
    expect(pw.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /show.*password/i }));
    expect(pw.type).toBe("text");
  });
});

/**
 * WARP-1733 UX review — three polish items the Simple-mode mount made visible.
 * All three are properties of THIS form, so they are pinned here at the unit
 * level; the mount-context half of the heading rule is pinned where the two
 * mounts live (NetworkSimple.test.tsx / WifiTab.test.tsx).
 */
describe("WifiSettingsForm — WARP-1733 UX polish", () => {
  /**
   * Item A. The failed-read notice used to be its own `.card`, rendered as a
   * SIBLING above this one. In Advanced that read acceptably — it was the
   * first thing inside a Wi-Fi-only tab panel. In Simple mode the column
   * becomes five identically-styled `.card` siblings at `gap-4`, so nothing
   * ties the notice to the form it qualifies and a household reads it as a
   * standalone page alert. One card, one subject: the notice belongs inside
   * the form's card, in the same inset slot as the form's own
   * `live && !live.ssid` honesty notice.
   */
  it("renders the failed-read notice inside its own card, not as a sibling card", () => {
    const { container } = render(<WifiSettingsForm failedRead />);

    // ONE card — the notice did not bring a second one with it.
    expect(container.querySelectorAll(".card")).toHaveLength(1);
    const card = container.querySelector(".card") as HTMLElement;
    const notice = screen.getByText(
      /We couldn't read your current Wi-Fi settings just now/i,
    );
    expect(card.contains(notice)).toBe(true);
    // Copy and politeness are unchanged from the sibling-card version:
    // nothing the user did caused this, so it is announced, not interrupting.
    expect(notice).toHaveTextContent(
      /changes the Wi-Fi this Droplet broadcasts itself/i,
    );
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  it("puts that notice under the heading and above the fields it qualifies", () => {
    render(<WifiSettingsForm failedRead />);

    const heading = screen.getByRole("heading", { name: "Wi-Fi settings" });
    const notice = screen.getByText(
      /We couldn't read your current Wi-Fi settings just now/i,
    );
    const ssid = screen.getByLabelText(/^network name/i);
    expect(
      heading.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(
      notice.compareDocumentPosition(ssid) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it("says nothing about a failed read when the read did not fail", () => {
    render(<WifiSettingsForm />);
    expect(
      screen.queryByText(/We couldn't read your current Wi-Fi settings/i),
    ).not.toBeInTheDocument();
  });

  /**
   * Item B. ShellPage owns the `<h1>`. Inside the Advanced Wi-Fi tab panel
   * this card is a subsection, so `h3` is right; in Simple mode it is a
   * SIBLING of the `<h2>Internet</h2>` hero, and a hardcoded `h3` there claims
   * the Wi-Fi card is part of the Internet hero. The level is a property of
   * the mount, not of the card — so the mount supplies it.
   */
  it("takes its heading level from the mount context", () => {
    const { unmount } = render(<WifiSettingsForm />);
    expect(
      screen.getByRole("heading", { name: "Wi-Fi settings", level: 3 }),
    ).toBeInTheDocument();
    unmount();

    render(<WifiSettingsForm headingLevel="h2" />);
    expect(
      screen.getByRole("heading", { name: "Wi-Fi settings", level: 2 }),
    ).toBeInTheDocument();
  });

  /**
   * Item D. The reveal button wrapped a 16px icon with no padding, so its hit
   * area was ~16×16 — under WCAG 2.2 SC 2.5.8's 24px floor, on what Simple
   * mode makes the likeliest phone surface. `p-2 -m-2` grows the target by
   * 8px on every side and takes the margin straight back, so nothing moves.
   */
  it("gives the password reveal a target that clears the 24px floor", () => {
    render(<WifiSettingsForm />);
    // jsdom computes no layout, so pin the mechanism rather than a rect:
    // padding grows the hit area, the negative margin keeps the icon put.
    const reveal = screen.getByRole("button", { name: /show wi-fi password/i });
    expect(reveal.className).toMatch(/(^|\s)p-2(\s|$)/);
    expect(reveal.className).toMatch(/(^|\s)-m-2(\s|$)/);
  });
});
