import { describe, expect, it } from "vitest";
import { cleanHtml } from "./ticket.service.js";

describe("Support ticket HTML write boundary", () => {
  it("keeps allowed formatting while removing executable tags, attributes and URLs", () => {
    const html = cleanHtml('<p onclick="alert(1)"><strong>Support details</strong><script>secretPayload()</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">bad link</a><a href="https://example.com">reference</a></p>');
    expect(html).toContain("<strong>Support details</strong>");
    expect(html).toContain('<a href="https://example.com">reference</a>');
    expect(html).not.toMatch(/script|secretPayload|onclick|onerror|javascript:|<img/);
  });

  it("normalizes missing or empty descriptions to null", () => {
    expect(cleanHtml(undefined)).toBeNull();
    expect(cleanHtml(null)).toBeNull();
    expect(cleanHtml("   ")).toBeNull();
  });
});
