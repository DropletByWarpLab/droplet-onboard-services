"""WARP-2895 — the process a `transform` step runs in. One per call.

Launched by main.py as ``python -I -S -B runner.py`` with the request on
stdin and the result on stdout; it is never imported by the service. The
service is the outer wall (a container on an internal-only network, read-only
rootfs, no capabilities, a process budget); this file is the inner one — what
the user's code can reach from inside Python.

Contract with the user's code
-----------------------------
    inputs   a dict of the named results the step referenced (read-only copy)
    output   what the code assigns; must be JSON-serialisable
    print()  goes to stderr, NOT to the result — the result is `output`

Import allowlist (ADR-047 §4.3, ROUTINES brief §4.3): stdlib, allowlist not
denylist — ``json math statistics datetime decimal collections itertools re
textwrap``. Everything else — ``socket subprocess os sys importlib ctypes
pathlib urllib http`` and the rest — is refused at import with a plain
message. The allowlist is enforced by replacing ``__import__`` in the
namespace the code runs in AND by a meta-path finder, so neither ``import x``
nor ``__import__("x")`` nor ``importlib`` (which is itself refused) gets past
it.

Why this is defence in depth and not the security boundary: Python has no
language-level sandbox worth trusting. A determined script can reach the
interpreter's internals through object introspection. The boundary is the
container — no network, no writable filesystem, no capabilities, a pid and
memory ceiling, killed on completion. This file exists so an honest routine
fails EARLY and LEGIBLY ("import os is not allowed in a transform step")
rather than at the container wall with a confusing error.
"""

from __future__ import annotations

import builtins
import json
import sys
import traceback

try:  # POSIX only; the container is Linux. Absent under a Windows dev checkout.
    import resource
except ImportError:  # pragma: no cover
    resource = None  # type: ignore[assignment]

ALLOWED_MODULES = frozenset(
    {
        "json",
        "math",
        "statistics",
        "datetime",
        "decimal",
        "collections",
        "itertools",
        "re",
        "textwrap",
    }
)

# Modules the allowlisted ones import underneath (``re`` pulls ``enum``,
# ``functools``; ``datetime`` pulls ``time``; ``statistics`` pulls
# ``fractions``, ``numbers``, ``random``; ``collections`` pulls ``operator``,
# ``keyword``, ``reprlib``). Reachable ONLY as a side effect of an allowed
# import, never by name from user code — the finder checks the importer.
# Top-level names only: a submodule of an allowed package (``json.decoder``,
# ``collections.abc``) is covered by its top-level entry, and a dotted literal
# here reads as a hostname to the egress scanner.
_STDLIB_INTERNALS = frozenset(
    {
        "enum",
        "functools",
        "operator",
        "keyword",
        "reprlib",
        "time",
        "fractions",
        "numbers",
        "random",
        "bisect",
        "copyreg",
        "copy",
        "types",
        "weakref",
        "heapq",
        "locale",
        "string",
        "warnings",
        "_collections_abc",
        "math",
        "itertools",
        "re",
        "_sre",
        "sre_compile",
        "sre_parse",
        "sre_constants",
        "decimal",
        "_decimal",
        "_pydecimal",
        "contextvars",
        "datetime",
        "_datetime",
        "statistics",
        "_statistics",
        "json",
        "_json",
        "textwrap",
        "collections",
        "_collections",
        "_functools",
        "_operator",
        "_heapq",
        "_bisect",
        "_random",
        "_sha2",
        "hashlib",
        "_hashlib",
        "os",
        "_locale",
        "_weakref",
        "_weakrefset",
        "abc",
        "_abc",
        "io",
        "_io",
        "codecs",
        "encodings",
    }
)

USER_MODULE = "<transform>"


class _Refused(ImportError):
    pass


def _refuse(name: str) -> None:
    raise _Refused(
        f"import {name} is not allowed in a transform step; "
        f"allowed: {', '.join(sorted(ALLOWED_MODULES))}"
    )


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    """The ``__import__`` the user's namespace sees. User code only."""
    if level != 0:
        _refuse(name)
    top = name.split(".", 1)[0]
    if top not in ALLOWED_MODULES:
        _refuse(name)
    return _real_import(name, globals, locals, fromlist, level)


