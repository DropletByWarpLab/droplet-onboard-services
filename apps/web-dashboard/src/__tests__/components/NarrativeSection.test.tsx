/**
 * WARP-2979 (ADR-059 P4 §8) — "Summary by Droplet" on the incident page.
 *
 *   · every state in the §8 table, and the states that render nothing
 *     (`narrative: null` — the box's DS-005 answer — and `expired`);
 *   · Regenerate / Summarise now only at act, never rendered and then refused;
 *   · a 409 NARRATIVE_COOLDOWN is the typed toast, never the server's words;
 *   · after a request, the incident is re-read every 5 s while pending, for
 *     at most 2 minutes — and the re-reads stop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NarrativeSection, NARRATIVE_COPY, NARRATIVE_POLL_MS, NARRATIVE_POLL_FOR_MS } from "@/components/security/NarrativeSection";
import type { IncidentNarrativeView } from "@/lib/types";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const NOW = new Date("2026-09-23T01:40:00Z");
const TEXT = "Someone was seen in the Stock room at 2:14 AM while the site was closed.";

function n(over: Partial<IncidentNarrativeView> = {}): IncidentNarrativeView {
  return { state: "written", text: TEXT, writtenAt: "2026-09-23T01:31:00Z", model: "gpt-oss:20b", promptVersion: 1, ...over };
}

function setup(props: Partial<Parameters<typeof NarrativeSection>[0]> = {}) {
  const onSummarise = vi.fn(async () => undefined);
  const refresh = vi.fn();
  const view = render(
    <NarrativeSection
      narrative={n()}
      grouping="closed"
      canAct
      paused={false}
      timezone="Europe/London"
      now={NOW}
      onSummarise={onSummarise}
      refresh={refresh}
      {...props}
    />,
  );
  return { ...view, onSummarise, refresh };
}

afterEach(() => {
  vi.useRealTimers();
  toast.mockReset();
});

describe("NarrativeSection — the §8 table", () => {
  it("written: the text, the caption that says the reasons win, and Regenerate at act", () => {
    setup();
    expect(screen.getByRole("heading", { name: NARRATIVE_COPY.title })).toBeTruthy();
    expect(screen.getByText(TEXT)).toBeTruthy();
    expect(screen.getByText("Written by the AI on this Droplet at 2:31 AM from the events below. The reasons above are what Droplet flagged; if this summary disagrees with them, the reasons are right.")).toBeTruthy();
    expect(screen.getByRole("button", { name: NARRATIVE_COPY.regenerate })).toBeTruthy();
  });

  it("pending: Droplet is writing — with the previous text marked Updating when there is one", () => {
    const { rerender } = setup({ narrative: n({ state: "pending", text: null, writtenAt: null, model: null, promptVersion: null }) });
    expect(screen.getByText(NARRATIVE_COPY.writing)).toBeTruthy();
    expect(screen.queryByText(NARRATIVE_COPY.updating)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <NarrativeSection narrative={n({ state: "pending" })} grouping="closed" canAct paused={false} timezone="Europe/London" now={NOW} onSummarise={vi.fn()} refresh={vi.fn()} />,
    );
    expect(screen.getByText(NARRATIVE_COPY.writing)).toBeTruthy();
    expect(screen.getByText(NARRATIVE_COPY.updating)).toBeTruthy();
    expect(screen.getByText(TEXT)).toBeTruthy();
  });

  it("pending while the on-box model is paused: the one line that says so", () => {
    setup({ narrative: n({ state: "pending", text: null, writtenAt: null }), paused: true });
    expect(screen.getByText(NARRATIVE_COPY.paused)).toBeTruthy();
    expect(screen.queryByText(NARRATIVE_COPY.writing)).toBeNull();
  });

  it("none, still collecting: written when it ends — Summarise now at act", () => {
    setup({ narrative: n({ state: "none", text: null, writtenAt: null }), grouping: "collecting" });
    expect(screen.getByText(NARRATIVE_COPY.whenItEnds)).toBeTruthy();
    expect(screen.getByRole("button", { name: NARRATIVE_COPY.summariseNow })).toBeTruthy();
  });

  it("failed: couldn't write one — Regenerate at act", () => {
    setup({ narrative: n({ state: "failed", text: null, writtenAt: null }) });
    expect(screen.getByText(NARRATIVE_COPY.failed)).toBeTruthy();
    expect(screen.getByRole("button", { name: NARRATIVE_COPY.regenerate })).toBeTruthy();
  });

  it.each([
    ["narrative: null (the box's DS-005 answer)", null],
    ["expired", n({ state: "expired", text: null, writtenAt: null })],
    ["none once closed", n({ state: "none", text: null, writtenAt: null })],
  ])("%s → the section is not rendered at all", (_l, narrative) => {
    const { container } = setup({ narrative });
    expect(container.innerHTML).toBe("");
  });

  it("below act: no Regenerate and no Summarise now — never rendered and then refused", () => {
    setup({ canAct: false });
    expect(screen.queryByRole("button")).toBeNull();
    setup({ canAct: false, narrative: n({ state: "none", text: null, writtenAt: null }), grouping: "collecting" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("NarrativeSection — asking for a summary", () => {
  it("a 409 NARRATIVE_COOLDOWN is the typed toast, never the server's message", async () => {
    const { onSummarise } = setup();
    onSummarise.mockRejectedValueOnce(Object.assign(new Error("raw server text"), { code: "NARRATIVE_COOLDOWN", status: 409 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: NARRATIVE_COPY.regenerate }));
    });
    expect(toast).toHaveBeenCalledWith("Droplet wrote this in the last 10 minutes. Try again later.", "error");
    expect(JSON.stringify(toast.mock.calls)).not.toContain("raw server text");
  });

  it("a second press while one is in flight is refused; the button stays focusable (aria-disabled)", async () => {
    let release!: () => void;
    const { onSummarise } = setup();
    onSummarise.mockImplementationOnce(() => new Promise<undefined>((r) => (release = () => r(undefined))));
    const button = screen.getByRole("button", { name: NARRATIVE_COPY.regenerate });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSummarise).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => release());
  });

  it(`re-reads every ${NARRATIVE_POLL_MS / 1000} s while pending, and stops: once written, or after ${NARRATIVE_POLL_FOR_MS / 60_000} minutes`, async () => {
    vi.useFakeTimers({ now: NOW });
    const refresh = vi.fn();
    const onSummarise = vi.fn(async () => undefined);
    const props = { grouping: "closed" as const, canAct: true, paused: false, timezone: "Europe/London", now: NOW, onSummarise, refresh };
    const { rerender } = render(<NarrativeSection narrative={n({ state: "failed", text: null, writtenAt: null })} {...props} />);
    // Nothing polls before a request.
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: NARRATIVE_COPY.regenerate }));
    });
    rerender(<NarrativeSection narrative={n({ state: "pending", text: null, writtenAt: null })} {...props} />);
    await act(async () => vi.advanceTimersByTime(NARRATIVE_POLL_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(3);

    // Written: the re-reads stop.
    rerender(<NarrativeSection narrative={n()} {...props} />);
    await act(async () => vi.advanceTimersByTime(NARRATIVE_POLL_MS * 4));
    expect(refresh).toHaveBeenCalledTimes(3);

    // Asked again, and it never finishes: at most 2 minutes of re-reads.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: NARRATIVE_COPY.regenerate }));
    });
    rerender(<NarrativeSection narrative={n({ state: "pending" })} {...props} />);
    await act(async () => vi.advanceTimersByTime(NARRATIVE_POLL_FOR_MS + 30_000));
    const calls = refresh.mock.calls.length;
    expect(calls - 3).toBe(NARRATIVE_POLL_FOR_MS / NARRATIVE_POLL_MS);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(calls);
  });
});
