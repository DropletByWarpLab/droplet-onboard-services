/**
 * WARP-3529 — the auto-acknowledgement template: its four variables, validated
 * when an administrator saves it and escaped when it is rendered for a stranger.
 */
import { describe, it, expect } from "vitest";
import {
  ACK_SAMPLE,
  ACK_TEMPLATE_MAX,
  ACK_VARIABLES,
  DEFAULT_ACK_TEMPLATE,
  ackFirstName,
  checkAckTemplate,
  renderAckTemplate,
} from "./ack-template.js";

const values = {
  requesterName: "Alex Morgan",
  requesterGivenName: null,
  ticketKey: "SUP-12",
  ticketTitle: "Printer is offline",
  deskName: "Front desk",
};

describe("checkAckTemplate", () => {
  it("accepts the default template and a template using each variable, with or without spaces", () => {
    expect(checkAckTemplate(DEFAULT_ACK_TEMPLATE)).toEqual([]);
    expect(checkAckTemplate("{{ requester.firstName }} {{ticket.key}} {{ ticket.title}} {{desk.name }}")).toEqual([]);
  });

  it("offers exactly the four variables the ticket promised", () => {
    expect([...ACK_VARIABLES]).toEqual(["requester.firstName", "ticket.key", "ticket.title", "desk.name"]);
  });

  it("names every variable it does not know", () => {
    expect(checkAckTemplate("Hi {{requester.name}}, {{ticket.key}} {{ticket.priority}}")).toEqual([
      { code: "unknown_variable", name: "requester.name" },
      { code: "unknown_variable", name: "ticket.priority" },
    ]);
  });

  it("is case-sensitive, and refuses filters and expressions", () => {
    expect(checkAckTemplate("{{TICKET.KEY}}")).toEqual([{ code: "unknown_variable", name: "TICKET.KEY" }]);
    expect(checkAckTemplate("{{ticket.key | upper}}")).toEqual([{ code: "unknown_variable", name: "ticket.key | upper" }]);
    expect(checkAckTemplate("{{}}")).toEqual([{ code: "unknown_variable", name: "" }]);
  });

  it("flags a brace that opens or closes nothing", () => {
    expect(checkAckTemplate("Hi {{requester.firstName")).toContainEqual({ code: "malformed" });
    expect(checkAckTemplate("Hi requester.firstName}}")).toContainEqual({ code: "malformed" });
    expect(checkAckTemplate("{{a{{ticket.key}}}}")).toContainEqual({ code: "malformed" });
  });

  it("refuses an empty template and one past the bound the database also holds", () => {
    expect(checkAckTemplate("   \n ")).toEqual([{ code: "empty" }]);
    expect(checkAckTemplate("x".repeat(ACK_TEMPLATE_MAX))).toEqual([]);
    expect(checkAckTemplate("x".repeat(ACK_TEMPLATE_MAX + 1))).toEqual([{ code: "too_long" }]);
  });
});

describe("ackFirstName", () => {
  it.each([
    ["Alex Morgan", null, "Alex"],
    ["alex", null, "alex"],
    ["Alex Morgan", "Alexandra", "Alexandra"],
    ["Dr. Priya Raman", null, "Dr."],
    ["priya@customer.com", null, "there"],
    ["Raman, Priya", null, "there"],
    ["", null, "there"],
    ["   ", null, "there"],
    ["***", null, "there"],
    [null, null, "there"],
  ])("%j (given %j) -> %j", (name, given, expected) => expect(ackFirstName(name, given)).toBe(expected));

  it("cannot carry a line break or a control character", () => {
    expect(ackFirstName("Alex\r\nBcc: x@y.com Morgan", null)).toBe("Alex");
  });
});

describe("renderAckTemplate", () => {
  it("fills the four variables", () => {
    const out = renderAckTemplate("Hi {{requester.firstName}}: {{ticket.key}} / {{ticket.title}} / {{desk.name}}", values);
    expect(out.text).toBe("Hi Alex: SUP-12 / Printer is offline / Front desk");
  });

  it("gives the comment HTML, escaped, from the same text", () => {
    const out = renderAckTemplate("Hi {{requester.firstName}},\n\nWe logged {{ticket.key}}.\nThanks", values);
    expect(out.html).toBe("<p>Hi Alex,</p><p>We logged SUP-12.<br>Thanks</p>");
  });

  describe("the values are a stranger's words", () => {
    it("escapes them in the HTML and never lets them add markup", () => {
      const out = renderAckTemplate("Re: {{ticket.title}}", { ...values, ticketTitle: '<script>alert("x")</script> & <b>hi</b>' });
      expect(out.html).toBe("<p>Re: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;hi&lt;/b&gt;</p>");
      expect(out.html).not.toMatch(/<(?!\/?p>|br>)/);
    });

    it("keeps a line break out of a value", () => {
      const out = renderAckTemplate("Re: {{ticket.title}}", { ...values, ticketTitle: "A\r\nBcc: x@y.com‮evil" });
      expect(out.text).toBe("Re: A Bcc: x@y.com evil");
    });

    it("expands each placeholder once: a value that looks like one is not expanded again", () => {
      const out = renderAckTemplate("{{ticket.title}} / {{desk.name}}", { ...values, ticketTitle: "{{desk.name}}" });
      expect(out.text).toBe("{{desk.name}} / Front desk");
    });

    it("bounds a long title", () => {
      const out = renderAckTemplate("{{ticket.title}}", { ...values, ticketTitle: "t".repeat(5000) });
      expect(out.text.length).toBeLessThanOrEqual(201);
      expect(out.text.endsWith("…")).toBe(true);
    });
  });

  it("renders a placeholder it does not know as nothing rather than failing the acknowledgement", () => {
    expect(renderAckTemplate("a{{nope}}b", values).text).toBe("ab");
  });

  it("renders the default template for a nameless sender", () => {
    const out = renderAckTemplate(DEFAULT_ACK_TEMPLATE, { ...values, requesterName: "who@customer.com" });
    expect(out.text.startsWith("Hi there,")).toBe(true);
    expect(out.text).toContain("SUP-12");
    expect(out.text).toContain("Front desk");
  });
});

describe("ACK_SAMPLE", () => {
  it("is what the preview shows", () => {
    const out = renderAckTemplate(DEFAULT_ACK_TEMPLATE, { ...ACK_SAMPLE, deskName: "Support" });
    expect(out.text).toContain("Hi Alex,");
    expect(out.text).toContain(ACK_SAMPLE.ticketKey);
  });
});
