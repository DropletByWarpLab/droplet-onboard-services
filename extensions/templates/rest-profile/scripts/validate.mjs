// The connector draft's rules (WARP-2899). Pure: no file, no network, no
// dependency — the sandbox has no network and this runs there.
//
// validateDraft() mirrors assertValidRestProfile() in
// services/erp-connector/src/rest/profile.ts, plus the rules only a DRAFT
// needs: a dynamic host is described in prose (hostShape) and never
// illustrated with a URL, and nothing but a static origin may carry a scheme.
// The vocabulary it checks fieldMaps against is vocabulary.json, a snapshot of
// the connector's canonical columns that a drift test in the repo pins.

export const MARKER = "Drafted on a Droplet box by the rest-profile template (WARP-2899)";

/** The six sections scripts/check-setup-guides.sh requires, in its order. */
export const GUIDE_SECTIONS = [
  "## Plan prerequisite",
  "## Cost",
  "## Click-path",
  "## Scopes and permissions",
  "## Rotation and expiry",
  "## Revocation",
];

export const PROVIDER_RE = /^[a-z][a-z0-9-]{1,40}$/;
const CONFIG_FIELD_RE = /^[a-z][A-Za-z0-9]{0,63}$/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const SUFFIX_RE = /^\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATA_CLASS_RE = /^[a-z][a-z-]{1,63}$/;
const PAGINATION_KINDS = ["cursor", "link-header", "limit-offset", "page-number", "relay-pageinfo"];
const WATERMARK_LOCATIONS = ["query", "header"];
const WATERMARK_FORMATS = ["iso", "date", "epoch-seconds", "epoch-millis", "http-date"];
const TRANSFORMS = ["minor-units", "date-to-instant"];

/** `acme-crm` → `ACME_CRM`: the constant prefix the repo's vendor files use. */
export function providerConst(provider) {
  return provider.toUpperCase().replace(/-/g, "_");
}

/** Where each rendered file lives. Every path is built from a validated id. */
export function outputPaths(provider) {
  return {
    profile: `services/erp-connector/src/rest/vendors/${provider}.ts`,
    guide: `docs/integrations/${provider}.md`,
    egress: `docs/security/allowed-egress.${provider}.draft.yaml`,
    adr042: `docs/adr-042/${provider}.rows.md`,
    checklist: "DRAFT-CHECKLIST.md",
  };
}

