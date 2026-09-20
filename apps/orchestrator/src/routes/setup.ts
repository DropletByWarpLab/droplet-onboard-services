/**
 * `/api/setup/state` — first-run setup state machine (PR #372 /
 * docs/ONBOARDING_STATE_MACHINE.md).
 *
 * Replaces the stateless, Nextcloud-`installed`-derived `setupRequired`
 * boolean with an explicit, resumable server-side state.
 *
 *   GET  /api/setup/state
 *     → { appliance: "unclaimed"|"ready", setup_step, user_tour_completed }
 *     The dashboard's AuthGate routes off this: unclaimed → wizard@step;
 *     ready + tour pending → tour; else dashboard.
 *
 *   PATCH /api/setup/state
 *     Body (any non-empty subset):
 *       { setup_step?: SetupStep,         // resumability — persist wizard step
 *         appliance?: "ready",            // wizard-finish transition
 *         user_tour_completed?: true }    // post-claim tour done
 *     → the updated state, same shape as GET.
 *
 * The router is mounted BEFORE the auth middleware in app.ts (allow-listed
 * in middleware/auth.ts) because first-run resumability happens before any
 * user exists, exactly like the existing public POST /auth/setup. The wire
 * shape is snake_case to match the spec contract; the service speaks
 * camelCase internally.
 *
 * AUTH POSTURE (M1/M2, PR #372 re-review):
 *   - GET is PUBLIC and SIDE-EFFECT-FREE (findUnique; never writes — M5).
 *   - PATCH of `setup_step` / `user_tour_completed` stays PUBLIC: these are
 *     low-sensitivity resumability hints that the wizard needs to persist
 *     pre-claim, and neither can claim the box.
 *   - PATCH of `appliance:"ready"` — the lifecycle-MUTATING claim transition
 *     — is GATED. It is honored only when the caller proves they're the
 *     legitimate owner: either a valid dashboard session cookie (the wizard
 *     authenticates at the account step, so the finish PATCH rides that
 *     cookie), or — the durable backstop — the service's M2 precondition
 *     that an admin account already exists (`markApplianceReady` rejects an
 *     account-less box with 409). An unauthenticated pre-claim caller can
 *     therefore neither take the box over (flip it ready early) nor lock the
 *     owner out.
 *
 * The GATE constraint (PR #372) keeps claim / org / team out of SetupStep,
 * so an unknown step is a 400 here (the service's InvalidSetupStepError),
 * never silently coerced onto a resume target the wizard can't render.
 */
import { Router, type Request } from "express";
import { type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  getSetupState,
  setSetupStep,
  advanceSetupStepToAtLeast,
  markApplianceReady,
  markTourCompleted,
  isSetupStep,
  STEP_AFTER_CLAIM,
  InvalidSetupStepError,
  SetupNotCompleteError,
  type SetupState,
} from "../services/setup.service.js";
import {
  consumeClaimCode,
  CLAIM_OUTCOME,
} from "../services/setup-claim.service.js";
import {
  persistOrg,
  SlugInvalidError,
  SlugTakenError,
} from "../services/setup-org.service.js";
import {
  checkBoxName,
  setBoxName,
  renameBoxName,
  BoxNameInvalidError,
  type BoxNameClaimer,
  type BoxNameReleaser,
} from "../services/box-name.service.js";
import {
  createBridgeBoxNamePersister,
  createBoxNameClaimer,
  createBoxNameReleaser,
} from "../services/tls-issuance.adapters.js";
import { reissueTlsNow } from "../services/tls-reissue.singleton.js";
import {
  boxNameReasonMessage,
  boxNameToFqdn,
  validateBoxName,
} from "@droplet/shared-types";
import { config } from "../config.js";
import { getApplianceContract } from "../services/appliance-contract.service.js";
import { verifyAccessToken } from "../services/jwt.service.js";
import { checkSession } from "../services/session.service.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { kickScreenQRRefresh } from "../services/screen-qr.service.js";
import { warmDefaultModel } from "../services/model-readiness.service.js";
import { createLogger } from "../lib/logger.js";
import { sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";

const logger = createLogger("setup-route");

// PR #373 / WARP-804 — STEP_AFTER_CLAIM (the wizard step the customer lands on
// after a successful claim: `account`, since claim slots FIRST) is now owned by
// the setup state machine (`services/setup.service.ts`) and imported above, so
// the route, getSetupState, and setSetupStep all read the SAME constant. WARP-804
// also makes the state machine treat a `claim` step on an already-claimed box as
// satisfied (→ STEP_AFTER_CLAIM), closing the lockout where a re-presented claim
// step could never be satisfied.

/**
 * PR #380 — the wizard step the customer lands on after naming their workspace.
 * Org slots AFTER account (welcome → claim → account → org → internet → …, per
 * the #380 spec), so a successful persist advances the resumable wizard to
 * `internet`. This is the ONLY place that step name is written for the org
 * flow; keep it in sync with the dashboard `STEPS` array + `SETUP_STEPS`.
 */
const STEP_AFTER_ORG = "internet";

/**
 * PR #380 — org request body. `name`, `slug`, `tz` are required (the workspace
 * must have a name + reservable host + a time zone). `industry` / `size` are
 * OPTIONAL LOCAL smart-default hints — the orchestrator persists them but never
 * sends them off the box (FEATURES.md §10). `logo` is the optional logo path.
 * Slug *shape* validation lives in the service (setup-org.service.isValidSlug)
 * so the schema only checks presence/type; the service throws the typed
 * SlugInvalidError the route maps to a 400.
 */
const orgSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(80),
  tz: z.string().min(1).max(64),
  industry: z.string().max(80).optional(),
  size: z.string().max(40).optional(),
  logo: z.string().max(512).optional(),
});

