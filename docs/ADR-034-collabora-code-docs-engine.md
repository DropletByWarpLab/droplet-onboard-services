# ADR-034 — Collabora CODE (LibreOffice) becomes the default document engine; DICOM/3D/image viewing lands in Nextcloud

- **Status:** proposed
- **Date:** 2026-08-03
- **Ticket:** WARP-1686
- **Deciders:** Stefan (direction given 2026-08-03), Romain (review via PR)
- **Supersedes:** ADR-027 Amendment §2's WS-4 engine pick (OnlyOffice). The rest of ADR-027 (workstreams, WOPI seam, RAM gate) stands.
- **Relates:** ADR-002 (home/small-team persona), ADR-013 (Nextcloud demoted to downstream), ADR-021 (`docs` profile RAM budget), ADR-023 (edge TLS), ADR-027/-027b (Files parity), ADR-029 (Teams/Departments)

## Context

WARP-882 (ADR-027 WS-4) shipped in-browser editing via **OnlyOffice Document
Server Community Edition**. The integration was deliberately engine-agnostic
(WOPI on every seam), and the one gate ADR-027 left open was **licensing**:
OnlyOffice CE is AGPLv3, the appliance *conveys* the engine to customers, and
ADR-027 required "an OnlyOffice OEM/commercial license before GA". That is a
recurring purchase per OnlyOffice's OEM program — a real per-product fee.

Stefan's direction (2026-08-03): implement the **LibreOffice-based engine
provided there is no licensing fee**, and broaden the Nextcloud portion of
Droplet to view **all document types — including CAD, X-rays, and images**.

## Decision

1. **Default engine flips to Collabora CODE** (LibreOffice technology) behind
   a new explicit `DOCS_ENGINE` knob (`collabora` default | `onlyoffice`).
   The seam stays WOPI, exactly as ADR-027 designed — the flip changes config,
   the connector app (`richdocuments` instead of `onlyoffice`), the gateway
   `/docs/` proxy variant, and two engine-keyed branches in
   `docserver.client.ts` (health path + connector page URL). OnlyOffice
   remains fully selectable for a future OEM-licensed SKU.
2. **Viewer breadth ships as free Nextcloud apps + core preview providers**,
   engine-independent, provisioned by `docker/nextcloud-init.sh` with the
   WARP-990 bounded-retry/never-fatal pattern:
   - `dicomviewer` (OHIF v3) — DICOM X-rays/scans (.dcm), 2D/3D/MPR;
   - `files_3dmodelviewer` — STL/OBJ/glTF (the 3D-CAD exchange formats);
   - `enabledPreviewProviders` extended with TIFF/HEIC/SVG (scans, phone
     photos) on top of the re-listed defaults — these previews feed both the
     Nextcloud UI and the dashboard's thumbnail proxy.
3. **The dashboard editor URL becomes browser-facing.** WARP-882 built
   `editorUrl` from the compose-internal `NEXTCLOUD_URL`
   (`http://nextcloud:80/...`), which no browser can resolve. Sessions now
   target the gateway's `/nextcloud/` leg via `NEXTCLOUD_PUBLIC_PATH`
   (path-relative → same-origin under every hostname the box answers on).

## Licensing ground truth (verified 2026-08-03)

| Component | License | Fee |
|---|---|---|
| Collabora CODE (`collabora/code:26.04.2.4.1`) | MPLv2 core; free-of-charge binaries | $0 |
| `richdocuments` (Nextcloud Office connector) | AGPL app | $0 |
| DICOM Viewer (`dicomviewer`, NC 28–32 — our NC 29 ✓) | AGPL-3.0 | $0 |
| 3D Model Viewer (`files_3dmodelviewer`, NC 24–34) | free app-store app | $0 |
| Preview providers (TIFF/HEIC/SVG) | Nextcloud core (AGPL, already conveyed) | $0 |

**Total new licensing fee: $0.** The OnlyOffice OEM purchase drops off the GA
critical path — it now gates only boxes an operator flips to
`DOCS_ENGINE=onlyoffice`. (The appliance already conveys AGPL software —
Nextcloud itself — so the corresponding-source obligation machinery is
unchanged by this ADR; what disappears is the *fee*.)

## Trade-offs accepted (why ADR-027 picked OnlyOffice, and why that flips)

- **CODE's soft limit** (~10 concurrent open documents / 20 connections) was
  ADR-027's shipping-blocker. Against the ADR-002 persona (a household or
  small team on one appliance) it is headroom, not a cap — ten *simultaneously
  open* documents is beyond the realistic concurrent load. If a larger SKU
  ever needs more, the paid path is **Collabora Online for Business** (support
  + higher limits) or the OnlyOffice OEM route — both deliberate purchases,
  neither a code change.
- **OOXML pixel-fidelity** is stronger in OnlyOffice; Collabora is
  good-not-pixel-perfect on .docx/.xlsx/.pptx but strictly broader on formats
  (ODF-native, Visio, WordPerfect, legacy Office, DXF import via LibreOffice
  filters). The user-stated goal is *view all document types* — breadth wins.
