"""WARP-268 — consumption of docs/security/allowed-egress.yaml.

THE FILE IS OWNED BY WARP-269 (telemetry-free-invariant CI gate); this
module is its runtime consumer. Expected schema — MUST stay in sync with
the WARP-269 spec (reconciled by the orchestrating session):

    schema_version: 1
    entries:
      - service: ai-gateway            # compose service name, or "host"
        destination: api.anthropic.com # hostname | "*.suffix" | IP | CIDR
        port: 443                      # 1-65535 | "any"
        protocol: tcp                  # tcp | udp | any
        purpose: BYOK cloud LLM calls (user-initiated)
        ticket: WARP-268

Defensive posture: unsupported schema_version / unparseable file raises
AllowlistError (the collector then tags records "allowlist-unavailable" and
emits ONE allowlist_unavailable anomaly per failure episode); individually
malformed entries are skipped and surfaced in Allowlist.problems.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Optional

import yaml

SUPPORTED_SCHEMA_VERSION = 1
_PROTOCOLS = ("tcp", "udp", "any")
_REQUIRED_FIELDS = ("service", "destination", "port", "protocol", "purpose", "ticket")


class AllowlistError(Exception):
    pass


@dataclass(frozen=True)
class AllowRule:
    service: str
    destination: str
    port: Optional[int]   # None == "any"
    protocol: str
    purpose: str
    ticket: str

    @property
    def key(self) -> str:
        port = self.port if self.port is not None else "any"
        return f"{self.service}->{self.destination}:{port}/{self.protocol}"


@dataclass(frozen=True)
class Allowlist:
    rules: tuple[AllowRule, ...]
    problems: tuple[str, ...]


def _parse_entry(entry: object) -> AllowRule:
    if not isinstance(entry, dict):
        raise ValueError("entry must be a mapping")
    for field in _REQUIRED_FIELDS:
        if field not in entry:
            raise ValueError(f"missing required field {field!r}")
    port = entry["port"]
    if port == "any":
        port = None
    elif not (isinstance(port, int) and not isinstance(port, bool) and 0 < port <= 65535):
        raise ValueError(f"port must be 1-65535 or 'any', got {port!r}")
    protocol = str(entry["protocol"]).lower()
    if protocol not in _PROTOCOLS:
        raise ValueError(f"protocol must be one of {_PROTOCOLS}, got {protocol!r}")
    destination = str(entry["destination"]).strip().lower()
    if not destination:
        raise ValueError("destination must be non-empty")
    return AllowRule(
        service=str(entry["service"]),
        destination=destination,
        port=port,
        protocol=protocol,
        purpose=str(entry["purpose"]),
        ticket=str(entry["ticket"]),
    )


def load_allowlist(text: str) -> Allowlist:
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise AllowlistError(f"unparseable YAML: {exc}") from exc
    if not isinstance(doc, dict):
        raise AllowlistError("top level must be a mapping")
    version = doc.get("schema_version")
    if version != SUPPORTED_SCHEMA_VERSION:
        raise AllowlistError(
            f"unsupported schema_version {version!r} "
            f"(this collector supports {SUPPORTED_SCHEMA_VERSION})"
        )
    entries = doc.get("entries")
    if not isinstance(entries, list):
        raise AllowlistError("entries must be a list")
    rules: list[AllowRule] = []
    problems: list[str] = []
    for i, entry in enumerate(entries):
        try:
            rules.append(_parse_entry(entry))
        except (TypeError, ValueError) as exc:
            problems.append(f"entries[{i}]: {exc}")
    return Allowlist(rules=tuple(rules), problems=tuple(problems))


def _destination_matches(dest: str, dst_ip: str, dst_names: frozenset[str]) -> bool:
    try:
        network = ipaddress.ip_network(dest, strict=False)
    except ValueError:
        pass
    else:
        try:
            return ipaddress.ip_address(dst_ip) in network
        except ValueError:
            return False
    if dest.startswith("*."):
        suffix = dest[1:]  # keep the dot → enforces the label boundary
        return any(name.endswith(suffix) for name in dst_names)
    return dest in dst_names


def match(
    allowlist: Allowlist,
    *,
    service: str,
    dst_ip: str,
    port: Optional[int],
    protocol: str,
    dst_names: frozenset[str] = frozenset(),
) -> Optional[AllowRule]:
    for rule in allowlist.rules:
        if rule.service != service:
            continue
        if rule.protocol != "any" and rule.protocol != protocol:
            continue
        if rule.port is not None and rule.port != port:
            continue
        if _destination_matches(rule.destination, dst_ip, dst_names):
            return rule
    return None
