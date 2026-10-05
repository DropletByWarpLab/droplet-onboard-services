/**
 * WARP-3522 — the deep-link contract of the single `/projects` route.
 *
 *   /projects?p=<IDENTIFIER>&view=<tab>&item=<KEY-123>&v=<savedViewId>&f=<filter>
 *
 * The dashboard reads and writes its state through these two functions, and
 * the orchestrator builds notification links with the third, so the parameter
 * names exist in exactly one place.
 */
import { describe, it, expect } from "vitest";
import {
  PM_PROJECTS_PATH,
  buildPmPath,
  parsePmUrl,
  parseWorkItemKey,
  pmWorkItemPath,
} from "./pm-links";
import { parsePmFilter, serializePmFilter } from "./pm-filter";

const search = (path: string): URLSearchParams => new URL(path, "http://box.local").searchParams;

describe("buildPmPath", () => {
  it("is the bare route when there is no state", () => {
    expect(buildPmPath({})).toBe(PM_PROJECTS_PATH);
    expect(buildPmPath({ p: null, view: null, item: null, v: null, f: null })).toBe("/projects");
    expect(buildPmPath({ p: "", view: "", item: "", v: "" })).toBe("/projects");
  });

  it("writes an EMPTY filter, because 'no filter on this view' is not 'the view's filter'", () => {
    expect(buildPmPath({ p: "INBOX", v: "mine", f: "" })).toBe("/projects?p=INBOX&v=mine&f=");
    expect(buildPmPath({ f: "" })).toBe("/projects?f=");
  });

  it("writes the parameters in a fixed order", () => {
    expect(buildPmPath({ f: "priority.is:high", item: "INBOX-42", v: "mine", view: "list", p: "INBOX" })).toBe(
      "/projects?p=INBOX&view=list&item=INBOX-42&v=mine&f=priority.is:high",
    );
  });

  it("leaves a compact filter readable instead of percent-encoding its delimiters", () => {
    const f = serializePmFilter({
      and: [
        { field: "assignee", op: "is", value: "me" },
        { field: "priority", op: "in", value: ["urgent", "high"] },
      ],
    });
    expect(buildPmPath({ p: "INBOX", f })).toBe("/projects?p=INBOX&f=assignee.is:me,priority.in:urgent;high");
  });

  it("encodes a value that would otherwise inject a parameter", () => {
    const path = buildPmPath({ p: "A&view=board", item: "X#frag" });
    const sp = search(path);
    expect([...sp.keys()].sort()).toEqual(["item", "p"]);
    expect(sp.get("p")).toBe("A&view=board");
    expect(sp.get("item")).toBe("X#frag");
  });
});

describe("parsePmUrl", () => {
  it.each(["calendar", "timeline", "my-work"])("round-trips the %s schedule view", (view) => {
    const state = { p: null, view, item: null, v: null, f: null };
    expect(parsePmUrl(search(buildPmPath(state)))).toEqual(state);
  });

  it.each(["-my-work", "my-work-", "my--work", "my-work/../x", "My-work", "any-other-tab"])(
    "rejects malformed or unrecognised hyphenated view %j", (view) => {
      expect(parsePmUrl(new URLSearchParams({ view })).view).toBeNull();
    },
  );

  it("reads every parameter", () => {
    const sp = new URLSearchParams("p=INBOX&view=list&item=INBOX-42&v=mine&f=priority.is%3Ahigh");
    expect(parsePmUrl(sp)).toEqual({
      p: "INBOX",
      view: "list",
      item: "INBOX-42",
      v: "mine",
      f: "priority.is:high",
    });
  });

  it("tells an empty `f=` from an absent one", () => {
    expect(parsePmUrl(new URLSearchParams("p=INBOX&f=")).f).toBe("");
    expect(parsePmUrl(new URLSearchParams("p=INBOX")).f).toBeNull();
    expect(parsePmUrl(search(buildPmPath({ p: "INBOX", f: "" }))).f).toBe("");
  });

  it("reports an absent parameter as null", () => {
    expect(parsePmUrl(new URLSearchParams(""))).toEqual({ p: null, view: null, item: null, v: null, f: null });
  });

  it("accepts any {get(name)} reader (next/navigation's ReadonlyURLSearchParams)", () => {
    const bag: Record<string, string> = { p: "INBOX" };
    expect(parsePmUrl({ get: (k: string) => bag[k] ?? null }).p).toBe("INBOX");
  });

  it("drops a value that cannot be what its parameter holds", () => {
    const state = parsePmUrl(
      new URLSearchParams({ p: "not an identifier", view: "../x", item: "nope", v: "a b", f: "x".repeat(5000) }),
    );
    expect(state).toEqual({ p: null, view: null, item: null, v: null, f: null });
  });

  it("round-trips through buildPmPath", () => {
    const f = serializePmFilter({
      and: [
        { field: "text", op: "contains", value: "a b,c" },
        { field: "dueDate", op: "before", value: "+14d" },
      ],
    });
    const state = { p: "INBOX", view: "board", item: "INBOX-7", v: "3f2b8c1e-9a44-4d3b-8f10-2a6c1b7d9e01", f };
    const back = parsePmUrl(search(buildPmPath(state)));
    expect(back).toEqual(state);
    expect(parsePmFilter(back.f!)).toEqual(parsePmFilter(f));
  });
});

describe("work-item keys", () => {
  it("parses INBOX-42", () => {
    expect(parseWorkItemKey("INBOX-42")).toEqual({ identifier: "INBOX", sequenceId: 42 });
    expect(parseWorkItemKey("a1-7")).toEqual({ identifier: "a1", sequenceId: 7 });
  });
  it.each(["", "INBOX", "INBOX-", "-42", "INBOX-0x2", "INBOX-4 2", "WAYTOOLONGKEY-1", "IN BOX-1", "INBOX-1234567890"])(
    "refuses %j",
    (s) => {
      expect(parseWorkItemKey(s)).toBeNull();
    },
  );

  it("builds the link a notification carries", () => {
    expect(pmWorkItemPath("INBOX", "INBOX-42")).toBe("/projects?p=INBOX&item=INBOX-42");
  });
});
