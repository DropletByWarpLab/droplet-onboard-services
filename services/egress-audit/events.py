"""WARP-268 — egress record / anomaly shapes + the anomaly dedup gate."""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

RECORD_SCHEMA_VERSION = 1
_KNOWN_PROTOCOLS = ("tcp", "udp", "icmp")


def _iso_utc(ts: float) -> str:
    return (datetime.fromtimestamp(ts, tz=timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def proto_class(proto: str) -> str:
    proto = proto.lower()
    if proto in ("icmp", "icmpv6", "ipv6-icmp"):
        return "icmp"
    return proto if proto in _KNOWN_PROTOCOLS else "other"


@dataclass(frozen=True)
class EgressRecord:
    event: str                  # "flow_start" | "flow_end" | "dns_query"
    ts: float
    service: str
    src: str
    dst: str
    proto: str
    port: Optional[int]
    bytes_out: Optional[int]
    bytes_in: Optional[int]
    allowed: Optional[bool]     # None == allowlist unavailable
    policy: Optional[str]       # AllowRule.key | "allowlist-unavailable" | None
    dst_name: Optional[str] = None
    qname: Optional[str] = None

    def to_json_line(self) -> str:
        doc: dict = {"v": RECORD_SCHEMA_VERSION}
        doc.update({k: v for k, v in asdict(self).items() if v is not None})
        return json.dumps(doc, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True)
class Anomaly:
    kind: str                   # "unlisted_destination" | "allowlist_unavailable"
    service: str
    ts: float
    dst: Optional[str] = None
    dst_name: Optional[str] = None
    port: Optional[int] = None
    proto: Optional[str] = None

    def dedup_key(self) -> tuple:
        return (self.kind, self.service, self.dst, self.port,
                proto_class(self.proto) if self.proto else None)

    def to_payload(self) -> dict:
        payload: dict = {
            "schemaVersion": 1,
            "kind": self.kind,
            "service": self.service,
            "firstSeen": _iso_utc(self.ts),
        }
        if self.dst is not None:
            payload["dst"] = self.dst
        if self.dst_name is not None:
            payload["dstName"] = self.dst_name
        if self.port is not None:
            payload["port"] = self.port
        if self.proto is not None:
            payload["protocol"] = proto_class(self.proto)
        return payload


class AnomalyGate:
    """At most one POSTed anomaly per dedup_key per cooldown window. The
    NDJSON sink keeps every record regardless — the gate only protects the
    signed activity chain from repeat-flow spam."""

    def __init__(self, clock: Callable[[], float] = time.monotonic,
                 cooldown_sec: float = 3600.0, max_keys: int = 2048) -> None:
        self._clock = clock
        self._cooldown = cooldown_sec
        self._max = max_keys
        self._last: dict[tuple, float] = {}

    def admit(self, anomaly: Anomaly) -> bool:
        now = self._clock()
        key = anomaly.dedup_key()
        last = self._last.get(key)
        if last is not None and now - last < self._cooldown:
            return False
        self._last[key] = now
        while len(self._last) > self._max:
            self._last.pop(next(iter(self._last)))
        return True
