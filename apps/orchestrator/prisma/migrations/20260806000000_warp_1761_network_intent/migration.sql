-- WARP-1761 (ADR-035 §1/§7) — NetworkIntent + DeviceIntentState: the fabric's
-- INTENDED state, and how far each device has got with it.
--
-- Purely ADDITIVE: two new tables, no column added to and no row touched in
-- any existing table. `ApDevice` keeps owning the ADR-005 AP lifecycle;
-- `FabricMember` keeps owning observed inventory. Neither is altered here.
--
-- The one architectural line to hold (ADR-035 §1): these tables are the
-- INTENDED half of the split. The OBSERVED half — "what is the AP actually
-- broadcasting" — is still read live off the device on every request and is
-- never mirrored here. If a display path ever starts answering from
-- `NetworkIntent`, drift stops being visible and starts being hidden, which
-- is precisely the failure ADR-035 exists to remove.
--
-- Column notes (the ones a reader would otherwise have to reverse-engineer):
--
--   NetworkIntent.key
--              PRIMARY KEY. Dot-namespaced domain key — `wifi.primary` is the
--              first and today the only one. TEXT, deliberately NOT an enum,
--              for the same reason `FabricMember.role` is: ADR-035 §7 lists
--              six further fabric-owned domains (VLANs, DHCP ranges, band
--              steering, onboard-radio-enable, management firewall) and a new
--              one must be storable without a migration. No CHECK constraint,
--              same reason. This is not derived state — it is the name of the
--              fact the row holds.
--
--   NetworkIntent.value
--              JSONB. A small, CLOSED, documented shape per key — not a junk
--              drawer. For `wifi.primary` it is exactly `{"ssid": "<name>"}`.
--
--              NO SECRET EVER LANDS HERE. The Wi-Fi passphrase is
--              deliberately absent: the orchestrator has never persisted one
--              (the audit writer strips it through `redactSecretParams`, the
--              Tier-2 pending-confirmation record that carries it is
--              in-memory with a 60 s TTL, and `ApDevice` stores only the
--              approval-time `approvedSsid` audit column), and this stage is
--              not the place to open a durable Wi-Fi-secret surface. A
--              converged passphrase waits for the per-device escrow rows of
--              ADR-035 §3. Passphrase WRITES are unchanged by this migration
--              — they still push directly at the AP, exactly as before.
--
--   NetworkIntent.generation
--              Monotonic, bumped atomically (`generation = generation + 1`)
--              on every write, so the converger can tell "this device already
--              runs the current intent" from "this device is behind". Never
--              reset, never decremented. DEFAULT 0 means "row exists, nothing
--              written yet" — the write path always lands on 1 or above.
--
--   DeviceIntentState (anchorMac, key)
--              Composite PRIMARY KEY. `anchorMac` is the SAME identity
--              `FabricMember` keys on (ADR-035 §2 — the wired management
--              interface's MAC, the one value every observer agrees on),
--              stored in the canonical `AA:BB:CC:DD:EE:FF` form that
--              `src/lib/mac.ts` `normalizeMac` produces.
--
--              No FOREIGN KEY to `FabricMember` on purpose: that table is an
--              observation ledger whose rows may lag or lead this one, and a
--              convergence record must not become deletable as a side effect
--              of inventory churn. Neither table has a delete path in the
--              application anyway (ADR-035 §6).
--
--   appliedGeneration / lastVerifiedAt / driftDetectedAt
--              Observation values and timestamps — NOT a state machine, and
--              nothing infers status from a NULL. `appliedGeneration` is the
--              generation last VERIFIED on the device (null = never verified
--              yet); `driftDetectedAt` is the last time the device was found
--              disagreeing and is NEVER cleared, so "this AP was edited in
--              LuCI at 14:02 and repaired at 14:03" stays answerable instead
--              of collapsing into "nothing ever happened". That is ADR-035
--              §6's "stale observations dim, they do not vanish", applied to
--              drift.
--
-- Re-runnable: CREATE TABLE / CREATE INDEX both use IF NOT EXISTS, so running
-- this migration a second time in dev is a no-op. It seeds NO rows, so there
-- is no seed row-count to drift either.

-- ── NetworkIntent ──

CREATE TABLE IF NOT EXISTS "NetworkIntent" (
    "key"        TEXT         NOT NULL,
    "value"      JSONB        NOT NULL,
    "generation" INTEGER      NOT NULL DEFAULT 0,
    "writtenBy"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkIntent_pkey" PRIMARY KEY ("key")
);

-- ── DeviceIntentState ──

CREATE TABLE IF NOT EXISTS "DeviceIntentState" (
    "anchorMac"         TEXT         NOT NULL,
    "key"               TEXT         NOT NULL,
    "appliedGeneration" INTEGER,
    "lastVerifiedAt"    TIMESTAMP(3),
    "driftDetectedAt"   TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceIntentState_pkey" PRIMARY KEY ("anchorMac", "key")
);

-- "which devices are behind / drifted on wifi.primary?" is a scan by key.
CREATE INDEX IF NOT EXISTS "DeviceIntentState_key_idx" ON "DeviceIntentState"("key");
