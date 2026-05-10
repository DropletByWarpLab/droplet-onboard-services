# Local Knowledge Platform — Long-Term Design

**Status:** Design baseline as of 2026-05-09; execution strategy updated 2026-05-10 (see §2.5 below). North-star reference; every product PR conforms to it.

**Tracking epic:** WARP-228 — Trust & Compliance Foundations.
**Sequential execution chain:** WARP-229 → WARP-278 (50 child tickets, blocks-linked in order).
**Live progress:** `docs/compliance-progress.md`.

## 2026-05-10 strategy update — E → C

The original "all-compliance-first, sequential, then product" plan was honest about timeline but heavy: 12-18 months wall-clock with zero product features in the window. After introspection we moved to:

- **E (triage now):** WARP-227 (fix 9 broken rag-tests) and WARP-225 (dashboard context-meter — direct user ask) before any new lane starts.
- **C (interleaved going forward):** compliance lane (WARP-229..278) and product lane (Phases A-J below) run in parallel, alternating weeks. Compliance milestones become customer-demand-gated rather than wall-clock-gated.

WARP-229 spec is preserved at `docs/superpowers/specs/2026-05-10-warp-229-fips-provider-design.md` and resumes when the compliance lane is active. The 50-ticket Jira chain is not changed; only execution cadence shifts.

Audits (SOC 2 Type I/II, HIPAA gap assessment, pen test booking, GRC tooling) are deferred until a customer demand justifies the cost. Engineering controls still ship; the audit attestations follow when paid demand exists.

---

## 1. Goal

Build a local-only equivalent of Glean (search + assistant + agents + developer surface), running entirely on the Droplet edge appliance, **compliant with SOC 2 + HIPAA + NIST 800-53 Moderate from launch day** and using exclusively the customer's own files, internal APIs, and on-device LLM.

The hard moats Glean defends — real-time permission mirroring across 100+ SaaS APIs, per-tenant fine-tuned embeddings without data leaving the tenant, an enterprise graph trained on years of click data — collapse when "the tenant" is a single household or small team and sources are local-first. Resource constraint becomes the design driver in their place.

## 2. Compliance targets and reality

| Target | "Day 1" achievable? | Path |
|---|---|---|
| SOC 2 Type I attestation | Yes — point-in-time audit | 6-9 months engineering + 3-6 months policies, audit ~9 months in |
| SOC 2 Type II attestation | **No — physically impossible.** AICPA framework requires 6-12 months of observed control operation. | Type I + 6-12 month observation window |
| HIPAA-ready (architecture + BAA + processes) | Yes — there's no certificate to wait for | 6-9 months of work |
| FIPS 140-3 cryptographic modules | Yes — via pre-validated modules (BoringCrypto / OpenSSL 3 FIPS provider) | use pre-validated modules from day 1 |
| NIST 800-53 Rev 5 Moderate baseline mappings | Yes — documentation exercise | 3-6 months |
| STIG-hardened OS profile | Yes — configuration | 2-3 months |
| FedRAMP | **N/A — wrong shape.** FedRAMP is for cloud services consumed by federal agencies. On-prem appliances are out of scope; the agency does its own ATO under FISMA. | Replaced with FISMA-aligned controls + Common Criteria EAL2 if a federal customer materializes |
| Common Criteria EAL2 | Lab-time-bound; deferred to year 2 unless a sponsoring customer materializes | 12-18 months from lab engagement |

**Honest "day 1" launch posture:** SOC 2 Type I attestation in hand + HIPAA-ready architecture and processes + FIPS 140-3 modules in use + NIST 800-53 Moderate control mappings published + STIG-compliance docs published. Type II follows ~12 months after launch.

## 3. Local-first design principles

These are the five rules every downstream decision answers to:

1. **Single-DB unless it hurts.** Postgres 16 with `pgvector`, `pg_search` (Tantivy), `apache_age`, and `pg_tde` covers vector + lexical + graph + relational + column-encryption in one process. Adding a second data store is the killer; coordination cost is the second killer.
2. **Models live behind a single proxy.** `services/ai-gateway` is the single model pool. Embeddings, reranking, OCR, ASR, scene detection — one place to swap models, one place to enforce VRAM budgets.
3. **Activity is captured from day one.** Glean's personalization graph took years because they had to instrument click data after launch. We instrument from the first commit. Every search, every chat turn, every tool call emits a structured event into the audit log + activity stream.
4. **Local-first means no upload, ever.** Embedding fine-tuning runs on-device. Reranker training on-device. Personalization rankers on-device. The only network egress is configurable mirrors for software updates and (optionally) pre-validated cloud LLM fallback when the operator opts in.
5. **Compliance-by-default.** Every code path is built against Phase 0 controls. New PRs have a security review checklist. Retrofitting tamper-evident audit logs into a system with millions of historical events is impossible; we don't try.

