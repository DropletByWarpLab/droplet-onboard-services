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

const BILL_RS = `<?xml version="1.0"?><?qbxml version="13.0"?>
<QBXML><QBXMLMsgsRs>
  <BillQueryRs requestID="2" statusCode="0" statusSeverity="Info">
    <BillRet>
      <TxnID>B1</TxnID><RefNumber>BILL-77</RefNumber>
      <TxnDate>2026-07-05</TxnDate><DueDate>2026-08-04</DueDate>
      <VendorRef><ListID>90000001</ListID><FullName>Henry Schein</FullName></VendorRef>
      <AmountDue>2000.00</AmountDue><OpenAmount>2000.00</OpenAmount>
    </BillRet>
    <BillRet>
      <TxnID>B2</TxnID><RefNumber>BILL-78</RefNumber>
      <TxnDate>2026-07-20</TxnDate><DueDate>2026-08-19</DueDate>
      <VendorRef><ListID>90000002</ListID><FullName>Patterson Dental</FullName></VendorRef>
      <AmountDue>1000.00</AmountDue><OpenAmount>850.25</OpenAmount>
    </BillRet>
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
    expect(bills[1].balance).toBe(850.25);
    expect(bills[1].amount).toBe(1000);
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
    expect(store.current!.rows.bill).toHaveLength(2);
  });

  it("leaves the previous snapshot intact when a session dies halfway", () => {
    // THE atomicity test. Half a payables ledger is a confidently-wrong,
    // smaller number for what the practice owes.
    // Mutation: clear or partially write the store on abort → red.
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    const good = store.current!;
    expect(good.rows.bill).toHaveLength(2);

    const s2 = new QbwcSession(CREDS, store, { now: () => NOW + 1000, newTicket: () => "T2" });
    const [t2] = s2.authenticate(CREDS.username, CREDS.password);
    s2.sendRequestXML(t2);
    s2.receiveResponseXML(t2, INVOICE_RS);
    // QuickBooks refuses the second step.
    const rs = `<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="3070" statusMessage="nope"/></QBXMLMsgsRs></QBXML>`;
    expect(s2.receiveResponseXML(t2, rs)).toBe(-1);

    expect(store.current).toBe(good);
    expect(store.current!.rows.bill).toHaveLength(2);
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

  it("refuses an oversized response before parsing it", () => {
    // Mutation: parse first, check size after → a hostile response is parsed.
    const store = new QbdSnapshotStore();
    const s = new QbwcSession(CREDS, store, {
      now: () => NOW,
      newTicket: () => "T",
      maxResponseBytes: 10,
    });
    const [t] = s.authenticate(CREDS.username, CREDS.password);
    expect(s.receiveResponseXML(t, INVOICE_RS)).toBe(-1);
    expect(s.getLastError(t)).toMatch(/ceiling/);
  });

  it("derives the payables aggregate from the same bills it ingested", () => {
    // Two sources for one number can disagree; one cannot.
    // Mutation: count rows rather than distinct vendors → red.
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    expect(store.current!.rows.ap_summary).toEqual([
      { vendor_count: 2, total_balance: 2850.25 },
    ]);
  });
});

// ── the connector ───────────────────────────────────────────────────────────

describe("QuickBooksDesktopConnector", () => {
  function connected() {
    const store = new QbdSnapshotStore();
    runSession(store, [INVOICE_RS, BILL_RS]);
    return { store, c: new QuickBooksDesktopConnector(store, {}, { now: () => NOW }) };
  }

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
    expect(rows.map((r) => r.bill_id)).toEqual(["BILL-77", "BILL-78"]);
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
