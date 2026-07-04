"""WARP-268 — deterministic in-memory pcap/DNS builders for dns_wire tests."""
from __future__ import annotations

import struct

LINKTYPE_ETHERNET = 1
LINKTYPE_LINUX_SLL2 = 276


def dns_name(name: str) -> bytes:
    out = b""
    for label in name.split("."):
        raw = label.encode("ascii")
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def dns_query(txid: int, qname: str) -> bytes:
    return (struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0)
            + dns_name(qname) + struct.pack("!HH", 1, 1))


def dns_response_a(txid: int, qname: str, ips: list[str], ttl: int = 300) -> bytes:
    msg = (struct.pack("!HHHHHH", txid, 0x8180, 1, len(ips), 0, 0)
           + dns_name(qname) + struct.pack("!HH", 1, 1))
    for ip in ips:
        rdata = bytes(int(o) for o in ip.split("."))
        # answer name = compression pointer to offset 12 (the question name)
        msg += b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, ttl, 4) + rdata
    return msg


def ipv4_udp(src: str, dst: str, sport: int, dport: int, payload: bytes) -> bytes:
    udp = struct.pack("!HHHH", sport, dport, 8 + len(payload), 0) + payload
    ip = struct.pack(
        "!BBHHHBBH4s4s", 0x45, 0, 20 + len(udp), 0, 0, 64, 17, 0,
        bytes(int(o) for o in src.split(".")),
        bytes(int(o) for o in dst.split(".")),
    )
    return ip + udp


def eth_frame(l3: bytes, ethertype: int = 0x0800) -> bytes:
    return struct.pack("!6s6sH", b"\xaa" * 6, b"\xbb" * 6, ethertype) + l3


def sll2_frame(l3: bytes, ethertype: int = 0x0800) -> bytes:
    # protocol(2) reserved(2) ifindex(4) hatype(2) pkttype(1) halen(1) addr(8)
    return struct.pack("!HHIHBB8s", ethertype, 0, 2, 1, 4, 6, b"\x02" * 8) + l3


def pcap(linktype: int, packets: list[tuple[float, bytes]]) -> bytes:
    out = struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, linktype)
    for ts, frame in packets:
        sec = int(ts)
        usec = int(round((ts - sec) * 1e6))
        out += struct.pack("<IIII", sec, usec, len(frame), len(frame)) + frame
    return out
