/**
 * WARP-2979 (ADR-059 P4 §6.9–§6.11, DS-007, D15–D23) — Droplet's incident
 * narrator: a short "Summary by Droplet" for each notice or alert incident,
 * written in the background, ON THIS BOX ONLY, from structured data only.
 *
 * WHEN (§6.9.1). An incident is `pending` when it seals (the engine's seal
 * and a resolve that seals set it, when its severity is not info and
 * `SecurityAiSettings.summaries = on`) or when a person asks (route 28,
 * "Summarise now" / "Regenerate"). Plain activity is never narrated (CHECK).
 *
 * THE TICK (§6.9.3), every minute on the cron runtime with NO lockKey — a
 * model call can outlive the lock's 60 s transaction, whose writes would then
 * roll back (the filing tick's lesson, index.ts). Exclusion is the in-process
 * `running` flag plus the per-incident claim:
 *   1. `running` → return;
 *   2. summaries off → return (health not_configured);
 *   3. expire: `pending` 7 days after the last activity → `expired`;
 *   4. count what waits (and, every 10th tick, what failed in a day);
 *      nothing waiting → done (the model is not even listed);
 *   5. chat busy (`interactiveInferenceIdle`: in flight, or ended < 30 s
 *      ago) → note the yield, return;
 *   6. the model: `resolveLocalBackgroundModel(prisma, {refuseCloudActive})`,
 *      cached 60 s. No local model → note `unavailable`, return. Not an
 *      attempt: nothing is claimed; after 7 days the incident expires;
 *   7. at most 30 model calls in the rolling hour (in process) → return;
 *   8. pick up to 5: alert before notice; never tried first (newest activity
 *      first), then retries oldest attempt first; a claim younger than 5 min
 *      is someone's lease;
 *   9. for each, re-checking 5 and 7: claim (CAS on the lease as read) →
 *      build the input → call → check → store. A YIELD (a chat started and
 *      aborted the call) releases the claim, is not an attempt, and stops
 *      the batch. A FAILURE counts an attempt; the third is `failed`.
 * "Batched" means several calls back to back in one tick while chat stays
 * idle — never several incidents in one prompt (D16).
 *
 * YIELDING (§6.9.2, D17), three layers: it does not start unless chat has
 * been idle for 30 s; its request carries gateway priority 10 (BACKGROUND),
 * so a chat that arrives while it waits in the gateway's queue goes first;
 * and it aborts its own call the moment an interactive request starts. A
 * queued request that is aborted frees its place; whether the runtime stops
 * generating mid-answer is the box proof's to measure.
 *
 * 🔴 THE LOCAL PIN (§6.10, DS-007). Not a setting, not a parameter, not the
 * chat model picker: security events are location and presence data about
 * people.
 *   1. the request says local: `NARRATOR_PROVIDER` on every call, and this is
 *      the only gateway call in any security service (a static test);
 *   2. the model is local: only the local-only resolver picks it, and it
 *      refuses a cloud ACTIVE model rather than fall back (Paused);
 *   3. the gateway routes an explicit local provider to the on-box runtime
 *      whatever the model is called (ai-gateway router.py; its test pins it);
 *   4. there is no other path: no one-shot completion helper, no agent loop,
 *      no per-person cloud decision (which answers "allowed" for a principal
 *      with no person behind it), and NO fallback of any kind.
 * With no local model there is no summary — only the codes.
 *
 * STORAGE (§6.11.2). Written with a compare-and-set on the claim: a seal or a
 * Regenerate that cleared the lease meanwhile makes the write miss, the text
 * is discarded, and the next tick narrates the newer incident. It never bumps
 * `SecurityIncident.version` (P3's CAS for the engine and for people — a
 * summary must never make an acknowledgement 409), and writes no ActivityRow
 * (D23: it changes no security state). Who may read it is
 * security-narrative-view.ts.
 *
 * In memory: the rate window, the model cache and health (one orchestrator
 * process per box; a restart resets the hour).
 */
