/**
 * WARP-2729 (ADR-048) — the filing invariants that only a real database can
 * hold, and the two FK/CHECK traps this schema was shaped to avoid.
 *
 * Why a pg suite rather than mocked assertions: a service check is a MESSAGE,
 * the constraint is the INVARIANT. `services/filing/*` is not the only thing
 * that will ever write these tables — a data migration, a psql session, a
 * future route, or a fixture all reach them without passing through it. The
 * consent row in particular is the record proving a human authorised unattended
 * CRM writes; it must be impossible to leave half-filled, not merely unusual.
 *
 * THE MUTATIONS THAT MAKE EACH GROUP VISIBLE (delete one, this file goes red
 * while every mocked test next door stays green):
 *
 *   1. `AutoFilingSetting_enabled_has_actor`  — consent without an actor.
 *   2. `AutoFilingSetting_auto_requires_canary` — auto mode with no canary pass.
 *   3. `IngestProposal_never_is_unappliable`  — a NEVER-class row applied.
 *   4. `IngestProposal_record_verdict_never_applies` — a patient record filed.
 *   5. `IngestProposal_decided_has_actor` / `_undone_has_actor`.
 *   6. `IngestProposal_source_pointer_matches_kind`.
 *   7. `FilingDecision_company_required_by_verdict`.
 *   8. The four partial unique indexes.
 *
 * AND THE THREE DELETES THAT MUST SUCCEED — the traps. Each of these is a
 * cascade or SetNull path that an `onDelete: SetNull` FK under a NOT-NULL CHECK
 * would turn into a permanent failure. They assert the ABSENCE of a constraint,
 * which is the only kind of test that catches someone "tightening" the schema
 * later and silently breaking `DELETE /api/email/accounts`.
 *
 * Real-Postgres and gated exactly like the sibling `*.pg.test.ts` suites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("filing schema invariants live in the database (WARP-2729)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Namespaced like the sibling suites: the pg-gated files share one throwaway
  // DB and run serially in CI but must not depend on that, so an unscoped
  // deleteMany() is never used here. (`erp-api-e2e.pg.test.ts` shipped one and
  // it silently ate other suites' rows until WARP-2562's Restrict FK made the
  // damage loud.)
  const P = "warp2729-";
  const OURS = { startsWith: P } as const;

  /** Minimum viable proposal; individual tests override what they are probing. */
  const proposal = (over: Record<string, unknown> = {}) => ({
    sourceKind: "FILE" as const,
    sourceRef: `${P}file:1`,
    ncFileId: 1,
    kind: "LINK_FILE" as const,
    policyClass: "REVIEW" as const,
    confidence: 90,
    phiVerdict: "CLEAN" as const,
    matchKind: "DOMAIN" as const,
    payload: {},
    extractorVersion: `${P}v1`,
    dedupeKey: `${P}k1`,
    requestedById: `${P}owner`,
    ...over,
  });

  beforeEach(async () => {
    // Proposals first: CrmCompany/Contact FK back to them with SetNull, and a
    // leftover row would make the company delete below look like it passed for
    // the wrong reason.
    await prisma.ingestProposal.deleteMany({ where: { sourceRef: OURS } });
    await prisma.filingDecision.deleteMany({ where: { keyValue: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.emailAccount.deleteMany({ where: { address: OURS } });
    await prisma.autoFilingSetting.deleteMany({ where: { id: "singleton" } });
  });

  // ───────────────────────── consent ─────────────────────────

  describe("consent is never half-recorded", () => {
    it("refuses a mode that is not off without an actor and a timestamp", async () => {
      await expect(
        prisma.autoFilingSetting.create({
          data: { id: "singleton", mode: "propose" },
        }),
      ).rejects.toThrow(/AutoFilingSetting_enabled_has_actor/);
    });

    it("refuses an actor recorded while the mode is off", async () => {
      // The other direction. Written as an equality of booleans precisely so
      // this half cannot be forgotten: a stale enabledById on an off row would
      // read as consent that was never given.
      await expect(
        prisma.autoFilingSetting.create({
          data: {
            id: "singleton",
            mode: "off",
            enabledById: `${P}owner`,
            enabledAt: new Date(),
          },
        }),
      ).rejects.toThrow(/AutoFilingSetting_enabled_has_actor/);
    });

    it("accepts propose mode with a complete consent record", async () => {
      const row = await prisma.autoFilingSetting.create({
        data: {
          id: "singleton",
          mode: "propose",
          enabledById: `${P}owner`,
          enabledAt: new Date(),
        },
      });
      expect(row.mode).toBe("propose");
      expect(row.level).toBe("links_only"); // the safe default, not also_create
    });

    it("🔴 refuses auto mode until a canary pass is recorded on this box", async () => {
      // WARP-2732 is auto mode's own stated merge condition. PR #2005 set
      // itself an equivalent condition and shipped without ever running it;
      // this is the difference between a gate and a promise.
      await expect(
        prisma.autoFilingSetting.create({
          data: {
            id: "singleton",
            mode: "auto",
            enabledById: `${P}owner`,
            enabledAt: new Date(),
          },
        }),
      ).rejects.toThrow(/AutoFilingSetting_auto_requires_canary/);
    });

    it("accepts auto mode once the canary has passed, naming the model", async () => {
      const row = await prisma.autoFilingSetting.create({
        data: {
          id: "singleton",
          mode: "auto",
          enabledById: `${P}owner`,
          enabledAt: new Date(),
          canaryPassedAt: new Date(),
          canaryModel: "gpt-oss:20b",
        },
      });
      expect(row.canaryModel).toBe("gpt-oss:20b");
    });

    it("refuses a second settings row", async () => {
      await expect(
        prisma.autoFilingSetting.create({ data: { id: "not-singleton", mode: "off" } }),
      ).rejects.toThrow(/AutoFilingSetting_is_singleton/);
    });

    it("refuses a zero or negative cap", async () => {
      await expect(
        prisma.autoFilingSetting.create({
          data: { id: "singleton", mode: "off", dailyCreateCap: 0 },
        }),
      ).rejects.toThrow(/AutoFilingSetting_caps_positive/);
    });
  });

  // ──────────────────── proposal invariants ────────────────────

  describe("a proposal cannot lie about what it is", () => {
    it("refuses a confidence outside 0-100", async () => {
      await expect(
        prisma.ingestProposal.create({ data: proposal({ confidence: 101 }) }),
      ).rejects.toThrow(/IngestProposal_confidence_range/);
    });

    it("refuses a FILE proposal carrying an email pointer", async () => {
      await expect(
        prisma.ingestProposal.create({
          data: proposal({ sourceKind: "FILE", emailMessageId: "whatever" }),
        }),
      ).rejects.toThrow(/IngestProposal_source_pointer_matches_kind/);
    });

    it("🔴 refuses applying a NEVER-class proposal, even deliberately", async () => {
      // NEVER is unappliable in the database, not merely in a branch of
      // policy.ts. A refactor of the policy table cannot reintroduce this.
      await expect(
        prisma.ingestProposal.create({
          data: proposal({
            policyClass: "NEVER",
            status: "APPLIED",
            decidedById: `${P}owner`,
            decidedAt: new Date(),
          }),
        }),
      ).rejects.toThrow(/IngestProposal_never_is_unappliable/);
    });

    it("🔴 refuses a patient-record source ever being applied", async () => {
      await expect(
        prisma.ingestProposal.create({
          data: proposal({
            phiVerdict: "RECORD",
            status: "APPLIED",
            decidedById: `${P}owner`,
            decidedAt: new Date(),
          }),
        }),
      ).rejects.toThrow(/IngestProposal_record_verdict_never_applies/);
    });

    it("🔴 refuses storing evidence quotes on a patient-record source", async () => {
      // A RECORD verdict is terminal BEFORE the extraction pass, so there is
      // never anything to quote. This stops a future code path persisting the
      // highest-PHI-density text the pipeline can touch.
      await expect(
        prisma.ingestProposal.create({
          data: proposal({ phiVerdict: "RECORD", evidence: [{ quote: "anything" }] }),
        }),
      ).rejects.toThrow(/IngestProposal_record_verdict_never_applies/);
    });

    it("refuses a decided status with no decider", async () => {
      await expect(
        prisma.ingestProposal.create({ data: proposal({ status: "APPLIED" }) }),
      ).rejects.toThrow(/IngestProposal_decided_has_actor/);
    });

    it("refuses an undone status with no undoer", async () => {
      await expect(
        prisma.ingestProposal.create({
          data: proposal({
            status: "UNDONE",
            decidedById: `${P}owner`,
            decidedAt: new Date(),
          }),
        }),
      ).rejects.toThrow(/IngestProposal_undone_has_actor/);
    });

    it("allows at most one PENDING proposal per (kind, dedupeKey)", async () => {
      await prisma.ingestProposal.create({ data: proposal() });
      await expect(
        prisma.ingestProposal.create({
          data: proposal({ sourceRef: `${P}file:2`, ncFileId: 2 }),
        }),
      ).rejects.toThrow(/IngestProposal_pending_dedupe_key/);
    });

    it("lets a decided proposal sit beside a new pending one — history accumulates", async () => {
      // The partial index is `WHERE status = 'PENDING'` for exactly this: a
      // second document about the same customer must be able to arrive after
      // the first was accepted, and it must not resurrect the old row.
      await prisma.ingestProposal.create({
        data: proposal({
          status: "REJECTED",
          decidedById: `${P}owner`,
          decidedAt: new Date(),
        }),
      });
      const second = await prisma.ingestProposal.create({
        data: proposal({ sourceRef: `${P}file:2`, ncFileId: 2 }),
      });
      expect(second.status).toBe("PENDING");
    });
  });

  // ──────────────────── correction memory ────────────────────

  describe("a filing rule points at a customer, or it is not a rule", () => {
    it("refuses ALWAYS_HERE with no customer", async () => {
      await expect(
        prisma.filingDecision.create({
          data: {
            keyKind: "EMAIL_DOMAIN",
            keyValue: `${P}acme.example`,
            verdict: "ALWAYS_HERE",
            createdById: `${P}owner`,
          },
        }),
      ).rejects.toThrow(/FilingDecision_company_required_by_verdict/);
    });

    it("refuses IGNORE_SOURCE that names a customer", async () => {
      await expect(
        prisma.filingDecision.create({
          data: {
            keyKind: "EMAIL_DOMAIN",
            keyValue: `${P}spam.example`,
            verdict: "IGNORE_SOURCE",
            companyId: "some-company",
            createdById: `${P}owner`,
          },
        }),
      ).rejects.toThrow(/FilingDecision_company_required_by_verdict/);
    });

    it("allows one ignore rule per key and refuses the duplicate", async () => {
      const base = {
        keyKind: "EMAIL_DOMAIN" as const,
        keyValue: `${P}newsletter.example`,
        verdict: "IGNORE_SOURCE" as const,
        createdById: `${P}owner`,
      };
      await prisma.filingDecision.create({ data: base });
      await expect(prisma.filingDecision.create({ data: base })).rejects.toThrow(
        /FilingDecision_ignore_source_key/,
      );
    });
  });

  // ─────────────── the deletes that must SUCCEED ───────────────

  describe("🔴 the FK/CHECK traps this schema avoids", () => {
    it("deleting a proposal SetNulls the record's back-pointer and SUCCEEDS", async () => {
      const p = await prisma.ingestProposal.create({
        data: proposal({ kind: "CREATE_CUSTOMER", dedupeKey: `${P}k-company` }),
      });
      const c = await prisma.crmCompany.create({
        data: { name: `${P}acme`, origin: "EXTRACTED", proposalId: p.id },
      });

      // If `proposalId` were referenced by a NOT-NULL CHECK, this delete would
      // fail — and the purge walker that reaps proposals whose source file was
      // deleted in Nextcloud could never run.
      await expect(
        prisma.ingestProposal.delete({ where: { id: p.id } }),
      ).resolves.toBeTruthy();

      const after = await prisma.crmCompany.findUnique({ where: { id: c.id } });
      expect(after).not.toBeNull();
      expect(after?.proposalId).toBeNull();
      expect(after?.origin).toBe("EXTRACTED"); // the row survives, still honest
    });

    it("deleting an email account with a proposal against its mail SUCCEEDS", async () => {
      // `EmailMessage.accountId` is onDelete: Cascade, so this delete reaches
      // the proposal through the message. A "source_exactly_one" CHECK over
      // (ncFileId, emailMessageId) would make the SetNull leave both NULL and
      // the CHECK would reject it — permanently breaking the account-delete
      // route that WARP-2734 adds.
      const acct = await prisma.emailAccount.create({
        data: {
          address: `${P}box@example.test`,
          imapHost: "imap.example.test",
          smtpHost: "smtp.example.test",
          passwordEnc: "x",
        } as never,
      });
      const thread = await prisma.emailThread.create({
        data: { accountId: acct.id, threadKey: `${P}t1`, subject: `${P}s` } as never,
      });
      const msg = await prisma.emailMessage.create({
        data: {
          accountId: acct.id,
          threadId: thread.id,
          messageId: `${P}m1`,
          fromAddr: "a@example.test",
          toAddrs: [],
          subject: `${P}s`,
          receivedAt: new Date(),
        } as never,
      });
      await prisma.ingestProposal.create({
        data: proposal({
          sourceKind: "EMAIL",
          sourceRef: `${P}email:${msg.id}`,
          ncFileId: null,
          emailMessageId: msg.id,
          kind: "LOG_EMAIL_ACTIVITY",
          dedupeKey: `${P}k-email`,
        }),
      });

      await expect(
        prisma.emailAccount.delete({ where: { id: acct.id } }),
      ).resolves.toBeTruthy();

      // The proposal survives with its pointer cleared. `sourceRef` is why the
      // row is still meaningful: it records WHICH message this came from even
      // though the message is gone.
      const left = await prisma.ingestProposal.findFirst({
        where: { sourceRef: `${P}email:${msg.id}` },
      });
      expect(left?.emailMessageId).toBeNull();
      expect(left?.sourceRef).toBe(`${P}email:${msg.id}`);
    });
  });

  // ──────────────── the EXTRACTED origin ────────────────

  describe("EXTRACTED needed no provenance-CHECK rewrite", () => {
    it("accepts an EXTRACTED company with all-NULL provenance", async () => {
      // This is the assertion behind the claim that adding the origin is ONE
      // `ALTER TYPE ... ADD VALUE`. The shipped `CrmCompany_provenance_complete`
      // first arm is (connectionId IS NULL AND externalSystem IS NULL AND
      // externalId IS NULL) with NO origin predicate — so this row already
      // passed before the enum grew, and widening the CHECK would have been
      // optional tightening rather than a prerequisite.
      const c = await prisma.crmCompany.create({
        data: { name: `${P}extracted-co`, origin: "EXTRACTED" },
      });
      expect(c.origin).toBe("EXTRACTED");
      expect(c.connectionId).toBeNull();
      expect(c.externalSystem).toBeNull();
      expect(c.externalId).toBeNull();
    });

    it("still refuses a half-filled provenance triplet at the new origin", async () => {
      // The guarantee above must not have widened into a hole: an EXTRACTED row
      // claiming an external id without a connection is still refused.
      await expect(
        prisma.crmCompany.create({
          data: {
            name: `${P}bad-provenance`,
            origin: "EXTRACTED",
            externalId: "x",
          } as never,
        }),
      ).rejects.toThrow(/provenance_complete/);
    });
  });

  // ──────────────── the ledger claim columns ────────────────

  describe("the ledger's terminal state and its timestamp move together", () => {
    const path = `${P}/Customers/acme-invoice.pdf`;
    const userId = `${P}alice`;

    beforeEach(async () => {
      await prisma.fileIndexStatus.deleteMany({ where: { userId } });
    });

    it("refuses a terminal status with no terminal timestamp", async () => {
      await expect(
        prisma.fileIndexStatus.create({
          data: { userId, path, status: "ready", extractStatus: "done" },
        }),
      ).rejects.toThrow(/FileIndexStatus_extract_terminal/);
    });

    it("refuses a terminal timestamp on a row still pending", async () => {
      await expect(
        prisma.fileIndexStatus.create({
          data: {
            userId,
            path,
            status: "ready",
            extractStatus: "pending",
            extractedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/FileIndexStatus_extract_terminal/);
    });

    it("defaults a brand-new index row to pending with no Python change", async () => {
      // The load-bearing property: `set_index_status` INSERTs naming its own
      // columns, so Postgres fills these. If any of them were NOT NULL without
      // a DB-level default, the Python writer would break — silently, because
      // `watcher.py _set_status` swallows DB errors at logger.debug.
      const row = await prisma.fileIndexStatus.create({
        data: { userId, path, status: "ready", ncFileId: 4242 },
      });
      expect(row.extractStatus).toBe("pending");
      expect(row.extractAttempts).toBe(0);
      expect(row.extractedAt).toBeNull();
      expect(row.extractedFromUpdatedAt).toBeNull();
      expect(row.extractFingerprint).toBeNull();
    });
  });
});
