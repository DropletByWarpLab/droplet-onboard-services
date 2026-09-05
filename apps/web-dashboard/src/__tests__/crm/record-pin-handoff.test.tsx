/**
 * WARP-2582 - "Ask AI about this customer" hands over an identity.
 *
 * Before this ticket the two Ask-AI actions in the tree were bare
 * `<Link href="/chat">`s: no query string, no sessionStorage, no record id.
 * The model was told nothing at all, so the button was a navigation dressed as
 * a feature. These assertions are what stop it regressing to that.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import { PENDING_COMPOSER_KEY, type PendingComposerPayload } from "@/lib/types";
import { stagePromptHandoff, stageRecordPinHandoff } from "@/lib/pin-handoff";

function staged(): PendingComposerPayload {
  return JSON.parse(window.sessionStorage.getItem(PENDING_COMPOSER_KEY)!);
}

beforeEach(() => {
  pushMock.mockReset();
  window.sessionStorage.clear();
});

describe("stageRecordPinHandoff", () => {
  it("carries the pin AND a seed line that names the record on turn 1", () => {
    stageRecordPinHandoff({ kind: "customer", id: "c-uuid", name: "Northwind Dental" });
    const p = staged();
    expect(p.kind).toBe("pin");
    expect(p).toMatchObject({ pin: { kind: "customer", ref: "c-uuid" } });
    // Turn 1 predates the session id, so the seed line has to carry the id
    // itself - the pin only starts working from turn 2.
    expect(p.seedText).toContain("Northwind Dental");
    expect(p.seedText).toContain("c-uuid");
  });

  it("sends the record id as `ref`, never the display name", () => {
    stageRecordPinHandoff({ kind: "deal", id: "d-uuid", name: "Chair replacement" });
    expect(staged()).toMatchObject({ pin: { ref: "d-uuid" } });
  });

  it("uses a human noun for work_item", () => {
    stageRecordPinHandoff({ kind: "work_item", id: "w", name: "Order chairs" });
    expect(staged().seedText).toContain("work item");
  });
});

describe("stagePromptHandoff", () => {
  it("stages a null pin - a list has no ref to pin", () => {
    stagePromptHandoff("Customers", "About my customers: ");
    const p = staged();
    expect(p.kind).toBe("pin");
    expect(p).toMatchObject({ pin: null });
    expect(p.seedText).toBe("About my customers: ");
  });
});

describe("the RecordDrawer action", () => {
  it("stages the drawer's subject and routes to /chat", async () => {
    const { RecordDrawer } = await import("@/components/crm/modals");
    render(
      <RecordDrawer
        title="Northwind Dental"
        subject={{ type: "COMPANY", id: "c-uuid" }}
        readOnly
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ask ai about this customer/i }));
    expect(staged()).toMatchObject({ pin: { kind: "customer", ref: "c-uuid" } });
    expect(pushMock).toHaveBeenCalledWith("/chat");
  });

  it("offers no pin for a CONTACT subject - there is no contact pin kind", async () => {
    const { RecordDrawer } = await import("@/components/crm/modals");
    render(
      <RecordDrawer
        title="Jo Blake"
        subject={{ type: "CONTACT", id: "p-uuid" }}
        readOnly
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /ask ai about this/i })).toBeNull();
  });
});