import type { PrismaClient, SecurityIncidentReason } from "@prisma/client";
import * as aiGateway from "./ai-gateway.client.js";
import { contentToText, type ChatResponse } from "../types/index.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import { readSecurityAiSettings, SECURITY_AI_SETTINGS_ID, type SecurityAiSettingsView } from "./security-ai-settings.js";
import { resolveLocalBackgroundModel, type ResolvedModel } from "./local-background-model.js";
import { interactiveInferenceIdle, onInteractiveInferenceStart } from "./interactive-inference.service.js";
import { stripUnsafeDisplayChars } from "./security-audit.js";
import { loadCameraLabels } from "./security-zones.service.js";
import { resolveSecurityTimezone } from "./security-mode.service.js";
import {
  SECURITY_NARRATIVE_PROMPT_VERSION,
  SECURITY_NARRATIVE_SYSTEM_PROMPT,
  buildNarrativeInput,
  type NarrativeAudience,
  type NarrativeInputV1,
  type NarrativeMemberRow,
} from "../lib/security-narrative-prompt.js";
import { checkNarrative, type NarrativeCheckRule } from "../lib/security-narrative-check.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-narrator");

/**
 * 🔴 DS-007 — the security narrator is pinned to the on-box runtime IN CODE. Not a setting, not a
 * parameter, not the chat model picker. Security events are location and presence data about people.
 * The gateway routes an explicit local provider to the on-box runtime whatever the model is called
 * (ai-gateway/router.py `resolve_provider`).
 */
export const NARRATOR_PROVIDER = "local" as const;
/** The gateway's BACKGROUND priority (ai-gateway scheduler.py): a chat queued behind it goes first. */
export const NARRATOR_PRIORITY = 10;
export const SECURITY_NARRATOR_INTERVAL_MS = 60_000;
export const NARRATOR_MAX_CALLS_PER_HOUR = 30;
export const NARRATOR_MAX_PER_TICK = 5;
export const SECURITY_NARRATIVE_MAX_ATTEMPTS = 3;
/** A claim younger than this is someone's lease; an attempt older than this may be retried. */
export const NARRATOR_LEASE_MS = 5 * 60_000;
/** `pending` this long after the incident's last activity → `expired`. */
export const NARRATIVE_EXPIRE_MS = 7 * 86_400_000;
/** gpt-oss spends output tokens on reasoning first; 700 with effort low leaves room for the text. */
export const NARRATOR_MAX_TOKENS = 700;
export const NARRATOR_CALL_TIMEOUT_MS = 90_000;
const MODEL_CACHE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FAILED_COUNT_EVERY_TICKS = 10;
const MEMBERS_READ = 400;
const TOKEN_SAMPLES = 50;

/** One retry line per rule: it names the rule, never quotes the text. */
const RETRY_LINE: Readonly<Record<NarrativeCheckRule, string>> = {
  SHAPE: "Your last answer was not in the right form. Write two to four plain sentences, under 600 characters, with no markdown, links, lists or symbols.",
  NAMES: "Your last answer named a person. Do not name anyone: say someone or a person.",
  TIMES: "Your last answer gave a time that is not in the JSON. Give only the times written in the JSON, exactly as written.",
  WORDS: "Your last answer used a word that is not allowed. Do not say monitored, alarm, armed, secure, protected, guarded, zone, intruder, burglar, thief, break-in or stolen.",
};

export type NarrativeError = "MODEL_ERROR" | "TIMEOUT" | "LENGTH" | "EMPTY" | `CHECK_FAILED:${NarrativeCheckRule}`;

export interface NarratorDeps {
  now?: () => Date;
}

// ── health (§6.15) ──────────────────────────────────────────────────────────

