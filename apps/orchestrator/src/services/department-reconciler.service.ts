/**
 * WARP-1257 (T5) — department reconciler.
 *
 * Bounded, idempotent convergence sweep (no `while True` — this module
 * exports a single `reconcileDepartments()` tick; scheduling lives in
 * `cron-runtime.service.ts` per `index.ts`, boot run + every 5 minutes).
 *
 * Prisma is truth. NC state is never read back as authorization truth —
 * `gfListFolders` is consulted only for groupfolder-id discovery (the id
 * gets reassigned on NC reinstall; UUID-keyed Department rows survive
 * that, the cached `ncGroupfolderId` doesn't).
 *
 * WARP-1557 extends that read by exactly one narrow case, on the FAILED-ROW
 * SWEEP ONLY: a row that has already had an attempt whose outcome could not
 * be confirmed gets its NC state compared against the Prisma-derived intent
 * before any write is re-issued (`provisionDepartment({ verifyOnFailure })`).
 * Without it the reconciler had no way to observe that reality already
 * matched intent — it could only re-issue the write that was failing, which
 * is why two departments on the .87 box logged `departmentsConverged: 0,
 * departmentsStillFailed: 2` every five minutes forever while Nextcloud held
 * both folders fully provisioned. Intent is still Prisma's alone; the active-
 * row drift pass below still overwrites unconditionally. The ADR-029
 * reasoning lives on `folderMatchesIntent` in the provisioner.
 *
 * Four independent sweeps per tick:
 *   1. Department state machine — pending/provisioning/failed rows are
 *      (re)provisioned; archiving rows are (re)archived; every ACTIVE
 *      DEPARTMENT/TEAM row is re-converged (drift overwrite + the
 *      droplet-admins-on-every-active-folder invariant). `archived`,
 *      and HOUSEHOLD rows outside `archiving`, are left alone.
 *   2. Membership state machine — pending/failed memberships are pushed
 *      to their target NC group; `removing` memberships are pulled from
 *      both groups and then their row is deleted.
 *   3. WARP-1526 (rail 6): droplet-admins USER membership — stateless
 *      tier-vs-group drift correction. Expectation derived from
 *      `User.role` alone (owner∪admin with an NC mapping — no sync
 *      columns); ncListGroupMembersStrict is compared and corrected both
 *      ways,
 *      revocations first, each member contained on its own. Converges the
 *      best-effort cascade the role-change post-effects push
 *      (role-mutation-guard.service.ts) after an NC outage. WARP-1558
 *      makes this the BACKFILL too: it now creates the group when it is
 *      missing, so an install that never had a member (the .87 box's
 *      empty group, and every install predating the create-path fix in
 *      routes/auth-groups.ts) converges on the boot tick.
 *   4. WARP-1526 (pr-reviewer #1229 N1): directoryStatus → NC enable
 *      mirror — re-asserts `enabled=false` for locally DEACTIVATED rows,
 *      so a failed disable-mirror cannot leave a revoked person with live
 *      Nextcloud web/WebDAV access (that surface is proxied without
 *      orchestrator auth in front of it).
 *
 * `gfDeleteFolder` is called from exactly one place in this whole
 * service: the `archiving` branch of `reconcileDepartmentRow`. No other
 * code path in this module (or in `department-provisioner.service.ts`'s
 * `provisionDepartment`) ever calls it — that is the never-delete-
 * outside-archiving invariant the brief requires.
 */
import type { PrismaClient } from "@prisma/client";
import {
  provisionDepartment,
  archiveDepartment,
  adminBasicToken,
  DROPLET_ADMINS_GROUP,
  MASK_RW,
  MASK_RO,
  MASK_ADMIN,
} from "./department-provisioner.service.js";
import { ncSetUserEnabled, ncEnsureGroup } from "./nextcloud.client.js";
import {
  gfListFolders,
  gfAddGroup,
  gfSetGroupPermissions,
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
  ncListGroupMembersStrict,
} from "./nextcloud-groups.client.js";
import { recordActivity } from "./activity.singleton.js";
import { sweepUsagePolicies } from "./usage-policy-reconciler.service.js";
// WARP-1526: the operator tier the droplet-admins group tracks — single
// source in the role-mutation guard (no inlined {owner, admin} copies).
import { ADMIN_TIER_ROLES } from "./role-mutation-guard.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("department-reconciler");

// WARP-1257: `failed` and `archive_failed` are BOTH swept, but they carry
// different original intent — `failed` retries down the provision path,
// `archive_failed` down the archive path (see reconcileDepartmentRow routing).
const DEPARTMENT_SWEEP_STATES = [
  "pending",
  "provisioning",
  "failed",
  "archiving",
  "archive_failed",
] as const;

/**
 * WARP-1557 — the states that mean "this row has already had at least one
 * attempt whose outcome we could not confirm". Rows entering the sweep in one
 * of these get `verifyOnFailure`: their NC state is checked against intent
 * before anything is re-written (see department-provisioner.service.ts).
 *
 * `pending` is deliberately EXCLUDED — a never-attempted row has no prior
 * write that could have landed, so there is nothing to verify and no reason
 * to spend the read. This is what keeps the ADR-029 read-back exception
 * scoped to the retry path.
 *
 * `provisioning` and `archiving` are in here because they are the RE-VERIFY
 * states: WARP-1557 parks an ambiguous (5xx / timeout / transport) write
 * outcome there instead of in a terminal failure state, and a row left
 * mid-flight by a process restart lands there too. Both mean exactly "a write
 * may or may not have taken effect".
 */