## 4. Capability gap — Glean vs Droplet today

| Glean capability | Status on Droplet | Notes |
|---|---|---|
| Hybrid retrieval (BM25 + vector + rerank) | partial | We have pgvector + naive ranking. No BM25, no reranker. |
| Per-customer fine-tuned embeddings | missing | We use a general embedding model via ai-gateway gRPC. |
| Knowledge graph (content + people + activity) | missing | No graph store. We have FileContentChunk and BrainMemoryItem; no edges. |
| Personalization rankers | missing | No activity events table, no click signals collected. |
| RAG chat with citations | partial | `/api/llm/chat` works; citations point at file paths but no section anchors. |
| Deep Research / Canvas / Prompt Library | missing | None. |
| Agent loop with tool calling | good | `llm-agent.service.ts` + `@droplet/tools-core` + MCP server. |
| Agent Library + Builder | missing | Tools exist; pre-built agents (compositions) and a no-code builder don't. |
| Connectors | partial | Nextcloud, Frigate, Matter, routing, switch, automount. ~5 of ~15 we'd want. |
| Permission mirroring | partial | Per-user chunk-level RBAC works for our own data. No cross-source ACL ingestion yet. |
| Audit / governance | missing | No audit log of queries, retrievals, tool calls. |
| MCP server | good | Stdio + HTTP transports, JWT auth, per-tool RBAC, ~20 tools. |
| REST Client API | partial | Several routes exist but no unified versioned API surface. |
| Web SDK / Generated SDKs / Browser extension / Activity feed / Indexing API | missing | All to build. |
| **Compliance posture** | **far below target** | Will be addressed by Phase 0 before any other product work. |

## 5. Phase 0 — Trust & Compliance Foundations

This phase is **the prerequisite** for all subsequent product work. The 50 child tickets of WARP-228 are sequenced in `docs/compliance-progress.md`. Themes summarized here:

### 5.1 Cryptographic foundations (WARP-229 through WARP-236)
- FIPS 140-3 validated cryptographic provider across all services (OpenSSL 3 FIPS provider / BoringCrypto). PR-blocking lint that bans non-FIPS algorithms.
- TPM 2.0-sealed device identity at first boot with reseal-on-rotation flow.
- UEFI Secure Boot + signed kernel + dm-verity rootfs + IMA runtime measurement.
- LUKS2 data partition encryption with TPM-sealed unlock keys (no boot passphrase).
- Postgres TLS 1.3 + SCRAM-SHA-256 + `pg_tde` column-level encryption for sensitive fields.
- Redis 7 TLS + per-service ACLs.
- MQTT broker TLS + per-service mTLS replacing the shared password.
- Internal service-to-service mTLS via cert-manager-style flow.

### 5.2 Audit & monitoring (WARP-237, WARP-250 through WARP-253)
- Append-only Merkle audit log: every privileged op, every data access, every key operation. Hash-chained, daily signed roots, tamper detection.
- OCSF-formatted export + syslog-over-TLS forwarding to operator-configurable SIEM.
- AIDE-style file integrity monitoring of critical paths.
- Anomaly detection on activity events (5σ deviation on rates, off-hours admin actions, MFA failure bursts).
- Authenticated time sync (NTS via Chrony) — audit log integrity depends on trusted timestamps.

### 5.3 Identity & access (WARP-238, WARP-239, WARP-247 through WARP-249)
- WebAuthn (FIDO2) MFA — replaces TOTP-only and SMS paths per NIST 800-63B.
- SAML 2.0 + OIDC SSO via embedded Authentik.
- Session management hardening — idle/absolute timeouts, concurrent caps, full revocation.
- Expanded RBAC matrix (viewer/editor/admin/security-admin/auditor/agent-runner) + ABAC for connector-source ACLs.
- Just-in-time admin elevation with re-authentication and session recording for forensics.

