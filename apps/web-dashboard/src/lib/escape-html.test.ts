import { describe, it, expect } from "vitest";
import { escapeHtml } from "./escape-html";

/**
 * The shared escapeHtml (PR #684 finding 8 — extracted from detail.tsx and
 * modals.tsx so a future tightening is applied in exactly one place). It escapes
 * the structural HTML metacharacters the dashboard wraps user text with before
 * sending it to the server (which then sanitizes against the strict allowlist).
 */
describe("escapeHtml", () => {
  it("escapes &, <, and >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("neutralises a script tag so it cannot be parsed as markup", () => {
    expect(escapeHtml("<script>steal(1)</script>")).toBe(
      "&lt;script&gt;steal(1)&lt;/script&gt;",
    );
  });

  it("neutralises an inline on* event handler so it cannot fire", () => {
    // The `<` and `>` are escaped, so the browser never builds an <img>
    // element and the onerror= attribute can never run.
    expect(escapeHtml('<img src=x onerror=steal()>')).toBe(
      "&lt;img src=x onerror=steal()&gt;",
    );
  });

  it("neutralises a javascript: scheme anchor so the tag cannot be built", () => {
    // Escaping the angle brackets means the javascript: href is inert text,
    // never an <a> the browser will navigate.
    expect(escapeHtml('<a href="javascript:steal()">x</a>')).toBe(
      "&lt;a href=\"javascript:steal()\"&gt;x&lt;/a&gt;",
    );
  });

  it("escapes ampersands first so existing entities are not double-mangled into markup", () => {
    // & must be escaped before < / > so the output never reintroduces a tag.
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
  });

  it("leaves newlines intact (the modal converts them to <br> after escaping)", () => {
    expect(escapeHtml("line1\nline2")).toBe("line1\nline2");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});
