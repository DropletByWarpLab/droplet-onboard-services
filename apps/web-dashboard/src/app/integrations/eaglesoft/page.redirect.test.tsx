/**
 * WARP-2560 (ADR-044) — the practice surface moved to /practice, and the old
 * address has to keep working.
 *
 * This is a small test for a small file, and it earns its place because the
 * failure it catches is invisible: deleting the redirect page does not break
 * a build, does not fail a type-check, and does not fail any other test. It
 * fails on a Monday morning, for the one person who bookmarked the schedule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirect(href),
}));

import EaglesoftRedirect from "./page";

describe("/integrations/eaglesoft", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it("sends the old practice address to /practice", () => {
    EaglesoftRedirect();
    expect(redirect).toHaveBeenCalledWith("/practice");
  });

  it("redirects rather than rendering anything of its own", () => {
    // A page that rendered a "this moved" notice would leave the reader a
    // click away from the thing they asked for, and would need its own copy,
    // its own gate, and its own reason to exist.
    EaglesoftRedirect();
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
