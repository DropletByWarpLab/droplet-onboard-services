# WARP-1254 — Groupfolders REST + OCS Group API spike

**Epic:** WARP-1251 (Droplet Files Teams/Departments)
**Ticket:** [WARP-1254](https://warp-lab.atlassian.net/browse/WARP-1254)
**Scope:** validate the Nextcloud `groupfolders` REST API + OCS group API against the
exact NC image the product ships (`docker/docker-compose.yml`), on a throwaway local
Docker container. No appliance/LAN device was touched.

## TL;DR verdicts

1. **API contract** — validated end-to-end (OCS group create/add/remove + full
   groupfolders CRUD lifecycle) against `nextcloud:29-apache` running `groupfolders
   17.0.16`. All endpoints behave as documented below.
2. **Nested mounts (`mount_point` containing `/`)** — **partially works**. Nesting
   renders correctly in WebDAV *only* when every intermediate path segment is itself
   a real, pre-existing groupfolder. An intermediate segment that is **not** its own
   groupfolder is presented as a synthetic listing node, but a direct write to that
   segment silently falls through to the acting user's **personal** storage — a
   data-boundary risk for a multi-level Team → Department hierarchy.
3. **WARP-882 (OnlyOffice/WOPI doc server)** — **shipped**, not vaporware. Real
   infra exists end-to-end: compose `docserver` service, orchestrator WOPI-adjacent
   session client + route, Nextcloud `onlyoffice` connector bootstrap, dashboard
   editor panel, and tests. See §4.

---

## 1. Image + pin status

`docker/docker-compose.yml` line 588:

```yaml
nextcloud:
  image: nextcloud:29-apache
```

**Not digest-pinned** as of this spike. Pulled and validated against:

```
nextcloud:29-apache
  → nextcloud@sha256:a7fbfcd4759bdd19b8fb8b1044b47ee3a9471d2e2c8bc68d56a2e671f86cebd2
  → Nextcloud 29.0.16.1 (versionstring 29.0.16)
```

**Recommendation: pin the digest.** `nextcloud:29-apache` is a moving tag (rebuilt on
every 29.0.x patch) — without a digest pin, the appliance can silently drift onto a
newer Nextcloud/groupfolders point release across an image re-pull, and the exact
`groupfolders` version bundled server-side (17.0.16 as of this spike) is not otherwise
reproducible. This spike pins it in `docker/docker-compose.yml` in this same branch:

```yaml
image: nextcloud:29-apache@sha256:a7fbfcd4759bdd19b8fb8b1044b47ee3a9471d2e2c8bc68d56a2e671f86cebd2
```

Bumping the pin later (e.g. for a Nextcloud security patch) should be a deliberate,
reviewed change — re-run this spike's curl checks against the new digest before
rolling it out, since the groupfolders REST shape has changed across major NC/app
versions historically.

## 2. Test setup

Throwaway container, SQLite-backed (not the appliance's Postgres — sufficient for
API-contract validation, not for HA/perf):

```bash
docker run -d --name nc-spike -p 18080:80 \
  -e SQLITE_DATABASE=nc \
  -e NEXTCLOUD_ADMIN_USER=admin \
  -e NEXTCLOUD_ADMIN_PASSWORD=SpikePass123 \
  nextcloud:29-apache@sha256:a7fbfcd4759bdd19b8fb8b1044b47ee3a9471d2e2c8bc68d56a2e671f86cebd2

# poll until installed
curl -s http://localhost:18080/status.php   # {"installed":true,...} after ~2 min

docker exec -u www-data nc-spike php occ app:install groupfolders
# → "groupfolders 17.0.16 installed" / "groupfolders enabled"
```

All API calls use HTTP Basic auth (`admin:SpikePass123`) plus the two headers OCS
requires: `OCS-APIRequest: true` and `Accept: application/json`.

Container was removed (`docker rm -f nc-spike`) at the end of the spike; nothing was
persisted.

## 3. Validated API contract

### 3a. OCS group API (`/ocs/v2.php/cloud/...`)

All three calls return the standard OCS v2 envelope with `statuscode: 200`:

| Function | Verb + path | Params | Response shape |
|---|---|---|---|
| Create group | `POST /ocs/v2.php/cloud/groups` | form: `groupid` | `{"ocs":{"meta":{"status":"ok","statuscode":200,"message":"OK"},"data":[]}}` |
| Add user to group | `POST /ocs/v2.php/cloud/users/{userid}/groups` | form: `groupid` | same shape, `data:[]` |
| Remove user from group | `DELETE /ocs/v2.php/cloud/users/{userid}/groups` | form body (via `-d`, not query string): `groupid` | same shape, `data:[]` |
| Verify membership | `GET /ocs/v2.php/cloud/users/{userid}?format=json` | — | `data.groups` is a flat array, e.g. `["admin","dept-eng"]` |

Verified live: created `dept-eng`, added `admin` to it (`groups` became
`["admin","dept-eng"]`), removed it (`groups` back to `["admin"]`), re-added for the
rest of the spike.

**Gotcha:** `DELETE` with a body is unusual for a REST client — curl needs `-X DELETE
-d "groupid=dept-eng"` (form-encoded body, not a query string) or the OCS group
controller 400s. Confirm whatever HTTP client the orchestrator uses supports a body on
DELETE (Node's `fetch` and `axios` both do, but it's worth a unit test).

### 3b. Groupfolders REST API (`/index.php/apps/groupfolders/folders`)

**Gotcha — different envelope convention than 3a:** every groupfolders response uses
the legacy OCS v1 status code, `"statuscode":100` (== OK), **not** 200. Do not reuse a
`statuscode === 200` success check written for the `/ocs/v2.php/cloud/*` endpoints
against these routes — it will treat every successful groupfolders call as a failure.

**Gotcha — CSRF/CORS gate:** omitting `OCS-APIRequest: true` on any groupfolders call
returns `HTTP 412 Precondition Failed` (verified live) — Nextcloud's CSRF middleware
rejects it before the request reaches the app. This header is mandatory on every call
below, matching the OCS group API.

| Function | Verb + path | Params | Response shape |
|---|---|---|---|
| Create folder | `POST /index.php/apps/groupfolders/folders` | form: `mountpoint` | `data:{"id":<int>}` |
| List folders | `GET /index.php/apps/groupfolders/folders` | — | `data` is an **object keyed by string folder id** (not an array): `{"1":{...},"2":{...}}` |
| Get one folder | `GET /index.php/apps/groupfolders/folders/{id}` | — | `data` is the single folder object directly (not id-keyed) |
| Add group to folder | `POST /index.php/apps/groupfolders/folders/{id}/groups` | form: `group` | `data:{"success":true}` |
| Set permissions | `POST /index.php/apps/groupfolders/folders/{id}/groups/{groupId}` | form: `permissions` (int bitmask) | `data:{"success":true}` |
| Set quota | `POST /index.php/apps/groupfolders/folders/{id}/quota` | form: `quota` (bytes, int; `-3` = unlimited) | `data:{"success":true}` |
| Delete folder | `DELETE /index.php/apps/groupfolders/folders/{id}` | — | `data:{"success":true}` |

Full folder object shape (from `GET .../folders/{id}` after addGroup + setPermissions
+ setQuota):

```json
{
  "id": 1,
  "mount_point": "Engineering",
  "groups": { "dept-eng": 15 },
  "quota": 1073741824,
  "size": 0,
  "acl": false,
  "manage": [],
  "group_details": {
    "dept-eng": { "displayName": "dept-eng", "permissions": 15, "type": "group" }
  }
}
```

Note `groups` is a `{groupId: permissionBitmask}` map on the single-folder response,
matching `group_details` keys — both need parsing if the orchestrator wants a typed
DTO.

**Gotcha — permission bitmask semantics** (Nextcloud `OCP\Constants` bits, same as
WebDAV/share permissions elsewhere in the codebase):

| Bit | Value | Meaning |
|---|---|---|
| `PERMISSION_READ` | 1 | read |
| `PERMISSION_UPDATE` | 2 | update/edit |
| `PERMISSION_CREATE` | 4 | create |
| `PERMISSION_DELETE` | 8 | delete |
| `PERMISSION_SHARE` | 16 | re-share |

`15` = read+update+create+delete (no share) — used in the T4 test above. `31` = all
five bits (full access, including share) — this is also the **default** permission a
group receives from `addGroup` if `setPermissions` is never called afterward (verified
live: folders 2 and 3 showed `dept-eng: 31` after `addGroup` alone). **Any caller that
wants less than full access, including re-share, must call `setPermissions`
immediately after `addGroup`** — there is no "restricted by default" mode.

### 3c. Nested `mount_point` test — critical finding

Two nested-mount scenarios were tested, both assigned to `dept-eng` and checked via
`PROPFIND` (`Depth: 1`) as `admin` (a `dept-eng` member) against
`/remote.php/dav/files/admin/`.

**Scenario A — parent segment IS a real groupfolder.** Folder 1 (`mount_point:
"Engineering"`) already existed. Created folder 2 with `mount_point:
"Engineering/Platform"`.

- `PROPFIND` at the WebDAV root shows only `Engineering/` (folder 2 does **not**
  appear as its own top-level entry).
- `PROPFIND` inside `/Engineering/` shows `Platform/` nested cleanly underneath.
- Physical storage stays **flat**: `docker exec nc-spike ls /var/www/html/data/__groupfolders/`
  shows sibling directories `1/`, `2/`, `3/` — keyed by folder id, not by
  `mount_point`. The nesting is a **presentation-layer path resolution** computed
  from the `mount_point` string at DAV-mount time; it is not physical nesting on
  disk.

**Scenario B — parent segment is NOT a groupfolder** (no folder claims
`mount_point: "NoParent"` by itself). Created folder 3 with `mount_point:
"NoParent/Child"`.

- `PROPFIND` still shows `NoParent/` at the root and `Child/` nested inside it — the
  listing looks identical to scenario A.
- But a direct `PUT` to `/remote.php/dav/files/admin/NoParent/direct.txt` (writing
  into the intermediate segment, not the actual `Child` mount) **succeeded (201
  Created)** and landed on disk at
  `/var/www/html/data/admin/files/NoParent/direct.txt` — i.e. inside **admin's own
  personal storage**, not any groupfolder backing store (`__groupfolders/3/` was
  untouched).

**Verdict: nested mounting via `mount_point: "Parent/Child"` PARTIALLY works.** It
renders correctly in WebDAV listings regardless of whether the parent segment is a
real groupfolder, but that parent segment is only *actually* protected/managed
storage when it corresponds to a real groupfolder object of its own. If it doesn't,
Nextcloud silently falls through to the acting user's personal storage on write,
auto-vivifying a same-named real folder there that then visually coexists with the
synthetic parent used to reach the nested child. For a WARP-1251 Team → Department
hierarchy, **this means every level of the hierarchy that should behave as
shared/managed storage must be materialized as its own groupfolder** — a purely
cosmetic `mount_point` path segment (e.g. "Team X" with no groupfolder of its own,
just there to nest "Department Y" under it visually) is not a safe substitute and
creates a real data-boundary leak into whichever user happens to write there first.

## 4. WARP-882 ground truth — did the OnlyOffice/WOPI doc server ship?

**Verdict: yes, it shipped.** This is real, wired infrastructure, not a ticket marked
Done without shipping code. Evidence, by layer:

- **Compose:** `docker/docker-compose.yml` (`docserver` service, lines ~696–718) —
  `onlyoffice/documentserver:8.2`, gated behind the `docs` Compose profile,
  default-on for ≥32 GB boxes (RAM-gated in `scripts/lib/single-box.sh`, which also
  writes `DOCS_ENABLED=1`/`0` accordingly).
- **Secrets:** `scripts/lib/secrets.sh` generates a per-device
  `ONLYOFFICE_JWT_SECRET` (`openssl rand -hex 32`) and migrates it idempotently.
- **Nextcloud-side bootstrap:** `docker/nextcloud-init.sh` (§"WARP-882 / WS-4") installs
  and enables the Nextcloud `onlyoffice` connector app with retry/backoff for
  appstore-not-ready races, then configures `DocumentServerUrl`,
  `DocumentServerInternalUrl`, `StorageUrl`, and the shared `jwt_secret` — only when
  `DOCS_ENABLED` is on and a JWT secret is present (fails closed otherwise).
- **Orchestrator:** `apps/orchestrator/src/services/docserver.client.ts` implements
  `ncMintEditorSession()` — resolves the NC file id, probes engine health via
  `/healthcheck`, mints a short-lived HS256 JWT session bound to
  `{ncFileId, ncUser, mode, documentKey}`, with `documentKey` deliberately keyed on
  `ncFileId` only (not per-user) so real-time co-authoring shares one session per
  file. Engine-agnostic by design (stays behind WOPI; no raw wire protocol here).
  Wired into `apps/orchestrator/src/routes/files.ts` (editor-session route) and
  `apps/orchestrator/src/modules/module-registry.ts`.
- **Dashboard:** `apps/web-dashboard/src/components/FileManager/DocEditorPanel.tsx`
  (iframe editor panel) + gating logic in `PreviewPane` + `src/lib/office-files.ts`.
- **Tests:** `apps/orchestrator/src/__tests__/docserver.client.test.ts`,
  `apps/orchestrator/src/__tests__/files.editor-session.test.ts`,
  `apps/web-dashboard/src/components/FileManager/DocEditorPanel.test.tsx`,
  `apps/web-dashboard/src/components/FileManager/PreviewPane.editor-gate.test.tsx`.

**Caveat (licensing, not infra):** the engine shipped is OnlyOffice Document Server
**Community Edition** (AGPLv3), which the codebase explicitly documents as
build/test-only — an OnlyOffice OEM/commercial license is required before GA
(`docker-compose.yml`, `docserver.client.ts`, `.env.example`, `CLAUDE.md` all flag
this consistently). That is an open licensing decision, not a missing-infra gap.

## 5. Other gotchas for WARP-1251 implementation

- **Two different OCS status-code conventions in the same product**: `2xx`-family
  routes (`/ocs/v2.php/cloud/*`) return `statuscode: 200`; app-routed OCS endpoints
  (`/index.php/apps/groupfolders/*`) return the legacy `statuscode: 100`. Any shared
  "was this OCS call successful" helper in the orchestrator needs to branch on this,
  or just check `meta.status === "ok"` (present and consistent on both) instead of
  the numeric code.
- **`List folders` and `Get one folder` have different `data` shapes** — the list
  endpoint's `data` is an id-keyed object (`{"1": {...}}`), the single-folder GET's
  `data` is the folder object directly. A naive shared parser will break on one or
  the other.
- **`quota: -3`** is Nextcloud's sentinel for "unlimited" — do not treat it as a
  literal negative byte count.
- **Basic auth + `OCS-APIRequest: true` is sufficient** for all calls tested here;
  no separate CSRF token/nonce fetch was needed on top of the header, because Basic
  auth requests are exempt from Nextcloud's session-cookie CSRF check as long as the
  OCS header is present.

## 6. Cleanup

`docker rm -f nc-spike` — throwaway container removed, nothing persisted. No
appliance or LAN device was touched at any point in this spike.
