/**
 * WARP-2108 — QuickBooks Desktop: the XML reader, the qbXML contract, the Web
 * Connector session, and the connector that serves from it.
 *
 * Two clusters carry most of the weight, and both are about things that must
 * NOT happen:
 *
 *  * The XML reader is the first inbound, attacker-adjacent parser in this
 *    package. Its refusals are the security property, so they are tested as
 *    behaviour rather than assumed from the absence of a feature.
 *  * A session is atomic. A run that dies halfway must leave the previous
 *    snapshot exactly as it was, because half a payables ledger is a
 *    confidently-wrong, smaller number for what a practice owes.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import { XmlError, decodeEntities, parseXml, textAt } from "../src/quickbooks/xml.js";
import {
  QBXML_VERSION,
  QbxmlStatusError,
  buildRequest,
  parseResponse,
} from "../src/quickbooks/qbxml.js";
import {
  QBD_DATASETS,
  QbdSnapshotStore,
  QbwcSession,
  QuickBooksDesktopConnector,
} from "../src/quickbooks/desktop-connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
const CREDS = { username: "droplet", password: "correct-horse-battery-staple" };

const INVOICE_RS = `<?xml version="1.0"?><?qbxml version="13.0"?>
<QBXML><QBXMLMsgsRs>
  <InvoiceQueryRs requestID="1" statusCode="0" statusSeverity="Info">
    <InvoiceRet>
      <TxnID>A1</TxnID><RefNumber>INV-1001</RefNumber>
      <TxnDate>2026-07-01</TxnDate><DueDate>2026-07-31</DueDate>
      <CustomerRef><ListID>80000001</ListID><FullName>Northside Clinic</FullName></CustomerRef>
      <Subtotal>1200.00</Subtotal><BalanceRemaining>1200.00</BalanceRemaining>
    </InvoiceRet>
    <InvoiceRet>
      <TxnID>A2</TxnID><RefNumber>INV-0999</RefNumber>
      <TxnDate>2026-06-02</TxnDate><DueDate>2026-07-02</DueDate>
      <CustomerRef><ListID>80000001</ListID><FullName>Northside Clinic</FullName></CustomerRef>
      <Subtotal>500.00</Subtotal><BalanceRemaining>0.00</BalanceRemaining>
    </InvoiceRet>
  </InvoiceQueryRs>
</QBXMLMsgsRs></QBXML>`;

// Three OPEN bills across TWO vendors, listed out of due-date order.
//
// Both properties are deliberate and were absent before. With two bills from
// two vendors, `vendor_count` was pinned to the literal 2 by three different
// wrong formulas (bills.length, vendors.size, even invoices.length), so the
// mutation the aggregate test named could not turn it red. And the bills were
// already in due-date order, so the ordering test could not tell a sorted
// result from ingest order.
const BILL_RS = `<?xml version="1.0"?><?qbxml version="13.0"?>
<QBXML><QBXMLMsgsRs>
  <BillQueryRs requestID="2" statusCode="0" statusSeverity="Info">
    <BillRet>
      <TxnID>B2</TxnID><RefNumber>BILL-78</RefNumber>
      <TxnDate>2026-07-20</TxnDate><DueDate>2026-08-19</DueDate>
      <VendorRef><ListID>90000002</ListID><FullName>Patterson Dental</FullName></VendorRef>
      <AmountDue>1000.00</AmountDue><OpenAmount>850.25</OpenAmount></BillRet>
    <BillRet>
      <TxnID>B1</TxnID><RefNumber>BILL-77</RefNumber>
      <TxnDate>2026-07-05</TxnDate><DueDate>2026-08-04</DueDate>
      <VendorRef><ListID>90000001</ListID><FullName>Henry Schein</FullName></VendorRef>
      <AmountDue>2000.00</AmountDue><OpenAmount>2000.00</OpenAmount></BillRet>
    <BillRet>
      <TxnID>B3</TxnID><RefNumber>BILL-79</RefNumber>
      <TxnDate>2026-07-21</TxnDate><DueDate>2026-08-20</DueDate>
      <VendorRef><ListID>90000001</ListID><FullName>Henry Schein</FullName></VendorRef>
      <AmountDue>300.00</AmountDue><OpenAmount>300.00</OpenAmount></BillRet>
  </BillQueryRs>
</QBXMLMsgsRs></QBXML>`;

/** Drive a whole session to completion. */
function runSession(store: QbdSnapshotStore, responses: string[], now = () => NOW) {
  const s = new QbwcSession(CREDS, store, { now, newTicket: () => "TICKET" });
  const [ticket] = s.authenticate(CREDS.username, CREDS.password);
  const progress: number[] = [];
  for (const body of responses) {
    s.sendRequestXML(ticket);
    progress.push(s.receiveResponseXML(ticket, body));
  }
  return { session: s, ticket, progress };
}

