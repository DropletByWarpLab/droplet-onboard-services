/**
 * Samantha QA (#bugs): the Block phone-home card never explains *what*
 * phone-home is or *why* it matters to a home user. Add a short, friendly
 * explainer under the header — what telemetry is, that smart devices/cameras
 * quietly send usage data to their makers, that blocking keeps it on the home
 * network, and that essential traffic (time sync, security/firmware updates)
 * is always allowed.
 *
 * Kept behind a "Why this matters" <details> disclosure so the card stays
 * compact; the body lives in the DOM (collapsed-by-default) so it's
 * discoverable by assistive tech and search.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { id: "u1", username: "alice", role: "owner" } }),
}));

import { PhoneHomeCard } from "@/components/network/PhoneHomeCard";

const offView = {
  enabled: { desired: false, applied: false, appliedAt: null },
  cameras: { desired: false, applied: false, appliedAt: null, count: 2 },
  groups: [],
  lastSync: new Date().toISOString(),
  pending: 0,
};

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        fetcher: async () => offView,
      }}
    >
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<PhoneHomeCard> explainer copy (Samantha QA #bugs)", () => {
  it("offers a 'Why this matters' disclosure trigger", () => {
    render(
      <Wrap>
        <PhoneHomeCard />
      </Wrap>,
    );
    expect(screen.getByText(/why this matters/i)).toBeInTheDocument();
  });

  it("explains what phone-home/telemetry is and that devices quietly send data to their makers", () => {
    render(
      <Wrap>
        <PhoneHomeCard />
      </Wrap>,
    );
    const explainer = screen.getByTestId("phone-home-explainer");
    const text = explainer.textContent ?? "";
    expect(text).toMatch(/telemetry|usage data/i);
    expect(text).toMatch(/quietly|behind the scenes/i);
  });

  it("says blocking keeps that data on the local network", () => {
    render(
      <Wrap>
        <PhoneHomeCard />
      </Wrap>,
    );
    const text = screen.getByTestId("phone-home-explainer").textContent ?? "";
    // WARP-1810: business build — "local network", not "home network".
    expect(text).toMatch(/your local network/i);
    expect(text).not.toMatch(/home network/i);
  });

  it("reassures that essential traffic (time sync, security/firmware updates) is always allowed", () => {
    render(
      <Wrap>
        <PhoneHomeCard />
      </Wrap>,
    );
    const text = screen.getByTestId("phone-home-explainer").textContent ?? "";
    expect(text).toMatch(/time sync/i);
    expect(text).toMatch(/security|firmware/i);
    expect(text).toMatch(/always allowed|still get through|never blocked/i);
  });
});
