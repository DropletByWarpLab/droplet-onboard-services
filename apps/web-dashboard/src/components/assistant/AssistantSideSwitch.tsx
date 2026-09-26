"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { LayoutDashboard, MessageSquare, type LucideIcon } from "lucide-react";
import type { AssistantSide } from "@/lib/assistant-side";

// Both labels and both glyphs are the nav's own (nav-config.ts: Overview is
// LayoutDashboard, Ask AI is MessageSquare), so the switch names places the
// person already knows rather than introducing a third vocabulary.
const SIDES: { side: AssistantSide; label: string; icon: LucideIcon }[] = [
  { side: "ask", label: "Ask AI", icon: MessageSquare },
  { side: "business", label: "Overview", icon: LayoutDashboard },
];

/**
 * WARP-3062 — the "Ask AI | Overview" switch at the top of the assistant
 * layout. A two-tab WAI-ARIA tablist whose tabs are real links, so the side
 * lives in the URL: Back, refresh, a new tab and a deep link all work, and
 * the selected tab is whichever side the current route belongs to.
 *
 * Keyboard: Tab reaches the selected tab only (roving tabindex); Left / Right
 * and Home / End move focus between the two; Enter or Space opens the focused
 * side. Activation is manual, not on arrow, because opening a side is a page
 * navigation — focus must be able to cross the switch without leaving the
 * page.
 *
 * The selected side carries three cues: the raised thumb behind it, a heavier
 * label, and the glyph in the brand colour at stroke 2 (styles in
 * assistant-shell.css).
 */
export function AssistantSideSwitch({
  side,
  hrefs,
}: {
  side: AssistantSide;
  /** Where each tab leads — the last place used on that side. */
  hrefs: Record<AssistantSide, string>;
}) {
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const focusTab = (index: number) => {
    const n = SIDES.length;
    tabRefs.current[(index + n) % n]?.focus();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLAnchorElement>, index: number) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTab(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTab(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(SIDES.length - 1);
        break;
      case " ":
        // Enter already follows the link; Space is the tab-activation key.
        e.preventDefault();
        router.push(hrefs[SIDES[index].side]);
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Ask AI or Overview"
      className="da-switch"
      data-side={side}
    >
      <span className="da-thumb" aria-hidden="true" />
      {SIDES.map((s, index) => {
        const selected = s.side === side;
        const Icon = s.icon;
        return (
          <Link
            key={s.side}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            href={hrefs[s.side]}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-side={s.side}
            className="da-tab"
            onKeyDown={(e) => handleKey(e, index)}
          >
            <Icon aria-hidden="true" strokeWidth={selected ? 2 : 1.5} />
            <span>{s.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
