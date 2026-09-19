"""WARP-2590 — every module the app imports has to be IN the image.

The bridge's Dockerfile copies its sources by NAME, one file per entry, rather
than `COPY services/erp-sql-bridge/ .` — deliberately, so the vendored SAP
client and the test suite stay out of the shipped layer. The cost of that
choice is that adding a module is TWO edits, and the second one is easy to
forget: `auth.py` shipped in the source tree but not in the image, so the
container died at `from auth import setup_auth` with ModuleNotFoundError and
restart-looped. Nothing in the suite noticed, because every test here imports
from the source tree, where the file has always been present.

So this pins the image's contents against the import graph instead of against
a hand-kept list. Add a module, forget the COPY, and this goes red — which is
the only place that mistake is catchable without building the image.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = SERVICE_ROOT / "Dockerfile"

#: The service's own flat modules — the ones `main.py` imports unqualified
#: because they land beside it in /app. `_shared/*` is copied separately and
#: imported as a package, so it is not in this set.
LOCAL_MODULES = {p.stem for p in SERVICE_ROOT.glob("*.py")}


def _local_imports(path: Path) -> set[str]:
    """Top-level module names `path` imports that are local .py files here."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.add(node.module.split(".")[0])
    return {name for name in found if name in LOCAL_MODULES}


def _required_modules() -> set[str]:
    """Transitive closure of local imports reachable from the app entrypoint."""
    seen: set[str] = set()
    queue = ["main"]
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        queue.extend(_local_imports(SERVICE_ROOT / f"{name}.py") - seen)
    return seen


def _copied_paths() -> set[str]:
    """Every path named on a COPY line, with line continuations folded in."""
    text = DOCKERFILE.read_text(encoding="utf-8").replace("\\n", " ")
    copied: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.upper().startswith("COPY "):
            continue
        # Drop the directive, any --flags, and the destination (last token).
        tokens = [t for t in stripped.split()[1:] if not t.startswith("--")]
        copied.update(tokens[:-1])
    return copied


class TestEveryImportedModuleIsCopiedIntoTheImage:
    def test_the_entrypoint_imports_resolve_to_files_that_exist(self):
        """Sanity: the closure is real, not an empty set that passes vacuously."""
        required = _required_modules()
        assert "main" in required
        assert "auth" in required, "auth.py is imported by main.py — the graph is wrong"
        for name in required:
            assert (SERVICE_ROOT / f"{name}.py").is_file()

    @pytest.mark.parametrize("module", sorted(_required_modules()))
    def test_module_is_copied_into_the_image(self, module):
        """A module in the import graph but not on a COPY line = a container
        that dies at import and restart-loops. This is that check."""
        expected = f"services/erp-sql-bridge/{module}.py"
        assert expected in _copied_paths(), (
            f"{module}.py is imported by the app but never copied into the image. "
            f"Add {expected} to the COPY line in services/erp-sql-bridge/Dockerfile."
        )

    def test_the_statement_manifest_is_copied(self):
        """WARP-2540: allowlist.py refuses to import without it, so a bridge
        missing the manifest cannot start half-guarded."""
        assert "services/erp-sql-bridge/statement_manifest.json" in _copied_paths()
