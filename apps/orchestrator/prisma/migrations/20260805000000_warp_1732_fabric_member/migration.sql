-- WARP-1732 (ADR-035 §2/§5/§6) — FabricMember: persisted inventory of every
-- device announcing on the network fabric (edge router, switch, APs, and
-- whatever role ships next).
--
-- Purely ADDITIVE: one new table, no column added to and no row touched in any
-- existing table. `ApDevice` is deliberately untouched — it keeps owning the
-- ADR-005 AP lifecycle state machine; this table is observations only and
-- holds no lifecycle state at all.
--
-- Column notes (the ones a reader would otherwise have to reverse-engineer):
--
--   anchorMac  PRIMARY KEY. ADR-035 §2: the wired management interface's MAC
--              is the one identifier every observer agrees on. Stored in the
--              canonical `AA:BB:CC:DD:EE:FF` form that src/lib/mac.ts
--              `normalizeMac` produces — every write path in the orchestrator
--              goes through it, so the PK cannot collide with itself under two
--              spellings of the same address. Never keyed on IP / hostname /
--              serial: each was observed failing on the lab unit.
--
--   role       TEXT, and deliberately NOT an enum — the one place this schema
--              chooses openness over an explicit enum column. ADR-035 §5 plans
--              for roles to grow; a role the routing service starts announcing
--              must be storable without a migration. There is no CHECK
--              constraint for the same reason. This is NOT derived state (rule
--              10 is about state inferred from another field's absence) — it is
--              a verbatim observed label.
--
--   poePorts / poeBudget
--              NULLABLE INTEGERs parsed from the `poe_ports` / `poe_budget`
--              mDNS TXT keys the GS1900 already advertises. NULL means "not
--              advertised" and is never conflated with 0 — hence no DEFAULT 0.
--
--   firstSeen / lastSeen
--              ADR-035 §6 staleness discipline: a member that stops announcing
--              is NEVER deleted, it goes stale via `lastSeen`. The reconciler
--              has no delete path, so nothing in the application can turn a
--              missed poll into a vanished device. firstSeen is write-once.
--
-- Re-runnable: CREATE TABLE / CREATE INDEX both use IF NOT EXISTS, so running
-- this migration a second time in dev is a no-op. It seeds NO rows, so there is
-- no seed row-count to drift either.

-- ── FabricMember ──

CREATE TABLE IF NOT EXISTS "FabricMember" (
    "anchorMac" TEXT         NOT NULL,
    "role"      TEXT         NOT NULL,
    "model"     TEXT,
    "version"   TEXT,
    "lastIp"    TEXT,
    "hostname"  TEXT,
    "poePorts"  INTEGER,
    "poeBudget" INTEGER,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FabricMember_pkey" PRIMARY KEY ("anchorMac")
);

-- The dashboard groups the inventory by role ("your switch", "your APs").
CREATE INDEX IF NOT EXISTS "FabricMember_role_idx" ON "FabricMember"("role");

-- Every read is most-recently-seen-first, and the staleness question
-- ("what stopped announcing?") is a range scan on this column.
CREATE INDEX IF NOT EXISTS "FabricMember_lastSeen_idx" ON "FabricMember"("lastSeen");
