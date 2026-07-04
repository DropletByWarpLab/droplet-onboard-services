#!/usr/bin/env python3
"""WARP-245 — aggregate per-image CycloneDX SBOMs into ONE device SBOM.

Called by .github/workflows/publish-release.yml after syft has written one
CycloneDX 1.5 JSON SBOM per released image into --sbom-dir
(droplet-<name>.cdx.json, exactly one per entry in
scripts/release/services.json). Emits a single CycloneDX 1.5 assembly SBOM:
metadata.component is the appliance itself (type "device", version = the
release git sha); each released image is a top-level "container" component
carrying its own component tree.

bom-refs are namespaced "droplet-<service>:<original ref>" during the merge
— two services routinely ship the same library at the same version, and
un-namespaced refs would collide (CycloneDX requires document-unique
bom-refs). "dependencies" graphs are rewritten with the same prefix.

Fails LOUDLY (non-zero, nothing written), same posture as
gen-release-manifest.py:
  - a services.json entry without an SBOM file (an image was not scanned);
  - an SBOM file in --sbom-dir that matches no service (scan-loop drift);
  - an input that is not a CycloneDX 1.5 JSON document;
  - a bom-ref collision AFTER namespacing (corrupt input);
  - a service without a pushed digest.

CI validates the output against the CycloneDX 1.5 schema with the
cyclonedx CLI right after this script runs;
scripts/release/test_aggregate_sboms.py pins the structural invariants.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SPEC_VERSION = "1.5"
DEVICE_BOM_REF = "droplet-appliance"


def die(msg: str) -> None:
    print(f"aggregate-sboms: ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def load_cyclonedx(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        die(f"cannot read {path}: {err}")
    if not isinstance(doc, dict) or doc.get("bomFormat") != "CycloneDX":
        die(f"{path} is not a CycloneDX document (bomFormat != 'CycloneDX')")
    if doc.get("specVersion") != SPEC_VERSION:
        die(f"{path} has specVersion {doc.get('specVersion')!r}, want {SPEC_VERSION!r}")
    return doc


def prefix_component(component: dict, prefix: str) -> dict:
    out = dict(component)
    if "bom-ref" in out:
        out["bom-ref"] = f"{prefix}:{out['bom-ref']}"
    if isinstance(out.get("components"), list):
        out["components"] = [prefix_component(c, prefix) for c in out["components"]]
    return out


def prefix_dependencies(deps: object, prefix: str) -> list:
    out = []
    if not isinstance(deps, list):
        return out
    for d in deps:
        if not isinstance(d, dict) or "ref" not in d:
            continue
        entry = {"ref": f"{prefix}:{d['ref']}"}
        if isinstance(d.get("dependsOn"), list):
            entry["dependsOn"] = [f"{prefix}:{r}" for r in d["dependsOn"]]
        out.append(entry)
    return out


def collect_refs(component: dict, seen: set, path: Path) -> None:
    ref = component.get("bom-ref")
    if ref is not None:
        if ref in seen:
            die(f"bom-ref collision after namespacing: {ref!r} (from {path})")
        seen.add(ref)
    for child in component.get("components") or []:
        collect_refs(child, seen, path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--services", required=True, type=Path)
    ap.add_argument("--digests", required=True, type=Path)
    ap.add_argument("--sbom-dir", required=True, type=Path)
    ap.add_argument("--git-sha", required=True)
    ap.add_argument("--registry", default="ghcr.io/dropletbywarplab")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if not re.fullmatch(r"[0-9a-f]{40}", args.git_sha):
        die(f"--git-sha must be a full 40-hex commit sha, got {args.git_sha!r}")

    services = json.loads(args.services.read_text(encoding="utf-8"))["services"]
    digests = json.loads(args.digests.read_text(encoding="utf-8"))
    names = [s["name"] for s in services]

    missing = [n for n in names if not (args.sbom_dir / f"droplet-{n}.cdx.json").is_file()]
    if missing:
        die(f"no SBOM for service(s): {', '.join(missing)} — "
            "syft did not scan every released image; refusing to aggregate")
    expected = {f"droplet-{n}.cdx.json" for n in names}
    extra = sorted(p.name for p in args.sbom_dir.glob("*.cdx.json")
                   if p.name not in expected and p.name != args.out.name)
    if extra:
        die(f"SBOM file(s) for unknown service(s): {', '.join(extra)} — "
            "scan loop and scripts/release/services.json have drifted")
    no_digest = [n for n in names if n not in digests]
    if no_digest:
        die(f"no pushed digest for service(s): {', '.join(no_digest)}")

    components = []
    dependencies = [
        {"ref": DEVICE_BOM_REF,
         "dependsOn": [f"container:droplet-{n}" for n in names]},
    ]
    seen_refs = {DEVICE_BOM_REF}
    for name in names:
        path = args.sbom_dir / f"droplet-{name}.cdx.json"
        doc = load_cyclonedx(path)
        prefix = f"droplet-{name}"
        container = {
            "type": "container",
            "bom-ref": f"container:droplet-{name}",
            "name": f"{args.registry}/droplet-{name}",
            "version": digests[name],
            "components": [prefix_component(c, prefix)
                           for c in doc.get("components", [])],
        }
        if container["bom-ref"] in seen_refs:
            die(f"duplicate service name {name!r}")
        seen_refs.add(container["bom-ref"])
        for child in container["components"]:
            collect_refs(child, seen_refs, path)
        components.append(container)
        dependencies.extend(prefix_dependencies(doc.get("dependencies"), prefix))

    bom = {
        "bomFormat": "CycloneDX",
        "specVersion": SPEC_VERSION,
        # Deterministic per release: same git sha → same serialNumber, so
        # re-runs of the workflow publish byte-identical identity.
        "serialNumber": "urn:uuid:" + str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            "https://github.com/DropletByWarpLab/droplet-onboard-services/"
            f"releases/{args.git_sha}/device-sbom",
        )),
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {
                "type": "device",
                "bom-ref": DEVICE_BOM_REF,
                "name": "droplet-appliance",
                "version": args.git_sha,
            },
        },
        "components": components,
        "dependencies": dependencies,
    }

    args.out.write_text(json.dumps(bom, indent=2) + "\n", encoding="utf-8")
    print(f"aggregate-sboms: wrote {args.out} "
          f"({len(components)} service SBOMs aggregated)")


if __name__ == "__main__":
    main()