const DEPARTMENT_REVERIFY_STATES = new Set<string>([
  "provisioning",
  "failed",
  "archiving",
  "archive_failed",
]);

/**
 * WARP-1557 — how many consecutive non-converged ticks a row may accumulate
 * before it is escalated. At the 5-minute cron interval this is 30 minutes,
 * comfortably past any transient NC restart but far short of the "hours"
 * the .87 box spent silently looping.
 *
 * Two things happen at the threshold: the log line escalates from warn to
 * error and the row is counted in `departmentsStuck`, AND a row still parked
 * in a non-terminal RE-VERIFY state is demoted to its terminal failure state.
 * That demotion is what makes the re-verify state *bounded* — an operator
 * looking at the dashboard must not see "Setting up…" forever when the truth
 * is "this has been failing for half an hour".
 */
const STUCK_TICK_THRESHOLD = 6;

/**
 * WARP-1651 — the same budget as `STUCK_TICK_THRESHOLD` ticks at the 5-minute
 * cron interval, expressed as wall-clock so it survives a restart.
 */
const STUCK_AFTER_MS = STUCK_TICK_THRESHOLD * 5 * 60 * 1000;

/**
 * WARP-1651 — how long a row has been failing to converge, from the DURABLE
 * `Department.nonConvergedSince` column.
 *
 * WARP-1557 counted consecutive ticks in a module-level in-memory Map and
 * claimed a restart "at worst delays an escalation by STUCK_TICK_THRESHOLD
 * ticks — it can never lose a row". The second half was true; the first was
 * not. On a box restarting more often than the threshold — a deploy, a
 * reboot, an OOM, or the very infra instability that produced the 5xx — the
 * counter never reached the threshold, the demotion never fired, and the
 * owner saw "Setting up…" with no error text forever. WARP-1557 moved the
 * silent-forever failure from `failed` to `provisioning`, which is worse:
 * the UI actively reassures.
 *
 * `updatedAt` cannot substitute for the column. `provisionDepartment` writes
 * `state = 'provisioning'` at entry on every retry, so `updatedAt` is
 * refreshed each tick and never ages.
 */
function msNonConverged(since: Date | null, now: number): number {
  return since ? now - since.getTime() : 0;
}

// WARP-1257: `failed` and `remove_failed` are BOTH swept — `failed` retries
// down the sync path, `remove_failed` down the removal path.
const MEMBERSHIP_SWEEP_STATES = [
  "pending",
  "failed",
  "removing",
  "remove_failed",
] as const;

export interface ReconcileResult {
  departmentsSwept: number;
  departmentsConverged: number;
  departmentsStillFailed: number;
  // WARP-1557: rows parked in a non-terminal RE-VERIFY state this tick
  // (`provisioning`/`archiving`) because their write outcome was ambiguous —
  // a 5xx/timeout that may or may not have landed. Distinct from
  // `departmentsStillFailed`, which counts unambiguous rejections.
  departmentsReverifying: number;
  // WARP-1557: rows that have failed to converge for STUCK_TICK_THRESHOLD
  // consecutive ticks. THE loud signal for the .87 failure mode — a
  // department stuck for hours previously produced only a debug-level tick
  // line and a dashboard chip that plain members cannot see.
  departmentsStuck: number;
  membershipsSwept: number;
  membershipsSynced: number;
  membershipsFailed: number;
  membershipsRemoved: number;
  // WARP-1271 (T19a): per-user usage-policy quota pushdown, swept on the
  // same tick — see usage-policy-reconciler.service.ts.
  usagePoliciesSwept: number;
  usagePoliciesSynced: number;
  usagePoliciesFailed: number;
  // WARP-1531 (RBAC v2 T7): stateless AccessRole storage-default pushdown
  // for users without a person-level quota, same tick, no sync state —
  // see usage-policy-reconciler.service.ts pass 2.
  roleDefaultQuotasSwept: number;
  roleDefaultQuotasSynced: number;
  roleDefaultQuotasFailed: number;
  // WARP-1526 (rail 6): droplet-admins tier-vs-group drift corrections.
  adminGroupAdded: number;
  adminGroupRemoved: number;
  // pr-reviewer #1229 B4: per-member NC failures are counted, not swallowed
  // — a sweep that silently fails every tick must be visible in the log.
  adminGroupFailed: number;
  // pr-reviewer #1229 N1: DEACTIVATED rows re-asserted against Nextcloud.
  ncDisableMirrored: number;
  ncDisableMirrorFailed: number;
}

/**
 * Re-attach `droplet-admins` at MASK_ADMIN on a folder — the invariant
 * every active groupfolder (department, team, and household alike) must
 * hold. Idempotent: `gfAddGroup` + `gfSetGroupPermissions` both no-op
 * cleanly when the group is already assigned at the target mask.
 */
async function ensureAdminsAttached(
  adminToken: string,
  folderId: number,
): Promise<void> {
  await gfAddGroup(adminToken, folderId, DROPLET_ADMINS_GROUP);
  await gfSetGroupPermissions(
    adminToken,
    folderId,
    DROPLET_ADMINS_GROUP,
    MASK_ADMIN,
  );
}

/**
 * Re-converge one ACTIVE DEPARTMENT/TEAM row: re-run provisionDepartment
 * (which is idempotent end to end — ensure-group, find-or-create-folder,
 * set masks, set quota) so out-of-band NC edits get overwritten back to
 * the Prisma-desired state, and so a stale `ncGroupfolderId` left over
 * from an NC reinstall gets re-discovered by mount point. Returns the
 * refreshed rw/ro group names too, so the caller can run the group-
 * membership drift pass without a second round-trip.
 */
