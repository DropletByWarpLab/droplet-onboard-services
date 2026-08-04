# Access Point (AP) onboarding & the flash path

**Audience:** operators and installers adding Wi-Fi coverage to a Droplet deployment.
**Scope:** how a plugged-in access point becomes a first-class Droplet AP, which APs qualify for true zero-touch, and how to bring a stock third-party AP into the fold.
**Related decisions:**
- [ADR-005 — Auto-onboard OpenWrt extender APs with `dawn` band-steering](./ADR-005-ap-auto-onboarding.md) — the onboarding mechanism this document operationalizes.
- [ADR-018 — Deployment-topology auto-detection + single-box network unification](./ADR-018-deployment-topology-and-network-unification.md) — §Decision 5 chooses "flash supported APs to the Droplet image" over EasyMesh/TR-069; this doc is its operator-facing companion.
- [ADR-011 — Hardware-agnostic codebase](./ADR-011-hardware-agnostic-codebase.md) — role-based vocabulary; concrete part numbers below are **examples**, not requirements.

> **One-line summary:** Droplet auto-onboards any AP **running the Droplet OpenWrt image** — it advertises itself on the LAN, you tap **Approve** once, and band-steering is handled for you. A stock third-party AP is brought in by **flashing it with the Droplet OpenWrt image, where its hardware is OpenWrt-supported**. For zero work, use an AP that already ships the Droplet image, or a known-good flashable model.

---

## 1. How Droplet's mDNS-announced zero-touch AP onboarding works today

Droplet does **not** use a vendor mesh protocol by default (no EasyMesh, no TR-069, no controller cloud on the Droplet path). Coverage extension is built on the fact that **every Droplet AP runs the same OpenWrt image as the Droplet router**, and that image knows how to announce itself and accept configuration from the Droplet control plane. (For households that already run a UniFi controller or an EasyMesh ecosystem, disabled-by-default integration backends exist — see ADR-024 and ADR-033 §6; they are explicit opt-ins, never the default.)

The end-to-end flow for an AP that already runs the Droplet image:

1. **Plug it in.** Connect the AP to the Droplet LAN over Ethernet (PoE or a separate power brick). No serial console, no pairing code, no app on the AP.
2. **It announces itself.** On first boot the AP advertises an `_droplet-ap._tcp` mDNS service on the LAN bridge (`br-lan`) with TXT records describing itself — MAC, serial, model, image version, and `role=extender`.
3. **The control plane discovers it.** The Droplet router polls the LAN for those announcements (~10 s cadence) and records each new AP as **Awaiting approval**. It does **not** auto-join Wi-Fi — discovery is not trust to broadcast the household SSID.
4. **You approve it once.** In the dashboard, the AP appears on the **Network** page under **Coverage Extenders**, showing its reported model and MAC. An **owner** or **admin** taps **Approve** (other roles can see AP state but cannot approve — see RBAC in ADR-005 §RBAC).
5. **It joins and is steered.** Approval hands the AP the household SSID + PSK and pushes its wireless config through the router's safe-apply path (with automatic rollback if contact is lost mid-apply). The `dawn` band-steering daemon — shipped in the image and enabled on first boot — then coordinates with the router and any other APs so clients hand off cleanly between cells.

### Why `dawn` (and why it matters for which AP you pick)

ADR-005 chose the `dawn` 802.11k/v/r daemon over `usteer` specifically because **`dawn` roams Apple clients reliably**. `usteer`'s default thresholds are known to make iPhones/MacBooks flap between APs. Most households have at least one Apple device, so clean Apple roaming is a hard product requirement.

`dawn` runs on the AP's radio. Its roaming behavior is only as good as the OpenWrt Wi-Fi driver for that AP's chipset. **This is the real constraint on the flash path:** an AP can be "OpenWrt-supported" for routing/Ethernet yet have an immature AP-mode Wi-Fi driver for its radio. A first-class Droplet AP needs **solid OpenWrt AP-mode support on its wireless chipset**, not just a bootable image. The Droplet router's own radio is a MediaTek part, so MediaTek-radio APs give the closest band-steering parity.

### State model (for reference)

Approved APs move through an explicit lifecycle (not a guessed/derived flag):

```
Discovered → Awaiting approval → Provisioning → Online → (Decommissioned)
                                      │
                                      └→ Failed (router unreachable / apply rejected / health probe timeout)
```

See ADR-005 §"Information architecture" and §"State machine" for the dashboard wizard and the persisted states.

---

## 2. Recommended APs for true zero-touch

There are two ways to get an AP that auto-onboards with no flashing work:

### Tier 1 — an AP that already runs the Droplet OpenWrt image (best)

This is the genuinely zero-touch, first-class path: the device boots the Droplet image, announces itself, and you only ever tap **Approve**. ADR-005's reference extender is a small single-board OpenWrt host running the Droplet AP overlay (the in-tree reference build target is a Raspberry Pi 5 — cited here strictly as an **example** per ADR-011; the requirement is "a board the Droplet OpenWrt overlay builds for," not that specific board). If your AP shipped with, or was pre-imaged with, the Droplet AP overlay, you are in Tier 1 and Section 3 does not apply to you.

### Tier 2 — a known-good third-party AP you flash once

Any AP whose hardware has **mature OpenWrt support including AP-mode Wi-Fi** can be flashed to the Droplet image (Section 3) and then behaves exactly like Tier 1. When choosing a Tier-2 AP, require:

- **It is on the OpenWrt Table of Hardware** with a current release build — verify at <https://openwrt.org/toh/start> (search the exact model **and hardware revision**).
- **Mature AP-mode Wi-Fi driver on its radio chipset.** Prefer a **MediaTek** radio for the closest parity with the Droplet router's own radio and `dawn` behavior.
- **At least one Gigabit Ethernet port**; PoE-in (802.3af/at) is convenient for ceiling/wall mounting.
- **A dedicated AP / "dumb AP" role** (it does not insist on being the network's router) and **802.11k/v/r** capability so `dawn` can steer it.

**Known-good example (verified OpenWrt-supported, MediaTek radio):** the **Ubiquiti UniFi 6 Lite** — MediaTek MT7621AT SoC with an MT7915 802.11ax radio, Gigabit + PoE, supported in OpenWrt's `mediatek`/`ramips` target ([OpenWrt commit adding support](https://github.com/openwrt/openwrt/commit/fb4d7a9680117a00721936c98ce41eeb2dea95c9)). Cited as an **example** of a model that meets the Tier-2 bar; always re-verify the current ToH entry and your exact hardware revision before buying or flashing.

> Cudy / other MT7621-based APs also appear in OpenWrt, but several have hardware-revision-specific gotchas — only adopt one after confirming its **specific revision** on the ToH.

---

## 3. The flash path: turning a supported third-party AP into a Droplet AP

> This converts a stock AP into a first-class Droplet AP. **Only follow it for a model you have confirmed is OpenWrt-supported (with AP-mode Wi-Fi) for your exact hardware revision** — see Section 2, Tier 2. Flashing an unsupported device can brick it.

**Before you start**

- Confirm the model **and hardware revision** on the [OpenWrt Table of Hardware](https://openwrt.org/toh/start). Hardware revisions matter: the same model name can be a different SoC/radio across `v1` / `v2`.
- Read that model's OpenWrt **device page** end to end — install method, the correct factory image, and any model-specific caveats (TFTP recovery, U-Boot quirks, stripped-vendor-header requirements, etc.).
- Have the device's recovery method ready (most OpenWrt-supported APs have a TFTP/serial recovery path) in case the flash needs a do-over.

**Steps**

1. **Flash OpenWrt onto the AP** using that model's documented OpenWrt install method (typically the vendor web UI "firmware upgrade" accepting the OpenWrt *factory* image, or TFTP). Follow the device's OpenWrt page exactly.
2. **Apply the Droplet AP overlay** so the device runs the **same image the Droplet router/extenders run**. The Droplet AP overlay is what supplies the three things that make onboarding automatic:
   - the `_droplet-ap._tcp` mDNS announcement (with `role=extender`),
   - the `dawn` package, enabled on first boot,
   - the RPC ACL that lets the Droplet control plane read the announcement and push wireless config.

   Build/obtain the Droplet AP image from the `openwrt/` overlay in this repository for a target that matches the AP's OpenWrt platform, and flash it (see `openwrt/README.md` for the image build). The first-boot provisioning is idempotent — re-running on an already-converged AP is a no-op.
3. **Plug it into the Droplet LAN** over Ethernet.
4. **Approve it** in the dashboard: **Network → Coverage Extenders → Approve** (owner/admin). The AP joins the household SSID and is picked up by `dawn`.

After step 4 the device is indistinguishable from a Tier-1 AP: it shows up in the dashboard, joins the same SSID/PSK, and band-steers.

**Why not EasyMesh / TR-069?** (the flash path reuses the `dawn` onboarding Droplet already ships rather than adopting a vendor mesh — see ADR-018 §Decision 5) A vendor mesh protocol would not configure a non-certified stock AP anyway, and adopting one would override ADR-005's deliberate `dawn` choice. The flash path reuses the onboarding flow Droplet already ships, with no second mechanism to maintain.

---

## 4. TEW-932DAP verdict

**Hardware in question:** TRENDnet TEW-932DAP (stock vendor firmware).

**Verdict: NOT OpenWrt-supported — it cannot be made a first-class Droplet AP via the flash path. Use a known-good model instead.**

Evidence (checked 2026-06-03):

| Source | Result |
|---|---|
| OpenWrt device techdata page `…/toh/hwdata/trendnet/trendnet_tew-932dap` | **404 — "This topic does not exist yet."** No device page exists. |
| [OpenWrt Table of Hardware](https://openwrt.org/toh/start) (filtered on `TEW-932DAP`) | **No matching row.** Other TRENDnet models (TEW-732BR, TEW-691GR, [TEW-827DRU](https://forum.openwrt.org/t/adding-openwrt-support-for-a-trendnet-tew-827dru-v2/69591)) are listed; this one is not. |
| OpenWrt forum (`site:forum.openwrt.org TEW-932DAP`) | **Zero threads** for this model (many other TRENDnet models have threads). |
| [WikiDevi / DeviWiki search for `TEW-932DAP`](https://deviwiki.com/wiki/Special:Search?search=TEW-932DAP) | **No entry** — the search returns no TEW-932DAP page (other TEW-### models are documented). |
| [TRENDnet product page](https://www.trendnet.com/products/product-detail?prod=130_TEW-932DAP) | Returns "Sorry, this product is not currently available" — no public spec/chipset sheet. |

Because the device is absent from OpenWrt's supported-hardware list, there is **no OpenWrt factory image and no validated install method** for it. Without OpenWrt there is no Droplet AP overlay, no `_droplet-ap._tcp` announcement, and no `dawn` — so it cannot auto-onboard and cannot be band-steered with the rest of the household. Stock TEW-932DAP firmware does not speak Droplet's onboarding protocol.

> **Model-number check for the operator.** Exact-string searches for `TEW-932DAP` surface only TRENDnet's *neighbouring* Wi-Fi-6 PoE access points (TEW-921DAP / TEW-923DAP / TEW-925DAP) and the older AC line (TEW-821DAP / TEW-825DAP). If your label actually reads one of those, re-verify it on the OpenWrt ToH — but note that **none of TRENDnet's current TEW-9xxDAP Wi-Fi-6 APs are in the OpenWrt Table of Hardware either**, so the verdict (not a flash-path candidate) is unchanged regardless of which of these the unit turns out to be.

### What to do instead

Pick a Tier-2 known-good AP (Section 2) and follow the flash path (Section 3) — or use a Tier-1 AP that already runs the Droplet image. The verified example that meets the bar today is the **Ubiquiti UniFi 6 Lite** (MediaTek MT7621AT + MT7915 802.11ax, Gigabit + PoE, OpenWrt `mediatek`/`ramips` support). Re-confirm the live ToH entry and your exact hardware revision before purchase.

The TEW-932DAP can still be used as a **plain dumb AP on its stock firmware** (plug it into the LAN, bridge it, broadcast the same SSID by hand) — but it will **not** appear in the dashboard, will **not** auto-onboard, and will **not** participate in `dawn` band-steering, so Apple-client roaming across it is not managed. That is a manual stopgap, not a supported Droplet AP.

---

## Sources

- OpenWrt Table of Hardware: <https://openwrt.org/toh/start>
- OpenWrt device techdata for TEW-932DAP (404 — page does not exist): `https://openwrt.org/toh/hwdata/trendnet/trendnet_tew-932dap`
- OpenWrt forum — TRENDnet TEW-827DRU v2 support thread (example of a supported TRENDnet model): <https://forum.openwrt.org/t/adding-openwrt-support-for-a-trendnet-tew-827dru-v2/69591>
- DeviWiki (ex-WikiDevi) TRENDnet index (no TEW-932DAP entry): <https://deviwiki.com/wiki/TRENDnet_TEW-821DAP_V2.0R>
- TRENDnet product page for TEW-932DAP ("not currently available"): <https://www.trendnet.com/products/product-detail?prod=130_TEW-932DAP>
- OpenWrt commit adding Ubiquiti UniFi 6 Lite (MT7621AT + MT7915) support: <https://github.com/openwrt/openwrt/commit/fb4d7a9680117a00721936c98ce41eeb2dea95c9>
- OpenWrt 802.11k/v/r AP guidance (community): <https://forum.openwrt.org/t/new-ap-with-802-11r-and-vlan-support/164791>
