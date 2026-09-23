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

Each ships an `extension-manifest.json` in the WARP-2900 schema
(`docs/schemas/extension-manifest.schema.json`): `kind: "extension"`, a
`runtime` (`node20` | `python312`), an `entrypoint` (`dist/index.js` after
`tsc`, or `tool.py`), `provides.tools` (each naming the module `export` the
box calls — both templates declare `word_count` → `run`), `routineDrafts`,
`proposedGrants`, `resources.memoryMb` and `egress: "none"`.
`workspace_propose` fills in the id, name and version, forces `kind` and
`egress`, and tags the commit; an older manifest shape (`footprint`,
`provides.routines`) is carried into this one on propose.

An extension module is NOT an MCP server. When an owner promotes and
installs it, the sandbox runs the image's first-party host shim
(`services/sandbox/ext_host/`), which serves `provides.tools` over MCP on
the container's loopback and calls the declared export for each call.
Editing a template here changes what NEW boxes seed — an existing box's
`templates.git` is never re-seeded over its operator's commits.
