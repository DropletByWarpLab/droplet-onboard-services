/**
 * WARP-2899 (ADR-056 slice L, AC4) — the one sentence a person reads about a
 * connector draft: which vendor, and which host nothing on this box will dial.
 *
 * Exact strings, because the same sentence is the Workshop readback, the
 * workspace_propose result and the activity row's `sub`, and it must never
 * imply the draft was verified or is live.
 *
 * MUTATION: derive the host from anything but `facts.host` (the display name,
 * the provider id) → the static and dynamic cases go red.
 */
import { describe, it, expect } from "vitest";
import {
  connectorDraftHostPhrase,
  connectorDraftReadback,
  parseConnectorDraftFacts,
  summarizeConnectorDraft,
  type ConnectorDraftFacts,
} from "../services/connector-draft.js";

const base: ConnectorDraftFacts = {
  provider: "acme",
  displayName: "Acme",
  host: { kind: "static", hosts: ["api.acme.example"] },
  files: {},
  problems: [],
};

describe("connectorDraftReadback", () => {
  it("names the static origin's host", () => {
    expect(connectorDraftReadback(base)).toBe(
      "drafts a connector for Acme; nothing on this box will dial api.acme.example until Warp Lab ships it",
    );
  });

  it("describes a per-account host by its suffix", () => {
    const facts: ConnectorDraftFacts = {
      ...base,
      host: { kind: "dynamic", configField: "companyDomain", allowedSuffixes: [".acme.example"], allowedHosts: [], hostShape: "" },
    };
    expect(connectorDraftReadback(facts)).toBe(
      "drafts a connector for Acme; nothing on this box will dial a per-account host under .acme.example until Warp Lab ships it",
    );
  });

  it("joins several suffixes with 'or' and appends the exact hosts", () => {
    const facts: ConnectorDraftFacts = {
      ...base,
      host: {
        kind: "dynamic",
        configField: "region",
        allowedSuffixes: [".acme.example", ".acme-eu.example"],
        allowedHosts: ["eu.acme.example", "au.acme.example"],
        hostShape: "",
      },
    };
    expect(connectorDraftHostPhrase(facts.host)).toBe(
      "a per-account host under .acme.example or .acme-eu.example or eu.acme.example, au.acme.example",
    );
  });

  it("a dynamic draft with exact hosts only names them", () => {
    expect(
      connectorDraftHostPhrase({ kind: "dynamic", configField: "dc", allowedSuffixes: [], allowedHosts: ["eu.acme.example"], hostShape: "" }),
    ).toBe("a per-account host among eu.acme.example");
  });

  it("falls back to the provider id when the display name is empty, and never invents a host", () => {
    expect(connectorDraftReadback({ ...base, displayName: "" })).toBe(
      "drafts a connector for acme; nothing on this box will dial api.acme.example until Warp Lab ships it",
    );
    expect(connectorDraftReadback({ ...base, host: null })).toBe(
      "drafts a connector for Acme; nothing on this box will dial the vendor until Warp Lab ships it",
    );
  });
});

describe("parseConnectorDraftFacts", () => {
  it("narrows the sandbox's JSON and refuses what is not a draft", () => {
    expect(parseConnectorDraftFacts(null)).toBeNull();
    expect(parseConnectorDraftFacts("x")).toBeNull();
    expect(parseConnectorDraftFacts({ displayName: "x" })).toBeNull();
    const parsed = parseConnectorDraftFacts({
      provider: "acme",
      displayName: "Acme",
      host: { kind: "static", hosts: ["api.acme.example", 7] },
      files: { profile: "services/erp-connector/src/rest/vendors/acme.ts" },
      problems: ["one", 2],
    });
    expect(parsed).toEqual({
      provider: "acme",
      displayName: "Acme",
      host: { kind: "static", hosts: ["api.acme.example"] },
      files: { profile: "services/erp-connector/src/rest/vendors/acme.ts" },
      problems: ["one"],
    });
    expect(parseConnectorDraftFacts({ provider: "", displayName: "", host: { kind: "weird" }, problems: [] })?.host).toBeNull();
  });

  it("summarizes for the detail response", () => {
    expect(summarizeConnectorDraft({ ...base, problems: ["p"] })).toEqual({
      provider: "acme",
      displayName: "Acme",
      readback: "drafts a connector for Acme; nothing on this box will dial api.acme.example until Warp Lab ships it",
      problems: ["p"],
    });
  });
});
