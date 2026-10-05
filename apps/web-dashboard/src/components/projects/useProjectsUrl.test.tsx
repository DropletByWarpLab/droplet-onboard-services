// WARP-3522 — the /projects page's state is its URL. This pins how the hook
// reads it and how it writes it back: PUSH for navigation (a project, a tab, an
// item), REPLACE for editing (a filter, a saved view), no navigation when
// nothing changed, and Back — not a second entry — when the drawer that THIS
// page pushed is closed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

let search = "";
const push = vi.fn();
const replace = vi.fn();
const back = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push, replace, back }),
}));

import { useProjectsUrl } from "./useProjectsUrl";

beforeEach(() => {
  search = "";
  push.mockClear();
  replace.mockClear();
  back.mockClear();
  window.history.replaceState(null, "", "/projects");
});

describe("reading the URL", () => {
  it("is the empty state at a bare /projects", () => {
    const { result } = renderHook(() => useProjectsUrl());
    expect(result.current.state).toEqual({ p: null, view: null, item: null, v: null, f: null });
  });

  it("reads every parameter", () => {
    search = "p=INBOX&view=list&item=INBOX-42&v=mine&f=priority.is%3Ahigh";
    const { result } = renderHook(() => useProjectsUrl());
    expect(result.current.state).toEqual({
      p: "INBOX",
      view: "list",
      item: "INBOX-42",
      v: "mine",
      f: "priority.is:high",
    });
  });

  it("drops what the contract rejects instead of acting on it", () => {
    search = "p=not%20valid&item=nope&view=BOARD&v=a%20b";
    const { result } = renderHook(() => useProjectsUrl());
    expect(result.current.state).toEqual({ p: null, view: null, item: null, v: null, f: null });
  });

  it("tells an empty filter (the view with its filter cleared) from no filter", () => {
    search = "p=INBOX&v=mine&f=";
    const { result } = renderHook(() => useProjectsUrl());
    expect(result.current.state.f).toBe("");
  });
});

describe("writing it", () => {
  it("keeps unowned query parameters and the anchor through Insights navigation", () => {
    search = "keep=1&keep=2&view=BOARD&p=not%20valid";
    window.history.replaceState(null, "", `/projects?${search}#overview`);
    const { result, rerender } = renderHook(() => useProjectsUrl());
    result.current.go({ view: "insights" }, "push");
    expect(push).toHaveBeenCalledWith("/projects?view=insights&keep=1&keep=2#overview", { scroll: false });
    search = "view=insights&keep=1&keep=2";
    rerender();
    result.current.go({ p: null, view: null, item: null, v: null, f: null }, "push");
    expect(push).toHaveBeenLastCalledWith("/projects?keep=1&keep=2#overview", { scroll: false });
  });

  it("opens My work through a URL that the hook can read back", () => {
    const { result, rerender } = renderHook(() => useProjectsUrl());
    result.current.go({ view: "my-work" }, "push");
    expect(push).toHaveBeenCalledWith("/projects?view=my-work", { scroll: false });
    search = "view=my-work";
    rerender();
    expect(result.current.state.view).toBe("my-work");
  });

  it("pushes a navigation and does not scroll the page", () => {
    search = "p=INBOX";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.go({ view: "list" }, "push");
    expect(push).toHaveBeenCalledWith("/projects?p=INBOX&view=list", { scroll: false });
    expect(replace).not.toHaveBeenCalled();
  });

  it("replaces an edit", () => {
    search = "p=INBOX&v=mine";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.go({ f: "priority.is:high" }, "replace");
    expect(replace).toHaveBeenCalledWith("/projects?p=INBOX&v=mine&f=priority.is:high", { scroll: false });
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps what it was not asked to change, and removes what it is told to", () => {
    search = "p=INBOX&view=list&v=mine&f=priority.is%3Ahigh&item=INBOX-1";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.go({ v: null, f: null }, "replace");
    expect(replace).toHaveBeenCalledWith("/projects?p=INBOX&view=list&item=INBOX-1", { scroll: false });
  });

  it("writes an empty filter as `f=`", () => {
    search = "p=INBOX&v=mine";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.go({ f: "" }, "replace");
    expect(replace).toHaveBeenCalledWith("/projects?p=INBOX&v=mine&f=", { scroll: false });
  });

  it("does nothing when the URL would not change", () => {
    search = "p=INBOX&view=list";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.go({ view: "list" }, "push");
    result.current.go({}, "replace");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("leaves the project for the index in one navigation", () => {
    search = "p=INBOX&view=list&v=mine&f=x.y&item=INBOX-1".replace("f=x.y", "f=priority.is%3Ahigh");
    const { result } = renderHook(() => useProjectsUrl());
    result.current.go({ p: null, view: null, v: null, f: null, item: null }, "push");
    expect(push).toHaveBeenCalledWith("/projects", { scroll: false });
  });
});

describe("the drawer", () => {
  it("opening an item pushes it", () => {
    search = "p=INBOX";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.openItem("INBOX-7");
    expect(push).toHaveBeenCalledWith("/projects?p=INBOX&item=INBOX-7", { scroll: false });
  });

  it("closing a drawer THIS page opened goes Back, so the entry it added is the one it removes", () => {
    search = "p=INBOX";
    const { result, rerender } = renderHook(() => useProjectsUrl());
    result.current.openItem("INBOX-7");
    search = "p=INBOX&item=INBOX-7"; // the push landed
    rerender();
    result.current.closeItem();
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("closing a drawer that arrived in the link replaces — Back from there would leave the app", () => {
    search = "p=INBOX&item=INBOX-7";
    const { result } = renderHook(() => useProjectsUrl());
    result.current.closeItem();
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false });
  });

  it("forgets it pushed once the item is gone from the URL (the user pressed Back themselves)", () => {
    search = "p=INBOX";
    const { result, rerender } = renderHook(() => useProjectsUrl());
    result.current.openItem("INBOX-7");
    search = "p=INBOX&item=INBOX-7";
    rerender();
    search = "p=INBOX"; // the browser's Back button closed it
    rerender();
    // Later a link opens an item directly; closing it must not call back().
    search = "p=INBOX&item=INBOX-9";
    rerender();
    result.current.closeItem();
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false });
  });
});
