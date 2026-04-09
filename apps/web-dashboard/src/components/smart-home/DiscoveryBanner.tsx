"use client";

import { useEffect, useState } from "react";
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
    <div className="flex items-center gap-3 bg-system-blue/10 border border-system-blue/20 rounded-lg p-3 mb-6">
      <Wifi size={18} className="text-system-blue flex-shrink-0" />
      <p className="type-subheadline text-label-primary flex-1">
        {count} Matter device{count > 1 ? "s" : ""} found on the network. Commission them via chat or pairing code.
      </p>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded text-label-tertiary hover:text-label-primary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