async function reconcileActiveDepartment(
  prisma: PrismaClient,
  id: string,
): Promise<{ active: boolean; ncGroupRw: string | null; ncGroupRo: string | null }> {
  await provisionDepartment(prisma, id);
  const row = await prisma.department.findUnique({
    where: { id },
    select: { state: true, ncGroupRw: true, ncGroupRo: true },
  });
  return {
    active: row?.state === "active",
    ncGroupRw: row?.ncGroupRw ?? null,
    ncGroupRo: row?.ncGroupRo ?? null,
  };
}

/**
 * Drift-overwrite for department/team NC group MEMBERSHIP (ADR-029 §3.6
 * bypass-path row "NC admin-UI out-of-band edits | Declared unsupported;
 * reconciler overwrites within ≤5 min"). `reconcileActiveDepartment`
 * above already re-converges the *group/folder/mask* shape; this closes
 * the matching gap for *who is IN* the rw/ro groups: a user hand-added to
 * `dept-<slug>` (or left behind by a bug) via the NC admin UI never gets
 * orchestrator policy access — `checkSpaceAccess` only ever reads Prisma
 * — but WOULD still get raw WebDAV/byte access through the groupfolder
 * mount until something removes them NC-side. Prisma (`synced`
 * memberships) is truth; anything `ncListGroupMembersStrict` reports that
 * isn't in the expected set gets removed.
 *
 * WARP-1565: the STRICT listing, so a Nextcloud that cannot answer is not
 * read as "this group is empty". Here the lenient `[]` was fail-SAFE — an
 * empty actual set removes nobody — but it also meant a real outage looked
 * identical to a converged group, so drift silently stopped being corrected
 * for as long as listing was broken. A throw propagates to the per-row
 * try/catch in the sweep loop above, which logs it and moves to the next
 * department; the tick retries in ≤5 min.
 *
 * Only `syncState=synced` rows count as "should be a member": `pending`/
 * `failed` rows haven't necessarily landed their NC add yet, so excluding
 * them from "expected" is correct, not a bug — worst case this pass
 * removes a straggling add and `sweepMemberships` re-adds it on the very
 * next tick (a one-tick bounce, never a security hole). `removing` rows
 * are mid-revocation and must never be treated as expected.
 *
 * HOUSEHOLD is never called with this (D-5: household rights convergence
 * is explicit post-GA, per the sibling exclusion in `sweepMemberships`).
 */
async function removeDriftedGroupMembers(
  prisma: PrismaClient,
  adminToken: string,
  departmentId: string,
  ncGroupRw: string | null,
  ncGroupRo: string | null,
): Promise<number> {
  if (!ncGroupRw && !ncGroupRo) return 0;

  const synced = (await prisma.departmentMembership.findMany({
    where: { departmentId, syncState: "synced" },
    select: { userId: true, right: true },
  })) as { userId: string; right: "reader" | "contributor" | "manager" }[];

  const ncUsernameByUserId = new Map<string, string | null>();
  for (const m of synced) {
    if (ncUsernameByUserId.has(m.userId)) continue;
    const user = await prisma.user.findUnique({
      where: { id: m.userId },
      select: { nextcloudUsername: true },
    });
    ncUsernameByUserId.set(m.userId, user?.nextcloudUsername ?? null);
  }

  const rwExpected = new Set<string>();
  const roExpected = new Set<string>();
  for (const m of synced) {
    const ncUsername = ncUsernameByUserId.get(m.userId);
    if (!ncUsername) continue;
    (m.right === "reader" ? roExpected : rwExpected).add(ncUsername);
  }

  let removed = 0;
  for (const [group, expected] of [
    [ncGroupRw, rwExpected],
    [ncGroupRo, roExpected],
  ] as const) {
    if (!group) continue;
    const actual = await ncListGroupMembersStrict(adminToken, group);
    for (const member of actual) {
      if (expected.has(member.id)) continue;
      await ncRemoveUserFromGroup(adminToken, member.id, group);
      removed += 1;
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "shield-alert",
        what: "Removed drifted NC group member (Prisma is truth)",
        sub: `${member.id} · ${group}`,
        refs: { departmentId, ncUsername: member.id, group },
        actor: { type: "system" },
      });
    }
  }
  return removed;
}

/**
 * Re-attach droplet-admins to an ACTIVE HOUSEHOLD row's folder, when one
 * is known. Household groupfolder creation is out of this ticket's scope
 * (T11 absorption seed) — if `ncGroupfolderId` hasn't been populated yet
 * this is a clean no-op, not a failure.
 */
async function reconcileActiveHousehold(
  adminToken: string,
  folderId: number | null,
): Promise<void> {
  if (folderId === null) return;
  await ensureAdminsAttached(adminToken, folderId);
}

interface DepartmentSweepRow {
  id: string;
  name: string;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  ncGroupfolderId: number | null;
  /** WARP-1651 — the durable escalation clock; null while converging. */
  nonConvergedSince: Date | null;
}

/**
 * WARP-1557 — terminal failure state matching a row's original intent, used
 * when a bounded re-verify has gone on long enough that "unconfirmed" stops
 * being an honest description.
 */
function terminalFailureStateFor(state: string): "failed" | "archive_failed" {
  return state === "archiving" || state === "archive_failed"
    ? "archive_failed"
    : "failed";
}

