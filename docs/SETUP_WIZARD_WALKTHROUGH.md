# Setup wizard walkthrough — design doc

> Branch: `feat/setup-wizard-walkthrough` off `main` (target). Will merge to
> `main` after Stefan validates the photo-studio handoff. Deployment-shape-
> specific overrides (single-box vs multi-box vs v2-6) ride the
> `COMPOSE_PROFILES` mechanism in `docker/docker-compose.yml`; this wizard
> itself is shape-agnostic.

## What we're adding (Stefan's brief)

Extend the existing first-run wizard at `apps/web-dashboard/src/app/setup/page.tsx`
so a non-technical customer can stand the box up alone, end-to-end:

1. **Internet** ("Set up your network") — name the **Home Wi-Fi the box
   broadcasts** (SSID + password the household joins, since the Droplet is the
   router). Remote access is handled separately by the box's named address
   (`<name>.droplet-us.com`) served over the Cloudflare Tunnel relay (ADR-025A,
   `droplet-fleet-hq`) with a publicly-trusted per-device cert (ADR-023) — no
   dynamic-DNS setup.
2. **Storage** — name the drives the box discovered ("Wedding Photos",
   "Headshots", etc.) so they show up labelled in Files.
3. **Cameras** — auto-detect ONVIF cameras on the LAN; if any are present,
   walk the customer through naming them. Skippable when no cameras.
4. **VPN** — create the customer's first WireGuard peer; show the QR code,
   download the `.conf`, plus an inline "here's how you actually use it"
   card (install WireGuard app, scan, tap Connect).
5. **AI** — show the model picker, run one sample prompt, explain "this
   runs on your hardware, nothing leaves the box."

Every step ends with the customer learning *how to use* the feature, not
just *how to configure* it.

## What already exists (anchoring our work to it)

The recon (commit-message footer at the bottom of this doc) confirms a
production wizard scaffold is already shipped:

| Layer | Path | Status |
|---|---|---|
| Wizard page | `apps/web-dashboard/src/app/setup/page.tsx` | 4 steps: welcome → account → discovery (Matter) → done |
| Auth gate | `apps/web-dashboard/src/components/AuthGate.tsx`, `lib/auth.tsx` | Redirects `setupRequired === true` users to `/setup` |
| Setup detection | `GET /api/auth/setup` → `{ setupRequired }` | Stateless — checks Nextcloud user list |
| Tests | `__tests__/setup.flow.test.tsx`, `setup.discovery-bounds.test.tsx` | Vitest + RTL + fake timers |
| Design tokens | `app/globals.css`, `tailwind.config.ts` | `dp-btn-*`, `type-*`, `text-label-*`, `bg-surface-*`, `bg-accent`, `bg-system-*` |

Each new walkthrough topic also has a *backend* already shipped:

| Topic | Endpoints | Dashboard API helpers |
|---|---|---|
| Home Wi-Fi | `POST /api/network/wifi/ssid`, `POST /api/network/wifi/password` (Tier 2 → `POST /api/network/command/confirm`, `GET /api/network/operations/:id`) | `setWifiSsid`, `setWifiPassword`, `confirmNetworkCommand`, `fetchNetworkOperation` |
| Storage | `GET /api/storage`, `GET /api/storage/drives` | `fetchStorageStats`, `fetchDrives` |
| Cameras | `GET /api/cameras/discovered`, `GET/POST /api/cameras/groups`, `GET/POST /api/cameras/:name/settings` | (search `cameras` in lib/api.ts) |
| VPN | `GET /api/vpn/status`, `GET/POST/DELETE /api/vpn/peers` | `fetchVpnStatus`, `fetchVpnPeers`, `createVpnPeer`, `deleteVpnPeer` |
| AI | `GET /api/llm/models` | `fetchModels` |

