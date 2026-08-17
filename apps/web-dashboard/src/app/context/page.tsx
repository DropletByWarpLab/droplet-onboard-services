"use client";

/**
 * WARP-225 — `/context` deep-dive page.
 *
 * Composes all 8 widgets per the design doc:
 *   - <StatCards />            (5 hero cards, stagger-revealed)
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
import { Brain } from "lucide-react";
import {
  useContextStatsFull,
  useContextStatsQueued,
  useContextStatsFailed,
} from "@/lib/hooks/useContextStats";
import { ShellPage } from "@/components/shell/ShellPage";
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
      className="animate-pulse"
      style={{ height, borderRadius: "var(--radius-card)", background: "var(--inset)" }}
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

  const SUB =
    "What your Droplet's AI has learned about you — indexed locally, on-device. Nothing here leaves the box.";
  const icon = <Brain size={15} />;

  // First-paint skeleton.
  if (isLoading && !full) {
    return (
      <ShellPage icon={icon} label="Context" title="Context" sub={SUB}>
        <div className="grid c4" style={{ marginBottom: 16 }}>
          <SkeletonRow height={120} />
          <SkeletonRow height={120} />
          <SkeletonRow height={120} />
          <SkeletonRow height={120} />
        </div>
        <SkeletonRow height={180} />
        <div className="grid c2" style={{ marginTop: 16 }}>
          <SkeletonRow height={320} />
          <SkeletonRow height={320} />
        </div>
      </ShellPage>
    );
  }

  if (error || !full) {
    return (
      <ShellPage icon={icon} label="Context" title="Context" sub={SUB}>
        <div className="card">
          <div className="empty">
            <span className="eh">Couldn&apos;t load your context</span>
            <span>
              Try refreshing the page. If it persists, the orchestrator may be unreachable.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  // Zero-context onboarding — only when BOTH pipelines are empty. A box
  // can hold serving chunks without countable file rows (WARP-1394);
  // "context is empty" over a live index is the lie this gate removes.
  if (full.files === 0 && full.chunks === 0) {
    return (
      <ShellPage icon={icon} label="Context" title="Context" sub={SUB}>
        <EmptyState />
      </ShellPage>
    );
  }

  return (
    <ShellPage icon={icon} label="Context" title="Context" sub={SUB}>
      {/* Single wrapper so the framer-motion sections aren't direct children
          of `.page-inner` (which would double up with the shell's CSS
          entrance animation). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <StatCards
          files={full.files}
          chunks={full.chunks}
          queued={full.queued}
          skipped={full.skipped}
          failed={full.failed}
        />

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          <ThroughputSparkline data={full.throughput7d} />
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-1 lg:grid-cols-2 gap-5"
        >
          <CoverageDonut data={full.byCategory} />
          <BytesBySource data={full.byCategory} />
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.48, ease: [0.16, 1, 0.3, 1] }}
        >
          <PipelineHealth rows={full.pipelineHealth} />
        </motion.section>

        {(queued.length > 0 || failed.length > 0) && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {queued.length > 0 && <QueuedList items={queued} onChange={refetchQueued} />}
            {failed.length > 0 && <FailedList items={failed} onChange={refetchFailed} />}
          </section>
        )}

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.56, ease: [0.16, 1, 0.3, 1] }}
        >
          <RecentlyIndexed items={full.recentlyIndexed} />
        </motion.section>
      </div>
    </ShellPage>
  );
}
