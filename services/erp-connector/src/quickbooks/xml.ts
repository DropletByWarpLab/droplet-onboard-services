/**
 * WARP-2108 — a deliberately small XML reader for qbXML responses.
 *
 * ## Why hand-rolled
 *
 * `@droplet/erp-connector` has ZERO runtime dependencies, and that is a
 * property worth keeping: this package is loaded by the orchestrator, which is
 * the process holding a practice's PHI. The export-drop track wrote its own
 * delimited reader for the same reason. This is that decision applied again,
 * not a new one.
 *
 * It is scoped to what qbXML actually is — elements, text, a handful of
 * attributes, no namespaces, no mixed content worth preserving — and it refuses
 * everything else rather than half-supporting it. A parser that quietly does
 * the wrong thing with input it does not understand is worse than one that
 * stops.
 *
 * ## Why this file is security-relevant
 *
 * This parses bytes posted by a machine on the practice LAN. It is the first
 * inbound, attacker-adjacent parser in this package, so the classic XML attacks
 * are refused structurally rather than mitigated:
 *
 *  * **No DOCTYPE, ever.** Refused outright, which kills external-entity (XXE)
 *    file reads and billion-laughs expansion in one rule, because both need a
 *    DTD to declare the entity. Not "entities are not expanded" — the document
 *    is rejected, so there is nothing to get subtly wrong later.
 *  * **No external anything.** Only the five predefined entities and numeric
 *    character references are decoded. An undeclared `&foo;` is an error, not a
 *    silent passthrough that a consumer might later re-interpret.
 *  * **Bounded.** Depth, total size and element count all have ceilings, so a
 *    hostile or merely enormous document cannot exhaust memory in the
 *    orchestrator.
 *
 * PURE: no I/O, no clock.
 */

/** Thrown for any document this reader will not process. */
export class XmlError extends Error {
  readonly code = "XML_PARSE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text content, entity-decoded and trimmed. */
  text: string;
}

export interface XmlLimits {
  maxBytes: number;
  maxDepth: number;
  maxElements: number;
  /**
   * Total attributes across the document.
   *
   * Separate from `maxElements` because attributes sat outside every ceiling
   * this reader advertised: one element can carry hundreds of thousands of
   * them, counting as a single element while amplifying the document
   * manyfold in heap. A ceiling on elements is not a ceiling on memory.
   */
  maxAttributes: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  // A qbXML response for a large company's invoice list is the big case; 64 MiB
  // matches the export-drop per-file ceiling so both inbound paths bound the
  // same way.
  maxBytes: 64 * 1024 * 1024,
  // qbXML nests perhaps six deep. 64 is far past anything legitimate and far
  // short of a stack problem.
  maxDepth: 64,
  maxElements: 2_000_000,
  // qbXML uses a handful per response (requestID, statusCode, statusSeverity).
  // Far past anything legitimate, far short of a memory problem.
  maxAttributes: 100_000,
};

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the five predefined entities and numeric character references.
 *
 * An UNDECLARED entity is an error rather than a passthrough. Leaving `&foo;`
 * in the output looks harmless until a consumer re-encodes or re-parses it, and
 * this reader's whole posture is that unrecognised input stops rather than
 * travels.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (_m, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new XmlError(`invalid character reference "&${body};"`);
      }
      // Surrogate halves are not characters; allowing them lets a document
      // smuggle a lone surrogate into a JS string that then fails to serialize.
      if (code >= 0xd800 && code <= 0xdfff) {
        throw new XmlError(`invalid surrogate character reference "&${body};"`);
      }
      return String.fromCodePoint(code);
    }
    const named = PREDEFINED[body];
    if (named === undefined) {
      throw new XmlError(
        `undeclared entity "&${body};" — only the five predefined entities are supported`,
      );
    }
    return named;
  });
}

