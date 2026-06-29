"use client";

import { useCallback, useState } from "react";
import { confirmMatterCommand } from "../api";
import type { MatterCommandResult } from "../types";

/** The staged Tier-2 confirmation the Devices surface is asking the user to OK. */
export type PendingMatterConfirmation = Extract<
  MatterCommandResult,
  { status: "confirmation_required" }
>;

/** The `command` shape this hook wraps (from `useSmartHome`). */
type CommandFn = (
  nodeId: string,
  command: string,
  data?: Record<string, unknown>,
) => Promise<MatterCommandResult>;

export interface MatterCommandConfirm {
  /** The pending Tier-2 confirmation, or null when nothing awaits confirm. */
  pending: PendingMatterConfirmation | null;
  /**
   * Issue a device command. Tier-1 writes execute immediately; a Tier-2 write
   * stages `pending` (the caller renders a confirm dialog) instead of silently
   * succeeding/failing.
   */
  request: (
    nodeId: string,
    command: string,
    data?: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Confirm + execute the staged command (echoing the token + service back to
   * the orchestrator), then refresh device state and clear `pending`. Rejects
   * (leaving `pending` set so the dialog stays open) if the confirm fails — e.g.
   * an expired token — so the caller can surface the error and let the user retry.
   */
  confirm: () => Promise<void>;
  /** Dismiss the staged confirmation without executing it. */
  cancel: () => void;
}

/**
 * KAN-5: device-control confirmation orchestration for the Devices surface.
 *
 * Wraps `useSmartHome.command` so the page can intercept the orchestrator's
 * Tier-2 `confirmation_required` (202) answer — for a lock/unlock or a climate
 * setpoint >= 30C — stage a confirm affordance, and complete the write by
 * echoing the single-use token + service to `confirmMatterCommand`. This is the
 * device-control sibling of the chat-side confirmation handling.
 *
 * @param command the `command` returned by `useSmartHome`.
 * @param refresh optional device-list revalidator, called after a confirmed
 *   write so the new state polls in promptly.
 */
export function useMatterCommandConfirm(
  command: CommandFn,
  refresh?: () => void,
): MatterCommandConfirm {
  const [pending, setPending] = useState<PendingMatterConfirmation | null>(null);

  const request = useCallback(
    async (
      nodeId: string,
      cmd: string,
      data?: Record<string, unknown>,
    ): Promise<void> => {
      const result = await command(nodeId, cmd, data);
      if (result.status === "confirmation_required") {
        setPending(result);
      }
      // Tier-1 `ok` needs no follow-up — `command` already revalidated.
    },
    [command],
  );

  const confirm = useCallback(async (): Promise<void> => {
    if (!pending) return;
    // Keep `pending` set across the await so the dialog stays open (and the
    // confirm button shows its working state) until the write resolves. On
    // failure we leave it set so the user can retry; on success we clear it.
    await confirmMatterCommand(
      pending.nodeId,
      pending.confirmationToken,
      pending.service,
    );
    refresh?.();
    setPending(null);
  }, [pending, refresh]);

  const cancel = useCallback(() => setPending(null), []);

  return { pending, request, confirm, cancel };
}