/** The directories the generator writes into (and cleans its own files out of). */
export const OUTPUT_DIRS = [
  "services/erp-connector/src/rest/vendors",
  "docs/integrations",
  "docs/security",
  "docs/adr-042",
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";

/** Every string anywhere in `value`, with its dotted location. */
function strings(value, at = "") {
  if (isStr(value)) return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${at}[${i}]`));
  if (isObj(value)) return Object.entries(value).flatMap(([k, v]) => strings(v, at ? `${at}.${k}` : k));
  return [];
}

function validateBaseUrl(baseUrl, problems) {
  if (!isObj(baseUrl)) return problems.push("baseUrl must be an object with kind static or dynamic");
  if (baseUrl.kind === "static") {
    let parsed = null;
    try {
      parsed = new URL(baseUrl.origin);
    } catch {
      return problems.push("baseUrl.origin is not a URL (fill it with https and the host only)");
    }
    if (parsed.protocol !== "https:") problems.push("baseUrl.origin must be https");
    if (parsed.origin !== baseUrl.origin) {
      problems.push("baseUrl.origin must be the bare origin: https and the host, no path, slash, query, credentials or fragment");
    }
    if (!HOST_RE.test(parsed.hostname)) problems.push("baseUrl.origin must name a host by domain, never an IP");
    return;
  }
  if (baseUrl.kind !== "dynamic") return problems.push("baseUrl.kind must be static or dynamic");
  if (!isStr(baseUrl.configField) || !CONFIG_FIELD_RE.test(baseUrl.configField)) {
    problems.push("baseUrl.configField must name the providerConfig field holding the customer's host (camelCase)");
  }
  const suffixes = Array.isArray(baseUrl.allowedSuffixes) ? baseUrl.allowedSuffixes : null;
  const hosts = Array.isArray(baseUrl.allowedHosts) ? baseUrl.allowedHosts : null;
  if (!suffixes || !hosts) return problems.push("baseUrl.allowedSuffixes and baseUrl.allowedHosts must be arrays");
  if (suffixes.length === 0 && hosts.length === 0) {
    problems.push("a dynamic baseUrl must carry at least one allowed suffix or host");
  }
  for (const s of suffixes) {
    if (!isStr(s) || !s.startsWith(".")) problems.push(`host suffix ${JSON.stringify(s)} must start with a dot`);
    else if (s.includes("/")) problems.push(`host suffix ${JSON.stringify(s)} must be a bare host suffix, not a URL`);
    else if (!SUFFIX_RE.test(s)) problems.push(`host suffix ${JSON.stringify(s)} must be a lowercase domain suffix like .vendor.example`);
  }
  for (const h of hosts) {
    if (!isStr(h) || h.includes("/")) problems.push(`allowed host ${JSON.stringify(h)} must be a bare host, not a URL`);
    else if (!HOST_RE.test(h)) problems.push(`allowed host ${JSON.stringify(h)} must be a lowercase domain`);
  }
  if (!isStr(baseUrl.hostShape) || !baseUrl.hostShape.trim()) {
    problems.push("baseUrl.hostShape must describe, in words, what the customer's host looks like");
  }
}

function validateDataset(spec, i, vocab, seen, problems) {
  const at = `datasets[${i}]`;
  if (!isObj(spec)) return problems.push(`${at} must be an object`);
  if (!vocab.DATASET_NAMES.includes(spec.dataset)) {
    return problems.push(`${at}.dataset ${JSON.stringify(spec.dataset)} is not one of the canonical datasets`);
  }
  if (seen.has(spec.dataset)) problems.push(`dataset "${spec.dataset}" is declared twice`);
  seen.add(spec.dataset);
  if (!isStr(spec.path) || !spec.path.startsWith("/")) problems.push(`dataset "${spec.dataset}" path must start with "/"`);
  if (spec.query !== undefined && (!isObj(spec.query) || !Object.values(spec.query).every(isStr))) {
    problems.push(`dataset "${spec.dataset}" query must map names to strings`);
  }
  if (spec.watermark !== null) {
    const w = spec.watermark;
    if (!isObj(w) || !isStr(w.name) || !w.name) {
      problems.push(`dataset "${spec.dataset}" watermark must be null (a full scan, declared) or name its parameter`);
    } else {
      if (!WATERMARK_LOCATIONS.includes(w.location)) problems.push(`dataset "${spec.dataset}" watermark.location must be query or header`);
      if (!WATERMARK_FORMATS.includes(w.format)) problems.push(`dataset "${spec.dataset}" watermark.format must be one of ${WATERMARK_FORMATS.join(", ")}`);
      if (typeof w.complete !== "boolean") problems.push(`dataset "${spec.dataset}" watermark.complete must be true or false`);
    }
  }
  if (!isObj(spec.pagination) || !PAGINATION_KINDS.includes(spec.pagination.kind)) {
    problems.push(`dataset "${spec.dataset}" pagination.kind must be one of ${PAGINATION_KINDS.join(", ")}`);
  }
  if (!isStr(spec.rowsPath)) problems.push(`dataset "${spec.dataset}" rowsPath must be a string ("" when the body is the array)`);
  if (!isObj(spec.fieldMap)) return problems.push(`dataset "${spec.dataset}" fieldMap must be an object`);
  const columns = vocab.CANONICAL_COLUMNS[spec.dataset];
  for (const [column, source] of Object.entries(spec.fieldMap)) {
    if (!columns.includes(column)) {
      problems.push(`dataset "${spec.dataset}" maps "${column}", which is not one of its canonical columns (${columns.join(", ")})`);
    }
    if (isStr(source)) {
      if (!source) problems.push(`dataset "${spec.dataset}" column "${column}" maps to an empty path`);
    } else if (!isObj(source) || !isStr(source.path) || !TRANSFORMS.includes(source.transform)) {
      problems.push(`dataset "${spec.dataset}" column "${column}" must map to a path or {path, transform}`);
    } else if (source.transform === "minor-units" && !(isStr(source.currencyFrom) && source.currencyFrom)) {
      problems.push(`dataset "${spec.dataset}" column "${column}" converts minor units without currencyFrom`);
    }
  }
  for (const column of vocab.REQUIRED_CANONICAL[spec.dataset]) {
    if (!(column in spec.fieldMap)) {
      problems.push(`dataset "${spec.dataset}" does not map "${column}", which REQUIRED_CANONICAL.${spec.dataset} names`);
    }
  }
}

/** Every problem with `draft`, as sentences. An empty list is a valid draft. */
export function validateDraft(draft, vocab) {
  const problems = [];
  if (!isObj(draft)) return ["connector-draft.json must hold one JSON object"];
  if (!isStr(draft.provider) || !PROVIDER_RE.test(draft.provider)) {
    problems.push("provider must match ^[a-z][a-z0-9-]{1,40}$ (lowercase letters, digits and dashes)");
  }
  if (draft.displayName !== undefined && !isStr(draft.displayName)) problems.push("displayName must be a string");
  validateBaseUrl(draft.baseUrl, problems);

  const auth = draft.auth;
  if (!isObj(auth) || !isStr(auth.headerName) || !HEADER_RE.test(auth.headerName)) {
    problems.push("auth.headerName must be the literal header name the vendor documents");
  }
  if (!isObj(auth) || !isStr(auth.valueTemplate) || !/\{\{\w+\}\}/.test(auth.valueTemplate)) {
    problems.push("auth.valueTemplate carries no {{placeholder}}, so no credential would be sent");
  }
  if (!isObj(draft.constantHeaders) || !Object.entries(draft.constantHeaders).every(([k, v]) => HEADER_RE.test(k) && isStr(v))) {
    problems.push("constantHeaders must map header names to strings");
  }
  if (!isStr(draft.probePath) || !draft.probePath.startsWith("/")) problems.push('probePath must start with "/"');
  const interval = draft.minRequestIntervalMs;
  if (interval !== null && interval !== undefined && !(Number.isInteger(interval) && interval > 0)) {
    problems.push("minRequestIntervalMs must be null (no published ceiling) or a positive integer");
  }
  if (!Array.isArray(draft.datasets) || draft.datasets.length === 0) {
    problems.push("the draft serves no datasets");
  } else {
    const seen = new Set();
    draft.datasets.forEach((spec, i) => validateDataset(spec, i, vocab, seen, problems));
  }
  if (!isObj(draft.egress) || !isStr(draft.egress.dataClass) || !DATA_CLASS_RE.test(draft.egress.dataClass)) {
    problems.push("egress.dataClass must be a registry data_class such as user-content-on-request");
  }
  if (!isObj(draft.credential)) problems.push("credential must be an object");
  if (!isObj(draft.guide) || !Array.isArray(draft.guide.clickPath)) problems.push("guide must be an object with a clickPath list");

  // Nothing but a static origin carries a scheme. A dynamic host is described
  // in words; a URL for it would be a destination nobody registered.
  for (const [at, value] of strings(draft)) {
    if (at === "baseUrl.origin" && draft.baseUrl?.kind === "static") continue;
    if (value.includes("://")) problems.push(`${at} carries a scheme URL; describe hosts in words (hostShape), never as a URL`);
  }
  return problems;
}

/**
 * Whether the rendered files agree with the draft. `read(path)` returns a
 * file's text or null. The sandbox's connector_draft.py makes the same checks
 * before it lets workspace_propose through.
 */
export function checkRendered(draft, read) {
  const problems = [];
  const paths = outputPaths(draft.provider);
  const profile = read(paths.profile);
  if (profile === null) problems.push(`${paths.profile} is missing`);
  else if (!profile.includes(`export const ${providerConst(draft.provider)}_PROFILE`)) {
    problems.push(`${paths.profile} does not export ${providerConst(draft.provider)}_PROFILE`);
  }
  const guide = read(paths.guide);
  if (guide === null) problems.push(`${paths.guide} is missing`);
  else {
    const h2 = guide.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.trimEnd());
    if (JSON.stringify(h2) !== JSON.stringify(GUIDE_SECTIONS)) {
      problems.push(`${paths.guide} must have exactly the six sections, in order: ${GUIDE_SECTIONS.join(", ")}`);
    }
  }
  const egress = read(paths.egress);
  if (egress === null) problems.push(`${paths.egress} is missing`);
  else if (draft.baseUrl.kind === "static") {
    const host = new URL(draft.baseUrl.origin).hostname;
    if (!egress.includes(host)) problems.push(`${paths.egress} does not name ${host}`);
  } else {
    const key = `IntegrationConnection.providerConfig.${draft.baseUrl.configField}`;
    if (!egress.includes(key)) problems.push(`${paths.egress} does not name ${key}`);
  }
  if (read(paths.adr042) === null) problems.push(`${paths.adr042} is missing`);
  if (draft.baseUrl.kind === "dynamic") {
    for (const p of [paths.profile, paths.guide, paths.egress, paths.adr042]) {
      if ((read(p) ?? "").includes("://")) problems.push(`${p} carries a scheme URL in a dynamic draft`);
    }
  }
  return problems;
}