/**
 * WARP-1557 — the louder signal the ticket asks for (item 5).
 *
 * Before this, a department failing every 5-minute tick for hours produced
 * exactly one debug-level line (`departmentsStillFailed: 2`) plus an
 * ActivityRow rendered as an owner/admin-only "Needs attention" chip. Plain
 * members — the people who lost access — saw nothing at all, and neither did
 * anything watching logs at the default level.
 *
 * Now each non-converged row carries a DURABLE start-of-failure timestamp
 * (WARP-1651) that escalates warn → error once the budget is spent, is
 * reported out of the tick as `departmentsStuck`, and bounds the re-verify
 * state by demoting a row that has been "unconfirmed" for too long to its
 * terminal failure state.
 *
 * Returns true if the row is stuck (at or past the budget).
 */
async function trackNonConvergedRow(
  prisma: PrismaClient,
  row: DepartmentSweepRow,
  currentState: string,
): Promise<boolean> {
  const now = Date.now();
  // WARP-1651: stamp the clock on the FIRST non-converged tick only. A row
  // already carrying a timestamp keeps it, which is the whole point — the
  // budget has to survive the restarts that used to reset the tick counter.
  const since = row.nonConvergedSince ?? new Date(now);
  const firstFailure = row.nonConvergedSince === null;
  const elapsedMs = msNonConverged(since, now);
  const stuck = elapsedMs >= STUCK_AFTER_MS;

  const detail = {
    departmentId: row.id,
    name: row.name,
    fromState: row.state,
    currentState,
    nonConvergedSince: since.toISOString(),
    minutesStuck: Math.floor(elapsedMs / 60000),
  };

  if (stuck) {
    logger.error(
      detail,
      "WARP-1557: department has failed to converge for far too long — manual intervention likely required",
    );
  } else {
    logger.warn(detail, "department did not converge this tick; will retry");
  }

  // Bound the RE-VERIFY state: an ambiguous outcome is allowed to stay
  // "unconfirmed" for a while, but not indefinitely. Past the budget the
  // row is demoted to the terminal failure state matching its intent, so the
  // operator-facing surface stops implying work is in progress.
  if (stuck && !currentState.endsWith("failed")) {
    const terminal = terminalFailureStateFor(currentState);
    await prisma.department.update({
      where: { id: row.id },
      // The clock is NOT cleared here: the row is still not converged, and
      // clearing it would restart the budget on the next sweep.
      data: { state: terminal, nonConvergedSince: since },
    });
    logger.error(
      { ...detail, demotedTo: terminal },
      "WARP-1557: re-verify budget exhausted; parking row in its terminal failure state",
    );
  } else if (firstFailure) {
    // WARP-1651: start the clock. One write per failure EPISODE, not one per
    // row per tick — every later tick reads the stamp back off the row.
    // (`firstFailure` implies `!stuck`: a clock started this tick has spent
    // none of its budget.)
    await prisma.department.update({
      where: { id: row.id },
      data: { nonConvergedSince: since },
    });
  }

  return stuck;
}

