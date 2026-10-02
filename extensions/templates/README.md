# Extension templates

The starting points a workshop run (ADR-056 slice G, WARP-2896) can create a
workspace from. `services/sandbox` bakes this directory into its image and
seeds `templates.git` from it on first start; a workspace created with
`template: "typescript-tool"` gets that directory as its first commit.

Every template must build and test with NOTHING installed: the sandbox has
no network, so `npm install` and `pip install` fail there by design. Use
what the image ships — Node 20's built-in test runner, the global `tsc`,
`pytest` and `ruff` — and no dependencies.

| template          | build           | test       | lint          |
| ----------------- | --------------- | ---------- | ------------- |
| `typescript-tool` | `npm run build` | `npm test` | `tsc --noEmit`|
| `python-tool`     | —               | `pytest`   | `ruff check .`|
| `rest-profile`    | `npm run build` | `npm test` | —             |

The two tool templates each ship an `extension-manifest.json` in the
WARP-2900 schema (`docs/schemas/extension-manifest.schema.json`):
`kind: "extension"`, a `runtime` (`node20` | `python312`), an `entrypoint`
(`dist/index.js` after `tsc`, or `tool.py`), `provides.tools` (each naming
the module `export` the box calls — both templates declare `word_count` →
`run`), `routineDrafts`, `proposedGrants`, `resources.memoryMb` and
`egress: "none"`. `workspace_propose` fills in the id, name and version,
forces `kind` and `egress`, and tags the commit; an older manifest shape
(`footprint`, `provides.routines`) is carried into this one on propose.

An extension module is NOT an MCP server. When an owner promotes and
installs it, the sandbox runs the image's first-party host shim
(`services/sandbox/ext_host/`), which serves `provides.tools` over MCP on
the container's loopback and calls the declared export for each call.

`rest-profile` is **not an extension** (WARP-2899). It drafts an ADR-046 REST
vendor profile, its guide, its egress entry and its ADR-042 rows from one
`connector-draft.json` (`npm run build` renders them). It has no manifest on
purpose: `workspace_propose` tags it as a connector draft, nothing on the box
installs or loads it, and an owner exports it as a git bundle for a Warp Lab
pull request.

Seeding. A new box seeds `templates.git` from this directory on first start.
On every later start, a template directory the image has and `templates.git`
does not is ADDED in its own commit (`templates: add <name> from the image`) —
so an existing box gains `rest-profile`. A template directory `templates.git`
already has is never touched, even when the image's copy differs: an
operator's commits to it are theirs. Editing an existing template here
therefore changes what NEW boxes seed, not what existing boxes hold.
