# Embedded PM stack — pilot procedure (superseded)

> **Superseded by [ADR-026](ADR-026-native-pm-supersedes-plane.md).**
>
> This document was the operator runbook for piloting the **embedded Plane PM
> stack** (ADR-010 / Epic WARP-496). That stack has been removed: project
> management is now a **native module owned by the orchestrator** — no `pm`
> compose profile, no `pm-*` containers, no `:8443` origin, no `DROPLET_PM_*`
> secrets, and no separate Plane login. PM data lives in the orchestrator's own
> Postgres (`Pm*` Prisma models) and renders natively in the dashboard
> `/projects` surface.
>
> There is no separate PM stack to deploy or observe, so this pilot procedure no
> longer applies. See **ADR-026** for the native PM design and rollout.