### 5.4 Data protection (WARP-240 through WARP-242, WARP-254 through WARP-258)
- Data classification taxonomy (public/confidential/PII/PHI/PCI/secret) with chunk-level tagging.
- Presidio DLP at index time + medical entity recognizers (ICD-10, MRN, CPT, NPI, RxNorm).
- Per-document encryption keys with crypto-shred deletion path.
- Restic backup with per-customer keys + automated monthly restore drill.
- Programmable retention engine driven by classification.
- Right-to-delete via key destruction (GDPR + HIPAA disposal).
- Customer data export — GDPR-style "everything about me."
- Breach notification automation + templated runbooks for HIPAA 60-day and GDPR 72-hour windows.

### 5.5 Vulnerability + supply chain (WARP-243 through WARP-245, WARP-259 through WARP-263)
- CI gate: Trivy + Dependabot + osv-scanner + Semgrep + CodeQL + gitleaks + hadolint, all PR-blocking.
- Sigstore + cosign signing on every release; runtime signature verification at pull time.
- CycloneDX SBOM (1.5) per service + aggregated device SBOM published with each release.
- On-device CVE scanner + patch agent with rollback.
- Reproducible builds (Nix or Bazel).
- Dependency provenance — sigstore-verified pulls only.
- Hardware BOM tracking with tamper detection on component changes.

### 5.6 Incident response + network (WARP-264 through WARP-267)
- Suricata IDS at the network edge (in `services/routing`) with default ET-Open rules + custom rules.
- Tamper detection + automatic isolation on secure-boot or IMA mismatch.
- Forensic preservation hooks: memory dump, container snapshot, audit-log freeze, signed timestamp.
- Incident response playbooks for breach / malware / lost device / key compromise / supply-chain / insider.

### 5.7 Privacy + telemetry (WARP-268 through WARP-270)
- Egress audit: every outbound HTTP / DNS / SMTP traced via eBPF or Cilium-style logging.
- Telemetry-free invariant: PR-blocking CI gate on outbound destinations against an allowlist.
- Customer-initiated diagnostic bundle export — redacted via Presidio, operator-reviewed before sharing.

### 5.8 Governance UI + Trust Center (WARP-246, WARP-271, WARP-272)
- Admin audit log viewer with hash-chain verification badge.
- Per-user retention controls.
- Trust Center: live attestations, policies, SBOMs, pen-test summaries, integrity badge, incident disclosures.

### 5.9 GRC operations (WARP-273 through WARP-278)
- Information Security Program — full ~80-doc policy library.
- HIPAA-specific documents: BAA template + Privacy Notice + Breach Risk Assessment.
- Vanta / Drata GRC tooling onboarding for continuous evidence collection.
- Wazuh SIEM deployment.
- Penetration test vendor selection + first booking.
- SOC 2 Type I readiness assessment + audit firm engagement.

### 5.10 What this enables

By end of Phase 0:
- Every existing product feature operates under documented controls.
- A SOC 2 Type I auditor can attest to control design.
- A HIPAA-covered customer can sign a BAA and deploy us.
- A federal customer can do their own ATO using our 800-53 control mapping.
- Every PR henceforth runs through the security CI gate.

---

## 6. Phase A through J — product

These phases run **after** Phase 0. Every ticket inside them inherits Phase 0 controls (audit logging, encryption, classification, RBAC, etc.) — they're not "stamped on later," they're built into each ticket's acceptance criteria.

### Phase A — Hybrid retrieval foundation
- Lexical (BM25 via `pg_search` Tantivy-on-Postgres) alongside pgvector
- RRF fusion + cross-encoder reranker (BGE-reranker-v2-m3 int8 in ai-gateway)
- Section-anchor extraction at chunk-write time (PDF page, video timestamp, audio timestamp, email message-id, markdown heading)
- Citations with deep links back to anchored source

### Phase B — Activity graph + first-pass personalization
- `ActivityEvent` table + Redis-streams async emission
- Materialized views (recent files, frequent collaborators, topic clusters)
- Recency + frequency boost in reranker
- Activity feed UI

### Phase C — Knowledge graph
- Apache AGE in same Postgres for graph
- Node types: Person, Document, Topic, Device, CalendarEvent
- Edge types: created_by, viewed_by, mentioned_in, replied_to, lives_on, attended_by, references
- Backfill + continuous maintenance hooks
- `graph_query` MCP tool + higher-level `find_experts` and `related_documents`

