# Plane upstream patches

Per [ADR-010](../../docs/ADR-010-pm-stack-selection.md): we ship vanilla Plane. Any local modification of Plane source code that ends up on a customer appliance must be recorded here, and the customer must be offered the corresponding source per AGPL-3 §13.

Currently: **no patches**. We pin upstream by commit SHA in [`docker-compose.local.yml`](docker-compose.local.yml) and the root [`docker/docker-compose.yml`](../../docker/docker-compose.yml).

If a patch becomes necessary (e.g. CSP `frame-ancestors` for iframe embedding per spec OQ2), record it here as:

```markdown
## <YYYY-MM-DD> — <short title> (WARP-NNN)

- **Upstream commit:** <SHA we forked from>
- **Reason:** <one sentence>
- **Files touched:** <list>
- **Patch lives at:** <path in this repo, e.g. patches/0001-csp-frame-ancestors.patch>
- **Customer source-offer URL:** <link to our fork's tag>
```

## Compliance posture

1. Plane upstream pinned by **commit SHA** (per spec OQ3 resolution), not floating tags.
2. SHA refresh is a deliberate per-Droplet-release decision; not auto-pulled.
3. Dashboard footer links to https://github.com/makeplane/plane and notes the pinned SHA.
4. If a customer requests source, Warp Lab serves the corresponding upstream tarball at the pinned SHA + any patches recorded above.
