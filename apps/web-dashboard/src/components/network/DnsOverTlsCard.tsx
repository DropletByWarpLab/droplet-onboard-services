"use client";

import { Lock } from "lucide-react";

/**
 * DNS over TLS (Droplet Design System · Network · DHCP & DNS).
 *
 * Honest gate — no fake control. The design's "Upstream DNS" row carries a
 * DNS-over-TLS toggle, but the shipping single-box image ships no DoT forwarder
 * (stubby / https-dns-proxy / dnscrypt) and stock dnsmasq does no DoT, so a
 * live toggle would silently no-op. Rather than fake it, we render the same
 * inert "not available on this build" state the shipped UPnP card uses, and
 * keep the working custom-upstream-DNS control (plain UDP) as the real knob.
 *
 * Real DoT is large on-box/image work — bake stubby into the singlebox image,
 * rewire dnsmasq to no-resolv + a localhost forwarder, and add the SDK write —
 * tracked as a follow-up, not faked behind a disabled switch.
 */
export function DnsOverTlsCard() {
  return (
    <div className="card">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-surface-secondary text-label-tertiary">
          <Lock size={18} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="type-headline text-label-primary">DNS over TLS</h3>
          <p className="type-caption-1 text-label-tertiary mt-0.5">
            Not available on this build — this Droplet&apos;s DNS resolver
            doesn&apos;t support encrypted upstream lookups yet. Your custom
            upstream DNS servers above still apply.
          </p>
        </div>
        <span className="type-caption-2 font-medium px-2 py-0.5 rounded-full flex-shrink-0 bg-surface-secondary text-label-tertiary">
          Off
        </span>
      </div>
    </div>
  );
}
