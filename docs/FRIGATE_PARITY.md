# Frigate Feature Parity in the Droplet Dashboard

> **Goal.** Every feature Frigate exposes through its own web UI is delivered through the Droplet dashboard instead. There is no `/frigate/` escape hatch, no "Open Frigate UI" button, and no separate auth surface — operators manage cameras, events, recordings, zones, detection rules, and system stats entirely from the Droplet dashboard at the box's trusted address (`https://<box-name>.droplet-us.com` — `droplet.local` is the shortcut you can type on the LAN; WARP-1301).

---

## Status: COMPLETE (April 2026)

The dashboard is a strict superset of Frigate's UI. All phases shipped:

| Phase | Feature | PRs |
|---|---|---|
| 1.1 + 1.2 | Multi-camera live grid + fullscreen detail | #104 |
| 1.3 | Camera groups | #106 |
| 1.4 | Pinned cameras | #107 |
| 2.1 | Events listing + clip playback | #108 |
| 2.2 | Retain toggle + Reviews tabs (Alerts / Detections) | #109 |
| 3.1 | Recordings page + 24-hour timeline scrubber | #110 |
| 3.2A | HLS playback (lifts the mp4 30-min cap) | #111 |
| 3.2B | Drag-to-select range + minute-precise export | #112 |
| 4.1 | Per-camera settings (detection / objects / retention) | #113 |
| 4.2 | Zone polygon editor | #114 |
| 4.3 | Motion mask painter | #115 |
| 5 | System health + restart | #116 |
| 6.1 + 6.2 | PTZ overlay + Birdseye | #117 |
| 6.3 | Global notifications preferences | #118 |
| 7.1 | Mobile pairing UI (QR + status polling) | #119 |
| 7.4 | Semantic search (Frigate 0.14+ embeddings) | #120 |
| 7.5 + 7.6 | Face recognition + LPR management | #121 |
| 7.7 | GenAI event descriptions | #122 |
| 7.2 + 7.3 | Web Push pipeline | #123, #124 |

There is no `/frigate/` gateway route. Frigate's bundled UI binary still ships in the upstream container, but the gateway never proxies to it — Frigate's `:8971` (UI) and `:5000` (API) are only reachable from sibling Docker containers (the orchestrator + camera-discovery), and the orchestrator's `/api/cameras/*` is the sole external surface. Camera IPs never leak to the browser.

The "Where we are now" section below is the original snapshot from the planning phase, kept for context.

---

## Where we are now (April 2026)

Already on `main`:

- **Live MJPEG** in the camera detail panel — `/api/cameras/:name/live` proxies Frigate's `multipart/x-mixed-replace` stream through the orchestrator (#102).
- **Snapshot grid** on the cameras list, with a 5 s cache-bucket so a transient failure unsticks itself (#102).
- **Per-camera enable/disable** + **Remove** wired through Frigate's REST API.
- **Auto-discovery** with the Hanwha first-run init flow + a default-credentials probe list (#68).
- **Network isolation** toggle that drops cameras onto the OpenWrt VLAN 100 / `192.168.100.0/24` subnet behind firewall rules.
- **Clip export to Nextcloud** with HMAC-signed share URLs + Clips dashboard tab (#74 / #96).
- **`Camera` / `CameraNotificationPref` / `CommandAuditLog` / `NetworkConfigSnapshot`** Prisma models (#99 finally landed the migration).
- **Orchestrator → Frigate** proxy living in `apps/orchestrator/src/services/frigate.client.ts` + `apps/orchestrator/src/routes/cameras.ts`. Camera IPs and Frigate's `:5000` internal port never leak to the browser.

Open on the Frigate side, but not yet surfaced in our UI:

- Events / review items (motion detections with thumbnails + clips)
- Continuous recordings + timeline scrub + calendar view
- Zone / mask drawing
- Per-camera detection rules (object filters, thresholds, FPS, audio)
- System stats (CPU, GPU, disk) + per-detector inference time
- Frigate logs viewer + YAML config editor
- PTZ controls + presets
- Birdseye composite view
- Notifications (push / email / webhook)
- Frigate's built-in user mgmt (we'll use ours instead — see Architecture)

---

## What Frigate's UI exposes (parity surface)

Roughly six product surfaces:

1. **Live** — MJPEG / MSE / WebRTC streams. Per-camera, multi-camera grid, birdseye composite. Stream quality selector (sub vs main).
2. **Events** — Object/motion detections with thumbnail + clip. Filterable by camera, label, sub-label, zone, time, score. Mark reviewed, delete, bulk actions.
3. **Recordings** — Continuous recording + alerts. Timeline scrub, calendar of days with footage, custom-range clip export, retention policies.
4. **Detection** — Per-camera object filters, thresholds, hysteresis, FPS, masks, zones, audio detection rules.
5. **System** — Stats (CPU, GPU, memory, disk), per-detector inference time, ffprobe per camera, logs, YAML editor, restart.
6. **Misc** — PTZ + presets + autotracking, birdseye, notifications config.

---

## Phased delivery

Each phase ships as its own milestone. Each PR within a phase has a single coherent scope (the same discipline we just used for the migration / password / live-feed work).

### Phase 1 — Live experience
*Highest-leverage; builds directly on what's already on `main`. **MJPEG everywhere** — most reliable, every browser, no extra firewall holes, off-LAN through HTTPS just works.*

- [ ] **Multi-camera live grid** — `CameraCard` keeps the snapshot `<img>` (cheap, ~80 kbps per card) but bumps the refresh bucket from 5 s to 1 s for "near-live" feel. On hover/focus, switch to the MJPEG live URL via `getCameraLiveUrl` for true motion preview.
- [ ] **Single-camera fullscreen view** at `/cameras/[name]` — full-bleed MJPEG via `getCameraLiveUrl`, status badge, quick toggles for enable/disable + recording, slide-up info panel.
- [ ] **Camera groups** — operator-defined logical groups (e.g. "Front of house", "Backyard") rendered as a navigation rail above the grid.
- [ ] **Pinned cameras** — per-user pin to elevate a subset above the alphabetical grid.

> **Why MJPEG over MSE/WebRTC for Phase 1:** zero new infrastructure (no UDP ports, no TURN, no WebSocket signaling), works in every browser including Safari without polyfills, and survives any HTTPS reverse-proxy unchanged. ~1–2 s latency on LAN is fine for a security camera live view (Ring/Nest/Wyze all sit in the same range). Bandwidth on the grid is dominated by snapshots, not MJPEG, because we only flip to MJPEG on hover/focus. **MSE-over-WebSocket** is a one-day upgrade we can take in Phase 6 if anyone hits a bandwidth wall on the fullscreen page; **WebRTC** sits behind that as a follow-up if PTZ ever needs sub-500 ms input feedback.

### Phase 2 — Events / Review
*The single highest-traffic page in any NVR.*

- [ ] **`/events` page** with infinite scroll, filterable by camera, label, time range, zone, score.
- [ ] **Event detail panel** — clip player, thumbnail strip, metadata (label, score, zone hits, duration, snapshot).
- [ ] **Mark reviewed / unmark** + **delete** actions, with confirm + undo for delete.
- [ ] **Bulk select** with select-all-in-view + bulk delete + bulk mark reviewed.
- [ ] **Real-time event feed** via SSE — already proxied via `/api/cameras/events/sse`; surface as a toast + auto-refresh at the top of `/events`.

### Phase 3 — Recordings & Timeline
*Storage-aware, the heaviest feature to get right.*

- [ ] **Calendar** per camera at `/cameras/[name]/recordings` — which days have how many minutes; click a day to scrub.
- [ ] **Timeline scrubber** with motion + event markers overlaid, snap-to-event.
- [ ] **HLS playback** for VOD via the orchestrator (`/api/cameras/:name/recordings/hls/master.m3u8`).
- [ ] **Custom-range clip export** — promote the existing `export_clip` LLM tool flow (#74) to a first-class UI button on the timeline.
- [x] **Storage breakdown** (WARP-1850) — bytes per camera, measured MiB/hr, each camera's share of the volume, and a combined "days of free space left" figure, from `GET /api/recordings/storage`. Drives an edge-triggered near-full warning (one ActivityRow per crossing) and the `get_camera_storage` tool. Oldest-recording-per-camera is still open.

### Phase 4 — Per-camera settings
*The config surface; biggest UI-design lift.*

- [ ] **Detection settings** form per camera — object filter list (multi-select w/ Frigate's known classes), min/max area, threshold, hysteresis, FPS.
- [x] **Recording settings — retention** (WARP-1849). All four windows are per-camera editable: `record.continuous.days`, `record.motion.days`, `record.alerts.retain.days`, `record.detections.retain.days`, plus `snapshots.retain.default`. Frigate enforces them natively; the orchestrator no longer attempts its own deletion. See "Retention — who deletes what" in `camera-system.md`.
- [ ] **Recording settings — remainder** — audio recording on/off, pre/post-roll seconds.
- [ ] **Zone editor** — polygon drawing on the live snapshot canvas; per-zone required-objects + inertia.
- [ ] **Mask editor** — same canvas, multi-polygon for motion masks + per-object-class masks.
- [ ] **Audio rules** — toggle audio detection + per-class thresholds (cry, dog bark, etc.).
- [ ] All of the above writes back through `/api/config/set` (Frigate's runtime config endpoint, already used by camera-discovery for adoption).

### Phase 5 — System & Config
*Operator/IT surface.*

- [ ] **Stats page** at `/cameras/system` — CPU, GPU, memory, disk; per-camera ffprobe (resolution, codec, FPS); per-detector inference time + p95.
- [ ] **Logs viewer** for Frigate's container, tailing via SSE.
- [ ] **YAML editor** with monaco-editor + Frigate-schema validation (use Frigate's own `/api/config/save?dry_run=true` to validate).
- [ ] **Restart Frigate** button — calls `/api/restart` via the orchestrator with a confirm dialog and a "what will go down" summary.

### Phase 6 — Advanced
*Niceties that aren't blocking but bring full parity. This is also where lower-latency live streaming lands if/when we need it.*

- [ ] **PTZ controls** in the fullscreen view (only shown for cameras that report PTZ capability).
- [ ] **PTZ presets** + autotracking config.
- [ ] **Birdseye composite** at `/cameras/birdseye` — Frigate already ships this; we proxy the MJPEG.
- [ ] **Notifications config** — wire push (web-push API) + email/webhook routing.
- [ ] **MSE-over-WebSocket fullscreen player** *(opt-in)* — drops fullscreen latency from ~1–2 s to ~500 ms – 1 s and cuts bandwidth ~5×. No extra ports (uses our existing nginx WebSocket upgrade). Add if anyone reports a bandwidth wall on the fullscreen page.
- [ ] **WebRTC for PTZ feedback** *(opt-in, after MSE)* — only worth the UDP-port + TURN cost if PTZ input → response feedback under 500 ms is the actual user need.

---

## Architectural decisions (settled)

### Frigate's built-in auth → disabled

Frigate 0.14+ ships its own JWT-based auth. We disable it (`auth: enabled: false`) and gate everything through the orchestrator's session middleware. Reasons:

- Single source of truth for users / sessions / roles.
- No cookie / JWT bridging between two stacks.
- Frigate's `:5000` API only listens inside the Docker network; the only path in is `/api/cameras/*` on the orchestrator, which already runs the auth gate.

### Streaming protocols → tiered

Default is **MJPEG everywhere for live**. It's the most reliable, lightest-weight, most-integrated path: a multipart `<img>` works on every browser including iOS Safari, no codec polyfills, no extra firewall holes, and any HTTPS reverse-proxy passes it through unchanged. Fancier protocols only land if we hit a concrete pain point.

| Surface | Protocol | Why |
|---|---|---|
| Card grid thumbnails | Snapshot `<img>` refreshed every 1 s (cache-busted) | Cheap (~80 kbps per card). Already done in #102, just bumping the bucket. |
| Card grid on hover/focus | MJPEG (`<img>`) | True motion preview only when the operator is looking at a card. |
| Single-camera fullscreen | MJPEG (`<img>`) | ~1–2 s latency on LAN. Same range as Ring/Nest. Reliable everywhere, no extra ports, off-LAN through HTTPS just works. |
| Birdseye composite | MJPEG (`<img>`) | Frigate produces it natively. |
| Recording playback (VOD) | HLS | Seekable timeline, cacheable, all browsers. |
| *Optional Phase 6:* fullscreen lower-latency | MSE over WebSocket via go2rtc | Drops to ~500 ms – 1 s, cuts bandwidth ~5×. Goes through our existing nginx WebSocket upgrade — no new ports. |
| *Optional later:* PTZ feedback | WebRTC via go2rtc | Sub-500 ms. Worth the UDP + TURN cost only if PTZ requires it. |
| Birdseye | MJPEG | Same reason as the grid. |

WebRTC adds an offer/answer exchange — proxied through the orchestrator to keep the camera IPs hidden.

### Real-time → SSE

Frigate publishes events via MQTT internally and exposes an SSE feed at `/api/events?include_thumbnails=0&...`. We already proxy `/api/cameras/events/sse`; extend it for stats + event lifecycle (review state changes).

### State management → SWR + a small Zustand store

- **SWR** for everything fetched via REST (current pattern).
- **EventSource** for SSE.
- **Zustand** for cross-page selection state (selected event, time range filter, camera group, pinned set). We don't have a global store yet; Phase 2 is when introducing one starts paying.

### API proxy boundary

All Frigate access goes through `apps/orchestrator/src/services/frigate.client.ts`. New endpoints live in `apps/orchestrator/src/routes/cameras.ts` for camera-scoped concerns and a new `apps/orchestrator/src/routes/frigate.ts` for non-camera concerns (stats, config, logs, restart).

### Storage path

Frigate's recordings live on disk under `${NVR_MEDIA_SOURCE}` (default `nvrdata` Docker volume; on the inference host typically `/mnt/cameras`). HLS playback streams from there via the orchestrator with auth + range-request support; clip export already uses Nextcloud (kept as-is).

---

## Out of scope (explicitly)

- **Paid Frigate model subscriptions** — Droplet stays on the OSS Frigate models that ship with the container (yolov9-s and friends). No paid model service is wired up or planned.
- **ONNX model upload** via UI — env var + bind-mount path, not an upload endpoint.
- **Cluster / multi-host Frigate** — single Frigate per Droplet.
- **Replacing Frigate** — we're skinning it, not forking it. If Frigate ships a new feature we want, it's a small PR to surface, not a rewrite.

---

## Tracking

Each phase has its own GitHub milestone (`Frigate Parity — Phase N`). Each PR is named after its concrete deliverable, not the phase number, e.g.:

- `feat(cameras): multi-camera live grid (MJPEG)`
- `feat(events): events page with filters`
- `feat(events): real-time event feed via SSE`
- `feat(recordings): HLS playback through orchestrator`
- `feat(cameras): zone editor (polygon canvas)`

Open this doc in PRs as the source of truth; tick items off as they ship.