- **Collabora's trust model** is the `aliasgroup1` WOPI-host allowlist + proof
  keys instead of OnlyOffice's shared JWT. The allowlist is pinned to the
  compose-internal Nextcloud only (`http://nextcloud:80`) — no wildcard, no
  browser-origin coupling. `ONLYOFFICE_JWT_SECRET` stays generated and
  required either way: the orchestrator signs its own editor-session tokens
  with it (the WARP-882 empty-secret fail-safe is engine-wide).
- **No added Linux capabilities:** the engine runs with
  `--o:security.capabilities=false` instead of `cap_add: MKNOD` — slightly
  slower per-document open, zero extra kernel surface. Security-first wins.
- `allow_local_remote_servers=true` is set in Nextcloud (its HTTP client
  refuses private hosts by default; the richdocuments discovery fetch targets
  `http://docserver:9980/docs` on the compose network). Appliance-internal
  posture, applied by `nextcloud-init.sh`.

## Topology (collabora default)

```
browser ── https://<box>/docs/…  ──► gateway ──► docserver:9980 (coolwsd,
   │        (same-origin iframe;                 net.service_root=/docs)
   │         WS for the live document)                   │ WOPI callback
   └──────  https://<box>/nextcloud/… ─► gateway ─► nextcloud:80 ◄──────┘
                                     (connector page + WOPI host; aliasgroup pin)
```

- `wopi_url = http://docserver:9980/docs` (NC → engine, server-side)
- `public_wopi_url = /docs` (browser → engine via gateway; RELATIVE keeps the
  editor same-origin on the FQDN, `droplet-ai.local`, and `.lan` alike — no
  cross-origin iframe, no cert coupling, works pre-cert-issuance; the value is
  consumed verbatim by richdocuments)
- `wopi_callback_url = http://nextcloud/` (engine → NC, compose-internal —
  matches `aliasgroup1` exactly; the OnlyOffice `StorageUrl` analogue)

## Known debt carried forward (explicitly NOT fixed here)

- **WARP-882 embed debt:** the dashboard's editor iframe loads the Nextcloud
  connector page through the gateway's prefix-stripping `/nextcloud/` leg.
  Nextcloud emits root-absolute asset URLs (`/apps/...`, `/core/...`) that the
  gateway does not route, and the page expects a Nextcloud session the
  dashboard user does not hold. Both predate this ADR (the old compose-internal
  editorUrl could never load at all — this ADR at least makes the URL
  reachable). The clean fix is richdocuments' **direct-editing token API**
  (`ocs/.../richdocuments/api/v1/document` → session-cookie-free
  `/direct/{token}` page) plus scoped gateway asset routing — follow-up ticket
  (see WARP-1686 comments), not shoehorned into the engine flip.
- **DWG stays unviewable** — no free Nextcloud viewer exists for proprietary
  2D-CAD DWG. DXF may open through Collabora's LibreOffice Draw filter
  (best-effort, depends on the connector's mimetype registration); STL/OBJ/glTF
  are covered by the 3D viewer. Anyone needing DWG converts to DXF/PDF first.
- Ghostscript/ffmpeg-dependent providers (PDF-page, EPS, video stills) need
  binaries the stock `nextcloud:29-apache` image does not ship — deliberately
  out of scope; would require a custom Nextcloud image.

## Alternatives considered

- **Keep OnlyOffice and buy the OEM license.** Rejected by the deciding
  constraint itself: the direction is a no-fee stack, and the fee bought
  nothing the persona needs (its no-cap co-authoring headroom is beyond a
  household's realistic load).
- **Nextcloud's built-in CODE server app (`richdocumentscode`).** Zero new
  container and inherently same-origin, but it runs the whole engine inside
  the `nextcloud` container (busts the 768 MB `NEXTCLOUD_MEM_LIMIT`, muddies
  ADR-021's per-service ceilings) and serves through `proxy.php` without
  WebSockets. The dedicated container matches the existing `docserver`
  architecture 1:1.
- **Run both engines side by side** (viewing breadth via Collabora, OOXML
  editing via OnlyOffice). Rejected: two ~2 GB engines on one box, two
  connector apps fighting over office mimetypes, and the OEM fee question
  returns. One engine, selectable, wins.

## References

- `docker/docker-compose.yml` — `docserver` service (engine-selectable image + env)
- `docker/nginx/docs-engine.{collabora,onlyoffice}.conf` + `docker-entrypoint-docs-engine.sh` — gateway variant selector
- `docker/nextcloud-init.sh` — engine-branched connector bootstrap, viewer apps, preview providers
- `apps/orchestrator/src/services/docserver.client.ts` — engine-aware health probe + editor URL
- `apps/orchestrator/src/config.ts` — `DOCS_ENGINE`, `NEXTCLOUD_PUBLIC_PATH`
- `scripts/lib/single-box.sh` — writes the `DOCS_ENGINE` / `DOCS_ENGINE_IMAGE` / `DOCS_INTERNAL_URL` trio
- `docs/ADR-027-files-sharepoint-parity.md` — the WS-4 engine analysis this ADR flips
- richdocuments settings ground truth: `wopi_url` / `public_wopi_url` (consumed verbatim) / `wopi_callback_url` — nextcloud/richdocuments `lib/AppConfig.php`