async function sweepDepartments(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{
  swept: number;
  converged: number;
  stillFailed: number;
  reverifying: number;
  stuck: number;
}> {
  const rows = (await prisma.department.findMany({
    where: { state: { in: [...DEPARTMENT_SWEEP_STATES] } },
    select: {
      id: true,
      name: true,
      kind: true,
      state: true,
      ncGroupfolderId: true,
      // WARP-1651: the durable escalation clock, read once per row per tick.
      nonConvergedSince: true,
    },
  })) as DepartmentSweepRow[];

  // Every currently-active DEPARTMENT/TEAM/HOUSEHOLD row also gets a
  // convergence pass — this is where drift overwrite + the
  // droplet-admins invariant get maintained on the steady-state happy
  // path, not just on error retry.
  const activeRows = (await prisma.department.findMany({
    where: { state: "active" },
    select: {
      id: true,
      name: true,
      kind: true,
      state: true,
      ncGroupfolderId: true,
      // WARP-1651: the durable escalation clock, read once per row per tick.
      nonConvergedSince: true,
    },
  })) as DepartmentSweepRow[];

  let converged = 0;
  let stillFailed = 0;
  let reverifying = 0;
  let stuck = 0;

  for (const row of rows) {
    // WARP-1557: rows that have already had an unconfirmed attempt get the
    // bounded verify step — their NC state is compared against the
    // Prisma-derived intent before any write is re-issued, and every write
    // they do make confirms its own postcondition on failure. `pending` rows
    // (never attempted) do not, which is what keeps this scoped to the retry
    // path. See ProvisionOptions.verifyOnFailure.
    const verifyOnFailure = DEPARTMENT_REVERIFY_STATES.has(row.state);

    // WARP-1257: route on ORIGINAL intent. `archiving` and its failure state
    // `archive_failed` retry down the archive path; `pending`/`provisioning`/
    // `failed` funnel through the idempotent provision path. Never re-provision
    // a row whose operator intent was archival just because a transient NC error
    // parked it in a failure state — that silently un-archives the department.
    if (row.state === "archiving" || row.state === "archive_failed") {
      await archiveDepartment(prisma, row.id, { verifyOnFailure });
    } else {
      await provisionDepartment(prisma, row.id, { verifyOnFailure });
    }

    const after = await prisma.department.findUnique({
      where: { id: row.id },
      select: { state: true },
    });

    if (after?.state === "active" || after?.state === "archived") {
      converged += 1;
      // WARP-1651: converged — stop the clock, so the NEXT failure episode
      // gets a full budget. Guarded on it actually running: a row that
      // converged normally has nothing to clear and must not cost a write.
      if (row.nonConvergedSince !== null) {
        await prisma.department.update({
          where: { id: row.id },
          data: { nonConvergedSince: null },
        });
      }
      await recordActivity({
        kind: "system",
        severity: "ok",
        sourceIcon: "refresh-cw",
        what: "Department reconciled",
        sub: row.name,
        refs: { departmentId: row.id, fromState: row.state, toState: after.state },
        actor: { type: "system" },
      });
    } else if (after?.state) {
      // WARP-1557: split the two non-converged outcomes. `provisioning` /
      // `archiving` mean "the write may have landed, re-verify next tick";
      // `failed` / `archive_failed` mean "the write was rejected".
      const isTerminalFailure =
        after.state === "failed" || after.state === "archive_failed";
      if (isTerminalFailure) {
        stillFailed += 1;
      } else {
        reverifying += 1;
      }

      const wasStuck = await trackNonConvergedRow(prisma, row, after.state);
      if (wasStuck) stuck += 1;

      // A row that entered this sweep already in a failure state (provision
      // `failed` or archive `archive_failed`) and is STILL failed after a retry
      // attempt is "stuck" — surface an alert ActivityRow distinct from the
      // per-attempt failure row provisionDepartment/archiveDepartment emitted.
      if (
        isTerminalFailure &&
        (row.state === "failed" || row.state === "archive_failed")
      ) {
        await recordActivity({
          kind: "system",
          severity: "err",
          sourceIcon: "alert-triangle",
          what: "Department stuck in failed state",
          sub: row.name,
          refs: {
            departmentId: row.id,
            // WARP-1557: how long this has been going on, so the activity
            // row itself carries the escalation and not just the log.
            // WARP-1651: read off the durable column, so the number survives
            // the restarts that used to reset it to 1.
            minutesStuck: Math.floor(
              msNonConverged(row.nonConvergedSince, Date.now()) / 60000,
            ),
          },
          actor: { type: "system" },
        });
      }
    }
  }

  for (const row of activeRows) {
    try {
      if (row.kind === "HOUSEHOLD") {
        await reconcileActiveHousehold(adminToken, row.ncGroupfolderId);
      } else {
        const result = await reconcileActiveDepartment(prisma, row.id);
        if (!result.active) {
          stillFailed += 1;
        } else {
          await removeDriftedGroupMembers(
            prisma,
            adminToken,
            row.id,
            result.ncGroupRw,
            result.ncGroupRo,
          );
        }
      }
    } catch (err) {
      logger.error({ err, id: row.id }, "active-department reconcile pass failed");
    }
  }

  return {
    swept: rows.length + activeRows.length,
    converged,
    stillFailed,
    reverifying,
    stuck,
  };
}

interface MembershipSweepRow {
  id: string;
  departmentId: string;
  userId: string;
  right: "reader" | "contributor" | "manager";
  syncState: string;
}

interface DepartmentMembershipTargetRow {
  id: string;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  ncGroupRw: string | null;
  ncGroupRo: string | null;
}

async function sweepMemberships(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ swept: number; synced: number; failed: number; removed: number }> {
  const rows = (await prisma.departmentMembership.findMany({
    where: { syncState: { in: [...MEMBERSHIP_SWEEP_STATES] } },
    select: { id: true, departmentId: true, userId: true, right: true, syncState: true },
  })) as MembershipSweepRow[];

  let synced = 0;
  let failed = 0;
  let removed = 0;

  for (const row of rows) {
    // WARP-1257: capture the ORIGINAL intent from the row's syncState BEFORE
    // any NC call, so the per-row catch below can re-mark a failure down the
    // path it actually came from. `removing` and its failure state
    // `remove_failed` are BOTH removal intent; `pending`/`failed` are sync
    // intent. A partial removal failure must never be re-synced (which would
    // silently re-grant the revoked access) — intent lives in the state.
    const isRemoval =
      row.syncState === "removing" || row.syncState === "remove_failed";
    try {
      const dept = (await prisma.department.findUnique({
        where: { id: row.departmentId },
        select: { id: true, kind: true, state: true, ncGroupRw: true, ncGroupRo: true },
      })) as DepartmentMembershipTargetRow | null;

      if (!dept) {
        // Parent department vanished — the FK's onDelete: Cascade should
        // have already removed this row, but guard defensively.
        continue;
      }

      // D-5 (brief §7.3): household rights convergence is explicit
      // post-GA — leave household memberships exactly as they are.
      if (dept.kind === "HOUSEHOLD") continue;

      if (isRemoval) {
        if (dept.ncGroupRw || dept.ncGroupRo) {
          const user = await prisma.user.findUnique({
            where: { id: row.userId },
            select: { nextcloudUsername: true },
          });
          const ncUsername = user?.nextcloudUsername ?? null;
          if (ncUsername) {
            if (dept.ncGroupRw) {
              await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRw);
            }
            if (dept.ncGroupRo) {
              await ncRemoveUserFromGroup(adminToken, ncUsername, dept.ncGroupRo);
            }
          }
        }
        await prisma.departmentMembership.delete({ where: { id: row.id } });
        removed += 1;
        continue;
      }

      // Sync intent (pending / failed) → push toward the target group for
      // `right`. (Removal intent already returned above.)
      if (dept.state !== "active" || !dept.ncGroupRw || !dept.ncGroupRo) {
        // Department itself isn't converged yet — retry next tick, once
        // the department sweep above (or a future tick) lands it active.
        await prisma.departmentMembership.update({
          where: { id: row.id },
          data: {
            syncState: "failed",
            syncError: "department not active yet",
          },
        });
        failed += 1;
        continue;
      }

      const user = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { nextcloudUsername: true },
      });
      const ncUsername = user?.nextcloudUsername ?? null;
      if (!ncUsername) {
        await prisma.departmentMembership.update({
          where: { id: row.id },
          data: {
            syncState: "failed",
            syncError: "user has no Nextcloud account provisioned yet",
          },
        });
        failed += 1;
        continue;
      }

      const isReader = row.right === "reader";
      const targetGroup = isReader ? dept.ncGroupRo : dept.ncGroupRw;
      const otherGroup = isReader ? dept.ncGroupRw : dept.ncGroupRo;
      const targetMask = isReader ? MASK_RO : MASK_RW;

      // Add-then-remove: momentarily over-permissive rather than
      // under-permissive during a rights transition, matching the
      // "upgrade" ordering in the brief §4 (the background reconciler
      // is a backstop for drift, not the hot revocation path — that
      // ordering lives in the membership routes themselves).
      await ncAddUserToGroup(adminToken, ncUsername, targetGroup);
      await ncRemoveUserFromGroup(adminToken, ncUsername, otherGroup);

      await prisma.departmentMembership.update({
        where: { id: row.id },
        data: {
          syncState: "synced",
          syncError: null,
          ncPermissionMask: targetMask,
        },
      });
      synced += 1;

      await recordActivity({
        kind: "system",
        severity: "ok",
        sourceIcon: "user-check",
        what: "Department membership synced",
        sub: `${ncUsername} · ${row.right}`,
        refs: { departmentId: dept.id, membershipId: row.id, right: row.right },
        actor: { type: "system" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, id: row.id }, "membership reconcile failed");
      try {
        await prisma.departmentMembership.update({
          where: { id: row.id },
          // WARP-1257: preserve intent across the failure. A removal that
          // failed partway is parked in `remove_failed` (retried down the
          // removal path next tick), NOT the generic `failed` the sync path
          // would pick up and re-add the user with.
          data: {
            syncState: isRemoval ? "remove_failed" : "failed",
            syncError: message.slice(0, 1024),
          },
        });
      } catch (updateErr) {
        // Row may have been deleted concurrently (e.g. cascaded delete
        // from a department archive) — non-fatal, next tick sees nothing.
        logger.warn(
          { err: updateErr, id: row.id },
          "failed to mark membership failed after reconcile error",
        );
      }
      failed += 1;
    }
  }

  return { swept: rows.length, synced, failed, removed };
}