**We are not building new orchestrator routes** unless one specific gap
forces it (see [Open question 1](#open-question-1-storage-volume-naming-persistence)
below). The wizard *orchestrates* existing capabilities.

## Step ordering and gates

```
welcome → account → internet → storage → discovery → cameras → vpn → ai → done
```

Rationale:
- `account` first because every other step needs an authenticated session
  (Nextcloud OCS token is required for `/api/storage`, network/VPN RBAC is
  admin-only, etc.).
- `internet` before `vpn` because the VPN peer config must include a
  reachable `endpoint_host`; the box's named address
  (`<name>.droplet-us.com`, served over the ADR-025A relay — `droplet-fleet-hq`) is how the
  customer reaches the box from outside.
- `storage` before `discovery` because naming drives is fast and
  unambiguous; smart-home / camera discovery is slow and visual.
- `cameras` AFTER `discovery` (Matter smart-home) because they share a
  visual "we're scanning your network" idiom — keep them adjacent so the
  customer's mental model is "discovery phase" of the wizard.
- `vpn` before `ai` because VPN's value prop (remote access) is concrete
  and tangible; the AI walkthrough is more about education and lands
  better with momentum.

### Step gates (what blocks vs. allows skip)

| Step | Skippable? | Why |
|---|---|---|
| welcome | n/a | Just a splash |
| account | **No** | Required for all subsequent calls |
| internet | Yes ("Configure later") | Customer might be in a hurry; can come back via `/remote-access` settings |
| storage | Yes ("Use defaults") | Default labels work fine; rename is purely cosmetic |
| discovery | Yes (already does) | Existing Matter flow already has "Skip for now" |
| cameras | **Auto-skip** if 0 detected | Don't make the customer skip-click on a no-op |
| vpn | Yes ("Set up later") | Gated on internet step being complete; if no reachable endpoint, force-skip with a "configure internet first" message |
| ai | Yes ("Take me to the dashboard") | Education-only; can be replayed from Help |
| done | n/a | Terminal state |

A `Setup not complete` banner on every other dashboard page if `setupRequired === false` but skipped steps remain — this is Phase N material though, not Phase M.

## Refactor pass first (no behavior change)

Current `setup/page.tsx` is 533 lines for 4 steps; adding 5 more steps
makes it ~1500 lines. Refactor before adding to keep it reviewable.

### Target structure

```
apps/web-dashboard/src/app/setup/
  page.tsx                     ← thin: <SetupWizard /> + step routing
  layout.tsx                   ← optional: pulls progress bar out

apps/web-dashboard/src/components/setup/
  SetupWizard.tsx              ← step state machine + progress bar
  steps/
    WelcomeStep.tsx
    AccountStep.tsx
    InternetStep.tsx           ← new
    StorageStep.tsx            ← new
    DiscoveryStep.tsx          ← extracts existing Matter discovery
    CamerasStep.tsx            ← new
    VpnStep.tsx                ← new
    AiStep.tsx                 ← new
    DoneStep.tsx
  shared/
    StepShell.tsx              ← title + subtitle + primary/skip buttons; shared chrome
    LearnMoreCard.tsx          ← "how to use" callout reused per step
    ProgressDots.tsx           ← already inlined in page.tsx; lift out
```

### Refactor rules

1. **Behavior preserved**: existing `setup.flow.test.tsx` and
   `setup.discovery-bounds.test.tsx` MUST pass without modification after
   the refactor lands.
2. **Step shape uniform**: every step is a `function StepName({ onComplete, onSkip, ctx })` that lifts its own state but reports completion up. `ctx` carries cross-step values (admin username after account, Wi-Fi SSID after internet) that later steps need.
3. **No router-based subroutes** — single page, local `step` state machine, same as today. Browser back/forward isn't useful in a forced wizard.
4. **Auto-advance disabled**: customer always taps "Continue"; no surprise jumps. Exception: `done` redirects to `/` after the WelcomeFlourish animation, same as today.

## Per-step spec

Each step gets a section. Format:
- **Purpose** — what the customer accomplishes
- **Backend calls** — exact endpoints, request/response shapes
- **UI** — visual structure + the "how to use" callout
- **Edge cases** — what we show when things fail
- **Tests** — what `__tests__/setup.*` files cover

### Step: Internet — "Set up your network" (Home Wi-Fi)

**Purpose** (WARP-657): The Droplet IS the home router, so this step names the
**Home Wi-Fi the box broadcasts** (the SSID + password every device at home
joins). Remote access is *not* configured here — the box reaches the outside
world at its named address (`<name>.droplet-us.com`) served over the Cloudflare
Tunnel relay (ADR-025A, `droplet-fleet-hq`) with a per-device publicly-trusted cert (ADR-023), set up
automatically at provisioning. The section is optional and skippable.

**Backend calls** — Home Wi-Fi (only when an SSID is entered):
  - `POST /api/network/wifi/ssid` with `{ ssid }` — Tier 1, applies immediately
    (`setWifiSsid`).
  - `POST /api/network/wifi/password` with `{ password }` — Tier 2
    (`setWifiPassword`). May return `202 { status: "confirmation_required",
    operation: "set_wifi_password", confirmationToken }` because the radio
    restart drops every connected device. The wizard **auto-confirms** — the
    "Save and continue" click is itself the consent, there is no extra modal —
    via `POST /api/network/command/confirm` (`confirmNetworkCommand`), then
    polls `GET /api/network/operations/:id` (`fetchNetworkOperation`) until the
    operation reaches a terminal state (`applied` / `rolled_back` / `unknown`).

**UI**:
```
Title:     Set up your network
Subtitle:  Name the Wi-Fi your Droplet broadcasts at home.

── HOME WI-FI ──────────────────────────────────  (wifi icon)
[ Network name (SSID) ] Studio Fotonia
[ Wi-Fi password      ] ••••••••••  (show/hide)
🛡 WPA2 / WPA3 · broadcast on 2.4 & 5 GHz — this becomes your home network

[ Save and continue ]
[ Skip for now ]

╭─ How does this work? ─────────────────────────╮
│ Your Wi-Fi name and password are what every   │
│ device at home joins — the Droplet is your    │
│ router now.                                    │
│                                               │
│ To reach the box from outside, just tap        │
│ "Connect" in the Droplet app — it opens a      │
│ secure relay to your box's own web address     │
│ (yourstudio.droplet-us.com), no port-forward   │
│ or dynamic-DNS setup needed.                    │
╰───────────────────────────────────────────────╯
```

**Validation** (client-side, mirrors `services/routing/schemas.py`):
- SSID: 1–32 chars. PSK: 8–63 chars. Only enforced when an SSID is entered; a
  network name with no password (or a too-short one) is rejected inline without
  an API call.

**Edge cases**:
- Wi-Fi password 202 confirmation token expires (60s TTL) or the apply rolls
  back: surfaced as an inline error so the customer doesn't trust a Wi-Fi change
  that didn't land. The step does not crash.
- Skipped: the VPN step downstream surfaces a "set up internet first" view and
  points back here.

**Tests** (`__tests__/setup.internet.test.tsx`):
- Renders the Home Wi-Fi step (SSID + password inputs + section label); title is
  "Set up your network".
- SSID > 32 / PSK < 8 → inline validation error, no `setWifiSsid` /
  `setWifiPassword` call.
- Valid Wi-Fi → `setWifiSsid` then `setWifiPassword`.
- 202 path → `confirmNetworkCommand` called, `fetchNetworkOperation` polled.
- Skip advances without POSTing.

### Step: Storage

**Purpose**: Customer sees the drives the box detected (1.4 TB SATA, 400 GB
SATA on the single-box deployment shape; could be different on multi-box
or v2-6) and gives them human-meaningful names instead of `/mnt/droplet/data`.

**Backend calls**:
- `GET /api/storage/drives` on mount → `{ drives: [{ device, mount, label, uuid, size_bytes, used_bytes, free_bytes, mounted }] }`.
- **Open question — see below** — there is no existing "save drive label" endpoint. Options:
  - **(A) Add `POST /api/storage/drives/:uuid/label`** — small new route that writes to a `DriveLabel` Prisma model. Most aligned with existing patterns.
  - **(B) Use Nextcloud external storage labels** — Nextcloud already has per-mount labels via OCS. Map drive labels into external storage configs. Heaviest lift but no new table.
  - **(C) Skip persistence in Phase M** — customer types names, they're stashed in a settings JSON, applied later. Defer real plumbing to Phase N or a follow-up.

  **Recommended: (A).** New Prisma model + route follows the existing
  shape of `apps/orchestrator/src/routes/storage.ts`; one migration; one
  test file.

**UI**:
```
Title:     Name your storage
Subtitle:  Give each drive a name so you remember what's on it.

╭─ Main drive ─ 1.4 TB ─ 0 GB used ────────╮
│ Name:  [ Wedding Photos          ]       │
│ Path:  /mnt/droplet/data                 │
╰──────────────────────────────────────────╯
╭─ Backup drive ─ 400 GB ─ 0 GB used ──────╮
│ Name:  [ Camera Footage          ]       │
│ Path:  /mnt/droplet/nvr                  │
╰──────────────────────────────────────────╯

[ Save and continue ]
[ Use default names ]

╭─ How does this work? ─────────────────────────╮
│ Each drive can hold a different kind of file. │
│ Name them however helps you find things:      │
│ "Wedding Photos", "Client Backups", etc.      │
│ You can rename them anytime from Settings →   │
│ Storage.                                      │
╰───────────────────────────────────────────────╯
```

**Edge cases**:
- 0 drives: skip step entirely (customer is on a single-disk box).
- Duplicate names: client-side validation; can't save until unique.
- Save fails: toast, retry, never block continue.

**Tests** (`__tests__/setup.storage.test.tsx`):
- Renders drive list from mock GET.
- Validates unique names before save.
- "Use default names" advances without saving.

### Step: Cameras

**Purpose**: If the box detected ONVIF cameras (most IP cameras advertise
themselves via WS-Discovery on the LAN), let the customer name them and
add credentials. If no cameras, skip silently.

**Backend calls**:
- `GET /api/cameras/discovered` on mount → list of auto-detected cameras with `{ ip, manufacturer, model, onvifPort }`.
- For each camera the customer adds: `POST /api/cameras/groups` to create a logical grouping, then `POST /api/cameras/:name/settings` with `{ rtspUrl, username, password }`.

**Auto-skip logic**:
- Mount → `GET /api/cameras/discovered`.
- If response is `{ cameras: [] }`, automatically advance to next step with a 1.5s "No cameras detected — that's OK, you can add them later from the Cameras page." flourish. Customer doesn't need to click.

**UI** (when cameras present):
```
Title:     Set up your cameras
Subtitle:  We found 2 cameras on your network.

╭─ Hikvision DS-2CD ─ 192.168.1.45 ────────╮
│ Name:     [ Front door            ]      │
│ Username: [ admin                  ]      │
│ Password: [ ●●●●●●●●               ]      │
╰──────────────────────────────────────────╯
╭─ Reolink RLC-810A ─ 192.168.1.62 ────────╮
│ Name:     [ Driveway              ]      │
│ Username: [ admin                  ]      │
│ Password: [ ●●●●●●●●               ]      │
╰──────────────────────────────────────────╯

[ Add cameras and continue ]
[ Skip — add cameras later ]

╭─ How does this work? ─────────────────────────╮
│ Your cameras record locally to your Droplet —│
│ never to the cloud. You can review footage    │
│ from the Cameras page, set up motion alerts,  │
│ and grant remote access through VPN.          │
│                                               │
│ Username + password are needed to fetch the   │
│ live video feed. They're stored encrypted on  │
│ this box only.                                │
╰───────────────────────────────────────────────╯
```

**Edge cases**:
- Camera credentials wrong: per-camera inline error, don't block others.
- ONVIF discovery returns 5xx: show "Couldn't scan — you can add cameras manually from the Cameras page" + Skip.

**Tests** (`__tests__/setup.cameras.test.tsx`):
- Auto-skip when discovered list is empty.
- Renders one card per detected camera.
- Failed credentials inline per-row.
- Skip advances without POSTing.

### Step: VPN

**Purpose**: Create the customer's *first* WireGuard peer (typically for
their phone). Show the QR code, let them download the `.conf`, then teach
them how to use the WireGuard app.

