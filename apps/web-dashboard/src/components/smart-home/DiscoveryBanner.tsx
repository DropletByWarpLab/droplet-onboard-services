"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Wifi, X } from "lucide-react";

interface DiscoveryBannerProps {
  count: number;
}

export function DiscoveryBanner({ count }: DiscoveryBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [prevCount, setPrevCount] = useState(0);

  // Show banner when count increases (new devices auto-accepted)
  useEffect(() => {
    if (count > prevCount && prevCount > 0) {
      setDismissed(false);
      // Auto-dismiss after 5 seconds
      const timer = setTimeout(() => setDismissed(true), 5000);
      return () => clearTimeout(timer);
    }
    setPrevCount(count);
  }, [count, prevCount]);

  if (dismissed || count === 0) return null;

  return (
    <div
      className="flex items-center gap-3 rounded-lg p-3 mb-6"
      style={{ background: "var(--brand-subtle)", border: "1px solid color-mix(in srgb, var(--brand) 30%, transparent)" }}
    >
      <Wifi size={18} className="flex-shrink-0" style={{ color: "var(--brand)" }} />
      <p className="type-subheadline flex-1" style={{ color: "var(--text)" }}>
        {count} Matter device{count > 1 ? "s" : ""} found on the network.{" "}
        <Link
          href="/devices/add-matter"
          className="hover:underline font-medium"
          style={{ color: "var(--brand)" }}
        >
          Scan its QR code
        </Link>{" "}
        to add it.
      </p>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss discovery banner"
        className="p-1 rounded transition-colors text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
