# ADR-040: Blind relay fallback for hole-punch failures — self-run, not Cloudflare TURN

- **Status:** Accepted (founder decision, Stefan Cruceru, 2026-08-15)
- **Epic:** [WARP-1382](https://warp-lab.atlassian.net/browse/WARP-1382) · resolves the spike [WARP-1390](https://warp-lab.atlassian.net/browse/WARP-1390)
- **Amends:** [ADR-031](ADR-031-own-wireguard-overlay-remote-access.md) §Decision 5, which left the fallback transport explicitly undecided and data-gated. This is that decision.
- **Builds on:** ADR-009 (no public inbound), ADR-023 (per-device public-CA TLS, split-horizon `<name>.droplet-us.com`), WARP-1384 (HQ signaling), WARP-1385 (box connect agent), WARP-1389 (punch telemetry).

## Context

ADR-031 ships remote access as direct WireGuard between our app and the box,
brokered by the HQ Worker and established by NAT hole-punching. That path is
built and, as of WARP-1767, switched on. It does not work everywhere: when both
ends sit behind symmetric NAT, or behind carrier-grade NAT on both legs, there
is no pair of ports to punch and the session cannot form. ADR-031 named the
consequence honestly — an "remote connect unavailable on this network" message
— and deferred the fix.

That deferral is the gap between "remote access works" and the requirement
driving this decision: **it has to work all the time.** A customer whose ISP
put them behind CGNAT did not choose that, cannot change it, and will not accept
"your network is the wrong shape" as an answer. The fallback is not a tail
optimisation; it is the difference between a feature and a promise.

ADR-031 framed the choice as Cloudflare TURN (managed, per-GB, nothing for us
to run) versus tiny self-run blind relays (ours, cheap, real ops), and left it
to be settled by WARP-1389 telemetry plus a CEO cost conversation.

## Decision

**Self-run stateless blind relays.**

A blind relay is a UDP packet forwarder that moves encrypted WireGuard datagrams
between two endpoints and holds none of the keys that would let it read them.
End-to-end crypto stays exactly where ADR-031 put it: phone ↔ box. The relay
sees ciphertext, source and destination addresses, packet sizes and timing. It
cannot see traffic, and no configuration change could make it able to — it has
no key material to decrypt with, unlike an HTTP-inspecting proxy which is one
toggle away from reading everything.

Per session, HQ mints a short-lived allocation on a relay: two UDP ports, one
faced at the box and one at the client. Each side learns the other's address
from its first datagram; the relay cross-forwards and forgets the pairing at
expiry. Allocations are minted only through the existing PoP-authenticated
signaling plane, so the relay is not an open forwarder anyone can point at
anything.

State lives in memory only: no disk, no keys, no content logs. A relay that
restarts loses its allocations and sessions re-broker through HQ. There is
nothing on a relay to back up and nothing on it worth stealing.

### Why not Cloudflare TURN — the deciding argument is not cost

The cost comparison was close enough to argue either way. What settled it is
that **a plain UDP forwarder requires zero client changes, and TURN requires
work in three codebases.**

Our clients already speak WireGuard and already dial a prioritised list of
endpoint candidates — `overlay-placement.service.ts` reserves
`relay` at priority 20 in exactly that ladder. A self-run relay is just another
`{kind, host, port}` entry in the profile: an IP and a port, indistinguishable
to the client from any other endpoint. Nothing in Android's GoBackend, iOS's
WireGuardKit/NetworkExtension, or the Windows boringtun data plane has to learn
a new protocol.

TURN is not a transparent forwarder. It is an allocation protocol with its own
framing, and using it means implementing TURN allocation plus ChannelData
framing *underneath* the WireGuard socket in all three clients — against
libraries that deliberately do not expose that seam. It also costs MTU that
straight forwarding does not: rewriting a UDP header changes nothing about
payload size, while TURN adds framing on top of WireGuard's own 60-byte
overhead, on precisely the constrained links where the fallback is needed.

So the managed option is more work, in more places, with a worse packet budget —
and it would re-couple the customer-facing path to a vendor's pricing and terms,
which is the coupling ADR-031 was written to escape.

### What this costs us, stated plainly

It reopens the "no servers" stance. ADR-025A recorded a founder directive — *"I
don't want it to be a VPS, I don't want external servers"* — and that directive
is being consciously narrowed here, not quietly ignored. The narrowing: no
server ever holds customer data, customer keys, or the ability to read customer
traffic. A blind relay is infrastructure in the same sense a network switch is.
The thing the original directive was protecting against — Warp operating systems
that see inside customer boxes — is untouched.

The precedent is load-bearing rather than decorative: Home Assistant's Nabu
Casa, the incumbent in exactly this market, runs exactly these blind relays as
its paid cloud product, for exactly this reason. The sovereign-appliance thesis
and a small relay fleet are not in tension; the market leader ships both.

## Consequences

**Positive**
- Remote access becomes reachable on every network shape, which is the point.
- No client work: the relay enters as an endpoint candidate the ladder already
  understands.
- No MTU penalty relative to a direct tunnel — payloads are forwarded unmodified.
- No per-seat pricing, no account caps, no third-party terms in the customer path.
- The privacy story stays simple enough to say in one sentence: our relay moves
  sealed packets and cannot open them.

**Negative / risks (owned, not hidden)**
- **Real ops.** Hosts to patch, monitor, and page on. This is the honest cost of
  the decision and it does not go away.
- **Bandwidth is the cost driver, and camera streaming is the risk.** Dashboard
  and chat traffic over a relay is negligible; a customer watching camera
  footage remotely is not. Metered per-relay egress and a policy for it are
  prerequisites to enabling relay for video surfaces, not follow-ups.
- **The relay is an abuse surface.** Allocations must be HQ-minted, short-lived,
  rate-limited, and bound to a session — an open UDP forwarder is a reflector.
- **Metadata.** The relay observes which client address talked to which box, how
  much, and when. Less than Cloudflare would have seen under ADR-025A, but not
  nothing, and it belongs in the customer-facing privacy language.
- **Geography.** One region means bad latency for distant customers; several
  regions multiply the ops cost. Start with one and let telemetry drive the
  second.

## Follow-ups

1. Relay implementation + HQ allocation minting (new story under WARP-1382).
2. Populate `relay` endpoint candidates in `overlay-profile.service.ts` — the
   `kind` is already in the type and the ladder, and is currently never emitted.
3. Region/sizing decision driven by WARP-1389 punch-failure telemetry, once
   there is field data rather than the ~10–15% industry folklore ADR-031 cited.
4. Egress metering + a policy for camera traffic over relay, before video is
   allowed to use it.
5. Privacy-policy language for what a relay observes.