**Backend calls**:
- `GET /api/vpn/status` on mount → `{ configured, endpointConfigured, ... }`. If `endpointConfigured === false` (no reachable endpoint host), show "Set up internet first" and a button back to the Internet step.
- `POST /api/vpn/peers` with `{ deviceLabel: "Stefan's iPhone" }` → returns `{ ..., conf, publicKey }`. `conf` is the one-time `.conf` blob; we render the QR locally with `qrcode.react` (already a dep — see `remote-access/page.tsx`).

**UI** (after creation):
```
Title:     Connect your phone
Subtitle:  Scan this QR code with the WireGuard app on your phone.

[ Device name ] Stefan's iPhone
[ Create config ]   ← before creation; afterwards:

      ╭───────────────╮
      │  ▓▓▓▓ ▓▓ ▓▓▓  │
      │  ▓ █▓▓ ▓▓▓ ▓  │
      │  ▓▓▓ ▓ █▓ ▓▓  │
      │  ▓ ▓▓ ▓▓▓ ▓▓  │
      ╰───────────────╯
     [ Download .conf ]  [ Copy ]

[ I'm connected — continue ]
[ I'll set this up later ]

╭─ How to use this on your phone ───────────────╮
│ 1. Install "WireGuard" from the App Store /   │
│    Play Store. (Free, made by the WireGuard   │
│    project — accept no substitutes.)          │
│ 2. Open WireGuard, tap "+", choose "Scan from │
│    QR code".                                  │
│ 3. Point your phone at the code above.        │
│ 4. Tap the toggle to Connect. You'll see a    │
│    little VPN icon in your status bar.        │
│                                               │
│ Once connected, open your box's secure        │
│ address `https://<name>.droplet-us.com` in    │
│ your browser — the same one you use at home.  │
│ (Names like `droplet.local` only work at      │
│ home, not over the tunnel.)                   │
╰───────────────────────────────────────────────╯
```

**Edge cases**:
- `endpointConfigured === false`: show the "set up internet first" view.
- `POST /api/vpn/peers` returns 503 (`WIREGUARD_ENDPOINT_HOST` unset): same path.
- Device label empty: client-side validation, focus the input.
- Server returns peer but `conf` is missing (defensive): error toast, leave dialog open.

**Tests** (`__tests__/setup.vpn.test.tsx`):
- Renders "Internet not configured" path when status returns `endpointConfigured: false`.
- Generates QR from `conf` blob.
- "Download .conf" triggers a Blob URL download.
- One-shot key: dialog warns "this private key won't be shown again."

### Step: AI

**Purpose**: Show the customer the AI is real (not a placeholder) and
runs on their hardware. Pick a default model, run one sample prompt,
explain "everything stays here."

**Backend calls**:
- `GET /api/llm/models` on mount → list of available models. Default-select the first locally-served one (i.e., one without a provider field, or one named `llama*` / `qwen*` / similar — defer the exact selector to implementation).
- `POST /api/llm/chat` (non-streaming) with `{ model, messages: [{ role: "user", content: SAMPLE_PROMPT }] }`. Sample prompt is a one-liner from a curated list:
  ```
  - "What can you help me with on this Droplet?"
  - "Write me a short welcome message for my photography studio."
  - "Summarize what kinds of files I might want to back up here."
  ```
  Customer picks one or types their own.

**UI**:
```
Title:     Your private AI is ready
Subtitle:  Try it — it runs entirely on your hardware.

