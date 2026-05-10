"use client";

/**
 * WARP-225 — `/context` deep-dive page.
 *
 * Composes all 8 widgets per the design doc:
 *   - <StatCards />            (4 hero cards, stagger-revealed)
 *   - <ThroughputSparkline />  (7-day area chart)
 *   - <CoverageDonut />        (source-type breakdown by file count)
 *   - <BytesBySource />        (same data, indexed-bytes lens)
 *   - <PipelineHealth />       (per-extractor row grid)
 *   - <QueuedList />           (only when count > 0; "Run now" per row)
 *   - <FailedList />           (only when count > 0; "Retry" per row)
 *   - <RecentlyIndexed />      (last 10 with relative timestamps)
 *
 * Polling cadence is paired to the orchestrator's Redis cache TTL:
 *   /full   → 60s
 *   /queued → 60s (TTL 5min on the server, but UI wants snappy retry)
 *   /failed → 60s
 *
 * Skeleton screens on first paint per spec polish bar; never spinners.
 * Empty-state for zero-files renders the onboarding card instead of
 * empty charts.
 */

import { motion } from "framer-motion";
import {
  useContextStatsFull,
  useContextStatsQueued,
  useContextStatsFailed,
} from "@/lib/hooks/useContextStats";
import { StatCards } from "@/components/context/StatCards";
import { ThroughputSparkline } from "@/components/context/ThroughputSparkline";
import { CoverageDonut } from "@/components/context/CoverageDonut";
import { BytesBySource } from "@/components/context/BytesBySource";
import { PipelineHealth } from "@/components/context/PipelineHealth";
import { QueuedList } from "@/components/context/QueuedList";
import { FailedList } from "@/components/context/FailedList";
import { RecentlyIndexed } from "@/components/context/RecentlyIndexed";
import { EmptyState } from "@/components/context/EmptyState";

function SkeletonRow({ height }: { height: number }) {
  return (
    <div
      className="dp-tile bg-surface-secondary/50 animate-pulse"
      style={{ height }}
    />
  );
}

export default function ContextPage() {
  const { full, isLoading, error } = useContextStatsFull();
  const { queued, mutate: refetchQueued } = useContextStatsQueued(
    !!full && full.queued > 0,
  );
  const { failed, mutate: refetchFailed } = useContextStatsFailed(
    !!full && full.failed > 0,
  );

  // First-paint skeleton.
  if (isLoading && !full) {
    return (
      <div className="relative min-h-screen">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] aurora-bg opacity-[0.45] animate-aurora"
        />
        <div className="relative p-6 lg:p-12 max-w-6xl mx-auto space-y-6">
          <div className="h-3 w-40 bg-surface-secondary rounded animate-pulse" />
          <div className="h-12 w-96 max-w-full bg-surface-secondary rounded animate-pulse" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SkeletonRow height={120} />
            <SkeletonRow height={120} />
            <SkeletonRow height={120} />
            <SkeletonRow height={120} />
          </div>
          <SkeletonRow height={180} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <SkeletonRow height={320} />
            <SkeletonRow height={320} />
          </div>
        </div>
      </div>
    );
  }

  if (error || !full) {
    return (
      <div className="p-6 lg:p-12 max-w-6xl mx-auto">
        <div className="dp-tile p-8 text-center">
          <p className="type-headline text-label-primary mb-2">
            Couldn&apos;t load your context
          </p>
          <p className="type-footnote text-label-tertiary">
            Try refreshing the page. If it persists, the orchestrator may
            be unreachable.
          </p>
        </div>
      </div>
    );
  }

  // Zero-files onboarding.
  if (full.files === 0) {
    return (
      <div className="relative min-h-screen">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] aurora-bg opacity-[0.45] animate-aurora"
        />
        <div className="relative p-6 lg:p-12 max-w-6xl mx-auto">
          <header className="mb-10">
            <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
              Your AI&apos;s Context
            </p>
            <h1 className="type-display text-label-primary text-5xl mt-2">
              Get started
            </h1>
          </header>
          <EmptyState />
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] aurora-bg opacity-[0.45] animate-aurora"
      />
      <div className="relative p-6 lg:p-12 max-w-6xl mx-auto space-y-8">
        {/* ── HERO ─────────────────────────────────── */}
        <header className="animate-fade-rise">
          <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
            Your AI&apos;s Context
          </p>
          <h1 className="type-display text-label-primary text-4xl lg:text-5xl mt-2 max-w-3xl">
            Your AI knows about{" "}
            <span
              className="type-display-italic"
              style={{ color: "var(--aurora-ink)" }}
            >
              you
            </span>
            .
          </h1>
        </header>

        {/* ── STAT CARDS (stagger-revealed) ────────── */}
        <StatCards
          files={full.files}
          chunks={full.chunks}
          queued={full.queued}
          failed={full.failed}
        />

        {/* ── THROUGHPUT SPARKLINE ─────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          <ThroughputSparkline data={full.throughput7d} />
        </motion.section>

        {/* ── DONUT + BYTES BAR (two-column on lg) ─── */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-1 lg:grid-cols-2 gap-5"
        >
          <CoverageDonut data={full.byCategory} />
          <BytesBySource data={full.byCategory} />
        </motion.section>

        {/* ── PIPELINE HEALTH ──────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.48, ease: [0.16, 1, 0.3, 1] }}
        >
          <PipelineHealth rows={full.pipelineHealth} />
        </motion.section>

        {/* ── ACTIONABLE LISTS (two-column when both present) ── */}
        {(queued.length > 0 || failed.length > 0) && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {queued.length > 0 && (
              <QueuedList items={queued} onChange={refetchQueued} />
            )}
            {failed.length > 0 && (
              <FailedList items={failed} onChange={refetchFailed} />
            )}
          </section>
        )}

        {/* ── RECENTLY INDEXED ─────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.56, ease: [0.16, 1, 0.3, 1] }}
        >
          <RecentlyIndexed items={full.recentlyIndexed} />
        </motion.section>
      </div>
    </div>
  );
}
