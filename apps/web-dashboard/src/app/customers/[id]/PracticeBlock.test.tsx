/**
 * WARP-2567 (ADR-044 §3) — the practice block reveals nothing it was refused.
 *
 * The assertion that matters is the negative one, and it is easy to get wrong
 * in a way that looks like good UX: rendering a lock, or "you don't have
 * access to this", tells the reader that a patient record EXISTS for this
 * customer. That is the disclosure the gate exists to prevent, and a `family`
 * member — the front desk — reaches this page by design.
 *
 * So a refusal must be indistinguishable from the ordinary case of a customer
 * with no linked patient: nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const authFetch = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import { PracticeBlock } from "./PracticeBlock";

/**
 * A FRESH SWR cache per render.
 *
 * Every test here uses the same company id, so without this they share one
 * cache entry: the second render resolves instantly from the first test's
 * value, `authFetch` is never called again, and the assertions either see
 * stale data or time out waiting for a fetch that already happened. Isolating
 * the cache is what makes each case actually exercise the fetch it describes.
 */
function renderBlock(companyId = "co1") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PracticeBlock companyId={companyId} />
    </SWRConfig>,
  );
}

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

beforeEach(() => {
  authFetch.mockReset();
});

describe("a refusal renders nothing", () => {
  it("renders nothing on 403 — no lock, no placeholder, no note", async () => {
    // The connector-grant refusal. A lock here would announce that this
    // customer IS a patient.
    authFetch.mockResolvedValue(json({ error: "forbidden" }, false, 403));
    const { container } = renderBlock();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByText(/practice/i)).toBeNull();
  });

  it("renders nothing on 404 — a box with no ERP configured", async () => {
    authFetch.mockResolvedValue(json({ error: "not_found" }, false, 404));
    const { container } = renderBlock();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("renders the same nothing when there IS no linked patient", async () => {
    // This is the point: a permitted reader looking at an unlinked customer
    // and a refused reader looking at a linked one see the identical page.
    authFetch.mockResolvedValue(json({ patients: [], linked: false }));
    const { container } = renderBlock();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});

describe("a permitted reader with a linked patient", () => {
  it("shows the practice identifier, and no chart detail", async () => {
    authFetch.mockResolvedValue(
      json({
        linked: true,
        patients: [
          {
            linkId: "pl1",
            externalSystem: "eaglesoft-api",
            externalId: "4471",
            patient: { id: "4471", name: "Dana Whitfield", dob: "1984-02-11", phone: "555-0100" },
          },
        ],
      }),
    );
    renderBlock();
    expect(await screen.findByText("Dana Whitfield")).toBeTruthy();
    expect(screen.getByText("#4471")).toBeTruthy();
    // The record page is the CRM's. Date of birth and phone came back in the
    // payload and are deliberately NOT rendered here — clinical detail lives
    // on /practice, behind the surface built for it.
    expect(screen.queryByText(/1984/)).toBeNull();
    expect(screen.queryByText(/555-0100/)).toBeNull();
  });

  it("offers the way through to the practice surface", async () => {
    authFetch.mockResolvedValue(
      json({
        linked: true,
        patients: [
          { linkId: "pl1", externalSystem: "eaglesoft-api", externalId: "4471", patient: null },
        ],
      }),
    );
    renderBlock();
    const link = await screen.findByRole("link", { name: /Open Practice/ });
    expect(link).toHaveAttribute("href", "/practice");
  });

  it("does not retry a refusal", async () => {
    // A recurring 403 would put one audit entry in the log per poll, for
    // every record page a family member opens.
    authFetch.mockResolvedValue(json({ error: "forbidden" }, false, 403));
    renderBlock();
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
  });
});