/**
 * Scan `name="value"` pairs out of a tag body, linearly.
 *
 * Returns how many attributes were read. Deliberately strict: a malformed
 * pair is an error rather than something skipped, because this reader's
 * posture is that unrecognised input stops instead of travelling. The regex
 * this replaces silently ignored anything it could not match, which is how a
 * dropped attribute went unnoticed.
 *
 * The document-wide attribute ceiling is enforced HERE, inside the loop,
 * before each attribute is scanned; `consumed` carries what earlier elements
 * already used, so the cap stays a property of the document rather than of
 * one element. Checked only at the call site, after this function returned,
 * the ceiling was a fence around a field that had already burned: one element
 * carrying millions of attributes was fully walked, entity-decoded and
 * materialized before the count was ever read — seconds of event-loop stall
 * and over a GiB of heap from a single posted envelope, the same denial of
 * service the linear scanner itself was written to close.
 */
function scanAttributes(
  body: string,
  from: number,
  out: Record<string, string>,
  consumed: number,
  maxAttributes: number,
  fail: (msg: string) => never,
): number {
  let k = from;
  let count = 0;
  const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

  while (k < body.length) {
    while (k < body.length && isSpace(body[k])) k += 1;
    if (k >= body.length) break;

    // Something non-space follows: another attribute is about to be scanned.
    // Refuse now if it would take the document past the ceiling, so the work
    // done is bounded by the limit rather than by the input.
    if (consumed + count >= maxAttributes) {
      throw new XmlError(`document exceeds the ${maxAttributes}-attribute ceiling`);
    }

    if (!/[A-Za-z_]/.test(body[k])) {
      fail(`unexpected "${body[k]}" where an attribute name was expected`);
    }
    const nameStart = k;
    while (k < body.length && /[\w.:-]/.test(body[k])) k += 1;
    const name = body.slice(nameStart, k);

    while (k < body.length && isSpace(body[k])) k += 1;
    if (body[k] !== "=") fail(`attribute "${name}" has no value`);
    k += 1;
    while (k < body.length && isSpace(body[k])) k += 1;

    const quote = body[k];
    if (quote !== '"' && quote !== "'") {
      fail(`attribute "${name}" value is not quoted`);
    }
    k += 1;
    const valueStart = k;
    while (k < body.length && body[k] !== quote) k += 1;
    if (k >= body.length) fail(`attribute "${name}" value is unterminated`);
    out[name] = decodeEntities(body.slice(valueStart, k));
    k += 1;
    count += 1;
  }
  return count;
}

/**
 * Parse an XML document into a single root element.
 *
 * Comments, the XML declaration and processing instructions (qbXML uses
 * `<?qbxml version="13.0"?>`) are skipped. A DOCTYPE is refused. Everything
 * else that is not a well-formed element is an error.
 */
