"use client";

/**
 * WARP-3062 — Home, at the address the assistant nav layout gives it.
 *
 * That layout opens on Ask AI, so `/` is the Ask side's front door and the
 * Overview entry points here instead (`ASSISTANT_OVERVIEW_HREF`). The board is
 * the same component, unchanged. In every other layout `/` is still Home, so
 * this address forwards there rather than serving a second copy of it.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNavLayout } from "@/lib/nav-layout";
import DashboardPage from "../page";

export default function OverviewPage() {
  const { layout } = useNavLayout();
  const router = useRouter();
  const forwards = layout !== "assistant";

  useEffect(() => {
    if (forwards) router.replace("/");
  }, [forwards, router]);

  if (forwards) return null;
  return <DashboardPage />;
}
