"""WARP-268 — conntrack -E line parsing."""
from __future__ import annotations

from conftest import FIXTURES
from conntrack_parse import parse_conntrack_line


def _fixture_lines() -> list[str]:
    return (FIXTURES / "conntrack_events.txt").read_text().splitlines()


class TestNewEvents:
    def test_parses_new_tcp_with_timestamp(self):
        ev = parse_conntrack_line(_fixture_lines()[0])
        assert ev is not None
        assert ev.event == "new"
        assert ev.ts == 1751600000.123456
        assert (ev.proto, ev.src, ev.dst) == ("tcp", "172.18.0.7", "160.79.104.10")
        assert (ev.sport, ev.dport) == (51824, 443)
        assert ev.bytes_out is None and ev.bytes_in is None

    def test_reply_tuple_never_overwrites_origin(self):
        # The reply dst is the masqueraded host IP (192.168.1.87) — origin
        # attribution would break if the second src=/dst= pair won.
        ev = parse_conntrack_line(_fixture_lines()[0])
        assert ev.dst == "160.79.104.10"

    def test_parses_without_timestamp_prefix(self):
        raw = "    [NEW] tcp      6 120 SYN_SENT src=172.18.0.7 dst=1.2.3.4 sport=1 dport=443 [UNREPLIED] src=1.2.3.4 dst=192.168.1.87 sport=443 dport=1"
        ev = parse_conntrack_line(raw)
        assert ev is not None and ev.ts is None and ev.dst == "1.2.3.4"


class TestDestroyEvents:
    def test_extracts_both_direction_byte_counters(self):
        ev = parse_conntrack_line(_fixture_lines()[1])
        assert ev.event == "destroy"
        assert (ev.bytes_out, ev.bytes_in) == (2412, 9876)

    def test_udp_dns_flow(self):
        ev = parse_conntrack_line(_fixture_lines()[3])
        assert (ev.proto, ev.dport, ev.bytes_out, ev.bytes_in) == ("udp", 53, 64, 128)


class TestRejects:
    def test_update_events_dropped(self):
        assert parse_conntrack_line(_fixture_lines()[4]) is None

    def test_garbage_and_blank_lines(self):
        assert parse_conntrack_line("") is None
        assert parse_conntrack_line("not a conntrack line") is None
        assert parse_conntrack_line("[1751600000.1]\t[NEW] tcp 6") is None


class TestTolerance:
    def test_assured_and_mark_tokens_ignored(self):
        ev = parse_conntrack_line(_fixture_lines()[5])
        assert ev is not None and ev.src == "192.168.1.87" and ev.dport == 443

    def test_ipv6_addresses_pass_through(self):
        raw = ("[1751600100.0]\t    [NEW] tcp      6 120 SYN_SENT "
               "src=fd00::7 dst=2606:4700::6810:84e5 sport=5000 dport=443 "
               "[UNREPLIED] src=2606:4700::6810:84e5 dst=fd00::1 sport=443 dport=5000")
        ev = parse_conntrack_line(raw)
        assert ev is not None and ev.dst == "2606:4700::6810:84e5"