export function parseXml(source: string, limits: Partial<XmlLimits> = {}): XmlElement {
  const lim = { ...DEFAULT_XML_LIMITS, ...limits };

  // Measured in UTF-8 bytes, which is what the option's name promises and
  // what the export track's per-file ceiling (deliberately mirrored here)
  // measures. `.length` counted UTF-16 code units and let a document up to
  // three times the ceiling through.
  if (Buffer.byteLength(source, "utf8") > lim.maxBytes) {
    throw new XmlError(`document exceeds the ${lim.maxBytes}-byte ceiling`);
  }
  // Checked on the raw source before any scanning: the point is that a DTD is
  // never processed at all, not that its effects are neutralised afterwards.
  if (/<!DOCTYPE/i.test(source)) {
    throw new XmlError(
      "DOCTYPE is refused — external entities and entity expansion are not supported",
    );
  }

  let i = 0;
  let elements = 0;
  let attrCount = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const fail = (msg: string): never => {
    throw new XmlError(`${msg} at offset ${i}`);
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);

    if (lt === -1) {
      // Trailing text after the root element. Only whitespace is acceptable.
      if (source.slice(i).trim() !== "") fail("text outside the root element");
      break;
    }

    // Text between elements belongs to the innermost open element.
    //
    // Entities are decoded HERE, per text run, rather than once over the
    // accumulated text at the closing tag. Decoding late also decoded whatever
    // arrived through CDATA, which is precisely the content CDATA exists to
    // keep literal — a customer name written `<![CDATA[Smith &amp; Sons]]>`
    // came back as "Smith & Sons". A text run cannot span a `<`, and an entity
    // cannot contain one, so per-run decoding is complete.
    if (lt > i) {
      const chunk = source.slice(i, lt);
      const open = stack[stack.length - 1];
      if (open) open.text += decodeEntities(chunk);
      else if (chunk.trim() !== "") fail("text outside the root element");
    }
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
      continue;
    }

    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end === -1) fail("unterminated CDATA");
      const open = stack[stack.length - 1];
      // CDATA is literal by definition — entities inside it are NOT decoded,
      // which is the whole reason a report writer would use it for a customer
      // name containing an ampersand.
      if (open) open.text += source.slice(i + 9, end);
      i = end + 3;
      continue;
    }

    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }

    // Find the tag's end by scanning, tracking quote state.
    //
    // `indexOf(">")` was wrong twice over. A raw `>` inside an attribute
    // value is LEGAL XML — only `<` and `&` must be escaped there — and it
    // truncated the tag at the wrong offset, after which the attribute was
    // silently dropped rather than refused. Quote-aware scanning ends the tag
    // where the tag actually ends.
    let gt = -1;
    let quote = "";
    for (let j = i + 1; j < source.length; j += 1) {
      const ch = source[j];
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ">") {
        gt = j;
        break;
      }
    }
    if (gt === -1) fail("unterminated tag");

    // Closing tag.
    if (source[i + 1] === "/") {
      const name = source.slice(i + 2, gt).trim();
      const open = stack.pop();
      if (!open) fail(`closing tag </${name}> with no open element`);
      if (open!.name !== name) fail(`closing tag </${name}> does not match <${open!.name}>`);
      open!.text = open!.text.trim();
      i = gt + 1;
      continue;
    }

    // Opening (or self-closing) tag.
    const selfClosing = source[gt - 1] === "/";
    const body = source.slice(i + 1, selfClosing ? gt - 1 : gt).trim();
    if (body === "") fail("empty tag");

    const spaceAt = body.search(/\s/);
    const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) fail(`invalid element name "${name}"`);

    elements += 1;
    if (elements > lim.maxElements) {
      throw new XmlError(`document exceeds the ${lim.maxElements}-element ceiling`);
    }

    const attributes: Record<string, string> = {};
    if (spaceAt !== -1) {
      // ⚠ Parsed with a LINEAR scanner, deliberately not a regex.
      //
      // The regex this replaces backtracked quadratically on a tag body
      // holding a long run of word characters with no `=`. A syntactically
      // valid qbXML envelope carrying a few tens of kilobytes of that blocks
      // the orchestrator's event loop for minutes; a little more and it does
      // not finish. That is a remote denial of service from a machine on the
      // practice LAN, and it was the one XML attack class this file's
      // "Bounded" docblock did not actually stop.
      //
      // A hand-written scanner is O(n) with no backtracking at all — a
      // property of the algorithm rather than of the input.
      //
      // The attribute ceiling is enforced INSIDE the scan, not on its return
      // value: the running document-wide count goes in, and the scanner
      // throws before processing the attribute that would exceed the cap.
      attrCount += scanAttributes(body, spaceAt, attributes, attrCount, lim.maxAttributes, fail);
    }

    const el: XmlElement = { name, attributes, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) fail("more than one root element");
    else root = el;

    if (!selfClosing) {
      stack.push(el);
      if (stack.length > lim.maxDepth) {
        throw new XmlError(`document exceeds the ${lim.maxDepth}-level depth ceiling`);
      }
    }
    i = gt + 1;
  }

  if (stack.length > 0) throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) throw new XmlError("document has no root element");
  return root;
}

/** Direct children with this name. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** First direct child with this name, or undefined. */
export function childNamed(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** Text of the first matching descendant on a dotted path, or undefined.
 *  Undefined rather than "" so an absent field stays distinguishable from an
 *  empty one — the same rule the export track applies to a blank cell. */
export function textAt(el: XmlElement, path: string): string | undefined {
  let node: XmlElement | undefined = el;
  for (const part of path.split(".")) {
    node = node ? childNamed(node, part) : undefined;
    if (!node) return undefined;
  }
  return node.text === "" ? undefined : node.text;
}

/** Escape text for inclusion in an XML document we generate. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}
