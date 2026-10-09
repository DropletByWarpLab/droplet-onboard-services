# ADR-074: Meeting recording and AI notes — the box records the room or a browser mic with the owner's consent, transcribes through the WARP-218 queue, and writes the notes on the box

- **Status:** Proposed, 2026-10-09 (epic [WARP-3320](https://warp-lab.atlassian.net/browse/WARP-3320); this document is [WARP-3939](https://warp-lab.atlassian.net/browse/WARP-3939)). It closes the six decisions the epic and the `VOICE-MEETING` entry in [`ROADMAP.md`](ROADMAP.md) say must be closed before any code. The decisions are proposed here for Romain's review; nothing in this ADR has shipped.
- **Closes:** WARP-3320 decisions 1–6 (consent, the privacy claim, who may start and read, CPU budget, capture path, where the phrase is decided). Supersedes the older idea ticket WARP-1233.
- **Builds on:** [`ADR-015`](ADR-015-voice-control-spoken-confirmation.md) (voice is a weak trust surface; spoken two-phase confirmation), [`ADR-032`](ADR-032-access-roles-custom-rbac.md) (module gates, who may read), [`ADR-051`](ADR-051-company-brain.md) (the opt-in singleton setting shape), [`ADR-056`](ADR-056-agentic-extensibility.md) (agent runs as the background worker), [`ADR-070`](ADR-070-camera-recording-storage.md) (recordings on `/data`, retention as a setting), [`ADR-014`](ADR-014-llm-client-dispatched-actions.md) (writes ask), the WARP-218 deferred-ASR design ([`superpowers/specs/2026-05-08-warp-218-deferred-asr-design.md`](superpowers/specs/2026-05-08-warp-218-deferred-asr-design.md)) and [`security/at-rest-encryption.md`](security/at-rest-encryption.md) (WARP-242 per-document chunk encryption, crypto-shred).
- **Number:** 074. Checked 2026-10-09 across every remote branch of this repository: `docs/ADR-*` reaches `ADR-073` (`origin/stage`, `origin/main`, and the hosted-apps branch), and no branch, open PR or WARP ticket cites an `ADR-074`. The document-generation plan that had pencilled in 074 takes 075. A claimed number reserves nothing: re-check before merge.

## 1. Context

The ask (WARP-3320): say "Hey Droplet, record this meeting", and the box records the room through the mic array it already listens on, says aloud that it has started, stops on "Hey Droplet, stop recording", and turns the audio into a transcript and notes without anything leaving the box. Since the epic was filed the ask has widened to the laptop case: a person in a meeting room with the dashboard open presses Record and gets the same transcript and notes. Both are the same feature with two audio sources.

What exists, verified on `origin/stage` @ `8ab00bb47` on 2026-10-09:

- **One exclusive mic loop, capped per turn.** `services/voice-io/voice/pipeline.py` `WakePipeline` (`:762`) owns the only capture stream; a turn ends at end-of-speech or `STT_MAX_RECORD_S` (`DEFAULT_STT_MAX_RECORD_S = 30.0`, `pipeline.py:312`). The live STT sidecar is Qwen3-ASR over Wyoming (`qwen-stt`, `docker/docker-compose.yml:2894`, `STT_URL` default `tcp://qwen-stt:10300`), 30 s per request, one inference at a time, text only. The orchestrator's `POST /api/stt` (`apps/orchestrator/src/routes/stt.ts:34-49`) enforces the same 30 s and two concurrent callers. Nothing in voice-io writes audio to disk: `audio_io.py` `record()` (`:164`) returns an in-memory array, and `docs/voice-assistant-overview.md:171` promises that audio "is never written to disk".
- **A long-audio path that is not the live one.** `services/file-indexer/extractors/audio.py` transcribes whole files with faster-whisper (`beam_size=5`, `:117-133`), accepts mp3, m4a, wav, ogg, flac, webm and aac (`:31-41`), has no duration cap, and emits per-segment start/end anchors (`MediaTimestampAnchor`, `:24`). It runs in the WARP-218 nightly window and on demand through `POST /api/files/brain/:itemId/transcribe-now` (`apps/orchestrator/src/routes/files-brain.ts:639`), with a per-item rolling-hour retry cap (`:47`). Audio uploads land in `BrainMemoryItemStatus.queued_for_transcription` (`:226`, `:335`). `BrainMemorySource` has one value, `chat_attachment` (`prisma/schema.prisma:2005`).
- **Browser capture is dictation only.** `apps/web-dashboard/src/lib/audio-capture.ts` captures 16 kHz PCM for 30 s at most (`MAX_RECORD_SECONDS = 30`, `:14`) and deliberately avoids MediaRecorder. `POST /api/files/upload` (`routes/files.ts`) accepts any file up to `MAX_UPLOAD_SIZE_MB`.
- **A kill switch that must win.** `services/voice-io/voice/enabled.py` (WARP-1599) is an on-box file that voice-io honours in its own startup path; "cannot read" resolves to OFF (WARP-1620). Proving it on real hardware (WARP-1617) is still open.
- **A spoken-confirmation contract.** ADR-015 reuses the Matter two-phase `/confirm` token for voice writes with a 10-second window, and voice actions land in the activity chain with `kind: "voice"` (`routes/voice.ts:398,504,539`).
- **An opt-in singleton shape.** `BrainSetting` (`schema.prisma:962`) is `enabled` default false with a server-stamped `enabledById`; ADR-051 is the pattern for a feature that is off until an owner says otherwise.
- **Background work with a card in chat.** `AgentRun` with `AgentRunOrigin { workshop, schedule, chat }` (`schema.prisma:4984`), the worker in `services/agent-run-worker.service.ts`, and a `RunCard` / `agent_run_result` message in the starting conversation (ADR-056, WARP-3299).
- **Meetings the box already knows about.** `TeamChatMeeting` carries `startsAt`, `durationMinutes`, `calendarEventId` and `meetingUrl` (`schema.prisma:9401-9408`).
- **Storage and encryption.** `/data` is LUKS2 (`security/at-rest-encryption.md` § Layout); brain chunk text is encrypted per document with its own DEK and crypto-shredded on delete (§ WARP-242); camera footage has its own section and a retention setting (ADR-070). Audio recordings have no section.
- **Nothing dials a meeting provider.** `ref-meeting-provider-hosts` (`security/allowed-egress.yaml:2312`) exists so that links can be parsed, never so the appliance joins a call.
- **Adjacent tools.** `summarize_file`, `read_document_text`, `create_reminder`, `create_event`, `team_chat_send_meeting_invite`, `create_pdf_report`, `create_word_document`, `start_agent_run`. No tool touches audio, recordings or transcripts.

What is missing is exactly what the epic lists: long-form capture, a recording lifecycle with an explicit state column, consent, an on-box indicator and retention, a path from the spoken phrase to a server route, and a recording / transcript / notes view. Two constraints shape every answer below: the AI side is never exposed to the network (nothing leaves the box, no new model, no `LLM_MODEL` change), and STT is CPU-only, so long audio competes with the chat model and Frigate for tens of minutes per file (WARP-218).

## 2. Decision

### 2.1 One lifecycle, two sources, in the orchestrator

A `Recording` row owns every recording regardless of where the audio comes from:

| Field | Meaning |
|---|---|
| `status: RecordingStatus` | `starting → recording → stopping → stopped → transcribing → notes_pending → ready`, with `failed` (carries `failureReason`) and `purged` as terminal states. An explicit enum column, never a state derived from which timestamps are null. |
| `source: RecordingSource` | `box_mic`, `browser`, `upload`. A later `mobile` value is additive. |
| `startedById`, `startedVia` | The user, or the voice principal; `startedVia` is `voice`, `dashboard` or `upload` and is what the activity chain records as `refs.surface`. |
| `teamChatMeetingId?`, `calendarEventId?` | Set when a meeting in progress claims the recording (§2.8); otherwise the recording is ad hoc. |
| `audioPath`, `transcriptPath`, `notesPath`, `brainMemoryItemId?` | File Store paths and the WARP-218 item that transcribes it. |
| `startedAt`, `endedAt`, `durationMs`, `audioPurgedAt?`, `stopReason?` | `stopReason` is `user`, `voice`, `kill_switch`, `capture_lost`, `max_duration` or `consent_revoked`. |

Routes, all under `/api/recordings`, all behind the ADR-032 module gate `recordings`:

| Route | Who | Effect |
|---|---|---|
| `POST /` | owner, admin; family only when the consent setting allows it; never guest; the voice principal only with an ADR-015 confirmation token | Creates the row in `starting`, allocates the File Store folder, returns the id and the chunk endpoint. Refused with `recording_consent_off` while §2.2's setting is off. |
| `POST /:id/chunks` | the starter's session, or voice-io's service bearer for `box_mic` rows | Appends one chunk (WAV from the box, webm/opus from a browser). Rejects after 3 hours of audio with `max_duration`, which also stops the recording. |
| `POST /:id/stop` | **any** signed-in user, the voice principal with no confirmation, the kill-switch hook, the capture-liveness watchdog | Finalises the file, moves to `stopped`, hands off to §2.4. Stop is deliberately open: anyone in the room, at any role, can end a recording of themselves. A stop by anyone other than the starter (including a participant of a claimed meeting) is never silent: the chain entry and `CommandAuditLog` row record the stopper's identity (or `voice` / `kill_switch` / `watchdog` for non-user stops) in `refs.stoppedBy`, and the starter gets an in-app notification and, for a voice start, a spoken line on the box's next idle ("Recording was stopped by <name>"). Stop never needs the starter's approval. |
| `GET /`, `GET /:id` | the starter, owner, admin, and the participants of a claimed meeting | List and detail, including status for the indicator (§2.9). |
| `DELETE /:id` | owner, admin, the starter | Deletes the audio, crypto-shreds the transcript and notes chunks, moves to `purged`. The row stays as an audit fact. |

Every start, stop and delete writes the signed activity chain (`kind: "voice"` for voice-started rows) and a `CommandAuditLog` row with the user, the surface, `confirmed`, and no audio. This is the one place RBAC and audit live; voice-io and the browser are clients of it, not peers.

### 2.2 Consent: off until an owner opts in; start is announced, stop is open

A `RecordingConsentSetting` singleton in the `BrainSetting` shape: `enabled` default **false**, `enabledById` and `enabledAt` server-stamped from the session, `audioRetentionDays` default 30, `transcriptRetentionDays` default unset (keep), `familyMayStart` default false. Only an owner can turn it on, and the settings copy says what it means in plain words: the box will record people in the room who may never have touched it, it will say so out loud when it starts, and anyone can stop it.

While the setting is off, `POST /api/recordings` is refused and the box answers a spoken request with "Recording is off. An owner can turn it on in Settings". Turning the setting off while a recording runs stops it (`stopReason = consent_revoked`).

Start and stop are asymmetric on purpose. Start needs consent on, an authorised principal, and for voice the spoken confirmation of §2.5. Stop needs none of that.

### 2.3 The privacy claim changes in the same PR as the capture code

`docs/voice-assistant-overview.md:171` and `services/voice-io/README.md` say audio is never written to disk. That becomes: audio is written to disk only while a recording the owner enabled and the box announced is running, and only to `/data`. The copy change lands in the capture-tee PR (WARP-3941), not before and not after.

The kill switch wins: when `enabled.py` flips to off, voice-io finalises the chunk in flight, posts `stop` with `stopReason = kill_switch`, and tears the pipeline down as it does today. The orchestrator independently stops every `box_mic` recording when `POST /voice/enabled` persists `false`, so the result does not depend on voice-io being alive to notice. WARP-1617 (the hardware proof of the kill switch) is an explicit gate on WARP-3941: voice start is not enabled on any customer box until WARP-1617 passes. The slice may merge behind the gate (the `box_mic` source refuses to start while the gate is closed); the dashboard and upload sources are not affected. WARP-1377 is not a gate, because speaker identity is never used to authorise a start (§2.5).

### 2.4 CPU budget: the WARP-218 queue transcribes, an agent run writes the notes

There is no second ASR path and no live transcription in v1. On `stop`, the orchestrator registers the audio as a `BrainMemoryItem` with a new `BrainMemorySource.recording` value in `queued_for_transcription` and calls the `transcribe-now` path, which keeps its rolling-hour retry cap and its one-at-a-time worker. The file-indexer's faster-whisper run produces the timestamped segments; the orchestrator writes them to `transcript.md` as `[hh:mm:ss] text` lines, one per segment, and moves the row to `notes_pending`.

Notes are a map-reduce job in an `AgentRun` with a new `AgentRunOrigin.recording` value, so they get the existing worker, cancellation, the `RunCard`, and the `agent_run_result` message in the starter's conversation. The run chunks the transcript by about 2,500 words, asks the configured model for per-chunk JSON (topics, decisions, action items with owner and due date, open questions, each with the segment anchors it came from), then merges the chunk outputs in a final pass that fits the 4,096-token output cap. The result is `notes.md` plus a `MeetingNotes` JSON blob on the row; the row moves to `ready`. No new model, no `LLM_MODEL` change, and the run competes for the model like any other agent run.

Speaker diarization (WARP-207), streaming transcription (WARP-209) and ASR sizing by duration (WARP-213) stay open tickets this leans on; none is v1 scope.

### 2.5 Capture: voice-io tees the one loop; the browser records with MediaRecorder

**Box mic.** A recorder subscribes to the frames `WakePipeline._on_frame` already receives. It does not open a second stream and it does not change the turn cap: wake detection stays armed, so "Hey Droplet, stop recording" is heard while recording. The recorder writes 16 kHz mono int16 WAV chunks of about 10 seconds and posts each to `POST /api/recordings/:id/chunks` with voice-io's service bearer. A box that loses its mic mid-recording (the WARP-3934 watchdog) stops the recording with `stopReason = capture_lost` instead of silently recording nothing. At 2 h 50 the box says the recording will stop in ten minutes; at 3 h the chunk route refuses and the recording stops with `max_duration`.

The spoken path rides ADR-015: "record this meeting" or "start recording" makes the box ask "Start recording this meeting? Say yes." The confirmation has the ADR-015 10-second window and token; the start lands in the activity chain with `refs.surface = "voice"`. The box then says "Recording started". Speaker identity is not a gate while WARP-1377 (voiceprints in plaintext at rest) is open; the gate is consent plus the spoken confirmation. "Stop recording" needs no confirmation and the box says "Recording stopped. Notes will be ready shortly."

**Browser.** The dashboard's Record control uses `MediaRecorder` with `audio/webm;codecs=opus`, which the file-indexer already accepts, and streams a chunk every ~10 seconds to the same route, so a tab crash or reload loses at most one chunk and the Recordings view can stop or resume the row. The existing 30 s PCM dictation module stays as it is; the recorder is a separate module. The browser source follows the same role matrix as §2.1; stop is available to every signed-in user.

**Upload.** Dropping an audio file on the Recordings view creates a `source = upload` row and goes straight to §2.4. This is the path for a phone memo until the mobile apps record natively.

### 2.6 Classification and encryption: recordings are a sensitive class

Recordings, transcripts and notes are a new sensitive class (a dental practice's box records PHI). They get: the ADR-032 module gate `recordings` on every route and tool; raw audio on `/data` only, under LUKS, never on the OS drive; transcript and notes text under the WARP-242 per-document chunk encryption with their own DEKs; crypto-shred on `DELETE`; and a "Recordings" section in `security/at-rest-encryption.md` that says exactly this. The brain index may hold the transcript segments (that is what makes `search_transcripts` work), under the same chunk encryption as every other brain item.

### 2.7 The phrase is decided in voice-io; no language model may start a recording

Of the two options the epic names, this ADR picks the deterministic match in voice-io (the `classify_tool_choice` pattern that already gates greetings locally), calling the orchestrator route. The reason is the one the epic gives against the alternative: a language model must not be the thing that decides whether to record a room. RBAC and audit are not lost by this choice, because the orchestrator route enforces both for every caller; voice-io merely decides that a phrase was said.

Consequently there is **no** `start_recording` tool. The LLM gets read-only tools over finished recordings (`list_recordings`, `get_recording_notes`, `search_transcripts`), and one write tool, `recording_actions_to_reminders`, which turns the notes' action items into `create_reminder` / `create_event` calls behind the standard confirmation card (ADR-014: writes ask). Export to PDF or DOCX reuses `create_pdf_report` / `create_word_document` and returns the file card inline.

### 2.8 Where it lands, who can reach it, how long it stays

Each recording gets a File Store folder `/Recordings/<yyyy-mm-dd> <title>/` holding `audio.wav` or `audio.webm`, `transcript.md` and `notes.md`. An ad hoc recording lives in the starter's personal folder. When a `TeamChatMeeting` is in progress at start (or the starter picks one), the recording is claimed by it and lives in that meeting's group folder, so its participants can reach it through the normal share rules; a voice-started recording with exactly one meeting in progress is claimed automatically, and the box says which one.

Retention follows ADR-070's shape: `audioRetentionDays` (default 30, owner-settable) governs a daily purge at 03:30, after the ASR window, that deletes the audio and sets `audioPurgedAt`. Transcript and notes stay until the recording is deleted. That default is a deliberate decision for the owner to confirm, not an oversight: a transcript of a room is itself sensitive. The consent panel states it in plain words, and `transcriptRetentionDays` (default unset, meaning keep) lets an owner set a purge that crypto-shreds the transcript and notes chunks on the same daily job. Nothing is deleted silently from a row the owner has not seen: the Recordings view shows the purge date on each card.

### 2.9 The box must look and sound different while it records

`/voice/status` and the `/voice` page expose a `recording` state distinct from `listening`, `off` and calibration, with who started it, the elapsed time and a Stop button. Every dashboard surface shows a header pill while any recording runs. The front panel shows "Recording" through `display.client.ts` `showMessage` for the whole duration and returns to the home screen on stop. The box announces start and stop aloud (§2.5). A room with a recording running should never need a dashboard to know it.

## 3. Alternatives rejected

- **Chunking the live Qwen path into a long recording.** It would saturate the sidecar that every voice turn needs, give no timestamps, and build a second ASR path the epic rules out. The batch path already exists and already produces anchors.
- **Starting a recording through an LLM tool.** Rejected per §2.7. The gain (one dispatch path) is not worth a model deciding to record a room, and the audit gain is illusory because the route audits every caller anyway.
- **Speaker identity as the start gate.** Not while WARP-1377 is open, and not as the only gate even after: the mic hears whoever is loudest.
- **Joining Zoom, Teams or Meet calls.** A bot that joins a call is a different product with egress, provider accounts and consent rules of its own. `ref-meeting-provider-hosts` stays a link-parsing reference, never a dial-out. Room and browser capture only.
- **Diarization in v1.** The permissively licensed options (whisperX with a non-pyannote embedding model, NVIDIA NeMo) need their own CPU and licence review; WARP-207 carries it.
- **Keeping audio forever by default.** Transcript and notes are the durable artefact; audio is the risk. Thirty days, owner-settable, matches how the camera footage is treated.

## 4. Consequences

- The "never written to disk" promise becomes a conditional one, stated precisely, and changes in the capture PR itself (§2.3).
- `BrainMemorySource` and `AgentRunOrigin` each gain one additive enum value; `RecordingStatus` and `RecordingSource` are new. Migrations on the feature branches need the usual timestamp re-check before merge.
- The file-indexer's one-at-a-time ASR worker means a two-hour recording stopped at 17:00 may not have notes until the evening on a busy box. The Recordings view and the box's spoken "notes will be ready shortly" must not promise minutes. The `transcribe-now` call is the only priority lever in v1.
- A new module gate, a new settings panel, a new File Store folder convention and a new at-rest section are review surface for the security pass.
- Open dependencies this ADR does not close: WARP-1617 (kill switch on hardware), WARP-1377 (voiceprints at rest), WARP-207 / 209 / 213 (diarization, streaming, sizing).

## 5. Slices

One ticket and one PR each, in dependency order, all under WARP-3320:

| Slice | Ticket | Owner area |
|---|---|---|
| 0. This ADR + roadmap pointer | WARP-3939 | docs |
| 1. Lifecycle, consent setting, routes, RBAC + audit, retention, at-rest section (§2.1, 2.2, 2.6, 2.8) | WARP-3940 | orchestrator |
| 2. Capture tee, phrases + spoken confirmation, kill-switch stop, privacy copy (§2.3, 2.5, 2.7) | WARP-3941 | voice-io, docs |
| 3. WARP-218 hand-off, notes agent run, RecordingCard (§2.4) | WARP-3942 | orchestrator, file-indexer |
| 4. Browser recorder (§2.5) | WARP-3943 | web-dashboard |
| 5. Indicator, Recordings view, settings, front panel (§2.9) | WARP-3944 | web-dashboard, oled-display |
| 6. Ask AI tools and export (§2.7) | WARP-3945 | tools-core |

Later, not filed here: native mobile recording, diarization (WARP-207), a rolling live draft from the 30 s path (WARP-209).