/**
 * WARP-631 — wrong-code rate-limit with PROGRESSIVE BACKOFF (replaces the flat
 * PR #373 10-attempts/15-min sliding lockout). A claim code is short and read
 * off a physical display, so an attacker on the LAN could otherwise brute-force
 * it. But the old flat lockout had a field-incident failure mode (2026-06-01):
 * its sliding TTL was bumped on EVERY attempt, so a user who kept trying never
 * let the window elapse — a correct code entered during the lock read as
 * rejected. The backoff model locks for a FIXED, escalating duration instead,
 * so the lock always elapses on its own and a correct code clears the state.
 *
 * FREE_TIER wrong codes are forgiven (inline CLAIM_CODE_INVALID, no lock). The
 * (FREE_TIER+1)th wrong code is the first lock; each successive lockout
 * escalates along BACKOFF_SCHEDULE and caps at its last value. Everything fails
 * OPEN if the cache is down so a flaky Redis can't lock a legitimate owner out
 * of claiming their box. Keyed by client IP.
 */
const CLAIM_FREE_TIER = 3;
/** Lockout seconds for the 1st, 2nd, 3rd … lock; the last value is the cap. */
const CLAIM_BACKOFF_SCHEDULE = [15, 30, 60, 120, 300, 900] as const;
/** Wrong-code counter resets after an hour of no failures (rolling window). */
const CLAIM_FAILS_TTL_SEC = 60 * 60;

/** `ratelimit:setup-claim:fails:<ip>` — running wrong-code count for the IP. */
function claimFailsKey(ip: string): string {
  return `ratelimit:setup-claim:fails:${ip}`;
}
/** `ratelimit:setup-claim:lock:<ip>` — locked-until epoch ms for the IP. */
function claimLockKey(ip: string): string {
  return `ratelimit:setup-claim:lock:${ip}`;
}

/**
 * WARP-631 — PURE progressive-backoff schedule. Maps a running wrong-code count
 * onto the lockout duration in seconds. The first `CLAIM_FREE_TIER` failures
 * are forgiven (0 = no lock); the next failure is the first scheduled lock, and
 * the schedule escalates then caps at its final value. Monotonic
 * non-decreasing. Exported + unit-tested independently of any I/O (AC#7).
 *
 *   idx = failureCount - CLAIM_FREE_TIER - 1
 *   idx < 0                        → 0
 *   else SCHEDULE[min(idx, last)]
 */
export function claimBackoffSeconds(failureCount: number): number {
  const idx = failureCount - CLAIM_FREE_TIER - 1;
  if (idx < 0) return 0;
  return CLAIM_BACKOFF_SCHEDULE[
    Math.min(idx, CLAIM_BACKOFF_SCHEDULE.length - 1)
  ];
}

/**
 * Read the per-IP lock. If a lock exists and is still in the future, the
 * request is locked and we report the whole-seconds wait. Fails OPEN (reports
 * not-locked) on any cache error — a down cache must never brick first-run
 * claiming.
 */
async function checkClaimLock(
  ip: string,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  try {
    const until = (await cacheGet<number>(claimLockKey(ip))) ?? 0;
    const now = Date.now();
    if (until > now) {
      return {
        locked: true,
        retryAfterSeconds: Math.ceil((until - now) / 1000),
      };
    }
    return { locked: false, retryAfterSeconds: 0 };
  } catch {
    return { locked: false, retryAfterSeconds: 0 };
  }
}

/**
 * Record one wrong-code attempt for the IP: bump the rolling failure counter
 * (1h TTL) and, if the new count crosses into a scheduled lock, write the
 * locked-until timestamp with a TTL equal to the lock duration so it expires on
 * its own. Returns the lock duration applied (0 = still within the free tier).
 * Fails OPEN (returns 0) on any cache error.
 */
async function recordClaimFailure(ip: string): Promise<{ lockedSeconds: number }> {
  try {
    const current = (await cacheGet<number>(claimFailsKey(ip))) ?? 0;
    const next = current + 1;
    await cacheSet(claimFailsKey(ip), next, CLAIM_FAILS_TTL_SEC);
    const lockedSeconds = claimBackoffSeconds(next);
    if (lockedSeconds > 0) {
      await cacheSet(
        claimLockKey(ip),
        Date.now() + lockedSeconds * 1000,
        lockedSeconds,
      );
    }
    return { lockedSeconds };
  } catch {
    return { lockedSeconds: 0 };
  }
}

/**
 * Clear the per-IP failure + lock state. Called after a successful (or
 * already-claimed) bind so a correct code always resets the counters (AC#3),
 * and so a brief lock can't outlive a legitimate success.
 */
async function clearClaimRateState(ip: string): Promise<void> {
  await cacheDel(claimFailsKey(ip));
  await cacheDel(claimLockKey(ip));
}

/** Claim request body — a single non-empty `code` string. */
const claimSchema = z.object({
  code: z.string().min(1).max(64),
});

/**
 * WARP-979 — box-name POST body. `name` is the owner-chosen name for the box's
 * secured address `<name>.droplet-us.com`. The service re-validates it against
 * the shared ruleset (`@droplet/shared-types`) before persisting, so the schema
 * only checks presence/type + a generous length ceiling (the shared validator
 * enforces the real 3–40 bound so the ONE ruleset owns the message).
 */
const boxNameSchema = z.object({
  name: z.string().min(1).max(120),
});