export interface NarratorHealthState {
  /** Set by `registerSecurityNarratorJobs`. Null = the narrator is not running (§7's boot assertion). */
  registeredAt: Date | null;
  /** The last tick that completed. */
  lastOkAt: Date | null;
  lastError: { at: Date; message: string } | null;
  /** The last time it stood aside for chat. */
  lastYieldAt: Date | null;
  /** The local model could not be used (none, degraded, unreachable, or a cloud model active). Cleared when it can. */
  unavailable: { reason: string; at: Date } | null;
  /** The last summary written. */
  lastWrittenAt: Date | null;
  /** `failed` incidents with an attempt in the last 24 h (counted every 10th tick). */
  failedLastDay: number;
  /** `pending` incidents, counted every tick. */
  pending: number;
  /** For the §12 measurement: the last call's `usage.total_tokens`, the last 50 of them, and its duration. */
  lastTotalTokens: number | null;
  tokenSamples: number[];
  lastCallMs: number | null;
}

const EMPTY_HEALTH = (): NarratorHealthState => ({
  registeredAt: null,
  lastOkAt: null,
  lastError: null,
  lastYieldAt: null,
  unavailable: null,
  lastWrittenAt: null,
  failedLastDay: 0,
  pending: 0,
  lastTotalTokens: null,
  tokenSamples: [],
  lastCallMs: null,
});

const narratorHealth: NarratorHealthState = EMPTY_HEALTH();
let running = false;
let ticks = 0;
/** Start times (ms) of the model calls in the rolling hour. */
let callStarts: number[] = [];
let modelCache: { at: number; result: ResolvedModel } | null = null;

export function narratorHealthState(): Readonly<NarratorHealthState> {
  return narratorHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetNarratorForTests(): void {
  Object.assign(narratorHealth, EMPTY_HEALTH());
  running = false;
  ticks = 0;
  callStarts = [];
  modelCache = null;
}

/**
 * The `summaries` row, pure. Every viewer; it names no area, camera or incident.
 *   · down "Not running" — not registered (the boot assertion);
 *   · not_configured "Turned off in Security settings";
 *   · down "Couldn't check for summaries to write: <reason>" — a tick threw after the last good one;
 *   · down "Paused: the AI model on this Droplet isn't available" — newer than the last summary written;
 *   · down "Couldn't write N summaries in the last day";
 *   · ok "Written on this Droplet, never in the cloud" (+ "; N waiting"). Waiting for chat is normal: ok.
 */
export function narratorHealthRow(
  state: Readonly<NarratorHealthState>,
  settings: Pick<SecurityAiSettingsView, "summaries"> | null,
  now: Date,
): SecurityHealthRow {
  void now;
  const lastSeenAt = state.lastOkAt ? state.lastOkAt.toISOString() : null;
  const row = (st: SecurityHealthRow["state"], detail: string): SecurityHealthRow => ({ id: "summaries", state: st, detail, lastSeenAt });
  if (!state.registeredAt) return row("down", "Not running");
  if (settings?.summaries === "off") return row("not_configured", "Turned off in Security settings");
  if (state.lastError && (!state.lastOkAt || state.lastError.at.getTime() > state.lastOkAt.getTime())) {
    return row("down", `Couldn't check for summaries to write: ${state.lastError.message}`);
  }
  if (state.unavailable && (!state.lastWrittenAt || state.unavailable.at.getTime() > state.lastWrittenAt.getTime())) {
    return row("down", "Paused: the AI model on this Droplet isn't available");
  }
  if (state.failedLastDay > 0) {
    return row("down", `Couldn't write ${state.failedLastDay} ${state.failedLastDay === 1 ? "summary" : "summaries"} in the last day`);
  }
  return row("ok", `Written on this Droplet, never in the cloud${state.pending > 0 ? `; ${state.pending} waiting` : ""}`);
}

/**
 * The row /security/health shows. NEVER throws: settings that cannot be read
 * are read as `on` — that is what the job does with its defaults; nothing is
 * created from a GET.
 */
export async function securitySummariesHealth(prisma: Pick<PrismaClient, "securityAiSettings">, now: Date): Promise<SecurityHealthRow> {
  let settings: Pick<SecurityAiSettingsView, "summaries"> | null = null;
  try {
    const row = await prisma.securityAiSettings.findUnique({ where: { id: SECURITY_AI_SETTINGS_ID }, select: { summaries: true } });
    settings = { summaries: row?.summaries ?? "on" };
  } catch (err) {
    logger.warn({ err }, "summaries health: the AI settings could not be read");
  }
  return narratorHealthRow(narratorHealth, settings, now);
}

/** A fixed phrase for the health row, never the raw error (it can name internals). */
function healthReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^P10\d\d$/.test(code)) return "the database didn't answer";
  return "something went wrong on this Droplet";
}

