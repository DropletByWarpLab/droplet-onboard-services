# Remote-access completion handoff — the pickup map

**Written 2026-08-16.** Epic: [WARP-1382](https://warp-lab.atlassian.net/browse/WARP-1382).
This directory is the package an agent (or human) starts from to finish any
remaining side of Droplet remote access **cold** — every packet stands alone,
cites code it verified, and names its tickets. If a cited PR below is not yet
merged, re-verify its citations before building on them.

## Where the system stands

The ADR-031 overlay (our apps + hole-punched WireGuard + HQ Worker signaling)
is **live and on by default** since WARP-1767 / #1608. A 27-agent adversarial
audit (2026-08-16) confirmed 20 defects; all blocker/major fixes shipped the
same week: onboard **#1609** (idle sweep spares live tunnels), **#1610**
(revocation sticks: HQ-revoke on owner delete, enroll state gate, deny guard,
cap counts live peers), **#1611** (openwrt attach re-applies on container
start), fleet-hq **#15** (read-path expiry, audit GC, enroll key guard,
endpoint validation), windows **#32** (tolerant candidate parsing). The vanity
HQ URL is staged: fleet-hq **#17** (custom domain) + onboard **#1615**
(default flip, DRAFT — merges only after a live-verified deploy).

Android is the only complete client. ADR-040 (self-run blind relays) is
decided and specced, not built.

## The packets

| Packet | Spec | Tickets (ordered) |
|---|---|---|
| **Relay (ADR-040)** — the biggest unbuilt side | [`../relay-implementation-spec.md`](../relay-implementation-spec.md) | [WARP-2071](https://warp-lab.atlassian.net/browse/WARP-2071) relayd daemon → [WARP-2072](https://warp-lab.atlassian.net/browse/WARP-2072) HQ allocation API → [WARP-2073](https://warp-lab.atlassian.net/browse/WARP-2073) box emission → [WARP-2074](https://warp-lab.atlassian.net/browse/WARP-2074) metering → [WARP-2075](https://warp-lab.atlassian.net/browse/WARP-2075) bench verification |
| **iOS connect** (WARP-1387 umbrella) | [`ios-connect-completion.md`](ios-connect-completion.md) | [WARP-2076](https://warp-lab.atlassian.net/browse/WARP-2076) two-phase enroll (gates everything; box wire change first) → [WARP-2077](https://warp-lab.atlassian.net/browse/WARP-2077) connect flow |
| **Windows** (WARP-1388 umbrella) | [`windows-connect-completion.md`](windows-connect-completion.md) | [WARP-2078](https://warp-lab.atlassian.net/browse/WARP-2078) installer ships without vpnd (**small, shippable alone, do first**) → [WARP-2079](https://warp-lab.atlassian.net/browse/WARP-2079) connect-flow completion → [WARP-2080](https://warp-lab.atlassian.net/browse/WARP-2080) vpnd required CI check |
| **Dashboard surface** | [`remote-access-dashboard-wireframe.md`](remote-access-dashboard-wireframe.md) | [WARP-2081](https://warp-lab.atlassian.net/browse/WARP-2081) status header + honesty pass → [WARP-2082](https://warp-lab.atlassian.net/browse/WARP-2082) #1610 error-state rendering |
| **HQ ops** | fleet-hq `docs/HQ-DEPLOY-AUTOMATION.md` + [`factory-mint-integration.md`](factory-mint-integration.md) | [WARP-2083](https://warp-lab.atlassian.net/browse/WARP-2083) gated deploy workflow · [WARP-2067](https://warp-lab.atlassian.net/browse/WARP-2067) factory mint (plan in the doc) |
| **Audit minors** (triaged, re-verified post-merge) | ticket bodies are self-contained | [WARP-2084](https://warp-lab.atlassian.net/browse/WARP-2084) connect-tick reliability · [WARP-2085](https://warp-lab.atlassian.net/browse/WARP-2085) enrollment GC + P2002 retry · [WARP-2086](https://warp-lab.atlassian.net/browse/WARP-2086) HQ signaling follow-ups · [WARP-2087](https://warp-lab.atlassian.net/browse/WARP-2087) Android DNS hardcode · [WARP-2088](https://warp-lab.atlassian.net/browse/WARP-2088) observability + deploy honesty |

## Cross-packet ordering constraints

1. **WARP-2078 (Windows installer) before WARP-2079** — nothing Windows-side
   reaches a customer until the installer carries vpnd.
2. **WARP-2076 before WARP-2077** — the key-custody wire change gates the iOS
   connect flow, and its box half deploys to the test box first.
3. **WARP-2072 before WARP-2073** — the box emission story dials the HQ
   allocation API (inert deploy is enough for unit work).
4. **fleet-hq #17 deploy → live-verify → onboard #1615 merge** — the NXDOMAIN
   sequencing rule; #1615 is a draft precisely so it cannot land early.
   WARP-2083's workflow makes this sequence auditable.
5. **WARP-2088 finding D** (NAT-class probe) is the *measurement half* of the
   relay rollout — if the relay epic starts first, fold it in there.
6. Everything in the minors rebases on the #1609/#1610/#1615 train — the
   tickets say which files moved.

## House rules the packets assume (do not relearn these the hard way)

- The box runs main only; host units land via `setup.sh`; a compose `restart`
  does **not** re-read `.env` — recreate.
- Candidates are **IP literals**; the per-device FQDN is public-NXDOMAIN by
  design and must never be dialled as a WG endpoint.
- Unknown candidate kinds are non-fatal on every client (windows #32 is the
  reference posture) — the relay kind must be a contract no-op for clients.
- Every claim of "verified on the box" needs a pasted transcript; absence of
  error logs is not a positive control.
- No AI trailers in commits to these repos; PRs stop at review-ready.
