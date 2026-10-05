/**
 * Service desk email channel (ADR-069 §4, WARP-3529) — the two translations
 * between a ticket's HTML and an email's text.
 *
 *   outbound  `htmlToPlainText` — a public reply is written and stored as the PM
 *             allowlist's HTML (`sanitizePmHtml`) and sent as PLAIN TEXT, because
 *             the indexer's WARP-3267 ruling is that the box does not compose
 *             HTML. The text is derived from the SANITIZED HTML, never from what a
 *             client sent: the input is passed through the allowlist first, so
 *             this function only ever reads the dozen tags the allowlist keeps,
 *             in the well-formed, escaped shape the sanitizer writes them.
 *   inbound   `inboundBodyHtml` — a stranger's HTML or text becomes the same
 *             allowlist's HTML before it is stored, because the dashboard renders
 *             it with dangerouslySetInnerHTML. No tag outside the allowlist, no
 *             image (so no tracking pixel is ever fetched by a browser that opens
 *             a ticket), no `javascript:` link survives.
 */
import { sanitizePmHtml } from "../pm/sanitize-html.js";

/** `EmailDraft.body` is bounded to this by the mail routes; the desk refuses a
 *  reply that would need more, rather than send a customer half of one. */
export const PLAIN_TEXT_MAX = 64_000;

/** What one inbound message may store as a ticket description or comment. */
export const INBOUND_HTML_MAX = 100_000;
/** Characters of plain text kept when a message is shortened: sized so that even
 *  a body that is all `&` (written `&amp;`) stays inside {@link INBOUND_HTML_MAX}. */
const SHORTENED_TEXT_CHARS = 12_000;
const SHORTENED_NOTE = "<p>This message was shortened — the full text is in the mailbox.</p>";

// ── HTML -> text ─────────────────────────────────────────────────────────────

type Node =
  | { kind: "text"; text: string }
  | { kind: "el"; tag: string; href: string | null; children: Node[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the entities the sanitizer writes (and the numeric ones a parser may). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const VOID = new Set(["br"]);
const TOKEN = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
const HREF = /\shref="([^"]*)"/i;

/** Parse the sanitizer's output. Tolerant by construction: an unmatched close tag
 *  is ignored and unclosed ones are closed at the end. */
function parse(html: string): Node[] {
  const root: Node = { kind: "el", tag: "root", href: null, children: [] };
  const stack: Array<Extract<Node, { kind: "el" }>> = [root];
  for (const m of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      top.children.push({ kind: "text", text: decodeEntities(m[5]) });
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (closing) {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const href = HREF.exec(m[3] ?? "")?.[1];
    const el: Extract<Node, { kind: "el" }> = {
      kind: "el",
      tag,
      href: href === undefined ? null : decodeEntities(href),
      children: [],
    };
    top.children.push(el);
    if (!VOID.has(tag) && m[4] !== "/") stack.push(el);
  }
  return root.children;
}

const BLOCK = new Set(["p", "h1", "h2", "h3", "ul", "ol", "blockquote", "pre"]);

const rawText = (nodes: Node[]): string =>
  nodes.map((n) => (n.kind === "text" ? n.text : rawText(n.children))).join("");

function inline(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") {
      out += n.text.replace(/\s+/g, " ");
    } else if (n.tag === "br") {
      out = out.replace(/ +$/, "") + "\n";
    } else if (n.tag === "a") {
      const words = inline(n.children).trim();
      const href = n.href?.trim() ?? "";
      const same = href === words || href.replace(/^mailto:/i, "") === words;
      out += href && !same ? `${words || href} (${href})` : words || href;
    } else {
      out += inline(n.children);
    }
  }
  return out;
}

/** Lines of a block, every line prefixed. A blank line gets the bare prefix. */
function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => {
      const p = i === 0 ? first : rest;
      return line.length === 0 ? p.trimEnd() : p + line;
    })
    .join("\n");
}

function blocks(nodes: Node[], separator: string): string {
  const parts: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const text = inline(run)
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .trim();
    if (text) parts.push(text);
    run = [];
  };
  for (const n of nodes) {
    if (n.kind === "el" && BLOCK.has(n.tag)) {
      flush();
      const text = renderBlock(n);
      if (text) parts.push(text);
    } else {
      run.push(n);
    }
  }
  flush();
  return parts.join(separator);
}

function renderBlock(n: Extract<Node, { kind: "el" }>): string {
  switch (n.tag) {
    case "ul":
    case "ol": {
      const ordered = n.tag === "ol";
      const items = n.children.filter((c): c is Extract<Node, { kind: "el" }> => c.kind === "el" && c.tag === "li");
      return items
        .map((li, i) => {
          const body = blocks(li.children, "\n");
          const marker = ordered ? `${i + 1}. ` : "- ";
          return prefixLines(body, marker, " ".repeat(marker.length));
        })
        .join("\n");
    }
    case "blockquote":
      return prefixLines(blocks(n.children, "\n\n"), "> ", "> ");
    case "pre":
      return rawText(n.children).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    default:
      // p, h1-h3
      return blocks(n.children, "\n\n");
  }
}

/** The sanitized HTML of a reply as the plain text that is emailed. */
export function htmlToPlainText(html: string): string {
  const clean = sanitizePmHtml(html);
  return blocks(parse(clean), "\n\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── text -> HTML ─────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain multi-line text as the paragraphs the allowlist keeps: a blank line
 *  starts a paragraph, a single newline is a `<br>`, and every character a parser
 *  would take for markup is escaped first. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 0)
    .map((p) => `<p>${escapeHtml(p.trim()).split("\n").join("<br>")}</p>`)
    .join("");
}

// ── inbound ──────────────────────────────────────────────────────────────────

/**
 * A stored message body as the HTML a ticket keeps, or null when there is
 * nothing to show.
 *
 * The HTML part wins when it still says something after the allowlist has had
 * it; a message that is only an image, or only markup the allowlist drops, falls
 * back to its text part. A body too large for a comment is cut to its first few
 * thousand characters of text with a note saying so — never megabytes of a
 * stranger's HTML in a table the dashboard renders.
 */
export function inboundBodyHtml(bodyText: string | null, bodyHtml: string | null): string | null {
  const text = bodyText?.trim() ?? "";
  const fromHtml = bodyHtml ? sanitizePmHtml(bodyHtml).trim() : "";
  const htmlSaysSomething = fromHtml.length > 0 && htmlToPlainText(fromHtml).length > 0;

  let out = htmlSaysSomething ? fromHtml : text ? textToHtml(text) : "";
  if (out.length === 0) return null;

  if (out.length > INBOUND_HTML_MAX) {
    const plain = text || htmlToPlainText(out);
    const cut = plain.length > SHORTENED_TEXT_CHARS ? plain.slice(0, SHORTENED_TEXT_CHARS) : plain;
    // Never end on half a surrogate pair.
    const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    out = textToHtml(safe) + SHORTENED_NOTE;
  }
  return out;
}