// ── the model call ──────────────────────────────────────────────────────────

/** The one gateway call in any security service (static test E). */
async function callNarratorModel(model: string, input: NarrativeInputV1, signal: AbortSignal, retry: NarrativeCheckRule | null): Promise<Response> {
  return aiGateway.chat(
    {
      model,
      provider: NARRATOR_PROVIDER,
      stream: false,
      temperature: retry ? 0.2 : 0,
      max_tokens: NARRATOR_MAX_TOKENS,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: retry ? `${SECURITY_NARRATIVE_SYSTEM_PROMPT}\n${RETRY_LINE[retry]}` : SECURITY_NARRATIVE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
    },
    signal,
    undefined, // no user: a background job, never a person's key
    { priority: NARRATOR_PRIORITY },
  );
}

type Attempt =
  | { kind: "written"; text: string; model: string }
  | { kind: "failed"; error: NarrativeError }
  | { kind: "yield" }
  | { kind: "rate" };

function callsInLastHour(nowMs: number): number {
  callStarts = callStarts.filter((t) => nowMs - t < HOUR_MS);
  return callStarts.length;
}

/** `narrativeModel`: the response's `model` when it is a sane string, else the local id that was asked for. */
function modelName(response: unknown, requested: string): string {
  const m = typeof response === "string" ? stripUnsafeDisplayChars(response).trim() : "";
  return m.length > 0 && m.length <= 120 ? m : requested;
}

/** One summary: the call, the check, one retry. Yields when a chat starts. */
async function narrateOnce(model: string, input: NarrativeInputV1, forbidden: readonly string[], now: () => Date): Promise<Attempt> {
  let retry: NarrativeCheckRule | null = null;
  for (let call = 0; call < 2; call++) {
    const nowMs = now().getTime();
    if (!interactiveInferenceIdle(nowMs)) return { kind: "yield" };
    if (callsInLastHour(nowMs) >= NARRATOR_MAX_CALLS_PER_HOUR) return { kind: "rate" };
    callStarts.push(nowMs);

    const yielded = new AbortController();
    const unsubscribe = onInteractiveInferenceStart(() => yielded.abort());
    const timeout = AbortSignal.timeout(NARRATOR_CALL_TIMEOUT_MS);
    const started = Date.now();
    let body: ChatResponse;
    try {
      const res = await callNarratorModel(model, input, AbortSignal.any([yielded.signal, timeout]), retry);
      body = (await res.json()) as ChatResponse;
    } catch (err) {
      if (yielded.signal.aborted) return { kind: "yield" };
      if (timeout.aborted) return { kind: "failed", error: "TIMEOUT" };
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "security narrator: the model call failed");
      return { kind: "failed", error: "MODEL_ERROR" };
    } finally {
      unsubscribe();
    }
    if (yielded.signal.aborted) return { kind: "yield" };
    narratorHealth.lastCallMs = Date.now() - started;
    const tokens = body?.usage?.total_tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      narratorHealth.lastTotalTokens = tokens;
      narratorHealth.tokenSamples = [...narratorHealth.tokenSamples, tokens].slice(-TOKEN_SAMPLES);
    }

    const choice = body?.choices?.[0];
    const text = contentToText(choice?.message?.content ?? null);
    if (choice?.finish_reason === "length") return { kind: "failed", error: "LENGTH" };
    if (text.trim().length === 0) return { kind: "failed", error: "EMPTY" };
    const checked = checkNarrative(text, input, forbidden);
    if (checked.ok) return { kind: "written", text: checked.text, model: modelName(body?.model, model) };
    if (call === 1) return { kind: "failed", error: `CHECK_FAILED:${checked.rule}` };
    retry = checked.rule;
  }
  return { kind: "failed", error: "MODEL_ERROR" };
}

