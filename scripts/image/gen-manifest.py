#!/usr/bin/env python3
"""WARP-663 / ADR-020 — appliance image release-manifest tool (pure stdlib).

Builds and validates `manifest.json`, the signed catalogue of built appliance
images that `droplet-image manifest|verify` and the M3.4 OTA agent consume.

NO third-party dependencies — the autoinstall ISO's first boot and CI both run
this with a stock python3 (`hashlib`, `json`, `argparse` only). The JSON-Schema
validator below is a deliberately small draft-07 SUBSET, just enough for
manifest.schema.json (type / required / enum / const / pattern / minimum /
minLength / additionalProperties:false / $ref+definitions / items). It is not a
general-purpose validator; it raises on schema constructs it does not implement
so a future schema change can't silently pass unchecked.

Subcommands
-----------
  build     Construct (or merge into) a manifest with one image entry, validate
            it against the schema, and write it out. --sha256 may be given
            explicitly, or --sha256-of <file> to hash a local artifact.
  validate  Validate an existing manifest file against the schema. Exit 0 if
            valid, non-zero (with a diagnostic) otherwise.

Exit codes: 0 ok; 1 validation failure; 2 usage / IO error.
"""

import argparse
import datetime
import hashlib
import json
import re
import sys


# --------------------------------------------------------------------------- #
# Minimal JSON-Schema (draft-07 subset) validator
# --------------------------------------------------------------------------- #
class SchemaError(Exception):
    """The schema uses a construct this minimal validator does not implement."""


def _resolve_ref(root_schema, ref):
    # Only local refs of the form "#/definitions/NAME" are supported.
    if not ref.startswith("#/"):
        raise SchemaError(f"unsupported $ref (only local #/... refs): {ref}")
    node = root_schema
    for part in ref.lstrip("#/").split("/"):
        if part == "":
            continue
        if not isinstance(node, dict) or part not in node:
            raise SchemaError(f"$ref does not resolve: {ref}")
        node = node[part]
    return node


_KNOWN_KEYWORDS = {
    "$schema", "$id", "$ref", "title", "description", "definitions",
    "type", "required", "properties", "additionalProperties", "items",
    "enum", "const", "pattern", "minimum", "minLength",
}

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    # bool is a subclass of int in Python; exclude it explicitly so a JSON
    # `true` never satisfies an integer/number field.
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _validate(node, schema, root_schema, path, errors):
    # Reject schema keywords we don't implement, so the schema can't quietly
    # grow an unchecked constraint.
    for kw in schema:
        if kw not in _KNOWN_KEYWORDS:
            raise SchemaError(f"unsupported schema keyword '{kw}' at {path or '<root>'}")

    if "$ref" in schema:
        _validate(node, _resolve_ref(root_schema, schema["$ref"]),
                  root_schema, path, errors)
        return

    where = path or "<root>"

    if "type" in schema:
        t = schema["type"]
        check = _TYPE_CHECKS.get(t)
        if check is None:
            raise SchemaError(f"unsupported type '{t}' at {where}")
        if not check(node):
            errors.append(f"{where}: expected type {t}, got {type(node).__name__}")
            # A type mismatch makes the deeper checks meaningless.
            return

    if "const" in schema and node != schema["const"]:
        errors.append(f"{where}: must equal {schema['const']!r}, got {node!r}")

    if "enum" in schema and node not in schema["enum"]:
        errors.append(f"{where}: {node!r} is not one of {schema['enum']!r}")

    if "pattern" in schema and isinstance(node, str):
        if re.search(schema["pattern"], node) is None:
            errors.append(f"{where}: {node!r} does not match pattern {schema['pattern']!r}")

    if "minimum" in schema and isinstance(node, (int, float)) and not isinstance(node, bool):
        if node < schema["minimum"]:
            errors.append(f"{where}: {node} < minimum {schema['minimum']}")

    if "minLength" in schema and isinstance(node, str):
        if len(node) < schema["minLength"]:
            errors.append(f"{where}: string shorter than minLength {schema['minLength']}")

    if isinstance(node, dict):
        for req in schema.get("required", []):
            if req not in node:
                errors.append(f"{where}: missing required property '{req}'")
        props = schema.get("properties", {})
        if schema.get("additionalProperties", True) is False:
            for key in node:
                if key not in props:
                    errors.append(f"{where}: additional property '{key}' not allowed")
        for key, subschema in props.items():
            if key in node:
                child = f"{path}.{key}" if path else key
                _validate(node[key], subschema, root_schema, child, errors)

    if isinstance(node, list) and "items" in schema:
        for i, item in enumerate(node):
            _validate(item, schema["items"], root_schema, f"{where}[{i}]", errors)


def validate_manifest(manifest, schema):
    """Return a list of human-readable validation errors ([] == valid)."""
    errors = []
    _validate(manifest, schema, schema, "", errors)
    return errors


# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #
def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _sha256_of_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _die(msg, code=2):
    sys.stderr.write(f"gen-manifest: {msg}\n")
    sys.exit(code)


