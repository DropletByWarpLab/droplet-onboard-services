"""WARP-268 — parser for `conntrack -E -e NEW,DESTROY -o timestamp` output.

One line per event. Grammar we rely on (conntrack-tools 1.4.x):

    [<epoch.frac>]\t<pad>[NEW|DESTROY|UPDATE] <proto> <protonum> [<timeout> <state>]
        src=A dst=B sport=N dport=M [packets=P bytes=Q]      ← ORIGIN tuple
        src=B' dst=A' sport=M' dport=N' [packets=P' bytes=Q'] ← REPLY tuple
        [flags like [UNREPLIED] [ASSURED] mark=0 use=1]

The parse is token-tolerant: anything without '=' (proto number, timeout,
TCP state, bracket flags) is skipped, and the SECOND occurrence of `src=`
switches accumulation from the origin tuple to the reply tuple. The origin
tuple is pre-NAT, so a masqueraded container flow keeps its bridge source
IP — that is the whole basis of attribution (see attribution.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

_EVENT_TAGS = {"[NEW]": "new", "[DESTROY]": "destroy"}


@dataclass(frozen=True)
class FlowEvent:
    event: str
    ts: Optional[float]
    proto: str
    src: str
    dst: str
    sport: Optional[int]
    dport: Optional[int]
    bytes_out: Optional[int]
    bytes_in: Optional[int]


def _as_int(d: dict[str, str], key: str) -> Optional[int]:
    value = d.get(key)
    return int(value) if value is not None and value.isdigit() else None


def parse_conntrack_line(line: str) -> Optional[FlowEvent]:
    line = line.strip()
    if not line:
        return None
    ts: Optional[float] = None
    if line.startswith("["):
        end = line.find("]")
        stamp = line[1:end] if end > 0 else ""
        if stamp.replace(".", "", 1).isdigit():
            ts = float(stamp)
            line = line[end + 1:].strip()
    event: Optional[str] = None
    for tag, name in _EVENT_TAGS.items():
        if line.startswith(tag):
            event = name
            line = line[len(tag):].strip()
            break
    if event is None:
        return None  # [UPDATE] and anything unrecognized is not ours
    tokens = line.split()
    if not tokens:
        return None
    proto = tokens[0].lower()
    origin: dict[str, str] = {}
    reply: dict[str, str] = {}
    current = origin
    for tok in tokens[1:]:
        if "=" not in tok:
            continue
        key, _, value = tok.partition("=")
        if key == "src" and "src" in current:
            current = reply
        current[key] = value
    if "src" not in origin or "dst" not in origin:
        return None
    return FlowEvent(
        event=event,
        ts=ts,
        proto=proto,
        src=origin["src"],
        dst=origin["dst"],
        sport=_as_int(origin, "sport"),
        dport=_as_int(origin, "dport"),
        bytes_out=_as_int(origin, "bytes"),
        bytes_in=_as_int(reply, "bytes"),
    )