/**
 * WARP-1526 (rail 6) — droplet-admins user-membership drift sweep.
 *
 * The role-change post-effects (role-mutation-guard.service.ts) push the
 * box-wide `droplet-admins` NC group best-effort; an NC outage used to
 * leave user↔group drift with no convergence pass at all. This sweep is
 * STATELESS on purpose: the expectation is recomputed from `User.role`
 * every tick (owner∪admin rows that have a Nextcloud mapping — Prisma is
 * truth, no sync-state columns), the actual set comes from
 * `ncListGroupMembersStrict`, and both directions are corrected:
 *   - missing operator → re-added (heals a failed promotion cascade);
 *   - non-operator member → removed (heals a failed demotion cascade, or
 *     an out-of-band NC admin-UI edit — declared unsupported, ADR-029
 *     §3.6 posture, same as removeDriftedGroupMembers above).
 * The NC system admin account is never removed — it owns the
 * provisioning credential and lives outside the local directory.
 * Failure containment matches the sibling sweeps: any NC error is
 * logged and the tick reports zeros; the next tick retries.
 *
 * WARP-1558 — this same statelessness is ALSO the backfill.
 *
 * Because the expectation is recomputed from `User.role` every tick and
 * nothing is remembered between ticks, an install that has never had a
 * single member in `droplet-admins` is indistinguishable, to this sweep,
 * from one that lost its members to an outage: both are "every operator is
 * missing", and both converge on the next pass. No migration, no one-shot
 * script, no upgrade flag — the boot tick (index.ts) backfills legacy
 * installs like the .87 box, where three admin-tier users faced an empty
 * group, and the 5-minute cron keeps them converged afterwards. Re-running
 * it is a no-op once converged.
 *
 * What the backfill needed on top of WARP-1526 was the ensure-group step
 * below: the group is created lazily by the provisioner, so on an install
 * with no departments it does not exist and every add would have failed
 * forever. See the comment at that call.
 */