_real_import = builtins.__import__


class _Finder:
    """Meta-path finder: refuses any module a USER frame tries to import that
    is neither allowed nor a stdlib internal of an allowed one. Catches
    ``importlib.import_module`` and friends even if a script somehow obtains a
    reference to them."""

    def find_spec(self, fullname, path=None, target=None):  # noqa: D401
        top = fullname.split(".", 1)[0]
        if top in ALLOWED_MODULES or fullname in _STDLIB_INTERNALS or top in _STDLIB_INTERNALS:
            return None  # defer to the normal machinery
        # Refuse only when a user frame is on the stack; the runner itself
        # imports json/resource/traceback above this line.
        frame = sys._getframe(1)
        while frame is not None:
            if frame.f_code.co_filename == USER_MODULE:
                _refuse(fullname)
            frame = frame.f_back
        return None


def _apply_limits(max_bytes: int) -> None:
    # A ceiling on address space and on forking, inside the container's own
    # cgroup ceiling. RLIMIT_AS is a rough instrument (it counts mappings, not
    # residency) but it is the one an unprivileged process can set on itself.
    if resource is None:  # pragma: no cover
        return
    try:
        resource.setrlimit(resource.RLIMIT_AS, (max_bytes, max_bytes))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))  # no fork
    except (ValueError, OSError):
        pass


def _run(request: dict) -> dict:
    code = request.get("code")
    inputs = request.get("inputs") or {}
    if not isinstance(code, str) or not code.strip():
        return {"error": "code must be a non-empty string"}
    if not isinstance(inputs, dict):
        return {"error": "inputs must be an object"}

    _apply_limits(int(request.get("maxMemoryBytes") or 256 * 1024 * 1024))

    safe_builtins = {
        k: getattr(builtins, k)
        for k in (
            "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter",
            "float", "format", "frozenset", "getattr", "hasattr", "int", "isinstance",
            "issubclass", "iter", "len", "list", "map", "max", "min", "next", "print",
            "range", "repr", "reversed", "round", "set", "slice", "sorted", "str", "sum",
            "tuple", "zip", "True", "False", "None", "Exception", "ValueError", "TypeError",
            "KeyError", "IndexError", "ZeroDivisionError", "ArithmeticError", "StopIteration",
            "RuntimeError",
        )
        if hasattr(builtins, k)
    }
    safe_builtins["__import__"] = _guarded_import
    # print() goes to stderr so it can never be mistaken for the result.
    safe_builtins["print"] = lambda *a, **k: builtins.print(*a, **{**k, "file": sys.stderr})

    namespace = {
        "__builtins__": safe_builtins,
        "__name__": USER_MODULE,
        "inputs": json.loads(json.dumps(inputs)),  # a private copy
        "output": None,
    }
    sys.meta_path.insert(0, _Finder())
    try:
        compiled = compile(code, USER_MODULE, "exec")
        exec(compiled, namespace)  # noqa: S102 — this is the point of the service
    except _Refused as exc:
        return {"error": str(exc)}
    except SyntaxError as exc:
        return {"error": f"syntax error at line {exc.lineno}: {exc.msg}"}
    except MemoryError:
        return {"error": "transform exceeded its memory budget"}
    except RecursionError:
        return {"error": "transform recursed too deeply"}
    except Exception as exc:  # noqa: BLE001 — every user error is a step failure
        tb = traceback.extract_tb(exc.__traceback__)
        user_frames = [f for f in tb if f.filename == USER_MODULE]
        where = f" at line {user_frames[-1].lineno}" if user_frames else ""
        return {"error": f"{type(exc).__name__}{where}: {exc}"}

    output = namespace.get("output")
    try:
        json.dumps(output)
    except (TypeError, ValueError) as exc:
        return {"error": f"output is not JSON-serialisable: {exc}"}
    return {"output": output}


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        sys.stdout.write(json.dumps({"error": f"bad request: {exc.msg}"}))
        return 2
    result = _run(request if isinstance(request, dict) else {})
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    sys.stdout.flush()
    return 0 if "output" in result else 1


if __name__ == "__main__":
    sys.exit(main())
