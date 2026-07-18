"use client";

/**
 * WARP-1056 — SWR wiring for the §3.3 "Who Droplet recognizes" section.
 *
 * Its own hook file (not useVoice.ts) so the WARP-1060 hygiene work on
 * that file (#1078) and this ticket compose with a trivial rebase.
 * Profiles change only through the enrollment/remove flows, so there's
 * no poll — revalidate on focus plus an explicit `refresh()` the
 * wizard/remove flows call after every write.
 */

import useSWR from "swr";
import { fetchVoiceProfiles, isVoiceUnavailableError } from "@/lib/api";
import type { VoiceProfileInfo, VoiceProfilesResult } from "@/lib/types";

export const VOICE_PROFILES_KEY = "/api/voice/profiles";

export interface VoiceProfilesData {
  /** null while loading or when voice-io is unreachable. */
  profiles: VoiceProfileInfo[] | null;
  /** §7.2 gate: false ⇒ keep every enrollment entry point disabled. */
  speakerModelAvailable: boolean;
  loading: boolean;
  refresh: () => void;
}

export function useVoiceProfiles(): VoiceProfilesData {
  const { data, error, isLoading, mutate } = useSWR<VoiceProfilesResult>(
    VOICE_PROFILES_KEY,
    () => fetchVoiceProfiles(),
    { shouldRetryOnError: false },
  );

  // voice-io down reads as "no profiles, can't enroll" — the hero
  // already renders the red state; this section must not double-error.
  const unavailable = isVoiceUnavailableError(error);

  return {
    profiles: data?.profiles ?? null,
    speakerModelAvailable: !unavailable && (data?.speaker_model_available ?? false),
    loading: isLoading && !data && !error,
    refresh: () => {
      void mutate();
    },
  };
}