async function sweepAdminGroupMembership(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ added: number; removed: number; failed: number }> {
  let added = 0;
  let removed = 0;
  let failed = 0;

  // The Prisma read sits OUTSIDE the containment — a DB-connectivity
  // failure propagates, matching the tick's documented posture (nothing
  // useful to converge without a DB). Only the NC half is contained.
  const operators = (await prisma.user.findMany({
    where: {
      role: { in: [...ADMIN_TIER_ROLES] },
      nextcloudUsername: { not: null },
    },
    select: { nextcloudUsername: true },
  })) as { nextcloudUsername: string | null }[];

  // ONE casing convention for the whole comparison (pr-reviewer #1229 N6).
  // Prisma's `nextcloudUsername` and the OCS member ids can differ in case
  // for the same account; exact-match set math would then see the member as
  // BOTH missing (add) and unexpected (remove) on every tick — an infinite
  // add/remove flap against a live account. Keys are lowercased on both
  // sides; the original spelling is kept as the value for the NC calls.
  const expectedByKey = new Map<string, string>();
  for (const row of operators) {
    if (row.nextcloudUsername) {
      expectedByKey.set(row.nextcloudUsername.toLowerCase(), row.nextcloudUsername);
    }
  }

  // Only the LISTING is wrapped here: without the actual membership there
  // is nothing to compare against, so the whole sweep is skipped this tick
  // and retried on the next one. Per-member failures are contained inside
  // their own loops below, never at this level (pr-reviewer #1229 B4).
  //
  // WARP-1565: this catch was UNREACHABLE until now. `ncListGroupMembers`
  // collapsed every failure to `[]`, so a list-broken/writes-working
  // Nextcloud did not skip the tick — it reported an empty droplet-admins,
  // concluded every operator was missing, and re-added all of them. On every
  // tick. The writes are idempotent so nothing broke; the cost was an
  // Activity log full of drift that never happened and a sweep that never
  // converged. `ncListGroupMembersStrict` throws on everything except a 404
  // (an absent group genuinely has no members), which is what makes the
  // skip below real.
  let actual: { id: string }[];
  try {
    actual = await ncListGroupMembersStrict(adminToken, DROPLET_ADMINS_GROUP);
  } catch (err) {
    logger.error(
      { err },
      "admin-group sweep: listing droplet-admins failed (non-fatal; next tick retries)",
    );
    return { added, removed, failed };
  }

  const actualKeys = new Set(actual.map((m) => m.id.toLowerCase()));
  const systemAdmin = (process.env.NEXTCLOUD_ADMIN_USER || "admin").toLowerCase();

  // REMOVALS FIRST (pr-reviewer #1229 B4). This is the security-relevant
  // direction — pulling a demoted ex-admin out of the box-wide admin group
  // — so it must never sit behind the add loop, where one un-addable
  // expected member (an operator whose NC account was deleted, say) would
  // otherwise starve revocation on every tick, forever.
  for (const member of actual) {
    const key = member.id.toLowerCase();
    if (expectedByKey.has(key)) continue;
    if (key === systemAdmin) continue; // owns the provisioning credential
    try {
      await ncRemoveUserFromGroup(adminToken, member.id, DROPLET_ADMINS_GROUP);
      removed += 1;
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "shield-alert",
        what: "Removed drifted admin-group member (role tier is truth)",
        sub: `${member.id} · ${DROPLET_ADMINS_GROUP}`,
        refs: { ncUsername: member.id, group: DROPLET_ADMINS_GROUP },
        actor: { type: "system" },
      });
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ncUsername: member.id },
        "admin-group sweep: revoking a drifted member failed (next tick retries)",
      );
    }
  }

  // Then the restorations: an operator NC lost (or never received) is
  // re-added. Per-item containment mirrors sweepMemberships' per-row
  // try/catch — one bad member must not abort the rest of the loop.
  const missing = [...expectedByKey].filter(([key]) => !actualKeys.has(key));

  // WARP-1558 — the group has to EXIST before anyone can be added to it.
  //
  // `droplet-admins` is created lazily, by `provisionDepartment`. A box that
  // has never provisioned a department therefore has no such group, and
  // `ncAddUserToGroup` answers OCS statuscode 102 → NextcloudGroupNotFoundError
  // for every operator, every tick, forever: the sweep would report
  // `adminGroupFailed` in perpetuity and Tier-1 see-all would never switch on.
  // `ncListGroupMembers` cannot distinguish the two cases either — it returns
  // `[]` for "empty" and for "no such group" alike (404 → []), which is exactly
  // the shape the .87 box presented.
  //
  // So: ensure once, and only when there is actually someone to add. On a
  // converged box `missing` is empty and this costs nothing; on the first tick
  // after an upgrade (or on a fresh install) it is what makes the backfill
  // below able to land. `ncEnsureGroup` is idempotent — OCS 100 (created) and
  // 102 (already exists) both resolve.
  //
  // Best-effort, matching the sweep's containment posture: if the ensure
  // fails, the adds below fail on their own, are counted in `failed`, and the
  // next tick retries. It must never abort the removals that already ran.
  if (missing.length > 0) {
    try {
      await ncEnsureGroup(DROPLET_ADMINS_GROUP);
    } catch (err) {
      logger.error(
        { err, group: DROPLET_ADMINS_GROUP },
        "admin-group sweep: ensuring droplet-admins exists failed (adds below will report the failure; next tick retries)",
      );
    }
  }

  for (const [, ncUsername] of missing) {
    try {
      await ncAddUserToGroup(adminToken, ncUsername, DROPLET_ADMINS_GROUP);
      added += 1;
      await recordActivity({
        kind: "system",
        severity: "warn",
        sourceIcon: "shield-alert",
        what: "Restored drifted admin-group member (role tier is truth)",
        sub: `${ncUsername} · ${DROPLET_ADMINS_GROUP}`,
        refs: { ncUsername, group: DROPLET_ADMINS_GROUP },
        actor: { type: "system" },
      });
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ncUsername },
        "admin-group sweep: restoring an operator failed (next tick retries)",
      );
    }
  }

  return { added, removed, failed };
}

/**
 * WARP-1526 (pr-reviewer #1229 N1) — directoryStatus → Nextcloud enable
 * mirror.
 *
 * The disable path writes `directoryStatus=DEACTIVATED` locally (the
 * ADR-013 truth every login gate honours) and then mirrors to Nextcloud
 * best-effort. When that mirror fails the local side is safe but the NC
 * account stays ENABLED — and Nextcloud is proxied directly at
 * `/nextcloud/` with no orchestrator auth in front, so the "disabled"
 * person keeps web, WebDAV and desktop-sync access indefinitely. Nothing
 * healed that until this pass.
 *
 * Stateless, same shape as the admin-group sweep: the expectation comes
 * from `User.directoryStatus` alone, no sync columns. Only the DEACTIVATED
 * direction is pushed — it is the security-relevant one, and re-asserting
 * `enabled=false` is idempotent. The ACTIVE direction is deliberately NOT
 * force-pushed every tick: it would mean an OCS write per active user per
 * five minutes to correct a state no security property depends on (the
 * enable route already writes both sides).
 */
