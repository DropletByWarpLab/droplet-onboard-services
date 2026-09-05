/**
 * WARP-2730 (ADR-048) — the two model passes, and everything that refuses to
 * make one.
 *
 * Reading order for this file is the order the guards run, and that order is
 * the design: each layer's job is to make the next one cheaper or unnecessary.
 *
 *   resolveFilingModel  — is there a LOCAL model at all?   (no network yet)
 *   screenSource        — does the text disqualify itself?  (still no network)
 *   classify            — what is this, and is it clinical? (one short call)
 *   extract             — the business facts.               (one long call)
 *   verifyEvidence      — did the model read, or invent?    (no network)
 *   applyPhiPosture     — MENTIONS drops every person.      (no network)
 *
 * 🔴 THE CLOUD REFUSAL IS NOT A PREFERENCE. Unattended extraction over
 * documents the owner stored on their own box is local, full stop — there is
 * no owner opt-in that turns it on, and the refusal is checked before the first
 * byte of the document exists in a request body. This is the caller
 * `resolveOffLanProvider`'s docstring names explicitly: `decideCloudTurn`
 * short-circuits to ALLOWED for a principal with no human, which is exactly
 * this worker, so asking THAT question would answer "yes" for the one caller
 * that must be told no.
 */
import type { PrismaClient } from "@prisma/client";

import * as aiGateway from "../ai-gateway.client.js";
import { completeOnce } from "../llm-complete.service.js";
import { extractJson } from "../llm-json.js";
import {
  localModelIdentifiers,
  readActiveChatModel,
  resolveActiveChatModel,
} from "../active-model.service.js";
import { resolveOffLanProvider } from "../cloud-access.service.js";
import { createLogger } from "../../lib/logger.js";

import {
  ClassifyOut,
  ExtractOut,
  type PhiVerdictValue,
  verifyEvidence,
} from "./contract.js";
import { screenPersistedString, screenSource, type PhiSignal } from "./phi-screen.js";
import {
  CLASSIFY_SYSTEM,
  EXTRACT_SYSTEM,
  buildRepairTurn,
  buildUserTurn,
} from "./prompts.js";
import { MENTIONS_CONFIDENCE_CAP } from "./policy.js";

const logger = createLogger("filing-extract");

/** The subset of `ExtractReason` this module can produce. Narrower than the
 *  enum on purpose: a reason nothing writes is a reason nobody has to read. */
export type ExtractFailureReason =
  | "phi_path"
  | "phi_record"
  | "not_business"
  | "bad_json"
  | "model_unreachable"
  | "cloud_model_refused";

export interface ExtractionResult {
  phiVerdict: PhiVerdictValue;
  role: string;
  counterparty: string;
  /** The classifier's own confidence, already capped for MENTIONS. */
  confidence: number;
  entities: ExtractOut;
  /** Entities dropped because a quote was not in the text we sent. */
  droppedUnverified: number;
  /** Entities and fields dropped by the MENTIONS posture or the post-filter. */
  droppedPhi: number;
  phiSignals: PhiSignal[];
  model: string;
}

export type ExtractOutcome =
  | { ok: true; result: ExtractionResult }
  | { ok: false; reason: ExtractFailureReason; detail?: string };

/** Bounded so a runaway generation cannot fill a proposal payload. Pass 1 is
 *  the long one; the classifier's answer is five keys. */
const CLASSIFY_MAX_TOKENS = 256;
const EXTRACT_MAX_TOKENS = 2048;

/** Deterministic. This is a reading task, not a writing one, and a document
 *  read twice should read the same way twice. */
const TEMPERATURE = 0;

export type ResolvedModel =
  | { ok: true; model: string }
  | { ok: false; reason: "model_unreachable" | "cloud_model_refused"; detail?: string };

/**
 * Which model will do the reading — and whether it is allowed to.
 *
 * CATALOGUE-FIRST, per `resolveOffLanProvider`: the prefix mirror
 * (`providerForModelName`) returns `undefined` for an id it does not know,
 * which reads as "local" and is precisely how an uncatalogued cloud id would
 * slip through. The catalogue is asked first and its answer wins.
 *
 * A gateway that cannot be listed is `model_unreachable`, not a fallback to a
 * hardcoded tag: `email-analysis.service.ts` carries a `mistral:7b-instruct`
 * fallback that is not pulled in production and 404s upstream, which turns
 * every analysis into a silent default. A worker that writes must fail loudly.
 */
