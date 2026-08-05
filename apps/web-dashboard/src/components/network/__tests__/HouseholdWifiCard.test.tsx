/**
 * HouseholdWifiCard — THE household Wi-Fi control (WARP-1723 → WARP-1733).
 *
 * WARP-1723 established one editable household surface, chosen by where the
 * Wi-Fi actually lives (`/api/network/wifi/current` → `source`). That choice
 * was inlined in WifiTab, which meant it existed only on the Advanced-mode
 * Wi-Fi tab — and Simple mode, the home persona's view (ADR-002), had no way
 * to change the Wi-Fi at all (WARP-1733).
 *
 * WARP-1733 extracts the choice into this component so Simple mode can mount
 * the SAME control instead of growing a second editable Wi-Fi surface — which
 * is precisely the bug WARP-1723 removed. This suite is the extracted
 * behaviour's new home: every one of the five render states that used to be
 * pinned through WifiTab is pinned here, against the component that now owns
 * them. WifiTab keeps its own composition tests (the secondary AP card, its
 * sibling cards); NetworkSimple keeps the mount test.
 *
 * The five states, unchanged from WARP-1723:
 *   source "ap"     → ApWifiCard slot="household" (the AP hosts the household net)
 *   source "router" → WifiSettingsForm (this Droplet's own radio hosts it)
 *   source null     → WifiSettingsForm + its own honest "couldn't read" notice
 *   unresolved      → the height-reserving skeleton, never both forms
 *   read failed     → FailedReadNotice + WifiSettingsForm, never a stuck skeleton
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { HouseholdWifiCard } from "../HouseholdWifiCard";
import {
  AP_WIFI_UP,
  CURRENT_WIFI_NONE,
  FAILED_READ_NOTICE,
  HOUSEHOLD_HEADLINE,
  ROUTER_FORM_SUBHEAD,
  SKELETON_TEXT,
  currentWifi,
  findSkeleton,
  mockWifiEndpoints,
  type FetchMock,
} from "./wifi-source-fixtures";

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <HouseholdWifiCard />
    </SWRConfig>,
  );
}

describe("HouseholdWifiCard source split (WARP-1723, extracted WARP-1733)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('source "ap" (edge-router shape): the AP form IS the household form; the router form is gone', async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });
    renderCard();

    // Exactly one household form, and it is the AP's — its input carries the
    // AP write path's id, not the router form's `wifi-ssid`.
    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.getAllByText(HOUSEHOLD_HEADLINE)).toHaveLength(1);
    const ssid = await screen.findByLabelText("Network name (SSID)");
    expect(ssid).toHaveAttribute("id", "ap-wifi-ssid");

    // The router-radio form must NOT render — its save path (POST
    // /api/network/wifi/ssid) writes to a radio that hosts nothing here.
    expect(screen.queryByText(ROUTER_FORM_SUBHEAD)).not.toBeInTheDocument();
    expect(document.getElementById("wifi-ssid")).toBeNull();
  });

  // UX blocker 1 (WARP-1723 second pass): promoted into the household slot, the
  // AP card must stop wearing secondary-slot copy. "Access point Wi-Fi" / "the
  // network your COVERAGE EXTENDER broadcasts" reads as an accessory network,
  // so a household admin concludes their own Wi-Fi isn't editable here.
  it('source "ap": the promoted card wears household copy, not coverage-extender copy', async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });
    renderCard();

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    // It still says WHERE the network is broadcast — honest about the restart.
    expect(screen.getByText(/the network your devices join/i)).toBeInTheDocument();
    expect(screen.queryByText(/coverage extender/i)).not.toBeInTheDocument();
  });

  // The AP card's own resolving state has to survive the extraction: with no
  // read landed yet, `supported` defaults to false, so asserting "not
  // available" about a healthy access point is a lie the card must not tell.
  it('source "ap": while the AP read is in flight it says it is checking, not "not available"', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes("/api/network/wifi/current"))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => currentWifi({ source: "ap" }),
        });
      // The AP read never settles.
      if (path.includes("/api/network/wifi/ap")) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    renderCard();

    expect(
      await screen.findByText("Checking with your access point…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not available —/)).not.toBeInTheDocument();
  });

  it('source "router": the router form owns the household slot', async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "router" }),
      apWifi: AP_WIFI_UP,
    });
    renderCard();

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(ROUTER_FORM_SUBHEAD)).toBeInTheDocument();
    expect(document.getElementById("wifi-ssid")).not.toBeNull();
    // The SECOND network's card is WifiTab's business, not this control's —
    // the extraction must not drag the secondary mount along, or Simple mode
    // grows an AP editor nobody asked it for.
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
  });

  it("source null (couldn't read): the router form renders with its own honest notice", async () => {
    mockWifiEndpoints(fetchMock, { current: CURRENT_WIFI_NONE });
    renderCard();

    expect(await screen.findByText(HOUSEHOLD_HEADLINE)).toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    // WifiSettingsForm's own `live && !live.ssid` notice, not a second one
    // stacked above it: `source: null` is a RESOLVED answer.
    expect(
      screen.getByText("We couldn't read the Wi-Fi configuration right now."),
    ).toBeInTheDocument();
    expect(screen.queryByText(FAILED_READ_NOTICE)).not.toBeInTheDocument();
  });

  it("while the source is unresolved: a single calm placeholder, never both editable forms", async () => {
    mockWifiEndpoints(fetchMock, { current: "pending" });
    renderCard();

    expect(await findSkeleton()).toBeInTheDocument();
    expect(screen.queryByText(HOUSEHOLD_HEADLINE)).not.toBeInTheDocument();
    expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
  });

  // UX + QA (WARP-1723 second pass), compounding live bug WARP-1726: the
  // placeholder measured ~168px and became a ~350px form, so the tab jumped
  // under the scroll clamp. It reserves the form's height and carries real
  // text inside the live region — an empty region with only aria-label
  // announces inconsistently across screen readers.
  it("the placeholder reserves the form's height and announces with real text", async () => {
    mockWifiEndpoints(fetchMock, { current: "pending" });
    renderCard();

    const skeleton = await findSkeleton();
    expect(skeleton.style.minHeight).toBe("300px");
    const srText = skeleton.querySelector(".sr-only");
    expect(srText).not.toBeNull();
    expect(srText?.textContent).toMatch(SKELETON_TEXT);
    // …and ONLY from that text node. Carrying both an aria-label and the same
    // words as content is a double announcement in NVDA/JAWS.
    expect(skeleton).not.toHaveAttribute("aria-label");
  });

  // QA note 1 (WARP-1723 second pass): the ONE state whose failure mode is
  // "the user can never edit Wi-Fi again". A failed read must fall back to the
  // router form — exactly what rendered before the split — never a permanent
  // skeleton.
  it("a FAILED source read falls back to the router form, never a stuck skeleton", async () => {
    mockWifiEndpoints(fetchMock, { current: "error" });
    renderCard();

    expect(await screen.findByText(ROUTER_FORM_SUBHEAD)).toBeInTheDocument();
    expect(screen.queryByText(SKELETON_TEXT)).not.toBeInTheDocument();
  });

  // Review finding 1 (WARP-1723 third pass): that fallback silently restores
  // the pre-split bug. On the edge-router shape WifiSettingsForm saves through
  // the ROUTER write path and reports success while nothing changes on air —
  // and the form's OWN honesty notice can't fire here, because it is gated on
  // `live && !live.ssid` and `live` is undefined on the very read that just
  // failed (same SWR key, same error).
  it("a FAILED source read says WHERE this form writes, above the form", async () => {
    mockWifiEndpoints(fetchMock, { current: "error" });
    renderCard();

    const notice = await screen.findByText(FAILED_READ_NOTICE);
    expect(notice).toBeInTheDocument();
    // Polite live region: nothing the user did caused this.
    expect(notice.closest('[role="status"]')).not.toBeNull();
    // It names the consequence, not just the failure.
    expect(
      screen.getByText(/changes the Wi-Fi this Droplet broadcasts itself/i),
    ).toBeInTheDocument();
    // Above the fields it qualifies, not buried under them. (WARP-1733 UX
    // review: this assertion used to anchor on the form's SUBHEAD, back when
    // the notice was a separate card stacked above the whole form. The notice
    // now sits inside the form's card, below the heading block — so the thing
    // it must precede is the editable fields, which was always the point.)
    const ssid = screen.getByLabelText(/^network name/i);
    expect(
      notice.compareDocumentPosition(ssid) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  /**
   * WARP-1733 UX review, item A. The notice used to be its own `.card`, a
   * SIBLING above the form. Inside the Advanced Wi-Fi tab panel that read
   * acceptably — it was the first thing in a Wi-Fi-only panel. In Simple mode
   * the column becomes five identically-styled `.card` siblings at `gap-4`,
   * with nothing binding the notice to the form it qualifies, so a household
   * reads it as a standalone page alert rather than a preamble to that form.
   * One card, one subject.
   */
  it("a FAILED source read produces ONE card, not a notice card plus a form card", async () => {
    mockWifiEndpoints(fetchMock, { current: "error" });
    const { container } = renderCard();

    const notice = await screen.findByText(FAILED_READ_NOTICE);
    expect(container.querySelectorAll(".card")).toHaveLength(1);
    const card = container.querySelector(".card") as HTMLElement;
    expect(card.contains(notice)).toBe(true);
    // …and it is the FORM's card it lives in, not a card of its own that
    // happens to be the only one.
    expect(card.contains(screen.getByLabelText(/^network name/i))).toBe(true);
  });

  /**
   * WARP-1733 UX review, item B. This control is mounted in two places whose
   * heading trees differ: inside the Advanced Wi-Fi tab panel it is a
   * subsection (h3), while in Simple mode it is a sibling of the
   * `<h2>Internet</h2>` hero. The level therefore travels from the mount —
   * and it has to reach BOTH branches, or the edge-router shape (where the AP
   * card is the household form) keeps the misnesting.
   */
  it("passes the mount's heading level through to whichever form owns the slot", async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "router" }),
    });
    const { unmount } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HouseholdWifiCard headingLevel="h2" />
      </SWRConfig>,
    );
    expect(
      await screen.findByRole("heading", {
        name: HOUSEHOLD_HEADLINE,
        level: 2,
      }),
    ).toBeInTheDocument();
    unmount();

    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "ap" }),
      apWifi: AP_WIFI_UP,
    });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HouseholdWifiCard headingLevel="h2" />
      </SWRConfig>,
    );
    expect(
      await screen.findByRole("heading", {
        name: HOUSEHOLD_HEADLINE,
        level: 2,
      }),
    ).toBeInTheDocument();
  });

  it("defaults to h3 — the Advanced tab panel's subsection level", async () => {
    mockWifiEndpoints(fetchMock, {
      current: currentWifi({ source: "router" }),
    });
    renderCard();

    expect(
      await screen.findByRole("heading", {
        name: HOUSEHOLD_HEADLINE,
        level: 3,
      }),
    ).toBeInTheDocument();
  });
});