async function sweepDirectoryStatusMirror(
  prisma: PrismaClient,
  adminToken: string,
): Promise<{ disabledMirrored: number; failed: number }> {
  let disabledMirrored = 0;
  let failed = 0;

  const deactivated = (await prisma.user.findMany({
    where: {
      directoryStatus: "DEACTIVATED",
      nextcloudUsername: { not: null },
    },
    select: { nextcloudUsername: true },
  })) as { nextcloudUsername: string | null }[];

  for (const row of deactivated) {
    if (!row.nextcloudUsername) continue;
    try {
      await ncSetUserEnabled(adminToken, row.nextcloudUsername, false);
      disabledMirrored += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err, ncUsername: row.nextcloudUsername },
        "directoryStatus mirror: re-asserting NC disable failed (next tick retries)",
      );
    }
  }

  return { disabledMirrored, failed };
}

/**
 * Run one convergence tick. Never throws — every per-row failure is
 * caught, logged, and reflected in the row's own state/syncState so the
 * next tick retries; a Prisma-connectivity-level failure at the
 * `findMany` level is the one case that propagates (there is nothing
 * useful to converge without a DB), matching cron-runtime's `safeRun`
 * canary contract (guest-expiry-sweep, audit-retention-purge follow the
 * same posture).
 */
export async function reconcileDepartments(
  prisma: PrismaClient,
): Promise<ReconcileResult> {
  const adminToken = adminBasicToken();

  const deptResult = await sweepDepartments(prisma, adminToken);
  const memberResult = await sweepMemberships(prisma, adminToken);
  const usageResult = await sweepUsagePolicies(prisma, adminToken);
  const adminGroupResult = await sweepAdminGroupMembership(prisma, adminToken);
  const statusMirrorResult = await sweepDirectoryStatusMirror(prisma, adminToken);

  const result: ReconcileResult = {
    departmentsSwept: deptResult.swept,
    departmentsConverged: deptResult.converged,
    departmentsStillFailed: deptResult.stillFailed,
    departmentsReverifying: deptResult.reverifying,
    departmentsStuck: deptResult.stuck,
    membershipsSwept: memberResult.swept,
    membershipsSynced: memberResult.synced,
    membershipsFailed: memberResult.failed,
    membershipsRemoved: memberResult.removed,
    usagePoliciesSwept: usageResult.usagePoliciesSwept,
    usagePoliciesSynced: usageResult.usagePoliciesSynced,
    usagePoliciesFailed: usageResult.usagePoliciesFailed,
    roleDefaultQuotasSwept: usageResult.roleDefaultQuotasSwept,
    roleDefaultQuotasSynced: usageResult.roleDefaultQuotasSynced,
    roleDefaultQuotasFailed: usageResult.roleDefaultQuotasFailed,
    adminGroupAdded: adminGroupResult.added,
    adminGroupRemoved: adminGroupResult.removed,
    adminGroupFailed: adminGroupResult.failed,
    ncDisableMirrored: statusMirrorResult.disabledMirrored,
    ncDisableMirrorFailed: statusMirrorResult.failed,
  };

  // WARP-1557: the tick summary used to be debug-only, which is why the .87
  // box looped `departmentsSwept: 3, departmentsConverged: 0,
  // departmentsStillFailed: 2` for hours without anyone noticing — at the
  // default log level the whole thing was invisible. A tick that leaves rows
  // non-converged is now visible at warn, and one with rows stuck past the
  // threshold at error. A clean tick stays at debug.
  if (result.departmentsStuck > 0) {
    logger.error(
      result,
      "department-reconciler tick complete — departments STUCK, manual intervention likely required",
    );
  } else if (
    result.departmentsStillFailed > 0 ||
    result.departmentsReverifying > 0
  ) {
    logger.warn(
      result,
      "department-reconciler tick complete — departments did not converge",
    );
  } else {
    logger.debug(result, "department-reconciler tick complete");
  }
  return result;
}

// ── Post-mutation trigger ──

let debounceTimer: NodeJS.Timeout | null = null;
let boundPrisma: PrismaClient | null = null;
const KICK_DEBOUNCE_MS = 2_000;

/**
 * Bind the Prisma client `kickReconcile()` uses. Called once at boot
 * alongside the cron wiring; safe to call again in tests.
 */
export function initReconcileKick(prisma: PrismaClient): void {
  boundPrisma = prisma;
}

/**
 * Debounced post-mutation trigger. Route handlers that create/update a
 * department or membership call this after their write commits so the
 * user doesn't wait a full 5-minute cron cycle for convergence to start.
 * Multiple calls within `KICK_DEBOUNCE_MS` collapse into a single tick.
 * A no-op before `initReconcileKick` has run (e.g. import order in
 * tests) or once the bound client is torn down.
 */
export function kickReconcile(): void {
  if (!boundPrisma) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  const prisma = boundPrisma;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reconcileDepartments(prisma).catch((err) => {
      logger.error({ err }, "kickReconcile: reconcile tick failed");
    });
  }, KICK_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/**
 * Exposed only for tests — clears any pending debounced kick.
 *
 * WARP-1651: this used to also clear the in-memory stuck-row tick counters so
 * one spec's non-converged rows could not leak an escalation into the next.
 * There are no counters any more — the escalation clock lives on the row
 * (`Department.nonConvergedSince`), so a spec's state goes away with its
 * prisma stub and there is nothing module-level left to reset.
 */
export function _resetReconcileKickForTests(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  boundPrisma = null;
}