# --------------------------------------------------------------------------- #
# Subcommands
# --------------------------------------------------------------------------- #
def cmd_validate(args):
    try:
        schema = _load_json(args.schema)
    except (OSError, json.JSONDecodeError) as exc:
        _die(f"cannot read schema {args.schema}: {exc}")
    try:
        manifest = _load_json(args.manifest)
    except json.JSONDecodeError as exc:
        _die(f"{args.manifest} is not valid JSON: {exc}", code=1)
    except OSError as exc:
        _die(f"cannot read manifest {args.manifest}: {exc}")

    try:
        errors = validate_manifest(manifest, schema)
    except SchemaError as exc:
        _die(f"schema error: {exc}")

    if errors:
        sys.stderr.write(f"gen-manifest: {args.manifest} is INVALID:\n")
        for err in errors:
            sys.stderr.write(f"  - {err}\n")
        sys.exit(1)
    print(f"{args.manifest}: valid against {args.schema}")
    sys.exit(0)


def cmd_build(args):
    try:
        schema = _load_json(args.schema)
    except (OSError, json.JSONDecodeError) as exc:
        _die(f"cannot read schema {args.schema}: {exc}")

    if args.sha256 and args.sha256_of:
        _die("pass at most one of --sha256 / --sha256-of")
    sha = args.sha256
    if args.sha256_of:
        try:
            sha = _sha256_of_file(args.sha256_of)
        except OSError as exc:
            _die(f"cannot hash {args.sha256_of}: {exc}")
    if not sha:
        _die("one of --sha256 or --sha256-of is required")

    build_date = args.build_date or (
        datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )

    entry = {
        "shape": args.shape,
        "version": args.version,
        "format": args.format,
        "file": args.file,
        "url": args.url,
        "size": args.size,
        "sha256": sha,
        "gitSha": args.git_sha,
        "buildDate": build_date,
        "minDiskGiB": args.min_disk_gib,
    }

    # Merge into an existing manifest if --merge-into is given (or --out exists
    # and --merge is set): replace any entry with the same (shape, version,
    # format), else prepend. Otherwise start fresh.
    manifest = {"schemaVersion": 1, "images": []}
    merge_src = args.merge_into
    if merge_src:
        try:
            manifest = _load_json(merge_src)
        except (OSError, json.JSONDecodeError) as exc:
            _die(f"cannot read --merge-into {merge_src}: {exc}")

    images = [
        img for img in manifest.get("images", [])
        if not (
            img.get("shape") == entry["shape"]
            and img.get("version") == entry["version"]
            and img.get("format") == entry["format"]
        )
    ]
    images.insert(0, entry)
    manifest["images"] = images
    manifest["schemaVersion"] = 1

    try:
        errors = validate_manifest(manifest, schema)
    except SchemaError as exc:
        _die(f"schema error: {exc}")
    if errors:
        sys.stderr.write("gen-manifest: refusing to write an INVALID manifest:\n")
        for err in errors:
            sys.stderr.write(f"  - {err}\n")
        sys.exit(1)

    rendered = json.dumps(manifest, indent=2, sort_keys=False) + "\n"
    if args.out and args.out != "-":
        try:
            with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(rendered)
        except OSError as exc:
            _die(f"cannot write {args.out}: {exc}")
        print(f"wrote {args.out} ({len(manifest['images'])} image(s))")
    else:
        sys.stdout.write(rendered)
    sys.exit(0)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="gen-manifest.py",
        description="Build/validate the appliance image release manifest (ADR-020).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_val = sub.add_parser("validate", help="validate a manifest against the schema")
    p_val.add_argument("manifest", help="path to manifest.json")
    p_val.add_argument("--schema", required=True, help="path to manifest.schema.json")
    p_val.set_defaults(func=cmd_validate)

    p_build = sub.add_parser("build", help="construct/merge a manifest entry")
    p_build.add_argument("--schema", required=True)
    p_build.add_argument("--shape", required=True)
    p_build.add_argument("--version", required=True)
    p_build.add_argument("--format", default="iso", choices=["iso", "raw"])
    p_build.add_argument("--file", required=True, dest="file")
    p_build.add_argument("--url", required=True)
    p_build.add_argument("--size", required=True, type=int)
    p_build.add_argument("--sha256", default=None)
    p_build.add_argument("--sha256-of", default=None, dest="sha256_of",
                         help="hash this local artifact instead of passing --sha256")
    p_build.add_argument("--git-sha", required=True, dest="git_sha")
    p_build.add_argument("--build-date", default=None, dest="build_date",
                         help="RFC3339 UTC; defaults to now")
    p_build.add_argument("--min-disk-gib", required=True, type=int, dest="min_disk_gib")
    p_build.add_argument("--merge-into", default=None, dest="merge_into",
                         help="existing manifest to merge this entry into")
    p_build.add_argument("--out", default="-", help="output path ('-' for stdout)")
    p_build.set_defaults(func=cmd_build)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
