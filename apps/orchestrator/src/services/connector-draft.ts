/**
 * WARP-2899 (ADR-056 slice L) — a connector draft, as the Workshop reads it.
 *
 * A workspace made from the `rest-profile` template drafts an ADR-046 REST
 * profile, its guide, its egress entry and its ADR-042 rows. The sandbox
 * (services/sandbox/connector_draft.py) reads the files back into FACTS: the
 * vendor, the host the profile WOULD dial, and what keeps the draft from being
 * ready. This module turns those facts into the one sentence a person reads —
 * on the workspace detail, in the workspace_propose result, and in the
 * activity row.
 *
 * 🔴 Nothing here loads, validates or registers a profile, and this module
 * imports nothing from @droplet/erp-connector on purpose: a draft is DATA in
 * the store and becomes a connector only through a Warp Lab PR. The sentence
 * says so, and never implies the draft is verified or live.
 */

export type ConnectorDraftHost =
  | { kind: "static"; hosts: string[] }
  | {
      kind: "dynamic";
      configField: string;
      allowedSuffixes: string[];
      allowedHosts: string[];
      hostShape: string;
    };

export interface ConnectorDraftFacts {
  provider: string;
  displayName: string;
  host: ConnectorDraftHost | null;
  files: Record<string, string>;
  problems: string[];
}

/** What GET /api/workspace/:id carries for a draft. */
export interface ConnectorDraftSummary {
  provider: string;
  displayName: string;
  readback: string;
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The display name on one line: whitespace, control and invisible format
 * characters (zero-width, bidi overrides) collapse to one space. The sandbox
 * (connector_draft.py) does the same; this holds it for the three surfaces
 * that carry the name verbatim — the activity `sub`, the notification and the
 * tool message (rjouffret on #2324).
 */
const NOT_ONE_LINE_RE = /[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;
const oneLine = (s: string): string => s.replace(NOT_ONE_LINE_RE, " ").trim();

function parseHost(raw: unknown): ConnectorDraftHost | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "static") return { kind: "static", hosts: strings(raw.hosts) };
  if (raw.kind === "dynamic") {
    return {
      kind: "dynamic",
      configField: str(raw.configField),
      allowedSuffixes: strings(raw.allowedSuffixes),
      allowedHosts: strings(raw.allowedHosts),
      hostShape: str(raw.hostShape),
    };
  }
  return null;
}

/** Narrow the sandbox's JSON. `null` for anything that is not a draft's facts. */
export function parseConnectorDraftFacts(raw: unknown): ConnectorDraftFacts | null {
  if (!isObj(raw) || typeof raw.provider !== "string") return null;
  const files: Record<string, string> = {};
  if (isObj(raw.files)) {
    for (const [k, v] of Object.entries(raw.files)) if (typeof v === "string") files[k] = v;
  }
  return {
    provider: raw.provider,
    displayName: oneLine(str(raw.displayName)),
    host: parseHost(raw.host),
    files,
    problems: strings(raw.problems),
  };
}

/**
 * The host a draft would dial, in words. A static origin by its hostname; a
 * per-account host by the suffixes it must end in (and the exact hosts it may
 * be); a draft whose host is not readable yet as "the vendor".
 */
export function connectorDraftHostPhrase(host: ConnectorDraftHost | null): string {
  if (!host) return "the vendor";
  if (host.kind === "static") return host.hosts.length ? host.hosts.join(" or ") : "the vendor";
  const { allowedSuffixes: suffixes, allowedHosts: hosts } = host;
  if (suffixes.length === 0) {
    return hosts.length ? `a per-account host among ${hosts.join(", ")}` : "a per-account host";
  }
  return `a per-account host under ${suffixes.join(" or ")}${hosts.length ? ` or ${hosts.join(", ")}` : ""}`;
}

/** The sentence. Exact, because three surfaces carry it verbatim. */
export function connectorDraftReadback(facts: ConnectorDraftFacts): string {
  const who = facts.displayName.trim() || facts.provider;
  return `drafts a connector for ${who}; nothing on this box will dial ${connectorDraftHostPhrase(facts.host)} until Warp Lab ships it`;
}

export function summarizeConnectorDraft(facts: ConnectorDraftFacts): ConnectorDraftSummary {
  return {
    provider: facts.provider,
    displayName: facts.displayName,
    readback: connectorDraftReadback(facts),
    problems: facts.problems,
  };
}