export async function resolveFilingModel(prisma: PrismaClient): Promise<ResolvedModel> {
  let installed: Set<string>;
  try {
    const models = await aiGateway.listModels();
    // 🔴 A DEGRADED listing is treated as unreachable, not as "no local
    // models". `resolveActiveChatModel` accepts `null` for "could not confirm"
    // and passes the stored tag through unresolved, which is right for a
    // dashboard that must render something — and wrong here. Extracting
    // against a model we could not confirm is installed is how a filing run
    // ends up dispatched to whatever the gateway falls back to.
    if (models.degraded === true || (models.degraded_providers?.length ?? 0) > 0) {
      return { ok: false, reason: "model_unreachable", detail: "model listing degraded" };
    }
    installed = localModelIdentifiers(models.models ?? []);
  } catch (err) {
    logger.warn({ err }, "filing: could not list models");
    return { ok: false, reason: "model_unreachable", detail: "model listing failed" };
  }

  const model = resolveActiveChatModel(await readActiveChatModel(prisma), installed);
  if (!model) {
    return { ok: false, reason: "model_unreachable", detail: "no local model installed" };
  }

  // Belt and braces. `localModelIdentifiers` already filtered to local
  // providers, so a non-local answer here means the catalogue disagrees with
  // itself — and a disagreement about whether a request leaves the LAN is
  // resolved in the direction of not sending it.
  const offLan = await resolveOffLanProvider({ user: undefined, model });
  if (offLan) {
    return { ok: false, reason: "cloud_model_refused", detail: offLan };
  }
  return { ok: true, model };
}

/** One JSON-shaped call, with the single repair retry. Returns the raw parsed
 *  value or null; the schema — not this function — decides what is valid. */
async function askForJson(args: {
  model: string;
  system: string;
  text: string;
  maxTokens: number;
  parse: (v: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
}): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
  const first = await completeOnce({
    system: args.system,
    text: buildUserTurn(args.text),
    model: args.model,
    temperature: TEMPERATURE,
    maxTokens: args.maxTokens,
  });

  // 🔴 `completeOnce` resolves `{content: ""}` on empty content rather than
  // throwing. Treated as a parse failure explicitly — an empty reply that fell
  // through as "nothing extracted" would file a document as having no
  // counterparty, which is a wrong answer wearing a right answer's clothes.
  const firstParsed = first.content.trim().length === 0 ? null : extractJson(first.content);
  let lastError = "no JSON object in the reply";
  if (firstParsed !== null) {
    const r = args.parse(firstParsed);
    if (r.ok) return r;
    lastError = r.error;
  }

  const repair = await completeOnce({
    system: args.system,
    text: buildRepairTurn(args.text, first.content.slice(0, 2000), lastError),
    model: args.model,
    temperature: TEMPERATURE,
    maxTokens: args.maxTokens,
  });
  const repairParsed = repair.content.trim().length === 0 ? null : extractJson(repair.content);
  if (repairParsed === null) return { ok: false, detail: "no JSON object after repair" };
  const r2 = args.parse(repairParsed);
  if (r2.ok) return r2;
  return { ok: false, detail: r2.error };
}

/** Compact a zod error to something a repair prompt can act on without
 *  becoming a second document. */
