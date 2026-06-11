---
name: gtm-alignment
description: |
  Map the April 2026 GTM strategy doc (droplet-gtm-strategy.docx) onto
  this repo: path translation, per-phase status (PH1-PH5), and which
  GTM milestones touch this repo. Use when following or citing the GTM
  doc, assessing phase/milestone status, or scoping work against GTM
  Stage 1-3 milestones.
---

# GTM Alignment (April 2026)

The April 2026 internal GTM strategy doc (`droplet-gtm-strategy.docx`) assesses the project against a reference architecture that has drifted from this repo's layout. When following the GTM doc, use `docs/gtm-mapping.md` to translate its file paths to the ones that actually exist here. The most frequent mapping: GTM's `services/assistant-api/` is split between `apps/orchestrator/` (Node control plane) and `services/ai-gateway/` (Python LLM proxy); tool-calling lives in the separate `inference-engine` repo.

## Phase status against GTM §1 (scoped to this repo)

| Phase | Name | Status here | Notes |
|---|---|---|---|
| PH1 | Repo + Runtime | **Complete** | Turbo monorepo + `docker/docker-compose.yml` (34 services, unified) + `scripts/setup.sh` / `factory-reset.sh`. Stack convergence (GTM M1.1) is already done here — no separate router/assistant compose files. |
| PH2 | Device Control API — auth/RBAC | **Not started** for JWT/RBAC | Auth middleware (`apps/orchestrator/src/middleware/auth.ts`) validates Bearer tokens against Nextcloud OCS with a 5-minute Redis cache and `droplet_session` cookies. No JWT issuance/refresh, no role model in Prisma. |
| PH3 | Service stubs → real | **Partial** | `services/routing/` (OpenWrt ubus), `services/camera-discovery/` (ONVIF/RTSP/Frigate), `services/file-indexer/` (filesystem + embeddings) are real services. Gaps: audit-log table, storage-metrics completeness, NVR clip-export delegation. |
| PH4 | Assistant tooling hardening | **N/A here** | Primary hardening lives in `inference-engine` (OpenClaw sandbox + tool policy). This repo's `services/ai-gateway/` is the outer input layer — M2.7 input-validation + rate-limit coverage needs to be audited here. |
| PH5 | Docs + polish | **Partial** | README.md, CLAUDE.md, CONTRIBUTING.md, scripts/README.md, TESTING.md are solid. Missing: OpenAPI wiring (delegated to `shared-api`), threat model, architecture diagrams beyond the README's ASCII art. |

## GTM milestones that touch this repo

Most of Stage 1 (M1.1–M1.8) lives here in some form, most of Stage 2 (M2.1–M2.8) does too, and Stage 3 participation is mostly M3.4 (OTA update agent) and M3.6 (extension-registry backend + UI). Per-milestone status and file pointers live in `docs/ROADMAP.md`.

## Pointers

- `docs/ROADMAP.md` — per-milestone status (M1.1–M3.6), blockers, next actions
- `docs/gtm-mapping.md` — path-by-path bridge from GTM reference architecture to this repo's layout, plus the major architectural deltas (OpenWrt vs. Pi-Docker router, Node vs. Python control plane, `file-sync` → `file-indexer` rename, Next.js vs. static HTML UI)
- `docs/STATUS.md` — Working / Partial / Not started capabilities with file references, and PH1–PH5 table
