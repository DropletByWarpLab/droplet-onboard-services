# ADR-011: Hardware-agnostic codebase

**Status:** Accepted
**Date:** 2026-05-30
**Deciders:** Stefan (CEO) — directive; Engineering team to execute
**Source:** CEO directive 2026-05-30 ("hardware-agnostic codebase; remove Raspberry Pi / Jetson / specific-hardware references"); the already-in-flight `JETSON_OLLAMA_URL` → `OLLAMA_URL` migration (`scripts/lib/secrets.sh`, `model-readiness.service.ts`, `ollama_local.py`); the fact that the shipping single-box is x86 (AMD Ryzen), not a Jetson.

## Context

The control plane grew up around one specific bill of materials — an NVIDIA Jetson Orin Nano for inference, a Raspberry Pi 5 running OpenWrt as the router, and a Lantronix managed switch. Those names leaked into the codebase as comments, log strings, env-var names (`JETSON_OLLAMA_URL`), file names (`openwrt/scripts/jetson-router-connect.py`), source labels (`"jetson-nmcli"`), and operator-facing copy.

Two things make this a liability:

1. **It's already inaccurate.** The shipping `single-box` deployment (`droplet-sys`, 192.168.1.87) is an x86 AMD Ryzen host with a containerized OpenWrt — there is no Jetson and no Pi in it. Every "Jetson" reference is now misleading to anyone reading the code or operating the box.
2. **It blocks portability.** The product should run on whatever capable hardware a deployment uses (x86 + dGPU today, ARM/other tomorrow). Code that names a specific SoC invites host-specific defaults — the exact failure `04-coding-standards/code-quality-rules.md` rule 14 ("No host-specific defaults") already prohibits.

The migration has effectively already begun: `OLLAMA_URL` is the canonical inference endpoint var, with `JETSON_OLLAMA_URL` kept only as a deprecated, warned fallback, and `secrets.sh` self-migrates `.env` with the log line "renamed JETSON_OLLAMA_URL -> OLLAMA_URL (hardware-agnostic)". This ADR generalizes that one-off into a standing rule.

## Decision

**The codebase is hardware-agnostic. No code, configuration, env var, log/UI string, or file/script name names a specific silicon vendor, SoC, board, or peripheral model.**

### 1. Role-based vocabulary

Refer to components by the role they play, not the part that fills it:

| Don't write | Write |
|---|---|
| Jetson / Orin / Orin Nano / Tegra | the inference host / the appliance / the box |
| Raspberry Pi / Pi 5 / BCM4345 | the router / the router host |
| Lantronix (as *the* switch) | the managed switch |
| MT7922 / MT7921 | the Wi‑Fi radio |
| PyPortal (as *the* display) | the OLED/status display |
| NovaRay / Compute Brick | the compute host |

### 2. Hardware drivers stay as pluggable backends

Device-specific drivers are legitimate and stay — but only behind an abstraction, never hardcoded as the sole option:

- `services/switch/drivers/lantronix.py` remains, selected by `SWITCH_DRIVER` (`lantronix` | `asic` | …). The driver file may name its device; the service must not assume it.
- `services/oled-display/` PyPortal backend stays as one display backend with a sim fallback; the service is display-agnostic.
- Ollama inference target is addressed by `OLLAMA_URL`, never by a host-named var.

Naming the part is fine **inside its own driver/backend module**. Naming it anywhere else (service logic, config defaults, shared comments, env vars, UI) is not.

### 3. Deployment shapes are described by capability, not silicon

`single-box` / `multi-box` / `v2-6` (per the architecture brain) are **capability** shapes: "one host with a dGPU for inference, an iGPU for NVR, and a Wi‑Fi-capable router," not "a Jetson + a Pi." Docs describing a shape state the capability requirement; any concrete part is an *example*, explicitly labelled as such.

### 4. Env vars

`OLLAMA_URL` is canonical. `JETSON_OLLAMA_URL` is deprecated (read-as-fallback + warn, already implemented) and will be **removed** once every provisioned box has self-migrated (tracked separately). No new hardware-named env vars — extends the existing `MATTER_*`/`DROPLET_MATTER_*` and host-specific-default rules.

### 5. Docs: genericize forward, preserve history

- **Forward/canonical docs** (`CLAUDE.md`, `README.md`, `docs/agentic-workflows.md`, operator runbooks, the dashboard, setup output) are genericized to role-based vocabulary.
- **Historical ADRs** (e.g. ADR-005's `dawn`-vs-`usteer` choice "for our hardware profile") are point-in-time decision records. They are **not** rewritten to erase the hardware context that motivated the decision — falsifying a decision record is worse than a stale name. Where a historical ADR's hardware mention is incidental (not load-bearing to the decision), it may be softened, but the rationale stays intact.

## Scope of references (main repo, 2026-05-30 survey, word-boundary)

`jetson` 45 code / 38 docs · `lantronix` 8 / 6 · `Pi 5` 8 / 3 · `JETSON_` 9 / 2 · `orin` 5 / 11 · `MT792x` 5 / 4 · `raspberry` 3 / 2 · `tegra` 3 / 1. Most code hits are comments/log strings; the functional env-var hit is already migrated. Sibling repos (`droplet-local-LLM`, formerly `droplet-jetson-ai`) carry their own references — tracked as follow-up, out of scope for this repo's ADR.

## Consequences

**Easier:** the code reads true to the actual x86 box; portability to other hosts no longer fights hardcoded names; the "no host-specific defaults" rule gains a vocabulary to enforce.

**Harder:** a large, mostly-cosmetic sweep across ~80 files; reviewers must distinguish "rename the reference" (most cases) from "preserve the decision record" (historical ADRs) from "leave the driver module alone" (pluggable backends).

**Revisit:** when `droplet-local-LLM` is genericized and the `JETSON_OLLAMA_URL` fallback is finally removed.

## Action items (each a scoped PR through the harness)

1. [ ] Genericize code-level cosmetic refs (comments, log strings, docstrings, source labels) in `services/` + `scripts/`; rename `openwrt/scripts/jetson-router-connect.py` → `router-connect.py` (+ update `.service` unit and `openwrt/README.md`).
2. [ ] Genericize canonical forward docs (`CLAUDE.md`, `README.md`, `docs/agentic-workflows.md`).
3. [ ] Add a ship-check / `test-security.sh` assertion: no new hardware-named tokens in non-driver, non-historical-ADR files (allow-list the driver modules + `docs/ADR-0*.md`).
4. [ ] Follow-up: genericize `droplet-local-LLM`; remove the `JETSON_OLLAMA_URL` fallback once all boxes migrated.