// ── loading one incident ──────────────────────────────────────────────────

const NARRATE_SELECT = {
  id: true,
  scope: true,
  zoneName: true,
  zoneKind: true,
  scopeCamera: true,
  openedInMode: true,
  firstActivityAt: true,
  eventCount: true,
  cameras: true,
  severity: true,
  narrativeState: true,
  narrativeAttempts: true,
  narrativeAttemptAt: true,
} as const;

type Picked = { id: string; narrativeAttemptAt: Date | null; narrativeAttempts: number };

/** How the mode the incident opened in was set — from the mode history, never guessed. */
async function modeSourceAt(prisma: PrismaClient, at: Date, mode: string): Promise<"schedule" | "manual" | null> {
  const row = await prisma.securityEvent.findFirst({
    where: { kind: "mode_changed", startedAt: { lte: at } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { labels: true },
  });
  const [m, source] = row?.labels ?? [];
  return m === mode && (source === "schedule" || source === "manual") ? source : null;
}

async function loadInput(
  prisma: PrismaClient,
  id: string,
  ctx: { labels: ReadonlyMap<string, string>; tz: string | null },
): Promise<{ input: NarrativeInputV1; audience: NarrativeAudience } | null> {
  const incident = await prisma.securityIncident.findUnique({ where: { id }, select: NARRATE_SELECT });
  if (!incident || incident.severity === "info") return null;
  const reasons: Array<Pick<SecurityIncidentReason, "code" | "severity" | "evidenceEventId" | "evidenceCamera" | "evidenceKind" | "evidenceLabel" | "evidenceAt" | "detail" | "relatedCamera" | "relatedLock">> =
    await prisma.securityIncidentReason.findMany({
      where: { incidentId: id },
      select: {
        code: true,
        severity: true,
        evidenceEventId: true,
        evidenceCamera: true,
        evidenceKind: true,
        evidenceLabel: true,
        evidenceAt: true,
        detail: true,
        relatedCamera: true,
        relatedLock: true,
      },
    });
  const triage = await prisma.securityEventTriage.findMany({
    where: { incidentId: id, outcome: "grouped" },
    orderBy: { eventId: "asc" },
    take: MEMBERS_READ,
    select: { event: true },
  });
  const members: NarrativeMemberRow[] = triage
    .map((t) => t.event)
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e) => ({
      id: e.id,
      source: e.source,
      sourceRef: e.sourceRef,
      kind: e.kind,
      camera: e.camera,
      labels: e.labels,
      cameraZones: e.cameraZones,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
    }));
  return buildNarrativeInput({
    incident,
    reasons,
    members,
    modeSource: await modeSourceAt(prisma, incident.firstActivityAt, incident.openedInMode),
    cameraLabels: ctx.labels,
    tz: ctx.tz,
  });
}

