/**
 * WARP-3161 — the chat composer's "Cloud models on" pill: shown while the
 * box's cloud_model_escape is on unless allowedForYou is false; tapping it
 * explains; only owners and admins get the Models link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CloudAccessInfo } from "@/lib/types";

let cloudAccess: CloudAccessInfo | undefined;
let role = "family";

vi.mock("@/lib/hooks/useModelsPage", () => ({
  useModelsPage: () => ({ data: cloudAccess ? { cloudAccess } : undefined }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "u", role } }),
}));

import { CloudModelsPill, CLOUD_PILL_EXPLAINER } from "./CloudModelsPill";

const access = (over: Partial<CloudAccessInfo>): CloudAccessInfo => ({
  escapeEnabled: true,
  escapeChangedBy: null,
  escapeChangedAt: null,
  allowedForYou: true,
  ...over,
});

beforeEach(() => {
  cleanup();
  cloudAccess = undefined;
  role = "family";
});

const pill = () => screen.queryByRole("button", { name: /cloud models on/i });

describe("CloudModelsPill", () => {
  it("is hidden while the Models data hasn't loaded", () => {
    render(<CloudModelsPill />);
    expect(pill()).toBeNull();
  });

  it("is hidden when cloud is off", () => {
    cloudAccess = access({ escapeEnabled: false, allowedForYou: false });
    render(<CloudModelsPill />);
    expect(pill()).toBeNull();
  });

  it("is hidden when the box never routes this person's turns to cloud", () => {
    cloudAccess = access({ allowedForYou: false });
    render(<CloudModelsPill />);
    expect(pill()).toBeNull();
  });

  it.each([true, null])("shows when cloud is on and allowedForYou is %s", (allowed) => {
    cloudAccess = access({ allowedForYou: allowed });
    render(<CloudModelsPill />);
    expect(pill()).not.toBeNull();
  });

  it("explains on tap; a member gets no Models link", () => {
    cloudAccess = access({});
    render(<CloudModelsPill />);
    fireEvent.click(pill()!);
    expect(pill()!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(CLOUD_PILL_EXPLAINER)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /manage cloud models/i })).toBeNull();
  });

  it("an external guest gets no Models link", () => {
    role = "guest";
    cloudAccess = access({ allowedForYou: null });
    render(<CloudModelsPill />);
    fireEvent.click(pill()!);
    expect(screen.queryByRole("link", { name: /manage cloud models/i })).toBeNull();
  });

  it.each(["owner", "admin"])("%s gets a link to Models", (r) => {
    role = r;
    cloudAccess = access({});
    render(<CloudModelsPill />);
    fireEvent.click(pill()!);
    expect(
      screen.getByRole("link", { name: /manage cloud models/i }).getAttribute("href"),
    ).toBe("/models");
  });

  it("Escape and an outside click close the explainer", () => {
    cloudAccess = access({});
    render(<CloudModelsPill />);
    fireEvent.click(pill()!);
    expect(screen.getByText(CLOUD_PILL_EXPLAINER)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(CLOUD_PILL_EXPLAINER)).toBeNull();
    fireEvent.click(pill()!);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText(CLOUD_PILL_EXPLAINER)).toBeNull();
  });
});
