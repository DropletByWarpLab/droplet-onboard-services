import { describe, expect, it } from "vitest";
import { htmlToText } from "./pm-export.service.js";

describe("plain-text project export", () => {
  it.each(["<script", "<script src=x", "hello <img src=x onerror=alert(1)", "<b><script"])("removes an unterminated HTML tag: %s", (html) => {
    expect(htmlToText(html)).not.toContain("<");
  });

  it("preserves paragraph and list boundaries", () => {
    expect(htmlToText("<p>Intro<br>Next</p><ul><li>One</li><li>Two</li></ul>")).toBe("Intro\nNext\n\n- One\n- Two");
  });

  it("keeps encoded angle brackets as literal text", () => {
    expect(htmlToText("<p>Use &lt;name&gt; &amp; &quot;title&quot;</p>")).toBe('Use <name> & "title"');
  });
});