/** Map the camelCase domain object onto the snake_case wire contract. */
function toWire(state: SetupState): {
  appliance: "unclaimed" | "ready";
  setup_step: string;
  user_tour_completed: boolean;
} {
  return {
    appliance: state.appliance,
    setup_step: state.setupStep,
    user_tour_completed: state.userTourCompleted,
  };
}

// PATCH body: every field optional, but `.refine` requires at least one so
// an empty patch is a 400 rather than a silent no-op. `setup_step` is
// validated against the shipped enum by the service (isSetupStep);
// `appliance` only ever moves forward to "ready" (the wizard-finish
// transition) — "unclaimed" is the boot default and isn't a client-driven
// target. `user_tour_completed` only flips true (you can't un-see the tour).
/**
 * WARP-1041 — wizard steps whose persistence means the customer is in the
 * BACK HALF of setup: minutes away from the AI step, which is exactly the
 * lead time the 30-90 s GPU model load needs. Reaching (or resuming at)
 * any of these fires a fire-and-forget model warm AFTER the response is
 * sent. `storage` is the primary trigger (storage → discovery → cameras →
 * vpn → ai is minutes of wizard time); the later steps cover mid-wizard
 * resumes that land past storage. The warm itself is debounced 10 min
 * inside model-readiness.service, so repeated PATCHes — including abuse of
 * this pre-auth route — are free, and the worst an anonymous caller can do
 * is load the box's own configured model.
 */
const WARM_TRIGGER_STEPS = new Set([
  "storage",
  "discovery",
  "cameras",
  "vpn",
  "ai",
]);

const patchSchema = z
  .object({
    setup_step: z.string().min(1).optional(),
    appliance: z.literal("ready").optional(),
    user_tour_completed: z.literal(true).optional(),
  })
  .refine(
    (b) =>
      b.setup_step !== undefined ||
      b.appliance !== undefined ||
      b.user_tour_completed !== undefined,
    { message: "At least one of setup_step, appliance, user_tour_completed is required" },
  );

/**
 * WARP-979 — the host `.env` writer for the chosen box name. Injectable so the
 * route test passes a fake (the real one POSTs to the device-bridge). Defaults
 * to the production bridge persister.
 */
