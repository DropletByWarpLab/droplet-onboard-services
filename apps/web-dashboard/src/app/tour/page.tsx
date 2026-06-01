"use client";

import { ProductTour } from "@/components/tour/ProductTour";

/**
 * /tour — post-setup product tour (PR #382).
 *
 * AuthGate routes a claimed ("ready") appliance whose owner hasn't finished
 * the tour here, and renders it full-screen (no sidebar chrome). The tour
 * persists `userTourCompleted` on finish/skip, after which AuthGate lets the
 * owner through to the dashboard. Replaying the tour later is an explicit
 * action from the Help page, not this route.
 */
export default function TourPage() {
  return <ProductTour />;
}
