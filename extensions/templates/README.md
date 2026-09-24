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

Each ships an `extension-manifest.json` (ADR-030 shape, `egress: none`);
`workspace_propose` fills in the name and version and tags the commit.
Editing a template here changes what NEW boxes seed — an existing box's
`templates.git` is never re-seeded over its operator's commits.