### Phase D — Connector framework + first 5 local connectors
- Spec: NormalizedDocument + ACL + crawl + realtime
- Runtime in new `services/connector-runtime` (Python, APScheduler-driven)
- IMAP, CalDAV, CardDAV, USB drives, Plex/Jellyfin
- Push API for arbitrary custom data

### Phase E — Assistant power features
- Deep Research mode (multi-step planner → structured citations report)
- Canvas (Yjs CRDT collaborative document workspace)
- Prompt Library (per-user + shared)
- Chat memory hardened
- Permission filtering at retrieval time across connector ACLs

### Phase F — Agent platform
- Agent definition spec (YAML)
- Agent runtime (extends `llm-agent.service.ts`)
- Agent Library — 10 pre-built agents (network triage, photo album builder, meeting summarizer, bill auditor, smart home routine builder, vacation prep, daily digest, file dedup scanner, document Q&A, photo memory)
- Agent Builder UI in dashboard
- Action tools (write paths) gated by per-action confirmation
- Agent observability — trace UI + replay + eval runner

### Phase G — Per-device fine-tuned embeddings
- Training-data pipeline: contrastive triplets from clicks
- On-device LoRA fine-tune in idle hours (apscheduler)
- Hot-swap with A/B harness
- Re-embed only deltas
- Eval harness with auto-rollback

### Phase H — Governance ops (extends Phase 0)
- AuditLog enrichments
- DLP rule expansion
- Audit UI deepening
- Per-user retention UI (full implementation)
- Export tooling production-grade

### Phase I — Developer surface
- OpenAPI spec for entire `/api/*` surface
- Auto-generated SDKs (Python, TypeScript)
- Web SDK — drop-in `<DropletSearch />`, `<DropletChat />`, `<DropletKnowledgeWidget />`
- MCP tool expansion
- Indexing API hardening + bulk batch upload

### Phase J — Browser extension + UI polish
- WebExtension (Chromium + Firefox) with sidebar
- System search bar (Spotlight / krunner / PowerToys plugins)
- VS Code extension
- Hybrid Search UI with structured filters
- Personal Graph view (interactive node-edge UI)

---

## 7. System design — layer by layer

### 7.1 Storage

| Concern | Tech | Where |
|---|---|---|
| Relational | Postgres 16 | `db` container |
| Vector ANN | `pgvector` | same Postgres |
| Lexical / BM25 | `pg_search` (Tantivy) | same Postgres |
| Graph | `apache_age` | same Postgres |
| Column-level encryption | `pg_tde` | same Postgres |
| Cache | Redis 7 (TLS + ACL) | `cache` container |
| Object / blob | Nextcloud (LUKS2-backed) | nextcloud + host bind-mount |
| Event queue | Redis Streams | `cache` container |
| Audit log | Postgres append-only with daily signed roots | same Postgres |
| Time series | Postgres partitioned by month | same Postgres |

### 7.2 Ingestion

```
┌─────────────────────────────────────────────────────────────┐
│ services/connector-runtime  (new, Python, APScheduler)      │
│                                                             │
│  Nextcloud / IMAP / CalDAV / Plex / USB / Push API ...      │
│                                                             │
│  Each connector → NormalizedDocument + ACL + classification │
│                                                             │
│                       │                                     │
│                       ▼                                     │
│      extractors.dispatch()  (existing recursive dispatcher) │
│                       │                                     │
│                       ▼                                     │
│      Presidio DLP scan (Phase 0 — WARP-241)                 │
│      → auto-classify chunks                                 │
│                       │                                     │
│                       ▼                                     │
│      Per-document DEK encryption (Phase 0 — WARP-242)       │
│                       │                                     │
│         ┌─────────────┼─────────────┐                       │
│         ▼             ▼             ▼                       │
│   FileContentChunk  ActivityEvent   Graph nodes & edges     │
│   (encrypted)       (audit log)     (Apache AGE)            │
│                                                             │
│   Embed via ai-gateway (LoRA-adapted weights when ready)    │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Retrieval

```
                       Query
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         BM25 (k=100)  ANN (k=100)  Graph
                         │          (entity-anchored)
              └──────────┼──────────┘
                         │
                  RRF fusion (top 50)
                         │
                         ▼
              Cross-encoder reranker
              (personalization features)
                         │
                         ▼
              Per-user ACL filter
              (RBAC + ABAC + classification)
                         │
                         ▼
                    Final top-K
