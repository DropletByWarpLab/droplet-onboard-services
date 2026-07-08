"""WARP-268 — runtime consumption of docs/security/allowed-egress.yaml.

THE FILE IS OWNED BY WARP-269 (telemetry-free-invariant CI gate); this module
is its runtime consumer. Both consumers now read the SAME committed schema —
the CI gate via scripts/check-egress-allowlist.py, the runtime collector via
this module — so there is a single source of truth. The committed schema is:

    version: 1
    entries:
      - id: cloud-llm-providers-optin   # unique slug
        kind: egress                    # egress | dynamic | reference
        service: ai-gateway             # owning service dir, or "host"/"repo"/"ci"
        destination:
          hosts: [api.anthropic.com]    # hostname | "*.suffix" wildcard | IP | CIDR
          cidrs: [1.1.1.1/32]           # optional — WARP-268 runtime IP/CIDR view
          ports: [443]                  # list of 1-65535 | "any"; empty/absent == any
          protocol: https               # advisory: https | quic | udp/ntp | dns | ...
        purpose: ...
        ticket: WARP-269

Runtime matching only considers `kind: egress` entries (the destinations the
box actually reaches). `kind: dynamic` (config-driven, no literal destination)
and `kind: reference` (hostnames that are not egress the box makes) are ignored
for allow-matching by design — a flow to a dynamic/reference host that is not
also an egress entry will surface as an anomaly, which is the intended posture.

Protocol is ADVISORY: the file's rich protocol labels (https/quic/dns/…) are
mapped to a transport-class set (tcp/udp) and only filter a candidate when the
mapping is unambiguous and excludes the observed flow's transport; unknown or
mixed labels match any transport, so classification falls back to host+port.

Defensive posture: unsupported version / unparseable file raises AllowlistError
(the collector then tags records "allowlist-unavailable" and emits ONE
allowlist_unavailable anomaly per failure episode); individually malformed
entries are skipped and surfaced in Allowlist.problems — a PRESENT valid file
loads and classifies.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Optional

import yaml

SUPPORTED_VERSION = 1

# Advisory protocol -> transport-class set. Anything not listed here (or an
# empty/absent protocol) is treated as "any transport" so matching falls back
# to host + port. "dns" spans both transports (UDP is the common path, TCP is
# the fallback); "any" is an explicit wildcard.
_PROTOCOL_TRANSPORTS: dict[str, frozenset[str]] = {
    "https": frozenset({"tcp"}),
    "http": frozenset({"tcp"}),
    "tcp": frozenset({"tcp"}),
    "smtp": frozenset({"tcp"}),
    "smtps": frozenset({"tcp"}),
    "imaps": frozenset({"tcp"}),
    "imap": frozenset({"tcp"}),
    "quic": frozenset({"udp"}),
    "udp": frozenset({"udp"}),
    "udp/ntp": frozenset({"udp"}),
    "ntp": frozenset({"udp"}),
    "dns": frozenset({"tcp", "udp"}),
    "any": frozenset({"tcp", "udp", "icmp", "other"}),
}

# Runtime allow-matching only considers destinations the box actually egresses
# to. dynamic (config-driven) and reference (non-egress hostnames) are ignored.
_MATCHABLE_KINDS = ("egress",)

# WARP-268/269 — service-name reconciliation. The registry (owned by WARP-269)
# labels egress rows with human-readable owners, but the runtime Attributor
# (attribution.py) emits a different vocabulary for two of them:
#   * network_mode:host services aggregate to "host" in v1  → "cloudflared"
#   * a bridge container reduces to its droplet-stripped name → the container
#     "droplet-openwrt" resolves to "openwrt", not "openwrt-router".
# match() filters candidate rules by the attributor's string, so without this
# a box's own tunnel + router DNS/NTP egress never matches its rule and surfaces
# as a steady false anomaly. Canonicalize the registry label to the attributor
# vocabulary at parse time; the human label is preserved on AllowRule.service
# for operator-facing `policy` / `key` output. The set is kept explicit (not
# derived from compose) so a new host-mode / renamed service is a conscious
# edit here — the TestRealAllowlist cross-check guards against silent drift.
_SERVICE_ALIASES: dict[str, str] = {
    "openwrt-router": "openwrt",   # bridge container droplet-openwrt
    "cloudflared": "host",         # network_mode:host → attributes to "host"
}


def _canonical_service(service: str) -> str:
    """Map a registry `service:` label to the Attributor.resolve() vocabulary."""
    return _SERVICE_ALIASES.get(service, service)


class AllowlistError(Exception):
    pass


@dataclass(frozen=True)
class AllowRule:
    entry_id: str
    service: str                        # registry label (operator-facing)
    match_service: str                  # service in Attributor.resolve() vocab
    hostnames: tuple[str, ...]          # bare hostnames + "*.suffix" wildcards
    networks: tuple[str, ...]           # IP/CIDR literals (from hosts + cidrs)
    ports: tuple[int, ...]              # empty == any port
    any_port: bool
    transports: frozenset[str]          # empty == any transport
    protocol_label: str
    phase: str                          # runtime | build | ci (absent == runtime)
    purpose: str
    ticket: str

    @property
    def key(self) -> str:
        # Stable, human-readable identity for NDJSON `policy` / dedup. Uses the
        # entry id (unique in the file) plus service so operators can grep the
        # matched registry row.
        return f"{self.service}->{self.entry_id}"


@dataclass(frozen=True)
class Allowlist:
    rules: tuple[AllowRule, ...]
    problems: tuple[str, ...]


def _parse_ports(raw: object) -> tuple[tuple[int, ...], bool]:
    """Return (explicit-ports, any_port). Empty/absent list == any port."""
    if raw is None:
        return (), True
    if not isinstance(raw, list):
        raise ValueError(f"destination.ports must be a list, got {raw!r}")
    if not raw:
        return (), True
    ports: list[int] = []
    any_port = False
    for p in raw:
        if p == "any":
            any_port = True
            continue
        if isinstance(p, bool) or not isinstance(p, int) or not (0 < p <= 65535):
            raise ValueError(f"port must be 1-65535 or 'any', got {p!r}")
        ports.append(p)
    return tuple(ports), (any_port or not ports)


def _classify_host_token(token: str) -> tuple[Optional[str], Optional[str]]:
    """Return (hostname, network). Exactly one is non-None.

    A token that parses as an IP address or CIDR network is a network literal;
    everything else (bare hostname or "*.suffix" wildcard) is a hostname.
    """
    try:
        ipaddress.ip_network(token, strict=False)
    except ValueError:
        return token.strip().lower(), None
    return None, token.strip().lower()


def _parse_entry(entry: object) -> Optional[AllowRule]:
    if not isinstance(entry, dict):
        raise ValueError("entry must be a mapping")
    kind = entry.get("kind")
    if kind not in _MATCHABLE_KINDS:
        # dynamic / reference / unknown-kind entries are not runtime egress
        # rules — silently skipped (not a problem).
        return None
    for required in ("id", "service", "destination"):
        if required not in entry:
            raise ValueError(f"missing required field {required!r}")
    dest = entry["destination"]
    if not isinstance(dest, dict):
        raise ValueError("destination must be a mapping")

    hosts = dest.get("hosts") or []
    cidrs = dest.get("cidrs") or []
    if not isinstance(hosts, list) or not isinstance(cidrs, list):
        raise ValueError("destination.hosts / destination.cidrs must be lists")

    hostnames: list[str] = []
    networks: list[str] = []
    for token in hosts:
        name, net = _classify_host_token(str(token))
        if name is not None:
            hostnames.append(name)
        else:
            networks.append(net)  # type: ignore[arg-type]
    for token in cidrs:
        # cidrs are IP/CIDR by contract; validate and dedupe with hosts-derived.
        try:
            ipaddress.ip_network(str(token), strict=False)
        except ValueError as exc:
            raise ValueError(f"invalid cidr {token!r}: {exc}") from exc
        net = str(token).strip().lower()
        if net not in networks:
            networks.append(net)

    if not hostnames and not networks:
        raise ValueError("destination has no hosts or cidrs")

    ports, any_port = _parse_ports(dest.get("ports"))

    protocol_label = str(dest.get("protocol", "")).strip().lower()
    transports = _PROTOCOL_TRANSPORTS.get(protocol_label, frozenset())
    # phase is advisory provenance (runtime | build | ci); absent == runtime.
    # It does NOT gate runtime matching — a build-labeled destination the box
    # legitimately reaches at runtime (e.g. openwrt opkg → downloads.openwrt.org,
    # WARP-826) must still match, not flag. It scopes the TestRealAllowlist
    # attributor-producibility cross-check to the rows the collector can see.
    phase = str(entry.get("phase", "runtime")).strip().lower()

    service = str(entry["service"])
    return AllowRule(
        entry_id=str(entry["id"]),
        service=service,
        match_service=_canonical_service(service),
        hostnames=tuple(hostnames),
        networks=tuple(networks),
        ports=ports,
        any_port=any_port,
        transports=transports,
        protocol_label=protocol_label,
        phase=phase,
        purpose=str(entry.get("purpose", "")),
        ticket=str(entry.get("ticket", "")),
    )


def load_allowlist(text: str) -> Allowlist:
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise AllowlistError(f"unparseable YAML: {exc}") from exc
    if not isinstance(doc, dict):
        raise AllowlistError("top level must be a mapping")
    version = doc.get("version")
    if version != SUPPORTED_VERSION:
        raise AllowlistError(
            f"unsupported version {version!r} "
            f"(this collector supports {SUPPORTED_VERSION})"
        )
    entries = doc.get("entries")
    if not isinstance(entries, list):
        raise AllowlistError("entries must be a list")
    rules: list[AllowRule] = []
    problems: list[str] = []
    for i, entry in enumerate(entries):
        try:
            rule = _parse_entry(entry)
        except (TypeError, ValueError) as exc:
            entry_id = entry.get("id") if isinstance(entry, dict) else None
            label = f"entries[{i}]" + (f" ({entry_id})" if entry_id else "")
            problems.append(f"{label}: {exc}")
            continue
        if rule is not None:
            rules.append(rule)
    return Allowlist(rules=tuple(rules), problems=tuple(problems))


def _hostname_matches(pattern: str, dst_names: frozenset[str]) -> bool:
    if pattern.startswith("*."):
        suffix = pattern[1:]  # keep the dot → enforces the label boundary
        return any(name.endswith(suffix) for name in dst_names)
    return pattern in dst_names


def _network_matches(cidr: str, dst_ip: str) -> bool:
    try:
        network = ipaddress.ip_network(cidr, strict=False)
        return ipaddress.ip_address(dst_ip) in network
    except ValueError:
        return False


def _rule_destination_matches(
    rule: AllowRule, dst_ip: str, dst_names: frozenset[str]
) -> bool:
    if any(_network_matches(net, dst_ip) for net in rule.networks):
        return True
    return any(_hostname_matches(h, dst_names) for h in rule.hostnames)


def match(
    allowlist: Allowlist,
    *,
    service: str,
    dst_ip: str,
    port: Optional[int],
    protocol: str,
    dst_names: frozenset[str] = frozenset(),
) -> Optional[AllowRule]:
    protocol = protocol.lower()
    for rule in allowlist.rules:
        # Compare against the attributor-vocabulary name, not the registry
        # label — see _SERVICE_ALIASES (WARP-268/269).
        if rule.match_service != service:
            continue
        # Protocol is advisory: filter only when the rule's transport set is
        # known (non-empty) and excludes the observed flow's transport.
        if rule.transports and protocol not in rule.transports:
            continue
        if not rule.any_port and port not in rule.ports:
            continue
        if _rule_destination_matches(rule, dst_ip, dst_names):
            return rule
    return None
