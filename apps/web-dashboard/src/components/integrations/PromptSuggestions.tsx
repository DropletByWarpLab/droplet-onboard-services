"use client";

import { useRouter } from "next/navigation";
import { CHAT_DRAFT_KEY } from "@/lib/types";

/**
 * WARP-3965 — "Try asking": each chip puts its text in the chat composer on a
 * fresh chat and sends nothing. The person edits and presses send themselves, so
 * a chip can never run a tool they only wanted to look at. The composer reads
 * `sessionStorage[CHAT_DRAFT_KEY]` when it mounts (WARP-3062), which is the
 * seat this uses.
 */
export function PromptSuggestions({ suggestions }: { suggestions: readonly string[] }) {
  const router = useRouter();
  if (suggestions.length === 0) return null;

  const seed = (text: string) => {
    try {
      window.sessionStorage.setItem(CHAT_DRAFT_KEY, text);
    } catch {
      /* private mode / quota: the chat still opens, just empty */
    }
    router.push("/chat");
  };

  return (
    <section aria-label="Prompt suggestions">
      <h2 className="type-title-3" style={{ marginBottom: 8 }}>Try asking</h2>
      <div className="chiprow">
        {suggestions.map((s) => (
          <button key={s} type="button" className="chip" onClick={() => seed(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}
