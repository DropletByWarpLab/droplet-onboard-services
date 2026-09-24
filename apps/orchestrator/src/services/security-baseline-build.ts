/**
 * WARP-2980 (ADR-059 P5, spec §6.5) — the one statement that builds the
 * baseline cells, and the full build / area rebuild around it.
 *
 * S0 stub: the types and signatures. Slice A3 fills in the bodies.
 */
import type { PrismaClient, SecurityBaselineBuildTrigger } from "@prisma/client";
import type { BaselineSlot } from "../lib/security-baseline-slots.js";

export interface BuildCellsInput {
  buildId: string;
  slots: readonly BaselineSlot[];
  windowStart: Date;
  windowEnd: Date;
  /** null = every active area; otherwise only these areas' keys. */
  onlyZoneIds: readonly string[] | null;
  includeCameraKeys: boolean;
}

export type FullBuildOutcome =
  | { status: "built"; buildId: string; cellCount: number; eventCount: number }
  | { status: "claimed_elsewhere" }
  | { status: "failed"; buildId: string; error: string };

export async function runFullBuild(
  prisma: PrismaClient,
  trigger: SecurityBaselineBuildTrigger,
  zone: string,
  now: Date,
): Promise<FullBuildOutcome> {
  void prisma;
  void trigger;
  void zone;
  void now;
  return { status: "claimed_elsewhere" };
}
