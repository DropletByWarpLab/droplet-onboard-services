# ADR-029 security review checklist — test map

**Ticket:** WARP-1274 (T21, epic WARP-1251) — "E2E/security suite: §8 checklist
automation."
**Source:** `TEAMS-DEPARTMENTS-FILES-ARCHITECTURE-BRIEF.md` §8 (condensed
checklist; full list travels with the epic). Each row below is one clause
of that checklist, mapped to the test(s) that pin it, or to the ticket that
owns it when the item isn't unit-testable (hardware/live-NC/process gates).

This doc is the audit trail: when §8 changes, update this table in the same
PR. A checklist line with no test AND no ticket reference is a gap — treat
that as a bug in this doc, not an acceptable state.

| # | Checklist line (§8) | Status | Test / ticket |
|---|---|---|---|
| 1 | Prereqs WARP-449 + WARP-1051 merged before any dept route ships | ✅ process gate, verified | WARP-1253 (T1) — both landed on `main` before T8 (`requireSpaceAccess`) branched; not independently unit-testable, it's a merge-order invariant enforced by the stack itself |
| 2 | Fail-closed matrix tested for every caller × space-state combo | ✅ | `apps/orchestrator/src/__tests__/space-access.test.ts` — "checkSpaceAccess — truth table" + "requireSpaceAccess middleware" (WARP-1260/T8); full role × state matrix in the file's own header table |
| 3 | All FKs local UUIDs (grep-gate) | ✅ | `apps/orchestrator/src/__tests__/auth.req-user-id.test.ts` (WARP-485/WARP-881 — `req.user.id` is always the local `User.id` UUID at the auth layer, every route's FK writes flow from this) + `addMemberSchema.userId: z.string().uuid()` in `routes/departments.ts`, pinned by `department-security-static-gates.suite.test.ts` (f2) (WARP-1274/T21, new) |
| 4 | Cross-space dual-check tested | ✅ | `apps/orchestrator/src/__tests__/files.space-threading.test.ts` (WARP-1262/T10) — move/copy resolves + gates BOTH source and target space independently |
| 5 | Share-bit-withheld verified against the live pinned NC image | ⏸ hardware/live-NC integration, deferred | WARP-1256 (T4) — CI integration test against the pinned Nextcloud container image (groupfolders REST is version-fragile per brief §4); not something a mocked unit test can prove — the mask-15 share-bit-withheld CONTRACT is unit-pinned in `department-provisioner.service.test.ts` (`MASK_RW = 15`), but that the live NC groupfolders app actually honors it is T4's job |
| 6 | `aclVersion` bump provably in-tx (single helper; no mutation path skips it) | ✅ | `apps/orchestrator/src/services/department-tx.ts`'s `bumpAclVersion` is the ONLY writer of `Department.aclVersion`; every call site is covered per-mutation in `department-membership.service.test.ts` (add/update-right/remove all assert the post-tx `aclVersion`) and `departments.test.ts`'s create/archive paths. `department-security.suite.test.ts` (a) (WARP-1274/T21, new) additionally proves the bump is visible to a THIRD reader (the search-corpus route) inside the same commit, not just to the mutator itself |
| 7 | Revocation e2e (search dead at commit, bytes at NC call, metadata via registry gate) | ✅ | `department-security.suite.test.ts` (a) + (b) (WARP-1274/T21, new) — one `removeMembership()` call proven to move the search corpus, the search cache key (`aclVersion`), AND the metadata gate (`checkSpaceAccess`) together; (b) additionally closes a real gap found while writing this suite: a `removing` row that hasn't finished its NC push yet now denies `checkSpaceAccess` immediately (`middleware/space.ts` fix, same PR) — previously it stayed policy-valid until the row was physically deleted |
| 8 | Reconciler never deletes outside `archiving` | ✅ | `apps/orchestrator/src/__tests__/department-reconciler.service.test.ts` — "reconcileDepartments — never-delete-outside-archiving" (WARP-1257/T5) |
| 9 | NC-reinstall simulation shows no corpus crossover | ✅ | `department-reconciler.service.test.ts` — "re-discovers a TEAM's groupfolder id by its FLAT mount point" (WARP-1257/T5, existing) proves the reconciler side; `department-security-reconciler.suite.test.ts` (d) (WARP-1274/T21, new) closes the gap that spec left open — proves the DOWNSTREAM search-corpus sentinel (`__dept_<uuid>__`) is byte-identical before/after a groupfolder-id reassignment, i.e. no crossover with content indexed under the old id |
| 10 | `isBusiness` never reaches authz | ✅ | `department-security-static-gates.suite.test.ts` (f1) (WARP-1274/T21, new) — grep-gate over all of `apps/orchestrator/src` (excluding tests), word-boundary matched so it doesn't false-positive on the unrelated `isBusinessType` module-registry guard |
| 11 | restic/factory-reset/reflash verified on .87 | ⏸ hardware validation, deferred to WARP-1268 (T16) | Physical-box validation, not unit-testable in this repo's CI |
| 12 | WARP-882 ground truth verified before any co-editing copy | ✅ resolved | D-6 (brief §10, 2026-07-11): WARP-1254 spike (PR #977) verified the doc server SHIPPED; co-editing ships enabled in dept libraries. Only the OnlyOffice OEM license (purchasing) remains before GA — not a test gap |
| 13 | BigInt string-encoded everywhere | ✅ | `apps/orchestrator/src/__tests__/departments.test.ts` — `quotaBytes` round-trips as a string (`"1099511627776"`) through create/list/patch; `usage-policy.service.test.ts` / admin usage-roster tests (WARP-1271/T19a) pin the same contract for per-user quota fields |

## Additional coverage this suite adds beyond the literal §8 line items

- **(c) Reconciler NC group-membership drift-overwrite** — `department-security-reconciler.suite.test.ts` (WARP-1274/T21, new). Not itself a §8 line, but the direct mechanism behind the bypass-path row in brief §3.6 ("NC admin-UI out-of-band edits | Declared unsupported; reconciler overwrites within ≤5 min"). Before this ticket, `services/nextcloud-groups.client.ts`'s `ncListGroupMembers` existed but was never called anywhere in production code — the reconciler re-converged group/folder/mask *shape* but never checked *who* was actually inside `dept-<slug>`. A user hand-added via the NC admin UI would have kept raw WebDAV byte access indefinitely. Closed in `services/department-reconciler.service.ts` (`removeDriftedGroupMembers`), same PR as this suite.
- **(e) Double-create idempotency** — `department-security.suite.test.ts` (WARP-1274/T21, new). `department-provisioner.service.test.ts`'s existing "dedupe by mount point" spec pre-seeds an existing folder and provisions once; this test calls `provisionDepartment` on the SAME row twice back-to-back (the duplicate-reconciler-kick / double-submit race) and proves `gfCreateFolder` still fires exactly once.
- **(f3) `DepartmentShare.createdById` is server-derived** — `department-security-static-gates.suite.test.ts`. Grep-gate confirming the one `prisma.departmentShare.create(...)` call site in `routes/files.ts` always sources `createdById` from `req.user.id`, never client body/query/params — the column brief §3.4 relies on as the "true creator" for later share-mutation authz would be spoofable otherwise.
- **(f4) NC admin credential never echoed in a response** — `department-security-static-gates.suite.test.ts`. Heuristic textual scan of every `res.json(...)`/`res.send(...)` call under `routes/` for the admin-credential env var names or `adminBasicToken()`/`adminToken` identifiers. **Documented limitation:** this is a textual proximity check, not data-flow analysis — a credential laundered through an innocuously-named intermediate variable before being spread into a response object would not be caught. Treat a pass as "no obvious leak," not a proof of absence.

## Files in this suite

- `apps/orchestrator/src/__tests__/department-security.suite.test.ts` — (a) revocation e2e, (b) NC-push-failure policy-denial, (e) double-create idempotency.
- `apps/orchestrator/src/__tests__/department-security-reconciler.suite.test.ts` — (c) reconciler drift-overwrite, (d) groupfolder-id reassignment + search-corpus stability.
- `apps/orchestrator/src/__tests__/department-security-static-gates.suite.test.ts` — (f1) `isBusiness` grep-gate, (f2) non-UUID `userId` rejected pre-DB, (f3) `createdById` server-derived, (f4) admin-credential-leak heuristic.

## Production fix landed alongside this suite

`apps/orchestrator/src/middleware/space.ts`'s `checkSpaceAccess`: a
`DepartmentMembership` row with `syncState === "removing"` (committed
revocation intent, NC-side push not yet confirmed — e.g. because the
immediate push failed and the row is waiting on the reconciler retry) is
now treated as **no membership** for policy purposes, for both the
family/guest/service-asserted-user branch and the owner/admin
non-member-audit branch. Previously `checkSpaceAccess` only checked
`right`, so a stuck `removing` row kept granting policy access for as long
as the NC push kept failing — directly contradicting brief §4's "Policy
access dies at commit; byte access at the NC call." Regression-locked by
`department-security.suite.test.ts` (b).
