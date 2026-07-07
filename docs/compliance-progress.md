# Compliance Progress Tracker

**Live status board for WARP-228 Trust & Compliance Foundations.** Updated after every merged ticket. Source of truth for "where are we against SOC 2 + HIPAA + FIPS 140-3 + NIST 800-53?"

**Design doc:** `docs/superpowers/specs/2026-05-09-local-knowledge-platform-design.md`
**Epic:** [WARP-228](https://warp-lab.atlassian.net/browse/WARP-228)
**Sequential chain:** WARP-229 → WARP-278 (50 tickets, blocks-linked in order)

## Execution strategy (2026-05-10 update)

After honest introspection on the original "all-compliance-first, sequential" plan, the strategy moved to **E → C**:

- **E (triage now, ~2 weeks):** unblock the platform's current state before starting compliance work.
  - WARP-227 — fix 9 failing rag-tests on main (silently broken since WARP-218 went `workflow_dispatch`-only)
  - WARP-225 — dashboard context-meter (the user's direct feature ask)
- **C (interleaved, ongoing):** compliance lane (WARP-229..278) and product lane (Phases A-J from the design doc) run in parallel, alternating weeks. WARP-229 spec is already written and is paused in implementation, not deleted; the spec at `docs/superpowers/specs/2026-05-10-warp-229-fips-provider-design.md` is ready to pick up when the compliance lane resumes.

Rationale: the literal "Type II attestation in hand at launch" target was 12-18 months wall-clock with zero new product features in that window. Type II observation is non-compressible (AICPA rule). A customer-driven model is cheaper and ships product faster. If a customer materializes who needs the literal attestation timeline, we revisit and accelerate the compliance lane.

This means **the timeline anchors below shift**: compliance milestones are no longer wall-clock dates, they are tracked relative to "when the compliance lane has burned through N tickets."

---

## Targets

| Target | Status | Path |
|---|---|---|
| SOC 2 Type I attestation | 🔵 not started | After engineering controls + policies in place; ~9 months in |
| SOC 2 Type II attestation | 🔵 not started | Type I + 6-12 month observation; ~18-24 months in |
| HIPAA-ready (architecture + BAA + processes) | 🔵 not started | Achieved by end of WARP-274 |
| FIPS 140-3 cryptographic modules | 🟡 in progress | WARP-229 closed: provider activation apparatus + boot self-tests + PR-blocking **static source lint** (`scripts/test-fips.sh`) shipped. WARP-967: validated `fips.so` (OpenSSL 3.0.9, CMVP #4282) source-built into every shipped service image with a build-time KAT self-test; no Alpine base remains. WARP-316: the **build-time provider gate** (distinct from the lint) — `install-fips-provider.sh` KATs + positive/negative probes in `docker-build.yml`, made required-to-merge via the `docker-build ok` fan-in check (ruleset JSON delivered for the branch-protection owner), plus a deliberate-sabotage proof (`tests/fips-sabotage.test.sh`) showing removing `fips.so` breaks the gate. WARP-318: per-customer runtime activation — single `DROPLET_FIPS_MODE` knob via `setup.sh --fips`/`--no-fips`, default OFF, no rebuild to flip. WARP-1021: edge TLS moved off `nginx:alpine` to a Bookworm nginx gateway image carrying the same dormant provider, with `DROPLET_FIPS_MODE`-keyed cipher profiles (`docker/nginx/`); redis:7-alpine (`cache`) deliberately out of scope — no TLS termination, no customer-facing crypto (WARP-234 owns the Redis-TLS hop). Remaining: full-stack activation smoke test + operator docs (WARP-317). |
| TPM-sealed device identity | ✅ done | WARP-230 closed: ECC P-256 sealed to PCRs [0,2,4,7] via `services/device-identity-svc/` sidecar (gRPC over Unix socket), pure-Python mock backend for dev/CI, `tpm2-pytss` real backend gated by `RUN_TPM_INTEGRATION=1`. Reseal requires MFA re-auth within 60s via new `require-recent-mfa` middleware. |
| NIST 800-53 Rev 5 Moderate baseline mapping | 🔵 not started | Documentation exercise, runs alongside other tickets |
| STIG-hardened OS profile | 🔵 not started | Configuration; produced as part of WARP-231 |
| Common Criteria EAL2 | ⏸ deferred | Year 2+, gated on a federal customer |
| FedRAMP | ❌ N/A | On-prem appliance, wrong shape; FISMA + agency ATO instead |

Legend: ✅ done · 🟡 in progress · 🔵 not started · ❌ blocked or N/A · ⏸ deferred

---

## Workstream rollup

| Workstream | Tickets | Done | In progress | Not started |
|---|---|---|---|---|
| Cryptographic foundations | 8 | 2 | 0 | 6 |
| Audit & monitoring | 5 | 0 | 0 | 5 |
| Identity & access | 5 | 0 | 0 | 5 |
| Data protection | 8 | 0 | 0 | 8 |
| Vulnerability + supply chain | 8 | 0 | 2 | 6 |
| Incident response + network | 4 | 0 | 0 | 4 |
| Privacy + telemetry | 3 | 0 | 0 | 3 |
| Governance UI + Trust Center | 3 | 0 | 0 | 3 |
| GRC operations | 6 | 0 | 0 | 6 |
| **Total** | **50** | **2** | **2** | **46** |

---

## Sequential ticket queue

The chain is non-negotiable — each ticket blocks the next.

| # | Ticket | Title | Workstream | Status |
|---|---|---|---|---|
| 1 | [WARP-229](https://warp-lab.atlassian.net/browse/WARP-229) | FIPS 140-3 cryptographic provider + CI lint | Crypto | ✅ |
| 2 | [WARP-230](https://warp-lab.atlassian.net/browse/WARP-230) | TPM 2.0-sealed device identity | Crypto | ✅ |
| 3 | [WARP-231](https://warp-lab.atlassian.net/browse/WARP-231) | UEFI Secure Boot + signed kernel + dm-verity rootfs + IMA | Crypto | 🔵 ← **next up** |
| 4 | [WARP-232](https://warp-lab.atlassian.net/browse/WARP-232) | LUKS2 disk encryption with TPM-sealed keys | Crypto | 🔵 |
| 5 | [WARP-233](https://warp-lab.atlassian.net/browse/WARP-233) | Postgres TLS 1.3 + SCRAM-SHA-256 + pg_tde for PHI/PII | Crypto | 🔵 |
| 6 | [WARP-234](https://warp-lab.atlassian.net/browse/WARP-234) | Redis 7 TLS + per-service ACLs | Crypto | 🔵 |
| 7 | [WARP-235](https://warp-lab.atlassian.net/browse/WARP-235) | MQTT TLS + per-service mTLS | Crypto | 🔵 |
| 8 | [WARP-236](https://warp-lab.atlassian.net/browse/WARP-236) | Internal service-to-service mTLS | Crypto | 🔵 |
| 9 | [WARP-237](https://warp-lab.atlassian.net/browse/WARP-237) | Append-only Merkle audit log + comprehensive event coverage | Audit | 🔵 |
| 10 | [WARP-238](https://warp-lab.atlassian.net/browse/WARP-238) | WebAuthn (FIDO2) MFA | Identity | 🔵 |
| 11 | [WARP-239](https://warp-lab.atlassian.net/browse/WARP-239) | SAML 2.0 + OIDC SSO via Authentik | Identity | 🔵 |
| 12 | [WARP-240](https://warp-lab.atlassian.net/browse/WARP-240) | Data classification taxonomy + chunk-level tags | Data | 🔵 |
| 13 | [WARP-241](https://warp-lab.atlassian.net/browse/WARP-241) | Presidio DLP + medical entity recognizers | Data | 🔵 |
| 14 | [WARP-242](https://warp-lab.atlassian.net/browse/WARP-242) | Per-document encryption + crypto-shred deletion | Data | 🔵 |
| 15 | [WARP-243](https://warp-lab.atlassian.net/browse/WARP-243) | PR-blocking security CI (Trivy/Semgrep/CodeQL/...) | VulnMgmt | 🔵 |
| 16 | [WARP-244](https://warp-lab.atlassian.net/browse/WARP-244) | Sigstore + cosign signed container images | SupplyChain | 🟡 |
| 17 | [WARP-245](https://warp-lab.atlassian.net/browse/WARP-245) | CycloneDX SBOM per service + per-release | SupplyChain | 🟡 |
| 18 | [WARP-246](https://warp-lab.atlassian.net/browse/WARP-246) | Audit log viewer + Trust Center placeholder | Governance | 🔵 |
| 19 | [WARP-247](https://warp-lab.atlassian.net/browse/WARP-247) | Session management hardening | Identity | 🔵 |
| 20 | [WARP-248](https://warp-lab.atlassian.net/browse/WARP-248) | RBAC matrix expansion + ABAC | Identity | 🔵 |
| 21 | [WARP-249](https://warp-lab.atlassian.net/browse/WARP-249) | Just-in-time admin elevation | Identity | 🔵 |
| 22 | [WARP-250](https://warp-lab.atlassian.net/browse/WARP-250) | OCSF audit log export + syslog-over-TLS | Audit | 🔵 |
| 23 | [WARP-251](https://warp-lab.atlassian.net/browse/WARP-251) | AIDE-style file integrity monitoring | Audit | 🔵 |
| 24 | [WARP-252](https://warp-lab.atlassian.net/browse/WARP-252) | Anomaly detection on activity events | Audit | 🔵 |
| 25 | [WARP-253](https://warp-lab.atlassian.net/browse/WARP-253) | NTS-authenticated time sync + drift alerting | Audit | 🔵 |
| 26 | [WARP-254](https://warp-lab.atlassian.net/browse/WARP-254) | Restic backup + monthly restore drill | Data | 🔵 |
| 27 | [WARP-255](https://warp-lab.atlassian.net/browse/WARP-255) | Programmable retention engine | Data | 🔵 |
| 28 | [WARP-256](https://warp-lab.atlassian.net/browse/WARP-256) | Right-to-delete via key shredding | Data | 🔵 |
| 29 | [WARP-257](https://warp-lab.atlassian.net/browse/WARP-257) | Customer data export (GDPR / HIPAA-style) | Data | 🔵 |
| 30 | [WARP-258](https://warp-lab.atlassian.net/browse/WARP-258) | Breach notification automation + runbook | Data | 🔵 |
| 31 | [WARP-259](https://warp-lab.atlassian.net/browse/WARP-259) | On-device CVE scanner + patch agent | VulnMgmt | 🔵 |
| 32 | [WARP-260](https://warp-lab.atlassian.net/browse/WARP-260) | Container image runtime signature verification | VulnMgmt | 🔵 |
| 33 | [WARP-261](https://warp-lab.atlassian.net/browse/WARP-261) | Reproducible builds (Nix or Bazel) | SupplyChain | 🔵 |
| 34 | [WARP-262](https://warp-lab.atlassian.net/browse/WARP-262) | Dependency provenance — sigstore-verified pulls | SupplyChain | 🔵 |
| 35 | [WARP-263](https://warp-lab.atlassian.net/browse/WARP-263) | Hardware BOM tracking | SupplyChain | 🔵 |
| 36 | [WARP-264](https://warp-lab.atlassian.net/browse/WARP-264) | Suricata IDS at network edge | IncidentResp | 🔵 |
| 37 | [WARP-265](https://warp-lab.atlassian.net/browse/WARP-265) | Tamper detection + automatic isolation | IncidentResp | 🔵 |
| 38 | [WARP-266](https://warp-lab.atlassian.net/browse/WARP-266) | Forensic preservation hooks | IncidentResp | 🔵 |
| 39 | [WARP-267](https://warp-lab.atlassian.net/browse/WARP-267) | Incident response playbook automation | IncidentResp | 🔵 |
| 40 | [WARP-268](https://warp-lab.atlassian.net/browse/WARP-268) | Egress audit — every outbound network call traced | Privacy | 🔵 |
| 41 | [WARP-269](https://warp-lab.atlassian.net/browse/WARP-269) | Telemetry-free invariant — CI gate on outbound calls | Privacy | 🔵 |
| 42 | [WARP-270](https://warp-lab.atlassian.net/browse/WARP-270) | Customer-initiated diagnostic bundle export | Privacy | 🔵 |
| 43 | [WARP-271](https://warp-lab.atlassian.net/browse/WARP-271) | Per-user retention controls + audit log surfacing | Governance | 🔵 |
| 44 | [WARP-272](https://warp-lab.atlassian.net/browse/WARP-272) | Trust Center page (full) | Governance | 🔵 |
| 45 | [WARP-273](https://warp-lab.atlassian.net/browse/WARP-273) | Information Security Program — full policy library | GRC | 🔵 |
| 46 | [WARP-274](https://warp-lab.atlassian.net/browse/WARP-274) | HIPAA-specific docs (BAA + Privacy Notice + ...) | GRC | 🔵 |
| 47 | [WARP-275](https://warp-lab.atlassian.net/browse/WARP-275) | GRC tooling onboarding (Vanta/Drata) | GRC | 🔵 |
| 48 | [WARP-276](https://warp-lab.atlassian.net/browse/WARP-276) | SIEM deployment (Wazuh) + audit log ingest | GRC | 🔵 |
| 49 | [WARP-277](https://warp-lab.atlassian.net/browse/WARP-277) | Penetration test vendor selection + first booking | GRC | 🔵 |
| 50 | [WARP-278](https://warp-lab.atlassian.net/browse/WARP-278) | SOC 2 Type I readiness + audit booking | GRC | 🔵 |

---

## Audit + certification milestones

Per the 2026-05-10 strategy update, milestones are tracked relative to compliance-lane progress, not wall-clock. Audits are gated on customer demand (signed customer with attestation requirement → kick off the audit booking).

| Milestone | Trigger | Status |
|---|---|---|
| All engineering controls (WARP-229..272) merged | When the compliance lane completes the engineering subset | 🔵 not started |
| Policy library complete (WARP-273..274) | When customer demand justifies the cost | 🔵 not started |
| Vanta + Wazuh operational (WARP-275..276) | When evidence-collection is needed for a real audit | 🔵 not started |
| Penetration test (WARP-277) | Pre-audit, when SOC 2 Type I is booked | 🔵 not started |
| SOC 2 Type I readiness (WARP-278) | When customer demand justifies the cost | 🔵 not started |
| **SOC 2 Type I attestation issued** | After WARP-278 completes successfully | 🔵 not started |
| HIPAA gap assessment | When a healthcare customer signs | 🔵 not started |
| **SOC 2 Type II attestation issued** | Type I + 6-12 months observation | 🔵 not started |

---

## Open risks (from design doc §9)

- Postgres-as-everything ceiling — mitigation: decouple retrieval interface
- Compliance pushes product roadmap >24 months — mitigation: be honest with stakeholders
- TPM sealing fails on kernel update — mitigation: documented reseal ceremony + recovery partition
- FIPS provider performance regression — mitigation: bench before commit, allowlist exception path
- Audit log I/O saturation — mitigation: monthly partitions, p99 budget enforced in tests
- HSM / cosign signing single point of failure — mitigation: multi-region escrow + DR
- SOC 2 firm finds late policy gaps — mitigation: pre-audit readiness 2-3 months early

---

## Update protocol

This file is updated by the executor (subagent or human) at the close of every ticket. Update fields:
- Ticket status emoji (🔵 → 🟡 → ✅)
- Workstream rollup row
- Audit milestone status if a milestone gates on this ticket
- Add a `## Recent closes` section entry with date + ticket + 1-line summary

Don't update audit dates here without an actual auditor commitment in writing.

---

## Recent closes

- **2026-07-05** — **WARP-1021 ✅ done.** FIPS-capable nginx edge gateway: `gateway` compose service moved from pulled `nginx:alpine` to a locally-built Debian Bookworm nginx (`docker/nginx/Dockerfile`) that bakes the dormant validated `fips.so` (CMVP #4282) with the same build-time KAT gate as the five service images, plus `DROPLET_FIPS_MODE`-keyed edge-TLS cipher profiles selected by a `/docker-entrypoint.d/` hook (default profile byte-identical to the old inline nginx:alpine posture; FIPS profile restricts to AES-GCM ECDHE suites, ChaCha dropped). `docker/nginx.conf` → `docker/nginx/nginx.conf`. Gateway added to `docker-build.yml`'s matrix (KNOWN + per-image filter) and `scripts/lib/compose.sh` build_services; Docker-free artifact checks at `tests/nginx-fips.test.sh` wired into `test-fips.yml`. redis:7-alpine (`cache`) noted out of FIPS scope (no TLS termination; WARP-234 owns Redis TLS). Not OTA-published: gateway is deliberately absent from `scripts/release/services.json` (devices build it via setup.sh, exactly as they pulled nginx:alpine before) — adding it to the OTA set is a separate decision.
- **2026-05-11** — **WARP-230 ✅ done** (PR #190). TPM 2.0-sealed device identity. Sidecar topology at `services/device-identity-svc/` (Python, gRPC over Unix socket) with two backends: pure-Python mock for dev/CI + `tpm2-pytss` real backend gated by `RUN_TPM_INTEGRATION=1`. ECC P-256 keys sealed to PCRs [0,2,4,7] (firmware + kernel + initramfs + secure-boot state). First-boot enrollment ceremony wired into `scripts/setup.sh` Phase 4 via `scripts/provision-device-identity.sh`. Reseal flow gated by new `require-recent-mfa` middleware (60s window) — surfaces in dashboard at `/admin/device-identity` and via `droplet-admin device-identity {status,reseal}` CLI. FIPS-clean. Compose `!reset []` (2.20+) clears inherited devices for the test lane so `/dev/tpm0` isn't required on CI runners.
- **2026-05-10** — **WARP-229 ✅ done.** FIPS 140-3 cryptographic provider activation apparatus shipped across all 8 application service containers (orchestrator, mcp-server, web-dashboard, file-indexer, ai-gateway, camera-discovery, routing, switch, oled-display). New `@droplet/fips-selftest` TS package + `services/_shared/fips_selftest.py` Python helper. PR-blocking static lint at `scripts/test-fips.sh` + `.github/workflows/test-fips.yml`. Documented allowed algorithms (`docs/security/fips-allowed-algorithms.md`) and 3-entry exceptions registry (`docs/security/fips-exceptions.md`): RTSP digest MD5, WireGuard X25519, FIPS-selftest negative-probe. file-indexer's MD5 item-id fingerprint replaced with SHA-256. Operator note: validated `fips.so` sourcing tracked separately.
- **2026-05-10** — WARP-229 spec written + reviewed. (Implementation followed in the same day, on the WARP-229 branch.) Spec at `docs/superpowers/specs/2026-05-10-warp-229-fips-provider-design.md`.

---

## Parallel product lane (E→C alternation)

Per the 2026-05-10 strategy update, the product lane runs in parallel with the compliance lane. Tracked here for visibility; not part of the WARP-228 epic accounting.

| Ticket | Title | Status | Notes |
|---|---|---|---|
| WARP-286 | Hybrid retrieval — BM25 + RRF + reranker | ✅ done | Postgres native FTS (pg_search swap path documented). BGE-reranker-base int8. Eval lane asserts ≥10% NDCG@10 improvement vs vector-only. |
| WARP-287 | Section anchors + citation deep-linking | 🟡 in review (PR #200) | Anchor union threaded extractor → chunker → DB → orchestrator → dashboard. `<CitationCard>` deep-links per kind. Admin re-index route reuses WARP-230's `require-recent-mfa`. |
| WARP-225 | Dashboard context-meter | ✅ done | Investor-grade polish surface. |
| WARP-279 | Meta-observability dashboard | ✅ done | LAN-only "watch Claude work" surface. |
| WARP-224 | Chat-retrieval validation | ✅ done | Includes frame-OCR (now anchor-aware via WARP-287). |
| WARP-227 | rag-tests live-stack triage | 🟡 partial | R1+R2+R3 fixed; R4 ("fixtures don't index") deferred as WARP-282. |

---

*Living document. Last updated 2026-05-11 with WARP-230 close + WARP-287 PR #200 in review.*