Model:     [ Llama 3.1 8B (recommended)  ▾ ]

Try asking:
  ○ "What can you help me with on this Droplet?"
  ○ "Write a welcome message for my photography studio."
  ○ "Summarize what I might back up here."
  ○ [ Or type your own…                          ]

[ Ask the AI ]

(Once response renders:)

╭─ Llama 3.1 8B ────────────────────────────╮
│ <streaming response here>                 │
╰───────────────────────────────────────────╯

[ Take me to the dashboard ]

╭─ How does this work? ─────────────────────────╮
│ The AI runs on your Droplet's GPU.            │
│ Your questions, your conversations, the AI's  │
│ answers — none of it leaves this box.         │
│ No OpenAI, no Anthropic, no cloud anything.   │
│                                               │
│ You can pick a different model anytime from   │
│ the Chat page.                                │
╰───────────────────────────────────────────────╯
```

**Edge cases**:
- Models list empty (Ollama not ready): show "Setting up your AI — this takes a minute on first boot" and retry every 3s for 30s, then fallback to "skip for now."
- Chat call fails: inline error, "Try again" button. Don't block continue.

**Tests** (`__tests__/setup.ai.test.tsx`):
- Renders model picker from mocked `fetchModels`.
- Sample prompt selection populates the input.
- "Ask the AI" calls `sendChat` with the selected model.
- "Take me to the dashboard" advances to `done`.

## Open question 1 — storage volume naming persistence

Three options from the Storage section above:
- **(A)** New `DriveLabel` Prisma model + small `POST /api/storage/drives/:uuid/label` route.
- **(B)** Map labels into Nextcloud external storage configs (OCS API).
- **(C)** Defer persistence — wizard collects names, stores in browser localStorage only.

**My recommendation: (A).** It's the smallest change that aligns with the
existing pattern (`storage.ts` route file + Prisma model + Zod schema +
test file). The model is just `{ uuid, label, createdAt, updatedAt }`.
The `GET /api/storage/drives` route gets a left-join to surface labels in
its existing response, no breaking change.

**If Stefan prefers (B), we lose architectural simplicity but gain "the
label shows up in Nextcloud's Files app too."** This is real customer
value. Worth a small spike to confirm OCS API supports it before
committing.

**If Stefan prefers (C), Phase M is faster but we're punting the work.**

## Open question 2 — "AI walkthrough" scope

The brief says "AI walkthrough" but doesn't say how deep. Three depths:
- **Lean**: model picker + single sample chat. ~80 lines.
- **Medium**: model picker, sample chat, explain streaming and tools, link to the full chat page. ~150 lines.
- **Deep**: standalone tutorial — what's a model, what's a prompt, here's how tools work, here's how to upload files. ~400 lines.

**My recommendation: Medium.** Lean feels like a missed pedagogical
opportunity given the customer's whole pitch is "AI you own." Deep
belongs in the Help/Manual surface (Phase N).

## Open question 3 — Help/Manual integration

Stefan's original brief also asked for a help page + global help button +
"how it works walkthrough" replay. Three options for where this lives:
- **Phase M scope creep**: add it now alongside the wizard.
- **Phase N (separate)**: separate branch after this one merges. Keeps PRs reviewable.
- **Hybrid**: add the help button + empty `/help` page stub in Phase M
  (so the wizard's Learn More cards can deep-link to it), fill the
  manual content in Phase N.

**My recommendation: Hybrid.** Adds ~50 lines this PR; doesn't bloat.

## Open question 4 — branch + merge plan

Branch is `feat/setup-wizard-walkthrough` off `main`. Two options for
when this is reviewed:
- **Single PR**: one big PR with all steps. Easier to see the full flow.
- **Stacked PRs**: refactor → internet → storage → cameras → vpn → ai →
  help-hybrid. Each ~200–400 lines. Easier to review individually.

**My recommendation: Stacked, one commit per step.** Lets Stefan correct
direction after each step lands instead of after the whole thing.

## What this doc IS and ISN'T

- **IS** the contract for the work. Anything not in here, I'm not
  building without confirming.
- **IS** a design doc, not a final spec — Stefan can change anything by
  redlining this file.
- **ISN'T** an implementation plan timeline. Each step is one session.
- **ISN'T** a substitute for code review. Each commit still gets reviewed.

## Reading list — files I'll touch

```
apps/web-dashboard/src/app/setup/page.tsx               (shrink to thin shell)
apps/web-dashboard/src/components/setup/SetupWizard.tsx (new)
apps/web-dashboard/src/components/setup/steps/*.tsx     (new — 8 files)
apps/web-dashboard/src/components/setup/shared/*.tsx    (new — 3 files)
apps/web-dashboard/src/__tests__/setup.*.test.tsx       (new tests + refactor existing)
apps/orchestrator/src/routes/storage.ts                 (if option A wins — add label endpoint)
apps/orchestrator/prisma/schema.prisma                  (if option A — DriveLabel model)
apps/orchestrator/prisma/migrations/<date>_drive_label  (if option A)
docs/SETUP_WIZARD_WALKTHROUGH.md                        (this file)
```

## After Stefan reads this

Concrete decisions I need from Stefan before I write code:

1. **Open question 1** — storage label persistence: A, B, or C?
2. **Open question 2** — AI walkthrough depth: Lean, Medium, or Deep?
3. **Open question 3** — Help/Manual in this branch or separate: Phase M, N, or Hybrid?
4. **Open question 4** — review style: one PR or stacked commits?
5. **Step ordering** — does the proposed sequence work, or do you want to reshuffle?
6. **Anything missing** from the per-step specs above that the photo-studio handoff needs?

Once those are settled, I'll do the refactor (no behavior change, all
existing tests pass) as the first commit, then implement each step in
its own commit.