export function createSetupRouter(
  prisma: PrismaClient,
  deps?: {
    persistBoxNameToHost?: (name: string) => Promise<void>;
    /** WARP-980 — device-auth name claimer. Defaults to the production
     *  `createBoxNameClaimer()` (real HQ + device-identity); route tests inject a
     *  fake so no HQ / sidecar is touched. */
    claimBoxName?: BoxNameClaimer;
    /** WARP-1109 — device-auth name RELEASER for the rename flow. Frees the box's
     *  current name at HQ before the new claim. Defaults to the production
     *  `createBoxNameReleaser()`; route tests inject a fake. */
    releaseBoxName?: BoxNameReleaser;
    /** WARP-1109 — trigger an immediate cert re-issue under the new FQDN after a
     *  rename. Defaults to the process-wide issuance hook (`reissueTlsNow`, a
     *  no-op until boot registers the composed issuance service); route tests
     *  inject a spy so no issuance runtime is touched. */
    reissueTls?: () => Promise<void>;
    /** WARP-1039 — boot-env fallback for GET /setup/box-name. Defaults to the
     *  `config` snapshot's DROPLET_BOX_NAME (covers a container restart
     *  mid-wizard, where the re-read host .env is the only place the name
     *  survives); tests inject a fake so they never touch the real config. */
    getEnvBoxName?: () => string;
    /** WARP-1041 — fire-and-forget model pre-warm. Defaults to the
     *  production `warmDefaultModel` (debounced, error-swallowing); route
     *  tests inject a spy so no Ollama is touched. */
    warmDefaultModel?: () => Promise<void>;
  },
): Router {
  const router = Router();
  const persistBoxNameToHost =
    deps?.persistBoxNameToHost ?? createBridgeBoxNamePersister();
  const claimBoxNameToHq = deps?.claimBoxName ?? createBoxNameClaimer();
  const releaseBoxNameFromHq = deps?.releaseBoxName ?? createBoxNameReleaser();
  const reissueTls = deps?.reissueTls ?? reissueTlsNow;
  const getEnvBoxName = deps?.getEnvBoxName ?? (() => config.DROPLET_BOX_NAME);
  const warmModel = deps?.warmDefaultModel ?? warmDefaultModel;

  // ── GET /api/setup/state ───────────────────────────────────────
  router.get("/setup/state", async (_req: Request, res, next) => {
    try {
      const state = await getSetupState(prisma);
      res.json(toWire(state));
    } catch (err) {
      next(err);
    }
  });

  // ── PATCH /api/setup/state ─────────────────────────────────────
  // CodeQL js/missing-rate-limiting — these routes are PUBLIC (mounted before
  // authMiddleware) and verify the session cookie inline, so they need their
  // own per-IP ceiling: `sensitiveRateLimit` (60/min) on the writes that
  // mutate the appliance lifecycle / workspace / box name, `standardRateLimit`
  // (300/min) on the read. The WARP-631 claim-code backoff is untouched.
  router.patch("/setup/state", sensitiveRateLimit, async (req: Request, res, next) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid setup state update",
          code: "INVALID_SETUP_PATCH",
          details: parsed.error.flatten(),
        });
        return;
      }
      const body = parsed.data;

      // Pre-validate the step here so we 400 BEFORE any write — the service
      // would also reject it, but failing fast keeps the persisted row
      // untouched on a bad request.
      if (body.setup_step !== undefined && !isSetupStep(body.setup_step)) {
        res.status(400).json({
          error: `Unknown setup step "${body.setup_step}"`,
          code: "INVALID_SETUP_STEP",
        });
        return;
      }

      // M1 — the `appliance:"ready"` claim is the only lifecycle-MUTATING
      // transition, so it is the only one we gate. A request is allowed to
      // claim the box when EITHER:
      //   (a) it carries a valid dashboard session cookie (the wizard's
      //       account step authenticated the owner, so the finish PATCH
      //       rides that cookie — this router is mounted before
      //       authMiddleware so we verify the cookie inline, the same way
      //       routes/pm.ts does for the OIDC authorize endpoint), OR
      //   (b) an admin account already exists, in which case the box is
      //       genuinely claimable and `markApplianceReady` (M2) will honor
      //       it; the service itself fails CLOSED with 409 when no admin
      //       exists, so an anonymous pre-claim caller can never flip it.
      // The session check here is a fast 403 for the common anonymous case;
      // the M2 precondition in the service is the authoritative backstop.
      let claimAuthorized = false;
      if (body.appliance === "ready") {
        const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
        const session = sessionToken ? verifyAccessToken(sessionToken) : null;
        if (session) {
          claimAuthorized = true;
        } else if ((await prisma.user.count()) === 0) {
          res.status(403).json({
            error:
              "Claiming the appliance (appliance:\"ready\") requires an authenticated session or a completed setup.",
            code: "SETUP_CLAIM_FORBIDDEN",
          });
          return;
        }
      }

      // Apply the requested transitions. Order is deliberate: persist the
      // step first (resumability), then the terminal flips. Each helper
      // upserts the singleton and returns the latest state, so the last
      // one wins as the response.
      let latest: SetupState | null = null;
      if (body.setup_step !== undefined) {
        latest = await setSetupStep(prisma, body.setup_step);
      }
      if (body.appliance === "ready") {
        // `authorized` short-circuits the service's admin-count precondition
        // when a valid session proved ownership (covers the freshly-claimed
        // window); otherwise the service re-checks admin existence (M2).
        latest = await markApplianceReady(prisma, { authorized: claimAuthorized });
      }
      if (body.user_tour_completed === true) {
        latest = await markTourCompleted(prisma);
      }

      // `latest` is guaranteed non-null: the schema's refine() rejects an
      // empty patch, so at least one branch above ran.
      res.json(toWire(latest ?? (await getSetupState(prisma))));

      // WARP-1041 — the wizard just advanced into the back half of setup:
      // start loading the chat model into GPU memory NOW so the AI step's
      // first ask lands warm. Strictly after the response (setImmediate),
      // never awaited — a hung/cold Ollama can never stall the wizard.
      // Errors are already swallowed inside warmDefaultModel; the extra
      // catch guards an injected/overridden implementation.
      if (
        body.setup_step !== undefined &&
        WARM_TRIGGER_STEPS.has(body.setup_step)
      ) {
        setImmediate(() => {
          void warmModel().catch(() => undefined);
        });
      }
    } catch (err) {
      if (err instanceof InvalidSetupStepError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      // M2 — claiming an account-less box is a 409 (well-formed request,
      // but the appliance isn't in a claimable state yet). Fail CLOSED:
      // the appliance stays unclaimed.
      if (err instanceof SetupNotCompleteError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      logger.error({ err }, "Failed to update setup state");
      next(err);
    }
  });

  // ── GET /api/setup/appliance ───────────────────────────────────
  //
  // PR #373 — the hardware contract the Claim step renders
  // ({ appliance_id, compute, storage, network, display, supply_chain }).
  // PUBLIC: shown before any account exists. This is a DOCUMENTED STUB — no
  // orchestrator facility produces this exact shape yet; the contract service
  // assembles it (best-effort enriching `network` from the routing
  // /system/info, which is router-only). The route stays thin so the UI has a
  // stable shape to build against while the real per-field sources land.
  router.get("/setup/appliance", async (_req: Request, res, next) => {
    try {
      const contract = await getApplianceContract();
      res.json(contract);
    } catch (err) {
      logger.error({ err }, "Failed to assemble appliance contract");
      next(err);
    }
  });

  // ── POST /api/setup/claim ──────────────────────────────────────
  //
  // PR #373 — bind the appliance to the workspace. Atomic, single-use,
  // rate-limited; the code is hashed at rest and compared in constant time
  // (setup-claim.service). PUBLIC: claiming precedes account creation.
  //
  //   correct code      → 200 { claimed:true, next_step } and advance the
  //                        resumable wizard to `account`. Does NOT flip the
  //                        appliance to "ready" — that's the wizard-FINISH
  //                        transition (#372); claim is the FIRST step. CLEARS
  //                        the per-IP failure/lock counters (WARP-631 AC#3).
  //   already claimed    → 200 { claimed:true, already_claimed:true, next_step }
  //                        — idempotent short-circuit so a refresh/re-run moves
  //                        the customer on instead of erroring. Also clears the
  //                        rate state.
  //   wrong/unknown/expired → 400 { code:"CLAIM_CODE_INVALID" } while within the
  //                        free tier (WARP-631), never echoing the real code;
  //                        the (FREE_TIER+1)th wrong code instead returns
  //                        429 { code:"CLAIM_RATE_LIMITED", retryAfterSeconds }
  //                        + a Retry-After header.
  //   already locked     → 429 { code:"CLAIM_RATE_LIMITED", retryAfterSeconds }
  //                        + Retry-After, BEFORE any DB read.
  router.post("/setup/claim", async (req: Request, res, next) => {
    try {
      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "A claim code is required.",
          code: "CLAIM_CODE_REQUIRED",
        });
        return;
      }

      // WARP-631 — check the per-IP lock BEFORE any DB work so a locked client
      // can't hammer the lookup, and so a correct code attempted DURING a lock
      // still reads as rate-limited (the lock must elapse first). `req.ip` is
      // the client address (Express trust-proxy aware). Fails OPEN if the
      // cache is down (checkClaimLock returns not-locked on error).
      const ip = req.ip ?? "unknown";
      const lock = await checkClaimLock(ip);
      if (lock.locked) {
        res.setHeader("Retry-After", String(lock.retryAfterSeconds));
        res.status(429).json({
          error: "Too many claim attempts. Try again shortly.",
          code: "CLAIM_RATE_LIMITED",
          retryAfterSeconds: lock.retryAfterSeconds,
        });
        return;
      }

      const result = await consumeClaimCode(prisma, parsed.data.code);

      if (result.outcome === CLAIM_OUTCOME.CLAIMED) {
        // A correct code clears the failure/lock counters (WARP-631 AC#3).
        // Best-effort: a cache hiccup here must not fail the committed claim.
        await clearClaimRateState(ip).catch(() => {});
        // Advance the resumable wizard to the next step. Best-effort: a failure
        // to persist the step must not fail the (already-committed) claim — the
        // dashboard also advances locally and re-syncs on the next PATCH.
        // WARP-867: floor semantics — never drags an already-further pointer
        // backward (a fresh claim can't legally have one, but the invariant is
        // cheap and uniform with the re-claim path below).
        try {
          await advanceSetupStepToAtLeast(prisma, STEP_AFTER_CLAIM);
        } catch (stepErr) {
          logger.warn(
            { err: stepErr },
            "Claim succeeded but persisting the post-claim step failed",
          );
        }
        // Unstick the PyPortal: the box just got claimed, so kick the screen-qr
        // poller to move the panel off the modal claim screen onto the live
        // System screen now, instead of waiting up to POLL_INTERVAL_MS. Fire-
        // and-forget — a display hiccup must not fail the (committed) claim.
        kickScreenQRRefresh();
        res.json({ claimed: true, next_step: STEP_AFTER_CLAIM });
        return;
      }

      if (result.outcome === CLAIM_OUTCOME.ALREADY_CLAIMED) {
        // Idempotent short-circuit — the box is already bound, move on. Clear
        // the rate state too so a prior partial-lock can't linger (WARP-631).
        await clearClaimRateState(ip).catch(() => {});
        // WARP-867 — reconcile the resume pointer on a re-presented claim
        // (wizard restarted from welcome after a reboot raced the state
        // probe). Floor semantics, two jobs: (a) HEAL a pointer stranded
        // at/before "claim" — e.g. the original claim's best-effort step
        // persist failed — so the next cold load resumes past the consumed
        // code instead of re-gating on it; (b) never move a further-along
        // pointer backward, so a replayed early step can't manufacture the
        // unsatisfiable-account dead-end from the field report (that
        // regression came from the client re-persisting early steps after
        // the broken cold-load resume; the floor keeps this side immune
        // regardless of client behaviour). Best-effort for the same reason
        // as the fresh-claim path.
        try {
          await advanceSetupStepToAtLeast(prisma, STEP_AFTER_CLAIM);
        } catch (stepErr) {
          logger.warn(
            { err: stepErr },
            "Re-claim acknowledged but reconciling the wizard step failed",
          );
        }
        // Idempotent re-claim — still kick the panel off the claim screen in
        // case a prior transition was missed (e.g. the display was down at the
        // moment of the original claim).
        kickScreenQRRefresh();
        res.json({
          claimed: true,
          already_claimed: true,
          next_step: STEP_AFTER_CLAIM,
        });
        return;
      }

      // Invalid (wrong / unknown / expired). Inline error, no reveal. WARP-631:
      // record the failure; if this crosses into a scheduled lock (the
      // FREE_TIER+1th wrong code), it was both wrong AND is now locked, so we
      // answer 429 with the wait — satisfying AC#1. Otherwise the usual inline
      // 400 within the free tier.
      const { lockedSeconds } = await recordClaimFailure(ip);
      if (lockedSeconds > 0) {
        res.setHeader("Retry-After", String(lockedSeconds));
        res.status(429).json({
          error: "Too many claim attempts. Try again shortly.",
          code: "CLAIM_RATE_LIMITED",
          retryAfterSeconds: lockedSeconds,
        });
        return;
      }
      res.status(400).json({
        error: "That claim code didn't match. Check the display and try again.",
        code: "CLAIM_CODE_INVALID",
      });
    } catch (err) {
      logger.error({ err }, "Failed to process claim");
      next(err);
    }
  });

  // ── POST /api/setup/org ────────────────────────────────────────
  //
  // PR #380 — name the single workspace (the "company brain") and reserve its
  // `droplet.local/<slug>` host. Org slots AFTER account in the resumable
  // wizard, so a successful persist advances the wizard to `internet`.
  //
  // The slug is validated `[a-z0-9-]` + uniqueness in setup-org.service; the
  // route maps the typed errors onto inline-error HTTP codes so the wizard can
  // block continue and show the field error:
  //   valid          → 200 { ok, slug, reserved_host, next_step:"internet" }
  //   missing fields → 400 { code:"ORG_FIELDS_REQUIRED" }
  //   bad slug shape → 400 { code:"ORG_SLUG_INVALID" }
  //   slug taken     → 409 { code:"ORG_SLUG_TAKEN" }
  //
  // industry / size are LOCAL smart-default hints only — persisted on the box,
  // NEVER sent off it (FEATURES.md §10). This handler makes no outbound call.
  router.post("/setup/org", sensitiveRateLimit, async (req: Request, res, next) => {
    try {
      // ORCH-04 — this route is on the public allow-list (no authMiddleware),
      // and `persistOrg` does an UNCONDITIONAL upsert of the Workspace
      // singleton (clearing optional fields with `?? null` each call). Gate
      // it the same way the lifecycle-mutating `appliance:"ready"` PATCH is
      // gated above: a write is allowed when EITHER
      //   (a) the request carries a valid dashboard session cookie (the
      //       wizard's account step authenticated the owner before the org
      //       step, so the org POST rides that cookie — verified inline
      //       because this router mounts before authMiddleware), OR
      //   (b) setup is not yet finished (`appliance !== "ready"`), i.e.
      //       genuine first-run/unclaimed onboarding, which must stay open.
      // Once the appliance is claimed (`appliance:"ready"`), an anonymous LAN
      // client must NOT be able to silently rename the workspace, change its
      // tz/logo, or re-reserve its slug — so we require a session then. This
      // also closes the unauthenticated slug-uniqueness probe oracle on a
      // set-up box.
      const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
      const session = sessionToken ? verifyAccessToken(sessionToken) : null;
      if (!session) {
        const { appliance } = await getSetupState(prisma);
        if (appliance === "ready") {
          res.status(401).json({
            error: "Editing the workspace requires an authenticated session.",
            code: "ORG_AUTH_REQUIRED",
          });
          return;
        }
      }

      const parsed = orgSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "A workspace name, URL, and time zone are required.",
          code: "ORG_FIELDS_REQUIRED",
          details: parsed.error.flatten(),
        });
        return;
      }
      const body = parsed.data;

      const result = await persistOrg(prisma, {
        name: body.name,
        slug: body.slug,
        tz: body.tz,
        industry: body.industry ?? null,
        size: body.size ?? null,
        logoPath: body.logo ?? null,
      });

      // Advance the resumable wizard. Best-effort: a failure to persist the
      // step must not fail the (already-committed) org write — the dashboard
      // also advances locally and re-syncs on the next PATCH. (Mirrors the
      // claim route's post-bind step advance.)
      try {
        await setSetupStep(prisma, STEP_AFTER_ORG);
      } catch (stepErr) {
        logger.warn(
          { err: stepErr },
          "Org persisted but advancing the wizard step failed",
        );
      }

      res.json({
        ok: true,
        slug: result.slug,
        reserved_host: result.reservedHost,
        next_step: STEP_AFTER_ORG,
      });
    } catch (err) {
      if (err instanceof SlugInvalidError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof SlugTakenError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      logger.error({ err }, "Failed to persist org settings");
      next(err);
    }
  });

  // ── GET /api/setup/box-name/check?name=<n> ─────────────────────
  //
  // WARP-979 — the "Secured / name your box" step polls this (debounced) as the
  // owner types. Validates `name` against the SHARED ruleset
  // (@droplet/shared-types, same rules the dashboard runs client-side) and
  // returns { available, slug, fqdn, reason?, authoritative }.
  //
  // MVP posture: format + reserved validity IS the availability answer, with
  // `authoritative: false` — the AUTHORITATIVE fleet-registry availability check
  // is a device-authed HQ call that is a COUPLED fleet-hq follow-up. PUBLIC:
  // this runs during first-run onboarding before any account exists (same
  // posture as the claim/org steps); it is a read-only validity check that
  // touches no state and reveals nothing beyond the shared ruleset.
  router.get("/setup/box-name/check", (req: Request, res, next) => {
    try {
      const nameParam = typeof req.query.name === "string" ? req.query.name : "";
      const result = checkBoxName(nameParam);
      res.json({
        available: result.available,
        slug: result.slug,
        fqdn: result.fqdn,
        authoritative: result.authoritative,
        ...(result.reason
          ? {
              reason: result.reason,
              message: boxNameReasonMessage(result.reason),
            }
          : {}),
      });
    } catch (err) {
      logger.error({ err }, "Failed to check box name");
      next(err);
    }
  });

  // ── GET /api/setup/box-name ────────────────────────────────────
  //
  // WARP-1039 — surface the CURRENT saved box name back to the wizard:
  // `{ name, fqdn }`, both null when no name has been chosen yet. Source of
  // truth is the ApplianceSetup singleton's `boxName` (written by the POST
  // below), falling back to the boot-env `DROPLET_BOX_NAME` — that covers a
  // container restart mid-wizard, where the re-read host .env is the only
  // place the name survived. Values from either source are re-validated with
  // the shared ruleset (defense-in-depth against a hand-edited .env, same
  // posture as tls-issuance) and reported as the normalized slug.
  //
  // GATED exactly like the POST: a read is allowed when EITHER a valid
  // dashboard session cookie is present, OR the appliance is not yet `ready`
  // (genuine first-run onboarding). The FQDN itself is CT-published by design
  // (vpn.ts), but an anonymous LAN client on a claimed box still gets nothing.
  router.get("/setup/box-name", standardRateLimit, async (req: Request, res, next) => {
    try {
      const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
      const session = sessionToken ? verifyAccessToken(sessionToken) : null;
      if (!session) {
        const { appliance } = await getSetupState(prisma);
        if (appliance === "ready") {
          res.status(401).json({
            error: "Reading the box name requires an authenticated session.",
            code: "BOX_NAME_AUTH_REQUIRED",
          });
          return;
        }
      }

      const row = await prisma.applianceSetup.findUnique({
        where: { id: "singleton" },
      });
      const candidate = (row?.boxName ?? "").trim() || getEnvBoxName().trim();
      const v = candidate ? validateBoxName(candidate) : null;
      if (!v?.ok) {
        res.json({ name: null, fqdn: null });
        return;
      }
      res.json({ name: v.slug, fqdn: boxNameToFqdn(v.slug) });
    } catch (err) {
      logger.error({ err }, "Failed to read box name");
      next(err);
    }
  });

  // ── POST /api/setup/box-name { name } ──────────────────────────
  //
  // WARP-979 + WARP-980 — persist the owner-chosen name AND make it AUTHORITATIVE
  // via a device-auth HQ claim. Re-validates server-side (never trust the
  // client), writes `DROPLET_BOX_NAME=<slug>` to the host .env via the
  // device-bridge (so the box's tls-issuance ORDER requests
  // `<name>.droplet-us.com`), THEN drives the device-auth PoP name claim so HQ
  // honors the name (the claim is the authoritative step; issuance issues UNDER
  // the claimed name). The claim is NON-FATAL to persistence — a not-yet-
  // registered / transient failure still persists locally and reports
  // `authoritative:false`; a 409 name-taken is surfaced with `suggestions`.
  //
  //   valid + claimed → 200 { ok, slug, fqdn, authoritative:true, taken:false }
  //   valid + fallback→ 200 { ok, slug, fqdn, authoritative:false, taken:false }
  //   valid + taken   → 409 { code:"BOX_NAME_TAKEN", slug, suggestions, taken:true }
  //   valid + this box already holds a different name (WARP-1109)
  //                   → 409 { code:"BOX_NAME_ALREADY_NAMED", currentName? }
  //                     (the wizard offers Rename → POST /setup/box-name/rename)
  //   invalid         → 400 { code:"BOX_NAME_INVALID", reason, error }
  //
  // GATED exactly like the org POST + the appliance:"ready" PATCH: a write is
  // allowed when EITHER a valid dashboard session cookie is present (the wizard
  // authenticated at the account step, so this POST rides that cookie), OR the
  // appliance is not yet `ready` (genuine first-run onboarding). Once claimed,
  // an anonymous LAN client must not be able to silently rename the box's
  // secured address.
  router.post("/setup/box-name", sensitiveRateLimit, async (req: Request, res, next) => {
    try {
      const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
      const session = sessionToken ? verifyAccessToken(sessionToken) : null;
      {
        // ORCH-002: on a claimed ("ready") box, changing the public secure
        // address is an owner/admin action. verifyAccessToken alone accepts
        // ANY role and a revoked-but-unexpired (<=15 min) token, so mirror
        // authMiddleware here: require an elevated role AND a live server-side
        // session before mutating the box name. First-run (pre-ready) keeps the
        // anonymous wizard allowance so onboarding still works.
        const { appliance } = await getSetupState(prisma);
        if (appliance === "ready") {
          if (!session) {
            res.status(401).json({
              error: "Naming the box requires an authenticated session.",
              code: "BOX_NAME_AUTH_REQUIRED",
            });
            return;
          }
          if (session.role !== "owner" && session.role !== "admin") {
            res.status(403).json({
              error: "Renaming the box requires an owner or admin.",
              code: "BOX_NAME_FORBIDDEN",
            });
            return;
          }
          if (session.sid) {
            const sess = await checkSession(session.sid);
            // "ok"/"error" (Redis down → fail-open, same as authMiddleware) pass;
            // "expired"/"missing" (revoked/GC'd) are dead now despite a valid JWT.
            if (sess.kind !== "ok" && sess.kind !== "error") {
              res.status(401).json({ error: "Your session is no longer valid.", code: "SESSION_EXPIRED" });
              return;
            }
          }
        }
      }

      const parsed = boxNameSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "A box name is required.",
          code: "BOX_NAME_REQUIRED",
          details: parsed.error.flatten(),
        });
        return;
      }

      const result = await setBoxName(parsed.data.name, {
        persist: persistBoxNameToHost,
        claim: claimBoxNameToHq,
      });

      // WARP-1109 — HQ says THIS box already holds a (different) name. Distinct
      // 409 so the wizard shows the current address + a Rename affordance
      // (POST /setup/box-name/rename) instead of the misleading "that name is
      // taken". `currentName` lets the wizard name the address it already holds.
      if (result.alreadyNamed) {
        res.status(409).json({
          ok: false,
          code: "BOX_NAME_ALREADY_NAMED",
          slug: result.slug,
          fqdn: result.fqdn,
          taken: false,
          authoritative: result.authoritative,
          ...(result.currentName ? { currentName: result.currentName } : {}),
          error:
            "This box already holds a secure address — use Rename to change it.",
        });
        return;
      }

      // HQ authoritatively rejected the name as taken by another box. 409 with
      // suggestions so the wizard shows the real conflict — the name WAS
      // persisted locally, but it is not authoritative.
      if (result.taken) {
        res.status(409).json({
          ok: false,
          code: "BOX_NAME_TAKEN",
          slug: result.slug,
          fqdn: result.fqdn,
          taken: true,
          authoritative: result.authoritative,
          suggestions: result.suggestions,
          error: "That name is already taken — pick another.",
        });
        return;
      }

      // WARP-1039 — persist the accepted slug on the ApplianceSetup singleton
      // alongside the host-.env write-back. The .env write only becomes
      // visible in-process on the next boot (config is a snapshot), so this
      // row is what GET /setup/box-name reads back for the wizard. NON-FATAL:
      // the name is already durable on the host, so a DB hiccup must not fail
      // the request (mirrors the org step's non-fatal step-advance).
      try {
        await prisma.applianceSetup.upsert({
          where: { id: "singleton" },
          create: { id: "singleton", boxName: result.slug },
          update: { boxName: result.slug },
        });
      } catch (dbErr) {
        logger.warn(
          { err: dbErr },
          "Box name persisted to the host .env but the ApplianceSetup write-back failed",
        );
      }

      res.json({
        ok: true,
        slug: result.slug,
        fqdn: result.fqdn,
        // WARP-980 — whether HQ device-auth-confirmed the name (true), or we
        // could only persist + fall back to opaque/bootstrap issuance (false).
        authoritative: result.authoritative,
        taken: false,
      });
    } catch (err) {
      if (err instanceof BoxNameInvalidError) {
        res.status(400).json({
          error: boxNameReasonMessage(err.reason),
          code: err.code,
          reason: err.reason,
        });
        return;
      }
      logger.error({ err }, "Failed to persist box name");
      next(err);
    }
  });

  // ── POST /api/setup/box-name/rename { name } ───────────────────
  //
  // WARP-1109 — CHANGE the box's secured address in place. This is the flow the
  // wizard's Rename affordance drives once a box already holds a name (the fix
  // for "every name reads as taken once the box holds one"): it RELEASES the
  // current name at HQ (device-auth PoP — the same signed release factory-reset
  // uses), THEN claims the NEW name and triggers a cert re-issue under the new
  // FQDN. All non-fatal past validation — a post-release claim failure falls back
  // to opaque/bootstrap issuance (the new name re-claims on the next tick), and a
  // re-issue-tick failure is retried by the daily renewal cron.
  //
  //   valid + claimed → 200 { ok:true, slug, fqdn, authoritative:true }
  //   valid + fallback→ 200 { ok:true, slug, fqdn, authoritative:false }
  //   new name taken  → 409 { code:"BOX_NAME_TAKEN", slug, suggestions, taken:true }
  //   invalid         → 400 { code:"BOX_NAME_INVALID", reason, error }
  //
  // GATED exactly like POST /setup/box-name: allowed with a valid session cookie
  // OR when the appliance is not yet `ready` (first-run). A rename is only ever
  // reached AFTER a name exists, so in practice the box is claimed and the
  // authenticated owner drives it — but the same first-run allowance keeps the
  // wizard flow uniform.
  router.post("/setup/box-name/rename", sensitiveRateLimit, async (req: Request, res, next) => {
    try {
      const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
      const session = sessionToken ? verifyAccessToken(sessionToken) : null;
      {
        // ORCH-002: on a claimed ("ready") box, changing the public secure
        // address is an owner/admin action. verifyAccessToken alone accepts
        // ANY role and a revoked-but-unexpired (<=15 min) token, so mirror
        // authMiddleware here: require an elevated role AND a live server-side
        // session before mutating the box name. First-run (pre-ready) keeps the
        // anonymous wizard allowance so onboarding still works.
        const { appliance } = await getSetupState(prisma);
        if (appliance === "ready") {
          if (!session) {
            res.status(401).json({
              error: "Renaming the box requires an authenticated session.",
              code: "BOX_NAME_AUTH_REQUIRED",
            });
            return;
          }
          if (session.role !== "owner" && session.role !== "admin") {
            res.status(403).json({
              error: "Renaming the box requires an owner or admin.",
              code: "BOX_NAME_FORBIDDEN",
            });
            return;
          }
          if (session.sid) {
            const sess = await checkSession(session.sid);
            // "ok"/"error" (Redis down → fail-open, same as authMiddleware) pass;
            // "expired"/"missing" (revoked/GC'd) are dead now despite a valid JWT.
            if (sess.kind !== "ok" && sess.kind !== "error") {
              res.status(401).json({ error: "Your session is no longer valid.", code: "SESSION_EXPIRED" });
              return;
            }
          }
        }
      }

      const parsed = boxNameSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "A box name is required.",
          code: "BOX_NAME_REQUIRED",
          details: parsed.error.flatten(),
        });
        return;
      }

      const result = await renameBoxName(parsed.data.name, {
        persist: persistBoxNameToHost,
        claim: claimBoxNameToHq,
        release: releaseBoxNameFromHq,
        reissue: reissueTls,
        logger,
      });

      // The NEW name is taken by ANOTHER box. 409 with suggestions so the wizard
      // shows the real conflict — the old name was already released, so the box
      // re-issues opaque/bootstrap on the next tick until a free name is chosen.
      if (result.taken) {
        res.status(409).json({
          ok: false,
          code: "BOX_NAME_TAKEN",
          slug: result.slug,
          fqdn: result.fqdn,
          taken: true,
          authoritative: result.authoritative,
          suggestions: result.suggestions,
          error: "That name is already taken — pick another.",
        });
        return;
      }

      // Persist the accepted slug on the ApplianceSetup singleton so
      // GET /setup/box-name reads the new name back without a container restart
      // (mirrors the POST). NON-FATAL: the name is already durable on the host.
      try {
        await prisma.applianceSetup.upsert({
          where: { id: "singleton" },
          create: { id: "singleton", boxName: result.slug },
          update: { boxName: result.slug },
        });
      } catch (dbErr) {
        logger.warn(
          { err: dbErr },
          "Renamed box name persisted to the host .env but the ApplianceSetup write-back failed",
        );
      }

      res.json({
        ok: true,
        slug: result.slug,
        fqdn: result.fqdn,
        authoritative: result.authoritative,
        taken: false,
      });
    } catch (err) {
      if (err instanceof BoxNameInvalidError) {
        res.status(400).json({
          error: boxNameReasonMessage(err.reason),
          code: err.code,
          reason: err.reason,
        });
        return;
      }
      logger.error({ err }, "Failed to rename box name");
      next(err);
    }
  });

  return router;
}