function zodMessage(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Read one source.
 *
 * `storedPath` is used ONLY by the deterministic screen and never reaches the
 * model — see `buildUserTurn`.
 */
export async function extractFromText(args: {
  model: string;
  storedPath: string;
  text: string;
  denylist?: readonly string[];
}): Promise<ExtractOutcome> {
  // ── Layer 1: no model call at all ────────────────────────────────────────
  const screen = screenSource({
    storedPath: args.storedPath,
    text: args.text,
    denylist: args.denylist,
  });
  if (screen.blocked) {
    return {
      ok: false,
      reason: screen.site === "text" ? "phi_record" : "phi_path",
      detail: screen.signals.join(","),
    };
  }

  // ── Layer 2: the classifier ──────────────────────────────────────────────
  const classified = await askForJson({
    model: args.model,
    system: CLASSIFY_SYSTEM,
    text: args.text,
    maxTokens: CLASSIFY_MAX_TOKENS,
    parse: (v) => {
      const r = ClassifyOut.safeParse(v);
      return r.success
        ? { ok: true as const, value: r.data }
        : { ok: false as const, error: zodMessage(r.error) };
    },
  });
  if (!classified.ok) return { ok: false, reason: "bad_json", detail: classified.detail };
  const c = classified.value as ClassifyOut;

  // 🔴 IN CODE, NOT IN THE PROMPT. The model is asked for a role and a verdict
  // separately, and a model that answers `PATIENT_RECORD` / `CLEAN` — which
  // small models do, reading "clean" as "well-formed" — must not be believed
  // about the second answer when the first one already settled it.
  const verdict: PhiVerdictValue = c.role === "PATIENT_RECORD" ? "RECORD" : c.phi.verdict;
  if (verdict === "RECORD") {
    return { ok: false, reason: "phi_record", detail: c.phi.signals.join(",") };
  }
  if (c.role === "PERSONAL") {
    return { ok: false, reason: "not_business", detail: "personal document" };
  }

  // ── Layer 3: extraction under the strict allow-lists ─────────────────────
  const extracted = await askForJson({
    model: args.model,
    system: EXTRACT_SYSTEM,
    text: args.text,
    maxTokens: EXTRACT_MAX_TOKENS,
    parse: (v) => {
      const r = ExtractOut.safeParse(v);
      return r.success
        ? { ok: true as const, value: r.data }
        : { ok: false as const, error: zodMessage(r.error) };
    },
  });
  if (!extracted.ok) return { ok: false, reason: "bad_json", detail: extracted.detail };

  const raw = extracted.value as ExtractOut;

  // ── Evidence verification ────────────────────────────────────────────────
  const companies = verifyEvidence(raw.companies, args.text);
  const people = verifyEvidence(raw.people, args.text);
  const projects = verifyEvidence(raw.projects, args.text);
  const moneyDocuments = verifyEvidence(raw.moneyDocuments, args.text);
  const deals = verifyEvidence(raw.deals, args.text);
  const droppedUnverified =
    companies.droppedUnverified +
    people.droppedUnverified +
    projects.droppedUnverified +
    moneyDocuments.droppedUnverified +
    deals.droppedUnverified;

  const posture = applyPhiPosture(
    {
      companies: companies.kept,
      people: people.kept,
      projects: projects.kept,
      moneyDocuments: moneyDocuments.kept,
      deals: deals.kept,
    },
    verdict,
  );

  return {
    ok: true,
    result: {
      phiVerdict: verdict,
      role: c.role,
      counterparty: c.counterparty,
      confidence:
        verdict === "MENTIONS" ? Math.min(c.confidence, MENTIONS_CONFIDENCE_CAP) : c.confidence,
      entities: posture.entities,
      droppedUnverified,
      droppedPhi: posture.droppedPhi,
      phiSignals: c.phi.signals as PhiSignal[],
      model: args.model,
    },
  };
}

/**
 * The MENTIONS posture, and the output post-filter.
 *
 * MENTIONS is the dental-lab invoice: a real vendor bill that lists patient
 * case names. Refusing it loses the vendor and the money; extracting it
 * naively leaks names. So:
 *
 *   - every `person` entity is dropped outright, not filtered — a person on
 *     such a document is a patient until proven otherwise, and nothing in the
 *     text proves otherwise;
 *   - every verbatim quote is replaced by its `chunkIdx` locator, because a
 *     quote from a page that lists cases is the leak in miniature;
 *   - company and money survive, which is the entire reason the class exists.
 *
 * The post-filter then re-runs EVERY string that would be persisted through
 * the text screen, on CLEAN documents too. A hit drops the field, not the
 * document: by this point the document has already been judged, and the
 * narrower question is whether this particular string carries something it
 * should not.
 */
export function applyPhiPosture(
  entities: ExtractOut,
  verdict: PhiVerdictValue,
): { entities: ExtractOut; droppedPhi: number } {
  let dropped = 0;

  /** An OPTIONAL string: a hit drops the field and keeps the entity. */
  const optional = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    if (screenPersistedString(v) !== null) return v;
    dropped += 1;
    return undefined;
  };

  /**
   * A REQUIRED string — a company's name, a project's title.
   *
   * A hit here drops the whole entity, and that asymmetry is deliberate: an
   * optional field can go missing and leave a usable record, but a record
   * whose IDENTITY tripped the screen is not a record with a redacted field,
   * it is a record that should not exist. Returning the value anyway (the
   * shape `?? x.name` invites) would make the screen decorative.
   */
  const requiredSurvives = (v: string): boolean => {
    if (screenPersistedString(v) !== null) return true;
    dropped += 1;
    return false;
  };

  const scrubEvidence = <T extends { evidence: { quote: string; chunkIdx?: number }[] }>(
    e: T,
  ): T => {
    if (verdict === "MENTIONS") {
      // Locator only. `quote` is non-optional in the schema, so it becomes an
      // empty marker rather than a missing key — the card renders the locator
      // and the owner opens the file to see the rest.
      return { ...e, evidence: e.evidence.map((ev) => ({ quote: "", chunkIdx: ev.chunkIdx })) };
    }
    const kept = e.evidence.filter((ev) => screenPersistedString(ev.quote) !== null);
    dropped += e.evidence.length - kept.length;
    return { ...e, evidence: kept };
  };

  if (verdict === "MENTIONS") dropped += entities.people.length;
  const people = verdict === "MENTIONS" ? [] : entities.people;

  return {
    entities: {
      companies: entities.companies
        .filter((x) => requiredSurvives(x.name))
        .map((x) => scrubEvidence({ ...x, address: optional(x.address) })),
      people: people
        .filter((x) => requiredSurvives(x.displayName))
        .map((x) => scrubEvidence({ ...x, roleTitle: optional(x.roleTitle) })),
      projects: entities.projects
        .filter((x) => requiredSurvives(x.name))
        .map((x) => scrubEvidence({ ...x, summary: optional(x.summary) })),
      moneyDocuments: entities.moneyDocuments.map((x) =>
        scrubEvidence({ ...x, counterpartyName: optional(x.counterpartyName) }),
      ),
      deals: entities.deals
        .filter((x) => requiredSurvives(x.title))
        .map((x) => scrubEvidence(x)),
    },
    droppedPhi: dropped,
  };
}
