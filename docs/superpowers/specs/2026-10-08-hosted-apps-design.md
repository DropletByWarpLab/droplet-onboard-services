# Hosted apps — bring your own UI or code into a Workshop workspace, the box runs it, the assistant sets it up (WARP-3901)

Decision record: [`docs/ADR-073-hosted-app-extensions.md`](../../ADR-073-hosted-app-extensions.md) (an amendment to [`ADR-056`](../../ADR-056-agentic-extensibility.md) §A and §C).
Ticket: [WARP-3901](https://warp-lab.atlassian.net/browse/WARP-3901) under the agentic-extensibility epic [WARP-2891](https://warp-lab.atlassian.net/browse/WARP-2891).
Ground truth: `origin/stage` @ `f8a712655`, read 2026-10-08. Every path below was verified there, not in a local checkout.

**Status: signed off 2026-10-08** — Stefan Cruceru: _"go with the defaults, file the slice tickets and start HA-1."_ Every decision in §9 is closed to its default; the slice tickets are filed under WARP-2891 (§10); HA-1 is in progress on [WARP-3905](https://warp-lab.atlassian.net/browse/WARP-3905). The security-review items (ADR-073 §4) are Romain's, as sub-tasks on HA-2 and HA-3.

## 0. The ask, and what it means on this box

Stefan, 2026-10-08: _"we need to start on the workspace, somewhere where you can bring in your own UI or code and host it and run it with the correct open ports and an easy way for the Chat to be able to help you set it up."_

"The workspace" is a **Workshop workspace** (`WorkshopWorkspace`, `/workshop`, `/api/workspace/*` — ADR-056 §A, WARP-2896). Today it can produce exactly one kind of thing: a **tool extension** — `kind: "extension"`, at least one tool in `provides.tools`, run as a supervised process inside `services/sandbox` that speaks MCP to the orchestrator and is reachable by nothing else (`docs/security/extension-trust.md` § Install and run). A person cannot bring code in except by `git push` to the store, nothing in the store can serve a page to a browser, and the container fragment WARP-2898 landed (#2328, `update-agent/extension-fragment.ts`) refuses `ports` by name.

So the four halves of the ask map onto the existing design like this:

| Ask | What it becomes |
|---|---|
| "bring in your own UI or code" | A Workshop workspace created **from an archive upload or from an app template**, or filled by `git push` — the store the box already has (§3). |
| "host it and run it" | A new extension kind, `kind: "app"`, promoted and signed exactly like a tool extension and run by the same sandbox (§4), v1 as a process or as static files, v2 as a container. |
| "with the correct open ports" | **None.** The app listens where the box tells it; people reach it only through the gateway, on an origin of its own; the gateway reaches it only through the orchestrator's relay. No host port, no firewall rule, no WAN forward (§5, ADR-073 D2). |
| "the Chat helps you set it up" | A chat-started workshop run with a "Set up this app" brief that reads the code, writes the manifest, fixes the listen port and base path, builds, smoke-checks and proposes; two read tools for status and logs afterwards (§6). |

Vocabulary: **hosted app** / **app** (an extension of kind `app`); **workspace** (the Workshop source); `extension`, `catalog` per ADR-030/ADR-056 — never "marketplace", "app store", "poc", "dev". The member-facing page is `/hosted` and its nav row reads **Apps** (`/apps/` is Nextcloud's prefix in nginx — `docker/nginx/nginx.conf:573`).

## 1. Ground truth that bounds the design (verified on `stage`)

- **ADR-056 is Proposed**, its Q1–Q7 still open with defaults. Slices F (sandbox, WARP-2895), G (store + workshop run, WARP-2896) and H (extensions v1, WARP-2900) are on `stage`. **Slice K (WARP-2898) reads Done in Jira but only its serializer landed**: `extension-fragment.ts` (#2328) writes a hardened `ext-<id>` service; there is **no `services/builder`, no `services/registry`, no `extensions` profile** on `stage` (`git ls-tree -r origin/stage | grep -E 'services/(builder|registry)/'` is empty; `docker-compose.yml` has no such service). Containers are a v2 of this design, not a substrate it can use today (§4.3).
- **Manifest** (`apps/orchestrator/src/services/extension-manifest.ts`, `schemaVersion: 1`, strict at every level): `kind: "extension"` literal (`:110`), `runtime: node20 | python312` (`:45`), `entrypoint`, `provides.tools` min 1 (`:115`), `resources { memoryMb 16..4096, processes: 1 }` (`:120-128`), `egress: "none"` literal (`:131`). The signed statement binds `manifestSha256`, so a new manifest field is covered by the existing signature with no statement change (`:220-231`).
- **Sandbox** (`docker-compose.yml:2351-2420`): one container, `read_only`, `cap_drop: ALL`, `no-new-privileges`, `init: true`, on `droplet-internal` only, no socket, no `env_file`, `mem_limit ${SANDBOX_MEM_LIMIT:-512m}`, `pids_limit 128`. Extension processes bind `127.0.0.1` on `SANDBOX_EXTENSION_PORT_RANGE` (18000–18999); the orchestrator reaches them only through the bearer-gated `/extensions/<slug>/rpc` relay; the child's env is an allowlist (`DROPLET_EXT_ID`, `DROPLET_EXT_PORT`, `DROPLET_EXT_TOKEN`, `DROPLET_EXT_RELAY_KEY`, `DROPLET_ORCHESTRATOR_URL`). Everything is behind `SANDBOX_PROCESS_SUPERVISION` (default `0`). Known limitations (same uid for every child; WARP-2898 is the named fix) are in `extension-trust.md` § Known limitations and apply to apps exactly as to tools.
- **Store and run** (`docs/agent-runs-design.md` §8a): bare repos on `workspace-git`, smart HTTP at `/git/<id>.git` through `/api/git/*`; `workspace_run` is an argv allowlist (`npm test`, `npm run build`, `pytest`, `ruff`, `tsc`); `workspace_propose` ends the run; one live run per workspace. `GIT_FETCH_ROLES` still admits `family` and `guest` (`routes/workspace.ts:84`); WARP-3541 / WARP-3633 narrow it to owner/admin — this design assumes they land first (§8).
- **Promote** (`routes/extensions.ts:378`): owner only, behind `promoteMfaGate`, readback derived from the manifest (`deriveReadback`, never free text). Install exports the signed tree, runs the host shim, attaches as an MCP server; tools stay blocked until classified.
- **Gateway** (`docker/nginx/nginx.conf`): one TLS listener, `:443` (`:180`); every route is a hand-written `location` to a fixed upstream; `/git/` rewrites to the orchestrator (`:279-286`); `/apps/`, `/core/`, `/dist/` go to Nextcloud. Only the gateway publishes LAN ports (`:82-84`).
- **Session** (`middleware/auth.ts:91-194`): `droplet_session` HTTP-only cookie carrying the JWT, or `Authorization: Bearer`. **Cookies are port-agnostic**, which is why §5 strips them at the relay and adds an `Origin` check (no `Origin` / `Sec-Fetch-Site` / CSRF check exists in `middleware/` or `app.ts` today — grep returns nothing).
- **Exposure to the internet** already exists as a Tier-2 chat tool, `add_port_forward` (routing `POST /firewall/port-forward`, orchestrator `routes/network-firewall.routes.ts:170`). This design does not use it for apps and says why (§5.4).
- **Research**: `shared_brain/research/competitors/nomad/decisions.md` N4 rejects a raw Docker-socket app marketplace; a signed, RBAC-gated catalog on the OTA substrate is the sanctioned shape. ADR-056 is that shape; this design stays inside it.
- **Network target** (`docs/security/compose-network-segmentation.md`, WARP-3623): `droplet-internal` stays "the untrusted network" holding sandbox, extension containers and orchestrator. The gateway does **not** join it — which is why the relay runs in the orchestrator (§5.2), not as an nginx upstream on that network.

## 2. The lifecycle, as the owner sees it

`New app` (archive, template or push) → the workspace exists → **`Set up with the assistant`** (a chat-started workshop run; the person watches it in the conversation) → the run **proposes** (manifest with `kind: "app"`, build output, smoke-check result) → the owner reads the readback on `/admin/extensions` — _"Serves a web app at https://<box>:8443/<slug>/ · runtime node20 · one process · 256 MB · reaches nothing outside the box · visible to: owner, admin"_ — and **promotes** (owner, MFA) → **signed** → **installed** (the sandbox serves it, the health path answers 200) → **live** (reachable; `Open` buttons appear) → **disabled** / **uninstalled**. "It's broken, fix it" in chat starts another run in the same workspace; a new version is a new proposal and a new promote. Every transition writes the activity rows extensions already write (`refs.extensionId`); no new activity kind.

Nothing new is executable without an owner promotion (ADR-056 I2); the one pre-promotion execution this design adds, the bounded smoke check, runs inside the sandbox on loopback with the blast radius of `npm test` (§6.2).

## 3. Bringing code in

Three doors, all into the store the box already has. No fourth: the box never fetches (ADR-045) and the sandbox has no egress, so **"import from a URL" does not exist** — the dialog says so rather than hiding the option.

1. **Template.** `extensions/templates/` gains `static-site`, `node-app`, `python-app` (§4.2). Seeded into `templates.git` on first start like the three today; the sandbox's seed never overwrites an operator's commits (`agent-runs-design.md` §8a).
2. **Archive.** `POST /api/workspace` accepts `source: "archive"` with a multipart `.zip` or `.tar.gz` (owner/admin; Q4 for the cap, default 256 MB) that the sandbox unpacks as the new repository's first commit. Unpacking is defensive: refuse absolute paths, `..`, symlinks and hardlinks, a top-level `.git`, more than 50 000 entries or 1 GB unpacked; strip executable bits except under `bin/`; commit as the uploading person. The archive itself is never stored.
3. **Push.** `git push` to `/git/<id>.git` as owner/admin, exactly as today. The workspace pane already shows the clone URL.

Vendored dependencies are the rule for v1 and the templates show it: `node_modules/` or `vendor/` committed (or in the archive), because `npm install` / `pip install` reach nothing inside the sandbox by construction (`extensions/templates/README.md`). The New app copy says this in one plain sentence. Compiled dependencies and Dockerfiles are v2 (§4.3).

## 4. Running it

### 4.1 Manifest: `kind: "app"` and the `http` block

`extension-manifest.ts` stays `schemaVersion: 1` and strict; the changes are additive:

```jsonc
{
  "schemaVersion": 1,
  "id": "shop-dashboard",          // workspace id, as today
  "name": "Shop dashboard",
  "version": "1.0.0",
  "kind": "app",                   // NEW: z.enum(["extension", "app"])
  "runtime": "node20",             // node20 | python312 | static (static is NEW, apps only)
  "entrypoint": "dist/server.js",  // the SERVER for node20/python312; omitted for static
  "http": {                        // NEW, required when kind is "app", refused otherwise
    "health": "/healthz",          // GET must answer 2xx within the install deadline
    "dir": "dist",                 // static only: the directory the sandbox serves
    "spa": true                    // static only: unknown paths fall back to index.html
  },
  "provides": { "tools": [], "routineDrafts": [], "proposedGrants": [{ "role": "member", "domain": "app:shop-dashboard", "level": "use" }] },
  "resources": { "memoryMb": 256, "processes": 1 },
  "egress": "none"
}
```

Rules the parser enforces (one test per rule): `kind: "app"` requires `http`; `kind: "extension"` refuses `http`; `runtime: "static"` is only valid for apps, requires `http.dir`, refuses `entrypoint`, and sets `resources.memoryMb` to 0 in the readback; an app's `provides.tools` must be empty in v1 (Q6); `egress` stays the literal `"none"`. **There is no port in the manifest, on purpose** — the box assigns it (§5.1). `deriveReadback` gains the app sentence quoted in §2, built from `kind`, `runtime`, `resources`, `egress` and the grants — never from `summary`.

`workspace_propose` keeps forcing `egress` and the id/name/version; it now carries `kind` through instead of forcing `"extension"`. The signed statement is unchanged (`manifestSha256` covers the new fields).

### 4.2 v1 runtimes: a process, or no process at all

- **`static`** — the sandbox serves `http.dir` from the installed read-only tree itself: no child process, no port, no budget. `spa: true` serves `index.html` for paths without a file. `Cache-Control: no-store` on HTML, immutable on hashed assets. This is the "bring your own UI" case (a built Vite / Next export / plain HTML tree) and the one most people will use first.
- **`node20` / `python312`** — the entrypoint **is** the HTTP server. The sandbox starts it under the existing supervisor with the existing env allowlist plus **`PORT`** (= `DROPLET_EXT_PORT`, because that is what every framework reads), `DROPLET_EXT_BASE_PATH` (`/<slug>/`) and `DROPLET_EXT_DATA_DIR` (§4.4). The app must bind `127.0.0.1:$PORT`; the install's health probe is the proof. The host shim is not involved — an app is not an MCP server.

Templates: `static-site` (an `index.html` + `assets/`, `http.dir: "."`), `node-app` (a dependency-free `node:http` server reading `PORT`, serving `public/` and one JSON route, `npm test` with the built-in runner), `python-app` (`http.server`-based, same shape, `pytest`). Each builds and tests with nothing installed, as the README demands.

### 4.3 v2 runtime: `image` (a container) — a separate decision, not this PR

An app with a Dockerfile, compiled dependencies or its own runtime needs the remainder of WARP-2898: a rootless BuildKit builder and an on-box registry on `droplet-internal`, install through the OTA apply exception with the fragment serializer that already exists, one `ext-<id>-data` volume. When that lands, the relay (§5.2) dials `http://ext-<slug>:<port>` on `droplet-internal` directly instead of the sandbox's HTTP relay, and nothing else in this design changes. The ticket for it is the existing WARP-2898, whose Jira status must be corrected to reflect what is on `stage` (§8).

### 4.4 Persistence, budget, logs

- **Data dir.** A fourth sandbox volume, `extensions-data`, mounted at `/var/lib/workspace-ext-data`, one subdirectory per slug (`0700`, owned by the sandbox uid), passed as `DROPLET_EXT_DATA_DIR`, **in the backup set**, kept across versions, removed on uninstall only after the owner's typed confirm names it. It is the one mutable thing an app owns (SQLite, uploads). Adding a writable mount to the sandbox changes the hardening table `test-security.sh` 14b pins, so this is a security-review item for the reviewer of WARP-2922 (Q5, default yes with a per-slug quota).
- **Budget.** `resources.memoryMb` is accounted against the sandbox ceiling as every extension is today (`extension-trust.md` § Limits). The default `SANDBOX_MEM_LIMIT` of 512 MB holds the transform child plus every running extension; a box that hosts apps will need it raised in `.env` — the readback says what is left, and promote refuses (block preflight, ADR-030 D3) when the budget cannot be met.
- **Logs.** The supervisor keeps the last 64 KB of each process's stdout/stderr in a ring buffer and serves it at `GET /extensions/<slug>/logs` (bearer-gated); the orchestrator exposes it owner/admin as `GET /api/hosted/<slug>/logs` and to the assistant as `hosted_app_logs` (§6.3). Static apps have access logs only (the relay's), not process logs.

## 5. Reaching it: no open ports, an origin of its own

### 5.1 The port is the box's, not the app's

The app listens on the loopback port the sandbox assigns from `SANDBOX_EXTENSION_PORT_RANGE`, handed to it as `PORT`. Nothing publishes it: the sandbox has no `ports:`, is on `droplet-internal` only, and `test-security.sh` already asserts both. "Open ports" on this box means a `location` in the gateway and a path in the relay — which is what the person is told in the New app dialog and the readback.

### 5.2 The path: gateway `:8443` → orchestrator relay → sandbox HTTP relay → app

- **A second TLS listener on the gateway, `:8443`**, in its own `server` block with the same certificate and cipher include as `:443`, whose **only** location is `location / { proxy_pass http://orchestrator:3000/api/hosted/relay/; }` with `proxy_buffering off`, request body cap from Q4, `proxy_read_timeout 60s` and the `X-Forwarded-*` set. Nothing else is served on `:8443`; `test-security.sh` gains an assertion that the `:8443` block has exactly one `location` and one upstream. Compose publishes `8443:8443` on the gateway next to `80`/`443`.
- **The orchestrator relay** (`routes/hosted.ts`, mounted at `/api/hosted/relay/*`, **refused on `:443`** by checking the forwarded port — an `/api/hosted/relay/...` request arriving through the dashboard's listener is a 404) resolves `<slug>` from the first path segment, requires a valid `droplet_app_<slug>` cookie (§5.3), checks the row is `live` and the person is granted (§7), then forwards to the sandbox's new `GET|POST|PUT|PATCH|DELETE /extensions/<slug>/http/<rest>` with the app's relay key — or, in v2, dials `ext-<slug>` on `droplet-internal` directly. Request and response bodies stream; the response status passes through unchanged (an app's 404 is a 404), with `X-Droplet-Relay: app` added so an app can never pose as the box (`extension-trust.md`'s relay rule, applied the other way round). HTTP/1.1 and SSE in v1; WebSocket upgrade is Q7.
- **The sandbox HTTP relay** is the `/rpc` relay generalised to a path: bearer-gated, loopback only, per-request timeout, body cap, header allowlist in both directions. For `runtime: "static"` the same route serves `http.dir` (§4.2).

Why the relay sits in the orchestrator and not in nginx: the gateway is not on `droplet-internal` and must not join it (WARP-3623's target keeps that network for untrusted code and its one caller); generated nginx config would need a reload path from the orchestrator, which is a new privileged route; and the relay is where session, grants and audit already live. The cost — the orchestrator in the data path — is bounded by the body cap and timeouts, and is the same cost the `/git/` smart-HTTP transport already pays.

### 5.3 Why an app never shares the dashboard's origin, and what makes that true

A page served from `https://<box>/<anything>` is same-origin with the dashboard: its JavaScript can read the dashboard's `localStorage`, and the browser attaches `droplet_session` to any request it makes. A hosted app's code was written by someone we did not review (I4), so **an app is never served from `:443`** (ADR-073 D3). `:8443` is a different origin for JavaScript (`localStorage`, DOM, `fetch` responses are isolated) but **not for cookies**, which ignore the port. So three more things hold, each with a test against a fixture app that echoes what it receives:

1. **The relay strips every inbound cookie and `Authorization` header** before forwarding, and forwards only `droplet_app_<slug>`'s *claims* as identity headers — the app never sees `droplet_session`, even though the browser sent it.
2. **The app session is its own credential.** `Open` on the dashboard calls `POST /api/hosted/<slug>/session` (dashboard session required, grant checked), which returns `https://<box>:8443/<slug>/_droplet/session?code=<single-use, 60 s>`; the relay exchanges the code for `droplet_app_<slug>` (`HttpOnly; Secure; SameSite=Lax; Path=/<slug>/`, a JWT with `aud: app:<slug>`, `sub`, role, 12 h) and redirects to `/<slug>/`. `/<slug>/_droplet/*` is reserved for the relay (`session`, `logout`, `whoami`); an app that defines such a path never sees those requests. The code exchange, not a cookie set from `:443`, is what keeps this working when apps move to their own hostnames (Q1).
3. **The orchestrator refuses a state-changing `/api/*` request whose `Origin` header is present and is not the dashboard's own origin** (new middleware, `GET`/`HEAD`/`OPTIONS` exempt, Bearer-authenticated requests exempt because they carry no cookie risk). This closes the remaining angle — a page on `:8443` sending a credentialed same-site `POST` to `:443/api/...` — and is a CSRF defence the dashboard should have had anyway. Native clients send a Bearer and are unaffected; the git transport sends Basic and no `Origin`.

Identity the app receives: `X-Droplet-User-Id`, `X-Droplet-User-Name`, `X-Droplet-Role`, `X-Droplet-App: <slug>`. An app can trust them because only the relay can reach it. An app cannot call the box's API in v1 — the `SERVICE_TOKEN_EXT_<id>` call-back ladder (`/extensions/self/call`, allowlist empty today) is the v2 door, not a bearer it is handed.

### 5.4 Off-LAN, and why `add_port_forward` is not the answer

An app is reachable wherever the gateway is: on the LAN, and off-LAN through the box's existing remote-access path (the ADR-031 overlay; the tunnel) exactly like the dashboard. A per-app WAN port forward would publish an unreviewed server with its own authentication straight to the internet, which is the posture N2/N4 of the nomad decisions reject; the readback never offers it, `add_port_forward` is unchanged and unrelated, and the dialog copy says "reachable wherever your Droplet is". Raw TCP/UDP exposure on the LAN (a game server, a broker) is Q3, default no.

## 6. The assistant's part

### 6.1 Entry points

- **Workshop → New app** (owner/admin): kind picker (Tool | App), source (template / upload an archive / "I'll push with git"), name. Creating runs nothing (as today). The dialog's primary action after creation is **Set up with the assistant**, which starts a chat-started workshop run (`POST /api/agent-runs { workspaceId, brief: "app-setup" }`, origin `chat`, linked to a new or chosen conversation per WARP-3299) so the person watches progress, confirms the proposal and reads the result where chat-started runs already put them (WARP-3298).
- **Chat**: "host the dashboard I uploaded", "set up my app in the shop-dashboard workspace" → the existing `start_agent_run` with `workspace` and the `app-setup` brief. Tier-2 on the first call, as every run is: the person confirms the box will spend minutes of compute.

### 6.2 The `app-setup` brief (one template in the run-brief registry WARP-3300 introduced)

The brief tells the model, in order, with the tools it already has:

1. Inventory the tree (`workspace_read` / `workspace_search`): `package.json`, `pyproject.toml`, `index.html`, a `dist/`, a `Dockerfile`. Decide the runtime: a built static tree → `static`; a Node server → `node20`; a Python server → `python312`; a Dockerfile only → **stop and say so** ("this needs a container; containers are not available on this box yet") — a run that cannot finish ends with a result, not a proposal.
2. Write or edit `extension-manifest.json` (`kind: "app"`, `runtime`, `entrypoint`, `http.health`, `http.dir`, `resources.memoryMb` from the app's size class, grants from the goal text, never above `member`).
3. Make the app listen on `PORT` and honour `DROPLET_EXT_BASE_PATH` (Vite `base`, Next `basePath`, Flask `SCRIPT_NAME`, a hard-coded `3000`): small, explained edits, one commit each (`workspace_write`, `workspace_commit`).
4. Build and test with the allowlisted argv (`npm run build`, `npm test`, `pytest`, `tsc`), fix what fails.
5. **`workspace_run app-check`** — NEW allowlisted argv, sandbox-side: start the entrypoint (or the static server) on a loopback port for at most 30 s, `GET http.health` and `GET /`, report status + first 2 KB, kill the process group. Same container, same loopback, same budget and the same "nothing persists" as `npm test`; the result is what the readback's health line is derived from. `app-check` is refused for `kind: "extension"`.
6. `workspace_propose`. The run ends; the person sees the proposal card; the owner promotes on `/admin/extensions` (the run never calls promote — I2).

The brief states the two hard limits in words the model repeats to the person: no network from the app, no dependency installs — vendored only.

### 6.3 After promote: two read tools

- `list_hosted_apps` (read, owner/admin; members see what they may open): slug, name, version, status, URL, last health, memory budget.
- `hosted_app_logs` (read, owner/admin): the last N lines from §4.4, `since` optional.

Both are ordinary `tools-core` handlers under `handlers/workspace/` with `TOOL_ROUTES` rows (`/api/hosted/*`), no confirmation, counted in the per-turn budget like everything else. No write tool: starting a fix is `start_agent_run`, and enable/disable/uninstall stay owner routes with their own confirms, never tools.

## 7. Who may do what

| Action | Who | Route |
|---|---|---|
| New app (template / archive / push) | owner, admin | `POST /api/workspace` (`source`), `/git/` push |
| Set up with the assistant | owner, admin (the run is theirs) | `POST /api/agent-runs` |
| Promote, enable, disable, uninstall | owner (ADR-056 Q2 default; MFA gate) | `/api/extensions/*` |
| Grant roles at promote | owner, from the manifest's `proposedGrants`, never `guest` | promote body |
| Open | owner, admin always; `member` when granted; `guest` never | `POST /api/hosted/<slug>/session` |
| Logs | owner, admin | `GET /api/hosted/<slug>/logs` |

Grants are explicit rows (`HostedAppGrant { extensionId, role }`, CLAUDE.md "No guessing"), written at promote and editable on `/admin/extensions`; the relay reads them on every request. Every mint, grant change and lifecycle transition is audited; relay requests are not (volume), but a denied open is.

## 8. What must land first, and what this corrects

- **WARP-3541 / WARP-3633** (store fetch narrowed to owner/admin): an app's source can hold more than a tool's; the git door must not be wider than `/workshop` before apps exist.
- **WARP-2898's Jira status**: Done on the board, serializer-only on `stage`. The ticket gets a comment with the evidence and is reopened or re-scoped (a workflow edit if `Done` is terminal — WARP-2913's precedent). This spec's v2 (§4.3) is its remaining scope.
- **`SANDBOX_PROCESS_SUPERVISION`** must be `1` on a box that hosts apps; the New app dialog shows the box's state and refuses creation with "turned off on this Droplet" when it is `0` (promote already answers 503).

## 9. Decisions (closed to their defaults — Stefan Cruceru, 2026-10-08)

| # | Decision | Default — **taken as written, Stefan Cruceru, 2026-10-08** |
|---|---|---|
| Q1 | Origin per app: `:8443` with a path (v1) now, or a hostname per app (`<slug>.<box-name>.box.warp-lab.ai`, wildcard SAN through ADR-023's DNS-01) | **`:8443` + path in v1**; hostnames when a box has a public-CA name, as a v2 slice; the code-exchange session (§5.3) is written so both work |
| Q2 | Base path: the app is told `DROPLET_EXT_BASE_PATH` and must honour it, or the relay rewrites HTML | **The app honours it**; the brief makes that edit; the relay never rewrites bodies |
| Q3 | Raw TCP/UDP exposure on the LAN for non-HTTP apps | **No in v1**; a later ADR if a customer asks, as a Tier-2 owner action through routing, never a manifest key |
| Q4 | Archive cap and relay body cap | **256 MB archive, 32 MB request body** |
| Q5 | A writable per-app data dir (fourth sandbox volume, backup set) | **Yes**, 1 GB per slug default, security review on the hardening-table change |
| Q6 | May an app also provide tools (`provides.tools` non-empty) | **No in v1**; the attach path stays tool-only; revisit when a real app wants both |
| Q7 | WebSocket upgrade through the two relays | **Not in v1** (HTTP/1.1 + SSE); measured on the bench box before a follow-up slice |
| Q8 | Who may create apps | **Owner and admin**, as the Workshop today |
| Q9 | Native clients | **"Open in browser"** for every app action in v1 (Mac, Windows, iOS) |

## 10. Slices (one PR each against `stage`; box bootable before and after)

| Slice | Scope | AC (abridged — each PR carries the full list) | Branch · migration |
|---|---|---|---|
| **HA-0** [WARP-3901](https://warp-lab.atlassian.net/browse/WARP-3901) | This spec + ADR-073 | Sign-off on §9 (done 2026-10-08); WARP-2898 status corrected (commented 2026-10-08); slice tickets filed (done) | `feat/warp-3901-hosted-apps-design` · — |
| **HA-1** [WARP-3905](https://warp-lab.atlassian.net/browse/WARP-3905) | Manifest `kind: "app"`, `http`, `runtime: "static"`; `deriveReadback`; `workspace_propose` carries `kind`; three templates | One test per rule in §4.1; readback test with a lying `summary`; templates build/test with nothing installed; `catalog.test.ts` unchanged | `feat/warp-3905-hosted-apps-manifest` · — |
| **HA-2** [WARP-3906](https://warp-lab.atlassian.net/browse/WARP-3906) | Sandbox: static server, `/extensions/<slug>/http/*` relay, `PORT` + `DROPLET_EXT_BASE_PATH` + `DROPLET_EXT_DATA_DIR`, `app-check` argv, log ring buffer + `/logs`, `extensions-data` volume | Relay refuses without bearer; loopback only; body/timeout caps hit are reported; `app-check` kills its group and is refused for tools; `test-security.sh` 14b updated and green; review sub-task for the volume | `feat/warp-3906-hosted-apps-sandbox` · — |
| **HA-3** [WARP-3907](https://warp-lab.atlassian.net/browse/WARP-3907) | Orchestrator: install path for `kind: "app"` (health probe, no MCP attach), `routes/hosted.ts` (list, session mint, logs, relay), `HostedAppGrant`, `Origin` middleware; gateway `:8443` block; compose port; `test-security.sh` nginx assertion | Fixture app echoes headers: no `droplet_session`, identity headers present; relay 404 on `:443`; code single-use + expiry; guest 403; cross-origin `POST /api/*` with foreign `Origin` → 403, Bearer exempt; ship-check green | `feat/warp-3907-hosted-apps-relay` · `20261009010000` |
| **HA-4** [WARP-3908](https://warp-lab.atlassian.net/browse/WARP-3908) | Web: New app dialog (kind, source, archive upload), workspace pane app facts + `Open`, `/admin/extensions` readback + grants at promote, `/hosted` page + **Apps** nav row | Empty/loading/error states; keyboard + focus; light/dark; existing tokens only; copy plain; `Open` goes through the session mint; dialog refuses when supervision is off | `feat/warp-3908-hosted-apps-web` · — |
| **HA-5** [WARP-3909](https://warp-lab.atlassian.net/browse/WARP-3909) | Assistant: `app-setup` brief, `list_hosted_apps`, `hosted_app_logs`, `start_agent_run` brief argument, dialog → chat-started run | Brief fixture run on the three templates proposes a valid manifest; a Dockerfile-only tree ends with a result, not a proposal; tools have `TOOL_ROUTES` rows; schema size measured before/after | `feat/warp-3909-hosted-apps-assistant` · — |
| **HA-6** (v2) | `runtime: "image"`: builder, registry, apply-path install, direct dial from the relay; Q1 hostnames; Q7 WebSocket | WARP-2898's own AC, unchanged | WARP-2898 · later |

Order: HA-1 → HA-2 → HA-3 → HA-4 and HA-5 in parallel. HA-2 and HA-3 each carry a security-review sub-task for the reviewers of WARP-2922 / WARP-2923 (the relay is a new way into the sandbox, and `:8443` is a new listener on the LAN).

## 11. Out of scope

- Containers, the builder, the registry (v2, §4.3). Multi-process apps. App egress of any kind. Apps that call the box's API (the call-back ladder stays empty).
- A code editor in the dashboard: the run writes, the person pushes.
- Community or Warp Lab-signed app catalog entries; any signing delegation.
- Changing what a tool extension does or how it attaches.
