"use client";

/**
 * WARP-2823 — the two inspector probes, kept independent on purpose.
 *
 * The prompt and the tool table answer different questions and fail for
 * different reasons. `Promise.all`ing them would mean a slow brain read blanks
 * the tool table, which is the one half that always works — the console's own
 * rule (`app/admin/page.tsx`) is that each probe degrades alone, because a
 * page that shows nothing when it could show half is a page an admin stops
 * trusting.
 */
import { useCallback, useEffect, useState } from "react";

import {
  fetchPromptInspect,
  fetchToolInspect,
  type InspectTurnOptions,
} from "@/lib/api";
import type { PromptInspectResponse, ToolInspectResponse } from "@/lib/types";

export type Probe<T> =
  | { state: "idle" | "loading" | "failed"; value?: undefined; error?: string }
  | { state: "ok"; value: T; error?: undefined };

export interface AssistantInspect {
  tools: Probe<ToolInspectResponse>;
  prompt: Probe<PromptInspectResponse>;
  reload: () => void;
}

export function useAssistantInspect(
  userId: string | null,
  turn: InspectTurnOptions,
): AssistantInspect {
  const [tools, setTools] = useState<Probe<ToolInspectResponse>>({ state: "idle" });
  const [prompt, setPrompt] = useState<Probe<PromptInspectResponse>>({ state: "idle" });

  // Spread rather than passed whole: `turn` is rebuilt on every render by the
  // page, so depending on the object identity would refetch on every keystroke
  // that changed nothing.
  const { message, offLan, interview, voice } = turn;

  const reload = useCallback(() => {
    if (!userId) {
      setTools({ state: "idle" });
      setPrompt({ state: "idle" });
      return;
    }
    const opts: InspectTurnOptions = { message, offLan, interview, voice };
    setTools({ state: "loading" });
    setPrompt({ state: "loading" });
    void fetchToolInspect(userId, opts)
      .then((value) => setTools({ state: "ok", value }))
      .catch((err: Error) => setTools({ state: "failed", error: err.message }));
    void fetchPromptInspect(userId, opts)
      .then((value) => setPrompt({ state: "ok", value }))
      .catch((err: Error) => setPrompt({ state: "failed", error: err.message }));
  }, [userId, message, offLan, interview, voice]);

  useEffect(reload, [reload]);

  return { tools, prompt, reload };
}
