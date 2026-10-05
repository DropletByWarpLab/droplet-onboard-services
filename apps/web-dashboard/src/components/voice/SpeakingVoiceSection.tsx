"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetchSpeakingVoice, sayVoiceTest, setSpeakingVoice } from "@/lib/api";
import type { SpeakingVoiceInfo } from "@/lib/types";
import "./voice.css";

export function SpeakingVoiceSection({ previewAllowed }: { previewAllowed: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<SpeakingVoiceInfo>(
    "/api/voice/speaking-voice", () => fetchSpeakingVoice(), { shouldRetryOnError: false },
  );
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { setCandidate(data?.voice ?? ""); }, [data?.voice]);

  async function preview() {
    setBusy("preview");
    setMessage("");
    try {
      await sayVoiceTest("Hello, I'm Droplet. This is the voice I'll use when we talk.", candidate);
      setMessage("Preview finished. Your saved speaking voice is unchanged.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't play the voice preview. Try again.");
    } finally { setBusy(null); }
  }

  async function save() {
    setBusy("save");
    setMessage("");
    try {
      const result = await setSpeakingVoice(candidate);
      await mutate(data ? { ...data, voice: result.voice, fault: result.fault } : undefined, false);
      setMessage("Speaking voice saved. Droplet will use it for spoken replies.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't save the speaking voice. Try again.");
    } finally { setBusy(null); }
  }

  const unavailable = Boolean(error) || (data && !data.available);
  const canChoose = !unavailable && data?.available && data.selectable;
  return (
    <section aria-labelledby="speaking-voice-heading">
      <div className="vsect-h"><h2 id="speaking-voice-heading">Droplet's speaking voice</h2></div>
      <div className="card speaking-voice-card">
        <p>Choose how Droplet sounds. The saved voice applies to its spoken replies.</p>
        {isLoading && <p role="status">Loading speaking voices…</p>}
        {unavailable && <>
          <p role="status">Speaking voices are unavailable. Try again in a moment.</p>
          <button type="button" className="btn" onClick={() => { void mutate(); }}>Retry speaking voices</button>
        </>}
        {!unavailable && data?.available && !data.selectable && <p>This Droplet uses its configured speaking voice.</p>}
        {canChoose && <div className="speaking-voice-controls">
          <label htmlFor="speaking-voice-choice">Speaking voice</label>
          <select id="speaking-voice-choice" className="input" value={candidate}
            disabled={busy !== null} onChange={(e) => { setCandidate(e.target.value); setMessage(""); }}>
            {!candidate && <option value="">Choose a voice</option>}
            {data.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
          </select>
          <button type="button" className="btn" disabled={!candidate || !previewAllowed || busy !== null}
            title={!previewAllowed ? "Voice must be on and ready to play a preview." : undefined} onClick={() => { void preview(); }}>
            {busy === "preview" ? "Playing preview…" : "Preview voice"}
          </button>
          <button type="button" className="btn pri" disabled={!candidate || candidate === data.voice || busy !== null}
            onClick={() => { void save(); }}>{busy === "save" ? "Saving…" : "Save speaking voice"}</button>
        </div>}
        {data?.fault && !unavailable && <p role="status">{data.fault}</p>}
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  );
}
