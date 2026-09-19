/**
 * WARP-2339 — upstream #221's pagination lie.
 *
 * The fixture below is the shape the issue describes verbatim: five nodes,
 * `hasNextPage: false`, `endCursor: null`, and a non-zero `remainingCount`.
 * Nothing here dials.
 */
import { describe, it, expect } from "vitest";
import {
  assertNotTruncated,
  ATLASSIAN_SEARCH_NODE_CAP,
  TruncatedResultError,
} from "../src/truncation.js";
import type { RemoteToolCallOutcome } from "../src/remote-session.js";

const TOOL = "searchJiraIssuesUsingJql";

function nodes(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ key: `FAKE-${i + 1}` }));
}

/** The defect: a capped page that claims to be the last one. */
function truncatedPage(remaining = 240): Record<string, unknown> {
  return {
    nodes: nodes(ATLASSIAN_SEARCH_NODE_CAP),
    pageInfo: { hasNextPage: false, endCursor: null },
    remainingCount: remaining,
  };
}

function outcome(structured: unknown, text?: string): RemoteToolCallOutcome {
  return {
    content: text === undefined ? [] : [{ type: "text", text }],
    isError: false,
    structuredContent: structured,
  };
}

describe("the truncation guard", () => {
  it("raises TruncatedResultError on the exact #221 shape", () => {
    const err = catchError(() => assertNotTruncated(TOOL, outcome(truncatedPage())));
    expect(err).toBeInstanceOf(TruncatedResultError);
    const t = err as TruncatedResultError;
    expect(t.code).toBe("REMOTE_RESULT_TRUNCATED");
    expect(t.returned).toBe(5);
    expect(t.remaining).toBe(240);
  });

  it("keeps the partial payload on the error, so five of 245 is renderable", () => {
    // Failing without the rows would trade one wrong answer for a lost one.
    const page = outcome(truncatedPage());
    const err = catchError(() => assertNotTruncated(TOOL, page)) as TruncatedResultError;
    expect(err.partial).toBe(page);
  });

  it("says the result is not the whole answer, in words a model will not average away", () => {
    const err = catchError(() =>
      assertNotTruncated(TOOL, outcome(truncatedPage())),
    ) as TruncatedResultError;
    expect(err.message).toContain("NOT the whole answer");
    expect(err.message).toContain("#221");
  });

  it("finds the page in a TEXT block when structuredContent was withheld (#213)", () => {
    // The two upstream defects compound: a client whose name the server does
    // not recognise gets no structuredContent, so a guard that only read that
    // field would be blind exactly when the response is already degraded.
    const err = catchError(() =>
      assertNotTruncated(TOOL, outcome(undefined, JSON.stringify(truncatedPage()))),
    );
    expect(err).toBeInstanceOf(TruncatedResultError);
  });

  it("reads a FLAT page object as well as the nested pageInfo shape", () => {
    const flat = { hasNextPage: false, endCursor: null, remainingCount: 7, nodes: nodes(5) };
    expect(() => assertNotTruncated(TOOL, outcome(flat))).toThrow(TruncatedResultError);
  });
});

describe("what the guard must NOT refuse", () => {
  it("passes an honest complete page — remainingCount 0", () => {
    const complete = {
      nodes: nodes(5),
      pageInfo: { hasNextPage: false, endCursor: null },
      remainingCount: 0,
    };
    expect(() => assertNotTruncated(TOOL, outcome(complete))).not.toThrow();
  });

  it("passes a genuine 5-result search — the CAP is not the trigger", () => {
    // A real five-issue project would be refused forever if the node count
    // were the evidence. remainingCount is the field the defect leaves honest.
    const five = { nodes: nodes(5), pageInfo: { hasNextPage: false, endCursor: null } };
    expect(() => assertNotTruncated(TOOL, outcome(five))).not.toThrow();
  });

  it("passes an HONESTLY paginating page — hasNextPage true with a cursor", () => {
    const honest = {
      nodes: nodes(5),
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      remainingCount: 240,
    };
    expect(() => assertNotTruncated(TOOL, outcome(honest))).not.toThrow();
  });

  it("passes a prose result with no page at all", () => {
    expect(() =>
      assertNotTruncated("atlassianUserInfo", outcome(undefined, "Ada Fake, Engineering")),
    ).not.toThrow();
  });

  it("passes an isError result — a failed call has no page to be honest about", () => {
    const failed: RemoteToolCallOutcome = {
      content: [{ type: "text", text: JSON.stringify(truncatedPage()) }],
      isError: true,
    };
    expect(() => assertNotTruncated(TOOL, failed)).not.toThrow();
  });

  it("ignores a non-numeric remainingCount rather than guessing at it", () => {
    const odd = { nodes: nodes(5), pageInfo: { hasNextPage: false }, remainingCount: "lots" };
    expect(() => assertNotTruncated(TOOL, outcome(odd))).not.toThrow();
  });
});

function catchError(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}