/** Up to `limit` incidents in the §6.9.3 order: alert before notice; never tried (newest first), then retries (oldest attempt first). */
async function pickIncidents(prisma: PrismaClient, nowMs: number, limit: number): Promise<Picked[]> {
  const out: Picked[] = [];
  const leaseCutoff = new Date(nowMs - NARRATOR_LEASE_MS);
  const select = { id: true, narrativeAttemptAt: true, narrativeAttempts: true } as const;
  for (const severity of ["alert", "notice"] as const) {
    if (out.length >= limit) break;
    out.push(
      ...(await prisma.securityIncident.findMany({
        where: { narrativeState: "pending", severity, narrativeAttemptAt: null },
        orderBy: [{ lastActivityAt: "desc" }, { id: "asc" }],
        take: limit - out.length,
        select,
      })),
    );
    if (out.length >= limit) break;
    out.push(
      ...(await prisma.securityIncident.findMany({
        where: { narrativeState: "pending", severity, narrativeAttemptAt: { lt: leaseCutoff } },
        orderBy: [{ narrativeAttemptAt: "asc" }, { lastActivityAt: "desc" }, { id: "asc" }],
        take: limit - out.length,
        select,
      })),
    );
  }
  return out;
}

/** The box's directory, for the NAMES rule: every display name and username. */
async function directoryNames(prisma: PrismaClient): Promise<string[]> {
  const users = await prisma.user.findMany({ select: { username: true, displayName: true } });
  return users.flatMap((u) => [u.username, u.displayName].filter((x): x is string => typeof x === "string" && x.length > 0));
}

async function localModel(prisma: PrismaClient, nowMs: number): Promise<ResolvedModel> {
  if (modelCache && nowMs - modelCache.at < MODEL_CACHE_MS) return modelCache.result;
  const result = await resolveLocalBackgroundModel(prisma, { refuseCloudActive: true });
  modelCache = { at: nowMs, result };
  return result;
}

// ── the tick ────────────────────────────────────────────────────────────────

export interface NarratorTickResult {
  written: number;
  failed: number;
  yielded: boolean;
}

/** One tick (see the header). A throw sets `lastError` and reaches safeRun. */
export async function tickSecurityNarrator(prisma: PrismaClient, deps: NarratorDeps = {}): Promise<NarratorTickResult> {
  const clock = deps.now ?? (() => new Date());
  const result: NarratorTickResult = { written: 0, failed: 0, yielded: false };
  if (running) return result;
  running = true;
  const now = clock();
  ticks++;
  try {
    await runTick(prisma, clock, now, result);
    narratorHealth.lastOkAt = now;
    return result;
  } catch (err) {
    narratorHealth.lastError = { at: now, message: healthReason(err) };
    throw err;
  } finally {
    running = false;
  }
}