```

ACL filter is the last step (after rerank) so the reranker has more candidates. Personalization features fed to the reranker include: recency_score, frequency_score, collaborator_score, topic_affinity, classification-based filter (e.g., user without `phi-access` won't see `phi`-tagged chunks regardless of permissions).

### 7.4 Assistant + agent

```
┌──────────────────────────────────────────────────────────────┐
│ /api/llm/chat                                                │
│   ├── system prompt (per-mode: assistant | research | agent) │
│   ├── retrieval (sec 7.3)                                    │
│   ├── conversation memory                                    │
│   ├── prompt-library expansion if /library run               │
│   ├── canvas state (if attached)                             │
│   └── agent loop                                             │
│        ├── tool registry (read tools + write tools)          │
│        ├── confirmation gate for write tools                 │
│        ├── eval / retry semantics                            │
│        └── trace persistence (AgentRun) + audit log emission │
└──────────────────────────────────────────────────────────────┘
```

### 7.5 ai-gateway model surface

Single proxy, single model pool, single VRAM budget. Endpoints:
- `/v1/chat/completions` → Ollama (LLM)
- `/v1/embeddings` → BGE-large-en-v1.5 + per-device LoRA adapter
- `/v1/rerank` → BGE-reranker-v2-m3 int8
- `/v1/asr` → faster-whisper
- `/v1/ocr` → Tesseract / PaddleOCR
- `/v1/diarize` → pyannote (Phase F WARP-207)
- `/v1/scene-detect` → CLIP-based (Phase J)

### 7.6 Resource budget — Jetson Orin (32 GB)

| Component | Memory | Notes |
|---|---|---|
| Postgres + extensions | 2-3 GB | Tunable via shared_buffers |
| Redis | 0.5 GB | |
| Orchestrator (Node) | 0.5 GB | |
| File-indexer (Python) | 0.5-1 GB | + transient OCR/ASR |
| Connector runtime (Python) | 0.5 GB | |
| LLM (8B Ollama Q4_K_M) | 8-10 GB | |
| Embedding model | 1.5 GB | BGE-large + LoRA adapter |
| Reranker | 0.5 GB | int8 |
| ASR (faster-whisper small) | 0.5 GB | |
| Web dashboard SSR | 0.3 GB | |
| Audit + SIEM agents | 0.5 GB | |
| Headroom | 6-9 GB | |

---

## 8. Repo placement guide

| New code | Lives in | Why |
|---|---|---|
| FIPS provider configuration | per-service Dockerfile + `scripts/test-fips.sh` | Cross-cutting; touched in every container |
| Device identity | `services/device-identity/` (new) | TPM operations isolated |
| Audit log writer | `apps/orchestrator/src/lib/audit.ts` + Python sibling in indexer/connector | Per-service emission, central table |
| MFA / SSO | `apps/orchestrator/src/middleware/auth.ts` + Authentik container | Hardens existing auth surface |
| Classification | `apps/orchestrator/prisma/migrations/` + `services/file-indexer/extractors/classify/` | Schema + indexer plugin |
| Presidio DLP | `services/file-indexer/dlp/` (new submodule) | Runs at chunk-write time |
| Per-doc encryption | `apps/orchestrator/src/lib/crypto.ts` + Prisma `@encrypted` decorator | Wraps Prisma reads/writes |
| Egress audit | OS-level eBPF + per-service log sink | Cross-cutting |
| Lexical search | `apps/orchestrator/prisma/migrations/` + `apps/orchestrator/src/services/retrieval.service.ts` | Same DB |
| Reranker serving | `services/ai-gateway/` | Centralizes model pool |
| Activity events | `apps/orchestrator/src/lib/activity.ts` (new) | Imported by every route |
| Knowledge graph | `apps/orchestrator/src/services/graph.service.ts` (new) | Wraps AGE access |
| Connector runtime | `services/connector-runtime/` (new Python service) | Sibling pattern to file-indexer |
| Connector specs | `packages/connector-spec/` (new TS) | Shared types |
| Agent definition spec | `packages/agent-spec/` (new TS) | Type-safe loader |
| Agent Library | `packages/agent-library/` (new TS) | YAML files + bundle |
| Canvas backend / frontend | `apps/orchestrator/src/routes/canvas.ts` + `apps/web-dashboard/src/app/canvas/` | Yjs persistence |
| Prompt library | `apps/orchestrator/src/routes/prompts.ts` + dashboard route | |
| LoRA fine-tune pipeline | `services/embedding-trainer/` (new Python) | Heavy compute, isolated |
| Web SDK | `packages/web-sdk/` (new TS) | React component library |
| Browser extension | `apps/browser-extension/` (new) | Sibling to web-dashboard |
| Trust Center page | `apps/web-dashboard/src/app/trust/` | Public-facing |
| Policy library | `docs/security/policies/` | All policy markdown lives here |
| HIPAA docs | `docs/security/hipaa/` | BAA template + Privacy Notice |

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Postgres-as-everything hits a wall | medium | high | Decouple retrieval interface so we can add Qdrant / OpenSearch behind it without changing callers |
| Compliance work pushes product roadmap >24 months | high | medium | Phase 0 sequencing is locked; product Phases A-J start the moment 0 is done. Be honest about timeline with stakeholders |
| Per-device fine-tuning regresses retrieval | medium | medium | Eval harness + auto-rollback (WARP-LXC-64) — won't ship weights that lose on NDCG@10 |
| TPM sealing fails on a kernel update without operator awareness | medium | high | Reseal ceremony documented; recovery partition catches failed boots; ops alerts on PCR mismatch |
| FIPS provider breaks a hot-path performance | low | medium | Bench before commit; if regression >10%, allowlist a non-FIPS algorithm via documented exception path |
| Audit log writes saturate disk I/O at scale | medium | high | Per-month partitioning + archival; performance budget <2ms p99 enforced in tests |
| Encryption-at-rest performance overhead unacceptable | low | medium | Limit pg_tde to PHI/PII columns; bench at every release |
| HSM / cosign signing infrastructure is single point of failure | medium | high | Multi-region key escrow; documented disaster-recovery for signing keys |
| SOC 2 audit firm finds policy gaps too late | medium | medium | Pre-audit readiness assessment 2-3 months before formal Type I audit |
| LLM context window can't hold reranked top-K + memory + canvas | medium | medium | Per-mode token budgets in orchestrator; truncation transparent to user |
| Browser extension privacy surprise | medium | high | Opt-in per browser, encrypted on-device, never leaves the device, surfaces "what's captured" auditably |

---

## 10. Sequential execution plan

The 50 child tickets of WARP-228 form a `Blocks` chain in Jira: WARP-229 must complete before WARP-230 can start, and so on through WARP-278. The chain is non-negotiable because:

- Cryptographic primitives (WARP-229..236) underpin every subsequent control.
- The audit log (WARP-237) must exist before any code that emits to it is hardened (WARP-247..253).
- Identity (WARP-238..239) must be hardened before sessions are tightened (WARP-247).
- Classification + DLP + per-doc encryption (WARP-240..242) are prerequisites for the data-protection set (WARP-254..258).
- CI gates (WARP-243..245) must be in place before subsequent code can be reviewed against them.

Execution: subagent-driven development harness (the same we used for WARP-224). Each ticket goes through:
1. Brainstorm (if non-trivial) → spec → plan (using the existing skill chain).
2. Subagent implementation with TDD.
3. Spec compliance review.
4. Code quality review.
5. PR + CI + admin merge.
6. Update `docs/compliance-progress.md`.

`docs/compliance-progress.md` is the live status board. Every ticket close updates it.

---

## 11. What this isn't

- **Not a public cloud.** Multi-tenant isolation, global deployment, SLAs — not us. Each device is its own world.
- **Not 100+ SaaS connectors.** ~15 local connectors plus the push API. Cross-system reach is via push.
- **Not a 70B-model experience.** 8B-class quantized LLM on Jetson is the realistic target. Operators who want frontier models can route to BYOK via the Model Hub in Phase F, but the default and primary mode is local.
- **Not FedRAMP.** That's a cloud certification. We pursue FISMA-aligned controls + Common Criteria EAL2 if a federal customer materializes.

---

*Living document. Last updated 2026-05-09 with WARP-228 epic + 50 child tickets filed and chained.*
