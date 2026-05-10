# Compliance Progress Tracker

**Live status board for WARP-228 Trust & Compliance Foundations.** Updated after every merged ticket. Source of truth for "where are we against SOC 2 + HIPAA + FIPS 140-3 + NIST 800-53?"

**Design doc:** `docs/superpowers/specs/2026-05-09-local-knowledge-platform-design.md`
**Epic:** [WARP-228](https://warp-lab.atlassian.net/browse/WARP-228)
**Sequential chain:** WARP-229 → WARP-278 (50 tickets, blocks-linked in order)

---

## Targets

| Target | Status | Path |
|---|---|---|
| SOC 2 Type I attestation | 🔵 not started | After engineering controls + policies in place; ~9 months in |
| SOC 2 Type II attestation | 🔵 not started | Type I + 6-12 month observation; ~18-24 months in |
| HIPAA-ready (architecture + BAA + processes) | 🔵 not started | Achieved by end of WARP-274 |
| FIPS 140-3 cryptographic modules | 🔵 not started | Achieved at WARP-229 close (using pre-validated modules) |
| NIST 800-53 Rev 5 Moderate baseline mapping | 🔵 not started | Documentation exercise, runs alongside other tickets |
| STIG-hardened OS profile | 🔵 not started | Configuration; produced as part of WARP-231 |
| Common Criteria EAL2 | ⏸ deferred | Year 2+, gated on a federal customer |
| FedRAMP | ❌ N/A | On-prem appliance, wrong shape; FISMA + agency ATO instead |

Legend: ✅ done · 🟡 in progress · 🔵 not started · ❌ blocked or N/A · ⏸ deferred

---

## Workstream rollup

| Workstream | Tickets | Done | In progress | Not started |
|---|---|---|---|---|
| Cryptographic foundations | 8 | 0 | 0 | 8 |
| Audit & monitoring | 5 | 0 | 0 | 5 |
| Identity & access | 5 | 0 | 0 | 5 |
| Data protection | 8 | 0 | 0 | 8 |
| Vulnerability + supply chain | 8 | 0 | 0 | 8 |
| Incident response + network | 4 | 0 | 0 | 4 |
| Privacy + telemetry | 3 | 0 | 0 | 3 |
| Governance UI + Trust Center | 3 | 0 | 0 | 3 |
| GRC operations | 6 | 0 | 0 | 6 |
| **Total** | **50** | **0** | **0** | **50** |

---

## Sequential ticket queue

The chain is non-negotiable — each ticket blocks the next.

| # | Ticket | Title | Workstream | Status |
|---|---|---|---|---|
| 1 | [WARP-229](https://warp-lab.atlassian.net/browse/WARP-229) | FIPS 140-3 cryptographic provider + CI lint | Crypto | 🔵 |
| 2 | [WARP-230](https://warp-lab.atlassian.net/browse/WARP-230) | TPM 2.0-sealed device identity | Crypto | 🔵 |
| 3 | [WARP-231](https://warp-lab.atlassian.net/browse/WARP-231) | UEFI Secure Boot + signed kernel + dm-verity rootfs + IMA | Crypto | 🔵 |
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
| 16 | [WARP-244](https://warp-lab.atlassian.net/browse/WARP-244) | Sigstore + cosign signed container images | SupplyChain | 🔵 |
| 17 | [WARP-245](https://warp-lab.atlassian.net/browse/WARP-245) | CycloneDX SBOM per service + per-release | SupplyChain | 🔵 |
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

| Milestone | Target wall-clock | Status |
|---|---|---|
| All engineering controls (WARP-229..272) merged | Month 6-7 | 🔵 not started |
| Policy library complete (WARP-273..274) | Month 7 | 🔵 not started |
| Vanta + Wazuh operational (WARP-275..276) | Month 7 | 🔵 not started |
| Penetration test (WARP-277) | Month 8 | 🔵 not started |
| Pen-test findings remediated | Month 9 | 🔵 not started |
| SOC 2 Type I readiness assessment (WARP-278) | Month 9 | 🔵 not started |
| **SOC 2 Type I attestation issued** | Month 10 | 🔵 not started |
| HIPAA gap assessment (third-party) | Month 11 | 🔵 not started |
| **Launch-ready** | Month 11-12 | 🔵 not started |
| SOC 2 Type II observation period start | Month 11 | 🔵 not started |
| **SOC 2 Type II attestation issued** | Month 18-24 | 🔵 not started |

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

*(none yet — first ticket WARP-229 in progress at design-doc-commit time)*

---

*Living document. Last updated 2026-05-09 at design-doc creation.*
