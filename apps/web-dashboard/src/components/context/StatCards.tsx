"use client";

/**
 * WARP-225 — 4 hero stat cards (files / chunks / queued / failed).
 *
 * Stagger-reveal on mount (80ms each per spec). Animated counters tick
 * up to live values on every poll. Color-coded by tone — neutral
 * indigo for files/chunks, amber for queued, red for failed.
 */

import { motion } from "framer-motion";
import { AnimatedCounter } from "./AnimatedCounter";

export interface StatCardsProps {
  files: number;
  chunks: number;
  queued: number;
  failed: number;
}

const CARDS: Array<{
  label: string;
  key: keyof StatCardsProps;
  tone: "indigo" | "amber" | "red";
}> = [
  { label: "Files", key: "files", tone: "indigo" },
  { label: "Chunks", key: "chunks", tone: "indigo" },
  { label: "Queued", key: "queued", tone: "amber" },
  { label: "Failed", key: "failed", tone: "red" },
];

const TONE_CLASS: Record<"indigo" | "amber" | "red", string> = {
  indigo: "text-label-primary",
  amber: "text-system-orange",
  red: "text-system-red",
};

export function StatCards(props: StatCardsProps) {
  return (
    <div
      className="grid grid-cols-2 lg:grid-cols-4 gap-4"
      data-testid="context-stat-cards"
    >
      {CARDS.map((c, i) => {
        const value = props[c.key] as number;
        const dim = c.tone !== "indigo" && value === 0;
        return (
          <motion.div
            key={c.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="dp-tile p-6 flex flex-col gap-2"
          >
            <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
              {c.label}
            </p>
            <AnimatedCounter
              value={value}
              className={`type-display text-4xl lg:text-5xl font-semibold ${dim ? "text-label-tertiary" : TONE_CLASS[c.tone]}`}
            />
          </motion.div>
        );
      })}
    </div>
  );
}