// ── the XML reader is a security boundary ───────────────────────────────────

describe("the XML reader refuses what it does not understand", () => {
  it("refuses DOCTYPE outright — XXE and billion-laughs in one rule", () => {
    // THE security test. Both attacks need a DTD to declare an entity, so the
    // document is rejected rather than the effects being mitigated afterwards.
    // Mutation: drop the DOCTYPE check → both cases parse → red.
    const xxe =
      `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><QBXML>&xxe;</QBXML>`;
    const lol =
      `<!DOCTYPE lolz [<!ENTITY lol "haha"><!ENTITY lol2 "&lol;&lol;">]><QBXML>&lol2;</QBXML>`;

    // Assert on the message the DOCTYPE branch ALONE produces, not merely that
    // something threw. Disabling the check still throws — the scanner trips
    // over `!DOCTYPE` as an invalid element name, and that message even
    // contains the word "DOCTYPE" — so the obvious assertions here all passed
    // with the guard removed. A test that cannot fail is worse than no test:
    // it reads as coverage of the one property this file exists to guarantee.
    for (const doc of [xxe, lol]) {
      expect(() => parseXml(doc)).toThrow(XmlError);
      expect(() => parseXml(doc)).toThrow(/external entities/);
    }
  });

  it("treats an undeclared entity as an error, not a passthrough", () => {
    // Leaving `&foo;` in the output looks harmless until a consumer re-encodes
    // or re-parses it. Mutation: return the match unchanged → red.
    expect(() => decodeEntities("hello &foo; world")).toThrow(XmlError);
    expect(decodeEntities("Smith &amp; Sons")).toBe("Smith & Sons");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  it("refuses a lone surrogate character reference", () => {
    // A lone surrogate smuggled into a JS string fails to serialize later, far
    // from here. Mutation: drop the surrogate range check → red.
    expect(() => decodeEntities("&#xD800;")).toThrow(XmlError);
  });

  it("bounds depth, size and element count", () => {
    // Mutation: remove any ceiling → the matching case parses → red.
    const deep = "<a>".repeat(70) + "x" + "</a>".repeat(70);
    expect(() => parseXml(deep, { maxDepth: 64 })).toThrow(/depth/);
    expect(() => parseXml("<a/>", { maxBytes: 2 })).toThrow(/byte/);
    expect(() => parseXml("<r><a/><a/><a/></r>", { maxElements: 2 })).toThrow(/element/);
  });

  it("the byte ceiling counts UTF-8 bytes, not UTF-16 code units", () => {
    // "€" is one code unit but three UTF-8 bytes. Measured with `.length`, a
    // document a third the ceiling's name promised sailed under it — the cap
    // mirrors the export track's per-file ceiling, and files are bytes.
    // Mutation: measure with `.length` → 407 code units pass a 1000-byte cap
    // → parses → red.
    const doc = `<A>${"€".repeat(400)}</A>`; // 407 code units, 1207 UTF-8 bytes
    expect(() => parseXml(doc, { maxBytes: 1000 })).toThrow(/byte ceiling/);
  });

  it("keeps CDATA literal", () => {
    // A report writer uses CDATA precisely so a name with an ampersand is not
    // re-interpreted. Mutation: decode entities inside CDATA → red.
    const el = parseXml(`<r><n><![CDATA[Smith &amp; Sons]]></n></r>`);
    expect(textAt(el, "n")).toBe("Smith &amp; Sons");
  });

  it("rejects malformed documents rather than guessing", () => {
    // Mutation: fall back to "best effort" on any of these → red.
    expect(() => parseXml("<a><b></a></b>")).toThrow(XmlError);
    expect(() => parseXml("<a>")).toThrow(/unclosed/);
    expect(() => parseXml("<a/><b/>")).toThrow(/root/);
    expect(() => parseXml("   ")).toThrow(XmlError);
  });

  it("parses a hostile attribute run in linear time, not quadratic", () => {
    // The regex this replaced backtracked catastrophically on a tag body with a
    // long run of word characters and no `=`. A valid-looking qbXML envelope
    // carrying tens of kilobytes of that blocked the event loop for minutes —
    // a remote DoS from a machine on the practice LAN.
    //
    // Asserted as a TIME BOUND because that is the actual property; a
    // correctness assertion would have passed against the vulnerable version
    // too (it eventually returns, just not this side of lunch).
    //
    // Mutation: restore the regex → this test hangs rather than failing fast,
    // which is itself the signal. The bound is deliberately loose (2s vs the
    // ~10ms observed) so it cannot flake on a loaded CI box.
    const hostile = `<QBXML><A requestID="1" ${"a".repeat(40_000)}></A></QBXML>`;
    const started = Date.now();
    expect(() => parseXml(hostile)).toThrow(XmlError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps a raw > inside an attribute value instead of silently dropping it", () => {
    // Only `<` and `&` must be escaped in an attribute value, so this is legal
    // XML. `indexOf(">")` ended the tag at the wrong offset and the attribute
    // vanished with no error — the "quietly does the wrong thing" behaviour the
    // module docstring promises never to have.
    //
    // Mutation: go back to indexOf(">") → `note` is absent → red.
    const el = parseXml('<A note="a>b"><B/></A>');
    expect(el.attributes.note).toBe("a>b");
    expect(el.children.map((c) => c.name)).toEqual(["B"]);
  });

  it("refuses a malformed attribute rather than skipping it", () => {
    // The regex ignored anything it could not match, so a bare word in a tag
    // body was invisible. Mutation: return silently instead of failing → red.
    expect(() => parseXml('<A bare></A>')).toThrow(XmlError);
    expect(() => parseXml('<A x=unquoted></A>')).toThrow(/not quoted/);
    expect(() => parseXml('<A x="unterminated></A>')).toThrow(XmlError);
  });

  it("bounds attributes, which are not elements", () => {
    // 200k attributes on ONE element counts as a single element, so maxElements
    // never engaged and the document amplified manyfold in heap.
    // Mutation: drop the attribute ceiling → parses → red.
    const many = "<A " + Array.from({ length: 50 }, (_, i) => `a${i}="0"`).join(" ") + "/>";
    expect(() => parseXml(many, { maxAttributes: 10 })).toThrow(/attribute ceiling/);
    expect(() => parseXml(many, { maxAttributes: 100 })).not.toThrow();
  });

  it(
    "stops scanning attributes AT the ceiling, not after the whole element",
    () => {
      // The test above cannot see WHERE the ceiling is enforced: 50 attributes
      // against a cap of 10 refuse identically whether the check runs inside
      // the scan loop or after the element has been fully scanned. This one
      // can. Two million attributes on one element against the same cap of 10:
      // the check-at-return implementation walks, entity-decodes and
      // materializes all two million before consulting the ceiling — seconds
      // of event-loop stall and hundreds of MiB of heap, posted by the
      // practice-LAN machine this file's docblock names as attacker-adjacent —
      // while the in-loop check bounds the decode-and-materialize work at ten
      // attributes. Finding the tag's end still walks the tag once, so the
      // refusal is a few hundred allocation-free milliseconds, not instant.
      // Mutation: move the ceiling check back to the call site → same
      // XmlError, but only after the full scan → the wall bound goes red.
      const doc =
        "<A " + Array.from({ length: 2_000_000 }, (_, i) => `a${i}="x"`).join(" ") + "/>";
      const started = performance.now();
      expect(() => parseXml(doc, { maxAttributes: 10 })).toThrow(/attribute ceiling/);
      const elapsed = performance.now() - started;
      // Generous for a slow CI runner: measured ~350 ms with the in-loop
      // check against ~9200 ms with the check-at-return version.
      expect(elapsed).toBeLessThan(1500);
    },
    30_000,
  );

  it("the attribute ceiling is document-wide, not per-element", () => {
    // Six attributes on each of two elements is twelve for the document.
    // Threading the ceiling into the scan must not quietly change it into a
    // per-element cap. Mutation: reset the running count per element (pass 0
    // for the already-consumed count) → 6 < 10 on each element → parses → red.
    const twoElements = (n: number) => {
      const attrs = (p: string) =>
        Array.from({ length: n }, (_, i) => `${p}${i}="0"`).join(" ");
      return `<A ${attrs("a")}><B ${attrs("b")}/></A>`;
    };
    expect(() => parseXml(twoElements(6), { maxAttributes: 10 })).toThrow(/attribute ceiling/);
    expect(() => parseXml(twoElements(6), { maxAttributes: 12 })).not.toThrow();
  });

  it("reads attributes, nesting and self-closing tags", () => {
    const el = parseXml(`<r s="0" m="ok"><c><d>7</d></c><e/></r>`);
    expect(el.attributes).toEqual({ s: "0", m: "ok" });
    expect(textAt(el, "c.d")).toBe("7");
    // Absent stays undefined, never "" — an absent field and an empty one are
    // different facts, the same rule the export track applies to a blank cell.
    // Mutation: return "" for a missing node → red.
    expect(textAt(el, "e")).toBeUndefined();
    expect(textAt(el, "nope")).toBeUndefined();
  });
});

// ── qbXML: which number is the money ────────────────────────────────────────

describe("qbXML", () => {
  it("asks for the pinned spec version and no line items", () => {
    // Line items multiply response size by lines-per-document and we read none.
    // The Web Connector holds QuickBooks single-threaded while a session runs,
    // so that is time the front desk cannot use their own software.
    // Mutation: drop IncludeLineItems → red.
    const rq = buildRequest("invoice");
    expect(rq).toContain(`<?qbxml version="${QBXML_VERSION}"?>`);
    expect(rq).toContain("<IncludeLineItems>false</IncludeLineItems>");
    expect(rq).toContain("InvoiceQueryRq");
    expect(buildRequest("bill")).toContain("BillQueryRq");
  });

  it("reads the OUTSTANDING figure, not the document total", () => {
    // THE money test. QuickBooks prints both: Subtotal/AmountDue is what the
    // document was FOR, BalanceRemaining/OpenAmount is what is still OWED.
    // Summing the former overstates payables by the full value of every
    // part-paid document — and looks entirely plausible doing it.
    //
    // BILL-78 is the one that catches it: 1000.00 due, 850.25 open.
    // Mutation: read AmountDue as the balance → 1000 → red.
    const bills = parseResponse("bill", BILL_RS);
    // By identity, not index: the fixture order is deliberately not sorted, and
    // an index-based assertion silently follows a fixture change to a different
    // row rather than failing.
    const partPaid = bills.find((b) => b.bill_id === "BILL-78")!;
    expect(partPaid.balance).toBe(850.25);
    expect(partPaid.amount).toBe(1000);
  });

  it("maps a response onto canonical rows", () => {
    const invoices = parseResponse("invoice", INVOICE_RS);
    expect(Object.keys(invoices[0]).sort()).toEqual([...CANONICAL_COLUMNS.invoice].sort());
    expect(invoices[0].invoice_id).toBe("INV-1001");
    // Canonical ISO instant, like every other track's date-only handling.
    // Mutation: pass "2026-07-31" through → red.
    expect(invoices[0].due_at).toBe("2026-07-31T00:00:00.000Z");
    // The readable name, not the ListID — "who do we owe" is useless as an id.
    // Mutation: prefer ListID → "80000001" → red.
    expect(invoices[0].customer_id).toBe("Northside Clinic");
  });

  it("reads money as the plain decimal QuickBooks prints, not everything Number() takes", () => {
    // `Number()` also accepts hex and exponent notation. QuickBooks never
    // prints them, so an envelope carrying "0x10" is malformed data — and it
    // was being read as sixteen dollars rather than left unread. Thousands
    // separators stay tolerated: they are the one decoration QuickBooks does
    // print. Mutation: fall back to bare Number() → amount 16, balance 1000
    // → red; strip the comma handling → BILL-C's amount undefined → red.
    const rs = `<QBXML><QBXMLMsgsRs><BillQueryRs requestID="9" statusCode="0" statusSeverity="Info">
      <BillRet><TxnID>H1</TxnID><RefNumber>BILL-H</RefNumber>
        <AmountDue>0x10</AmountDue><OpenAmount>1e3</OpenAmount></BillRet>
      <BillRet><TxnID>C1</TxnID><RefNumber>BILL-C</RefNumber>
        <AmountDue>1,234.50</AmountDue><OpenAmount>1,234.50</OpenAmount></BillRet>
    </BillQueryRs></QBXMLMsgsRs></QBXML>`;
    const rows = parseResponse("bill", rs);
    const hex = rows.find((r) => r.bill_id === "BILL-H")!;
    expect(hex.amount).toBeUndefined();
    expect(hex.balance).toBeUndefined();
    const comma = rows.find((r) => r.bill_id === "BILL-C")!;
    expect(comma.amount).toBe(1234.5);
    expect(comma.balance).toBe(1234.5);
  });

  it("treats 'no matching records' as a real empty answer", () => {
    // A practice with no unpaid bills is a good outcome, not a fault.
    // Mutation: throw on statusCode 1 → red.
    const rs = `<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="1" statusMessage="not found"/></QBXMLMsgsRs></QBXML>`;
    expect(parseResponse("bill", rs)).toEqual([]);
  });

  it("refuses to read an error response as data", () => {
    // Mutation: ignore statusCode → the session ingests zero rows as though the
    // practice owed nothing, which is the worst outcome this file can produce.
    const rs = `<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="3070" statusMessage="String too long"/></QBXMLMsgsRs></QBXML>`;
    expect(() => parseResponse("bill", rs)).toThrow(QbxmlStatusError);
  });
});

// ── the session is atomic ───────────────────────────────────────────────────

describe("the Web Connector session", () => {
  it("rejects wrong credentials in the guide's form, without throwing", () => {
    // The Web Connector shows a user whatever we return; an unhandled fault
    // reads as "the server is broken" rather than "check the password".
    // Mutation: return a ticket anyway → red.
    const s = new QbwcSession(CREDS, new QbdSnapshotStore(), { now: () => NOW });
    expect(s.authenticate("droplet", "wrong")).toEqual(["", "nvu"]);
    expect(s.authenticate("wrong", CREDS.password)).toEqual(["", "nvu"]);
  });

  it("refuses any call carrying the wrong ticket", () => {
    // Mutation: skip assertTicket → an unauthenticated caller drives a session.
    const store = new QbdSnapshotStore();
    const s = new QbwcSession(CREDS, store, { now: () => NOW, newTicket: () => "TICKET" });
    s.authenticate(CREDS.username, CREDS.password);
    expect(() => s.sendRequestXML("not-the-ticket")).toThrow(/ticket/);
    expect(() => s.receiveResponseXML("not-the-ticket", BILL_RS)).toThrow(/ticket/);
  });

  it("publishes a snapshot only when the whole session completes", () => {
    const store = new QbdSnapshotStore();
    const s = new QbwcSession(CREDS, store, { now: () => NOW, newTicket: () => "TICKET" });
    const [ticket] = s.authenticate(CREDS.username, CREDS.password);

    s.sendRequestXML(ticket);
    expect(s.receiveResponseXML(ticket, INVOICE_RS)).toBeLessThan(100);
    // Mutation: publish per step instead of on commit → a snapshot exists here
    // carrying invoices and no bills → red.
    expect(store.current).toBeNull();

    s.sendRequestXML(ticket);
    expect(s.receiveResponseXML(ticket, BILL_RS)).toBe(100);
    expect(store.current).not.toBeNull();
    expect(store.current!.rows.invoice).toHaveLength(2);
    expect(store.current!.rows.bill).toHaveLength(3);
  });

  it("leaves the previous snapshot intact when a session dies halfway", () => {
    // THE atomicity test. Half a payables ledger is a confidently-wrong,
    // smaller number for what the practice owes.
    // Mutation: clear or partially write the store on abort → red.
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    const good = store.current!;
    expect(good.rows.bill).toHaveLength(3);

    const s2 = new QbwcSession(CREDS, store, { now: () => NOW + 1000, newTicket: () => "T2" });
    const [t2] = s2.authenticate(CREDS.username, CREDS.password);
    s2.sendRequestXML(t2);
    s2.receiveResponseXML(t2, INVOICE_RS);
    // QuickBooks refuses the second step.
    const rs = `<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="3070" statusMessage="nope"/></QBXMLMsgsRs></QBXML>`;
    expect(s2.receiveResponseXML(t2, rs)).toBe(-1);

    expect(store.current).toBe(good);
    expect(store.current!.rows.bill).toHaveLength(3);
  });

  it("aborts on unparseable XML rather than ingesting nothing", () => {
    // Mutation: swallow the parse error and continue → the session commits an
    // empty bill list over a good one.
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    const good = store.current!;

    const s2 = new QbwcSession(CREDS, store, { now: () => NOW, newTicket: () => "T3" });
    const [t3] = s2.authenticate(CREDS.username, CREDS.password);
    s2.sendRequestXML(t3);
    expect(s2.receiveResponseXML(t3, "<QBXML><unclosed>")).toBe(-1);
    expect(store.current).toBe(good);
  });

  it("refuses an oversized response BEFORE parsing it", () => {
    // The ordering is the property, and the previous version could not see it:
    // it posted a VALID oversized document, so the ceiling message came back
    // whether the size check ran before the parse or after it.
    //
    // This document is oversized AND malformed. If the size check runs first
    // the error is the ceiling; if the parse runs first the error is a parse
    // failure. Only one of those can be true.
    //
    // Mutation: move the size check below the parse → getLastError reports the
    // unclosed element instead of the ceiling → red.
    const store = new QbdSnapshotStore();
    const s = new QbwcSession(CREDS, store, {
      now: () => NOW,
      newTicket: () => "T",
      maxResponseBytes: 10,
    });
    const [t] = s.authenticate(CREDS.username, CREDS.password);
    expect(s.receiveResponseXML(t, "<QBXML><unclosed>" + "x".repeat(200))).toBe(-1);
    expect(s.getLastError(t)).toMatch(/ceiling/);
    expect(s.getLastError(t)).not.toMatch(/unclosed/);
  });

  it("the response ceiling counts UTF-8 bytes, not UTF-16 code units", () => {
    // The same unit bug one layer up: the session's own pre-parse cap
    // measured code units. This response is under the cap in code units,
    // over it in bytes, and malformed — so a correctly measured ceiling
    // refuses it as the ceiling, while a code-unit ceiling lets the parser
    // run and report the unclosed element instead.
    // Mutation: measure with `.length` → getLastError reports a parse
    // failure instead of the ceiling → red.
    const store = new QbdSnapshotStore();
    const s = new QbwcSession(CREDS, store, {
      now: () => NOW,
      newTicket: () => "T",
      maxResponseBytes: 1000,
    });
    const [t] = s.authenticate(CREDS.username, CREDS.password);
    // 407 code units, 1207 UTF-8 bytes.
    expect(s.receiveResponseXML(t, "<QBXML>" + "€".repeat(400))).toBe(-1);
    expect(s.getLastError(t)).toMatch(/ceiling/);
  });

  it("an aborted session cannot resume and publish", () => {
    // `abort()` resets stepIndex to 0, so without a `failed` check the next post
    // simply started the session over and could go on to publish — defeating
    // the abort, and with it the previous snapshot's protection.
    // Mutation: drop the `failed` check in receiveResponseXML → red.
    const store = new QbdSnapshotStore();
    const s = new QbwcSession(CREDS, store, { now: () => NOW, newTicket: () => "T" });
    const [t] = s.authenticate(CREDS.username, CREDS.password);
    s.sendRequestXML(t);
    expect(s.receiveResponseXML(t, "<QBXML><unclosed>")).toBe(-1);

    // The Web Connector posts again anyway.
    expect(s.sendRequestXML(t)).toBe("");
    expect(s.receiveResponseXML(t, INVOICE_RS)).toBe(-1);
    expect(s.receiveResponseXML(t, BILL_RS)).toBe(-1);
    expect(store.current).toBeNull();
  });

  it("a completed session cannot publish a second time", () => {
    // The ticket outlives commit() so the connector can wind down through
    // closeConnection. That is not licence to replay a financial snapshot.
    // Mutation: drop the `completed` check → the store is republished → red.
    const store = new QbdSnapshotStore();
    const { session, ticket } = runSession(store, [INVOICE_RS, BILL_RS]);
    const first = store.current;
    expect(first).not.toBeNull();

    expect(session.sendRequestXML(ticket)).toBe("");
    expect(session.receiveResponseXML(ticket, BILL_RS)).toBe(100);
    expect(store.current).toBe(first);
  });

  it("expires a ticket left behind by a Web Connector that never closed", () => {
    // closeConnection is the only thing that retires a ticket on the happy
    // path, and it is exactly what does not happen when the connector crashes
    // or a user kills the run. Mutation: remove the TTL → the stale ticket
    // still drives a session → red.
    const store = new QbdSnapshotStore();
    let t = NOW;
    const s = new QbwcSession(CREDS, store, {
      now: () => t,
      newTicket: () => "T",
      ticketTtlMs: 60_000,
    });
    const [ticket] = s.authenticate(CREDS.username, CREDS.password);
    expect(s.sendRequestXML(ticket)).toContain("InvoiceQueryRq");
    t = NOW + 61_000;
    expect(() => s.sendRequestXML(ticket)).toThrow(/ticket/);
  });

  it("derives the payables aggregate from the same bills it ingested", () => {
    // Two sources for one number can disagree; one cannot.
    // Mutation: count rows rather than distinct vendors → red.
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    // 3 open bills, 2 distinct vendors: 2000 + 850.25 + 300.
    // `bills.length` would give 3 and is now a DIFFERENT number, so the
    // mutation named below can actually fail.
    expect(store.current!.rows.ap_summary).toEqual([
      { vendor_count: 2, total_balance: 3150.25, unaccounted_count: 0 },
    ]);
  });

  it("counts a bill it could not read rather than dropping it from the total", async () => {
    // The list read KEEPS a bill whose OpenAmount is missing; the aggregate used
    // to skip exactly those, so one bill was visible as money owed and absent
    // from what the business was told it owed.
    // Mutation: filter unparseable balances before aggregating → red.
    const rs = `<QBXML><QBXMLMsgsRs>
      <BillQueryRs statusCode="0">
        <BillRet><TxnID>B1</TxnID><RefNumber>BILL-A</RefNumber>
          <VendorRef><FullName>Henry Schein</FullName></VendorRef>
          <AmountDue>500.00</AmountDue><OpenAmount>500.00</OpenAmount></BillRet>
        <BillRet><TxnID>B2</TxnID><RefNumber>BILL-B</RefNumber>
          <VendorRef><FullName>Mystery Co</FullName></VendorRef>
          <AmountDue>300.00</AmountDue></BillRet>
      </BillQueryRs>
    </QBXMLMsgsRs></QBXML>`;
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, rs]);
    expect(store.current!.rows.bill).toHaveLength(2);
    expect(store.current!.rows.ap_summary).toEqual([
      { vendor_count: 2, total_balance: 500, unaccounted_count: 1 },
    ]);
  });

  it("reads the document total, not the pre-tax subtotal", async () => {
    // qbXML prints `Subtotal` (pre-tax) AND `SalesTaxTotal`. Reading Subtotal
    // as `amount` understated a taxed invoice by the whole tax line and
    // disagreed with QBO (`TotalAmt`) and export-drop (`Amount`) for the same
    // document. Mutation: go back to amountFields: ["Subtotal"] → 1000 → red.
    const rs = `<QBXML><QBXMLMsgsRs>
      <InvoiceQueryRs statusCode="0">
        <InvoiceRet><TxnID>A9</TxnID><RefNumber>INV-TAX</RefNumber>
          <CustomerRef><FullName>Northside Clinic</FullName></CustomerRef>
          <Subtotal>1000.00</Subtotal><SalesTaxTotal>80.00</SalesTaxTotal>
          <BalanceRemaining>1080.00</BalanceRemaining></InvoiceRet>
      </InvoiceQueryRs>
    </QBXMLMsgsRs></QBXML>`;
    const rows = parseResponse("invoice", rs);
    expect(rows[0].amount).toBe(1080);
    expect(rows[0].balance).toBe(1080);
  });

  it("leaves an untaxed invoice's amount alone", async () => {
    // A missing sibling field must not collapse the total to undefined.
    // Mutation: require every field → undefined → red.
    const rows = parseResponse("invoice", INVOICE_RS);
    expect(rows[0].amount).toBe(1200);
  });
});

// ── the connector ───────────────────────────────────────────────────────────

describe("QuickBooksDesktopConnector", () => {
  function connected() {
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    return { store, c: new QuickBooksDesktopConnector(store, {}, { now: () => NOW }) };
  }

  it("refuses rather than fabricating a zero payables total", async () => {
    // `publish` is public and exported so the orchestrator can own the SOAP
    // transport; nothing guarantees a publisher included an ap_summary key.
    // Returning a zero total for absent data states "you owe nobody anything".
    // Mutation: restore the `?? [{ vendor_count: 0, total_balance: 0 }]` → red.
    const store = new QbdSnapshotStore();
    store.publish({ completedAt: NOW, rows: { bill: [] } });
    const c = new QuickBooksDesktopConnector(store, {}, { now: () => NOW });
    await expect(c.runRead("get_ap_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("blocks with an ACTIONABLE reason before any session has run", async () => {
    // Distinct from a capability gap: "run the Web Connector" is something a
    // person can do. Mutation: return [] instead → red.
    const c = new QuickBooksDesktopConnector(new QbdSnapshotStore(), {}, { now: () => NOW });
    const err = await c.runRead("get_open_bills", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err).not.toBeInstanceOf(DatasetNotServedError);
    expect((err as Error).message).toMatch(/Web Connector/);
  });

  it("returns rows shaped exactly like every other track", async () => {
    // Mutation: drop `status` from the mapped row → red.
    const { c } = connected();
    const rows = (await c.runRead("get_open_invoices", {})) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.invoice].sort());
    // INV-0999 is paid off and is not open. Mutation: drop the filter → 2 → red.
    expect(rows.map((r) => r.invoice_id)).toEqual(["INV-1001"]);
  });

  it("orders open bills oldest due first", async () => {
    // Mutation: drop the sort → red.
    const { c } = connected();
    const rows = (await c.runRead("get_open_bills", {})) as Record<string, unknown>[];
    // The fixture lists BILL-78 first; due-date order puts BILL-77 first.
    expect(rows.map((r) => r.bill_id)).toEqual(["BILL-77", "BILL-78", "BILL-79"]);
  });

  it("reports staleness without going unhealthy", async () => {
    // A 30-hour-old snapshot is old, not broken. Collapsing the two would
    // either hide the age or throw away readable data.
    // Mutation: make health() throw when stale → red.
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    const late = new QuickBooksDesktopConnector(
      store,
      {},
      { now: () => NOW + 30 * 60 * 60 * 1000 },
    );
    expect(await late.health()).toEqual({ ok: true, stale: true });
    const s = await late.status();
    expect(s.stale).toBe(true);
    expect(s.ageMinutes).toBe(30 * 60);
    expect(s.lastSessionAt).toBe(new Date(NOW).toISOString());
  });

  it("refuses a practice read as a capability, not a fault", async () => {
    // Mutation: remove assertDatasetsServed → becomes a blocked error → red.
    const { c } = connected();
    await expect(c.runRead("get_schedule_today", { from: "a", to: "b" })).rejects.toBeInstanceOf(
      DatasetNotServedError,
    );
  });

  it("declares exactly the accounting datasets", () => {
    expect([...QBD_DATASETS].sort()).toEqual(["ap_summary", "bill", "invoice"]);
  });

  it("refuses every write", async () => {
    // A write would apply whenever the practice's Web Connector next runs, so
    // "confirmed" and "applied" could be hours apart — which no confirmation
    // flow we have models honestly.
    // Mutation: allow any write path → red.
    const { c } = connected();
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
  });

  it("moves the fingerprint with the pinned qbXML version", async () => {
    // Mutation: drop the version from the fingerprint → a spec change reports
    // "no drift" across a real one.
    const { c } = connected();
    expect((await c.introspect()).fingerprint).toContain(`:qbxml${QBXML_VERSION}`);
  });
});