async function runTick(prisma: PrismaClient, clock: () => Date, now: Date, result: NarratorTickResult): Promise<void> {
  const nowMs = now.getTime();
  // 2. The switch.
  const settings = await readSecurityAiSettings(prisma);
  if (settings.summaries === "off") return;

  // 3. Expire.
  await prisma.securityIncident.updateMany({
    where: { narrativeState: "pending", lastActivityAt: { lt: new Date(nowMs - NARRATIVE_EXPIRE_MS) } },
    data: { narrativeState: "expired" },
  });

  // 4. What waits.
  narratorHealth.pending = await prisma.securityIncident.count({ where: { narrativeState: "pending" } });
  if (ticks % FAILED_COUNT_EVERY_TICKS === 1) {
    narratorHealth.failedLastDay = await prisma.securityIncident.count({
      where: { narrativeState: "failed", narrativeAttemptAt: { gte: new Date(nowMs - DAY_MS) } },
    });
  }
  if (narratorHealth.pending === 0) {
    narratorHealth.unavailable = null;
    return;
  }

  // 5. Chat first.
  if (!interactiveInferenceIdle(nowMs)) {
    narratorHealth.lastYieldAt = now;
    result.yielded = true;
    return;
  }

  // 6. The local model, or nothing.
  const model = await localModel(prisma, nowMs);
  if (!model.ok) {
    narratorHealth.unavailable = { reason: model.reason, at: now };
    return;
  }
  narratorHealth.unavailable = null;

  // 7. The hour.
  if (callsInLastHour(nowMs) >= NARRATOR_MAX_CALLS_PER_HOUR) return;

  // 8. The pick.
  const picked = await pickIncidents(prisma, nowMs, NARRATOR_MAX_PER_TICK);
  if (picked.length === 0) return;
  const [labels, tz, forbidden] = await Promise.all([loadCameraLabels(prisma), resolveSecurityTimezone(prisma), directoryNames(prisma)]);

  // 9. One at a time.
  for (const p of picked) {
    const at = clock();
    if (!interactiveInferenceIdle(at.getTime())) {
      narratorHealth.lastYieldAt = at;
      result.yielded = true;
      return;
    }
    if (callsInLastHour(at.getTime()) >= NARRATOR_MAX_CALLS_PER_HOUR) return;

    // Claim: CAS on the lease as read.
    const claimAt = at;
    const claim = await prisma.securityIncident.updateMany({
      where: { id: p.id, narrativeState: "pending", narrativeAttemptAt: p.narrativeAttemptAt },
      data: { narrativeAttemptAt: claimAt },
    });
    if (claim.count !== 1) continue;
    const mine = { id: p.id, narrativeState: "pending" as const, narrativeAttemptAt: claimAt };

    const built = await loadInput(prisma, p.id, { labels, tz });
    if (!built) {
      await prisma.securityIncident.updateMany({ where: mine, data: { narrativeAttemptAt: p.narrativeAttemptAt } });
      continue;
    }
    const attempt = await narrateOnce(model.model, built.input, forbidden, clock);

    if (attempt.kind === "yield" || attempt.kind === "rate") {
      // Not an attempt: release the claim and stop the batch.
      await prisma.securityIncident.updateMany({ where: mine, data: { narrativeAttemptAt: p.narrativeAttemptAt } });
      if (attempt.kind === "yield") {
        narratorHealth.lastYieldAt = clock();
        result.yielded = true;
        logger.info({ incidentId: p.id }, "security narrator: stood aside for chat");
      }
      return;
    }
    if (attempt.kind === "failed") {
      const final = p.narrativeAttempts + 1 >= SECURITY_NARRATIVE_MAX_ATTEMPTS;
      await prisma.securityIncident.updateMany({
        where: mine,
        data: { narrativeAttempts: { increment: 1 }, narrativeError: attempt.error, ...(final ? { narrativeState: "failed" as const } : {}) },
      });
      result.failed++;
      logger.warn({ incidentId: p.id, error: attempt.error, final }, "security narrator: a summary was not written");
      continue;
    }
    // Written — only if the claim still holds; never the incident's version, never an ActivityRow.
    const written = await prisma.securityIncident.updateMany({
      where: mine,
      data: {
        narrative: attempt.text,
        narrativeModel: attempt.model,
        narrativePromptVersion: SECURITY_NARRATIVE_PROMPT_VERSION,
        narratedAt: clock(),
        narrativeAudience: { ...built.audience },
        narrativeState: "written",
        narrativeError: null,
      },
    });
    if (written.count === 1) {
      result.written++;
      narratorHealth.lastWrittenAt = clock();
      narratorHealth.pending = Math.max(0, narratorHealth.pending - 1);
    } else {
      logger.info({ incidentId: p.id }, "security narrator: the incident moved while it was written; the text is discarded");
    }
  }
}

// ── registration ────────────────────────────────────────────────────────────

/**
 * Wire the narrator (index.ts, right after `registerSecurityLinkJobs`): every
 * minute, NO lockKey (see the header), and set `registeredAt` — the
 * `summaries` health row's boot assertion.
 */
export function registerSecurityNarratorJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  prisma: PrismaClient,
  deps: NarratorDeps = {},
): void {
  cronRuntime.scheduleInterval(SECURITY_NARRATOR_INTERVAL_MS, async () => {
    const r = await tickSecurityNarrator(prisma, deps);
    if (r.written > 0 || r.failed > 0) logger.info(r, "security narrator tick");
  });
  narratorHealth.registeredAt = new Date();
}
