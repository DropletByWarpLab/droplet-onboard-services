# Hosted application workspaces

Status: **implemented, unreleased, default-off**. This feature extends the
device's Workshop, Chat agent runs, signed extension lifecycle and gateway.
It hosts owner-reviewed UI and code on the Droplet.

## Create and prepare

An owner or admin opens Workshop and creates an **App** using `static-site`,
`node-app` or `python-app`, imports a `.zip`/`.tar.gz`, or creates a workspace
for an operator Git push. Archives are limited to 256 MiB compressed, 1 GiB
unpacked and 50,000 entries. Unsafe paths, links, devices and Git metadata are
refused. Imported built files and vendored dependencies are committed even
when the source archive's ignore rules exclude them.
App workspaces remain available for assistant setup when reopened, even
before they have a valid manifest.

Use **Set up with assistant** from the workspace to create a Chat conversation
and a workspace-bound `app-setup` run. Tell it what the app should do. The
device's agent can inventory files, adapt `extension-manifest.json`, edit code,
run offline builds/tests and `app-check`, then propose a version for review.
The linked conversation shows the run's progress and outcome. Chat can also
list hosted apps and read operator-authorized bounded logs.

The device has no network package-install step. Include built UI files and
vendored dependencies, or use the templates' dependency-free servers. A
Dockerfile-only project requires adaptation to a supported runtime; arbitrary
containers are outside v1.

## Review, host and open

The owner reviews the proposed manifest and pinned code on the extension
administration page, then promotes with MFA. Promotion uses the existing
device signature and transparency-log flow. Apps do not register MCP tools.
The owner chooses whether members may open the app; owner and admin always
have access and guests do not. Grant edits, lifecycle operations and imports
are audited.

The Apps page lists applications the signed-in user may open and shows their
health/lifecycle state. **Open** mints a one-use session exchange on the
gateway's second TLS listener. The resulting URL is
`https://<device-host>:8443/<slug>/`. Dashboard authentication is never passed
to app code. Enable/disable and uninstall remain owner-MFA operations.
Uninstall preserves persistent app data by default; deleting that data
requires an explicit checkbox and the app slug typed as confirmation.

## Runtime contract

- `kind: "app"`, runtime `static`, `node20` or `python312`, `tools: []`,
  `egress: "none"`; the app fields are covered by the signed manifest hash.
- Static apps serve a confined `http.dir`; `http.spa` optionally enables a
  navigation fallback. HTML is not cached; fingerprinted assets are immutable.
- Node/Python apps bind **127.0.0.1**, use assigned `PORT` in 18000–18999,
  honor `DROPLET_EXT_BASE_PATH=/<slug>/`, and expose `http.health`.
- `DROPLET_EXT_DATA_DIR` is the app's persistent writable directory. Data
  survives code updates and is included in device/restic backups. Factory
  reset wipes it.
- HTTP has a 32 MiB upload ceiling and a 60-second relay budget. WebSockets,
  arbitrary TCP/UDP ports, custom app cookies/CORS, and outbound networking
  are outside v1.

## Deployment and review

Apply the checked-in Prisma migrations through the existing deployment path.
Keep `SANDBOX_PROCESS_SUPERVISION=0` until security/deployment review approves
enablement; when enabled, set it consistently for orchestrator and sandbox.
The gateway publishes TLS **8443** in addition to the dashboard listener and
uses the existing certificate, cipher and client-certificate configuration.
Allow 8443 through the device's intended network access policy. Do not publish
individual app ports or the sandbox API.

The sandbox keeps its internal network, non-root uid, read-only root,
capability drop, memory/process ceilings and four fixed named volumes. The
current named-volume deployment **does not enforce a 1 GiB per-app data quota**;
that needs host filesystem provisioning. Apps also share one sandbox uid and
one browser origin with other apps. These limits are documented in
[`security/extension-trust.md`](security/extension-trust.md) and must be
considered before enabling third-party code. Separate-container isolation and
host-provisioned quotas remain planned work.
