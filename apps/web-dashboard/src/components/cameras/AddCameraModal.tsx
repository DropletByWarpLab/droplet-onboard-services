"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Plus, Loader2, Radar, Check, Video, KeyRound, Eye, EyeOff } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { addCameraManual, addDiscoveredCameraWithCredentials } from "@/lib/api";
import { normalizeCameraName } from "@/lib/camera-name";
import { exampleStreamUrl, streamPathFor, vendorHintFor } from "@/lib/camera-stream-hints";
import { translateError } from "@/lib/friendly-errors";
import { useRemaskOnLeave } from "@/lib/hooks/useRemaskOnLeave";
import type { DiscoveredCamera } from "@/lib/types";

interface AddCameraModalProps {
  onClose: () => void;
  onAdded: () => void;
  /**
   * WARP-1847 — what a discovery sweep found. "Add camera" used to open
   * straight onto an empty RTSP form, which asked the operator for an address
   * and stream path the appliance already knew. When there are candidates, the
   * list is the first thing they see.
   */
  cameras?: DiscoveredCamera[];
  discoveryOnline?: boolean;
  scanning?: boolean;
  onScan?: () => void;
  onAccept?: (camera: DiscoveredCamera) => Promise<void> | void;
  /**
   * A camera we found but can't stream — its name and address are known, only
   * the credentials (and sometimes the path) are missing. A live record opens
   * the username/password form; anything else opens the manual form prefilled.
   */
  prefill?: DiscoveredCamera | null;
}

type Tab = "discovered" | "manual" | "credentials";

/** What went wrong, and for which view — so it can never be shown on another one. */
interface Problem {
  key: string;
  message: string;
  /** The API's machine code (AUTH_FAILED, LOCKED, …), when it sent one. */
  code?: string;
}

/** A camera that reported a lockout: Add stays off for a while (F10). */
interface Lock {
  id: string;
  until: number;
  message: string;
}

const TITLE_ID = "add-camera-title";
const ERROR_ID = "add-camera-error";

const PROBING_STATUS = "Checking the camera. This can take up to a minute. Keep this window open.";

/**
 * How long Add stays disabled after a camera reports it has locked its account.
 * Hanwha, Axis and some Hikvision firmwares lock after ~5 bad passwords for
 * several minutes; every further attempt is another chance to extend it. This
 * is a throttle, not the vendor's timer, which is why the copy still says to
 * give it a few minutes.
 */
const LOCK_COOLDOWN_MS = 60_000;

/**
 * WARP-3505 — a found camera whose stream needs a sign-in AND that
 * camera-discovery still holds a live record for can be added by typing its
 * username and password: discovery re-probes with them. A database-only row has
 * no probed stream to verify against, so it keeps the manual form.
 */
function acceptsCredentials(camera: DiscoveredCamera | null | undefined): camera is DiscoveredCamera {
  return !!camera && camera.id.startsWith("mac:") && camera.status === "needs_credentials";
}

/**
 * rtsp://host:554/path skeleton for a camera we know the address of.
 *
 * A `rtsp_port_open` URL is the prober's placeholder GUESS (`…/stream1`), not a
 * stream anything answered — wrong for the cameras that most need help (a
 * Hanwha 400s it) — so it is replaced with the manufacturer's known path, or a
 * bare address when we don't have one.
 */
function suggestRtspUrl(camera: DiscoveredCamera): string {
  if (camera.rtspUrl && camera.detectionMethod !== "rtsp_port_open") return camera.rtspUrl;
  if (!camera.ip) return "";
  return `rtsp://${camera.ip}:554${streamPathFor(camera.manufacturer) ?? "/"}`;
}

function cameraLabel(camera: DiscoveredCamera): string {
  return camera.displayName || camera.name.replace(/_/g, " ");
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Failures that are ABOUT the username/password fields, so they are flagged
 * invalid (aria-invalid) — the camera refused them, or the server refused them
 * before touching the camera. Every other failure (unreachable, timeout, no
 * stream path, lockout) is not the fields' fault and does not mark them.
 */
const ACCOUNT_FAULT_CODES: ReadonlySet<string> = new Set([
  "AUTH_FAILED",
  "INVALID_CREDENTIALS",
  "UNSUPPORTED_PASSWORD",
]);
/** Of those, the ones where the next thing to do is retype the password. */
const PASSWORD_FAULT_CODES: ReadonlySet<string> = new Set(["AUTH_FAILED", "UNSUPPORTED_PASSWORD"]);

/** m:ss — the ClaimStep lockout format (WARP-631). */
function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

const INPUT_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
} as const;

const LABEL_CLASS = "type-footnote font-medium block mb-1";
const LABEL_STYLE = { color: "var(--text-muted)" } as const;
const INPUT_CLASS = "w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]";

/** The `*` is decoration: the field says it is required with aria-required. */
function Required() {
  return <span aria-hidden="true"> *</span>;
}

interface PasswordFieldProps {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  shown: boolean;
  onToggle: () => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  describedBy?: string;
  invalid?: boolean;
}

/**
 * Password input with a show/hide toggle — SignInForm's pattern (WARP-3135).
 *
 * autoComplete="new-password", NOT "current-password": this is a CAMERA's
 * password, and the browser would otherwise offer the Droplet admin login for
 * it. Filling that in and pressing Add burns one of the camera's few allowed
 * sign-in attempts. The same reasoning keeps the username field on
 * autoComplete="off" rather than "username".
 */
function PasswordField({
  id,
  label,
  required,
  value,
  onChange,
  shown,
  onToggle,
  inputRef,
  describedBy,
  invalid,
}: PasswordFieldProps) {
  return (
    <div>
      <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor={id}>
        {label}
        {required && <Required />}
      </label>
      <div className="relative">
        {/* WARP-3135: `[&::-ms-reveal]:hidden` turns off Edge's native eye (also
            in WebView2), which would otherwise sit beside the toggle below —
            two eyes on one field. */}
        <input
          id={id}
          ref={inputRef}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          maxLength={256}
          aria-required={required ? true : undefined}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={`${INPUT_CLASS} pr-12 [&::-ms-reveal]:hidden`}
          style={INPUT_STYLE}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-[var(--radius-input)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          style={{ color: "var(--text-muted)" }}
        >
          {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

export function AddCameraModal({
  onClose,
  onAdded,
  cameras = [],
  discoveryOnline = true,
  scanning = false,
  onScan,
  onAccept,
  prefill = null,
}: AddCameraModalProps) {
  const { toast } = useToast();

  // ── What is on screen ────────────────────────────────────────────────────
  // Open on the list when there's something to pick and we weren't sent here to
  // finish a specific camera's setup.
  const [tab, setTab] = useState<Tab>(
    prefill
      ? acceptsCredentials(prefill)
        ? "credentials"
        : "manual"
      : cameras.length > 0
        ? "discovered"
        : "manual",
  );
  // The camera the open form was started from — drives the "we found …" copy and
  // which camera the credentials are submitted for. Null on a blank manual form.
  const [found, setFound] = useState<DiscoveredCamera | null>(prefill);

  const [name, setName] = useState(normalizeCameraName(prefill?.name ?? ""));
  const [rtspUrl, setRtspUrl] = useState(prefill ? suggestRtspUrl(prefill) : "");
  const [manufacturer, setManufacturer] = useState(prefill?.manufacturer ?? "");
  const [model, setModel] = useState(prefill?.model ?? "");

  // WARP-3505: the camera's own account — required on the credentials form,
  // optional on the manual one. Kept apart from the URL so the server merges and
  // encodes it: the password is never part of an address anyone sees.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // True only right after "Enter the stream address instead" carried what was
  // typed over — the one place credentials are allowed to follow the operator.
  const [carriedAccount, setCarriedAccount] = useState(false);
  // WARP-3135: a revealed password masks again when the window loses focus.
  useRemaskOnLeave(setShowPassword);

  // ── What is in flight, and what went wrong ───────────────────────────────
  // Both are KEYED by the view they belong to (F3): a submit for camera A is
  // never read as "Checking…" or an error on camera B, and nothing it does when
  // it finishes can reach a form that was not the one it was started from.
  const [inflightKey, setInflightKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lock, setLock] = useState<Lock | null>(null);
  const [lockNote, setLockNote] = useState("");
  const [, setLockTick] = useState(0);

  const mounted = useRef(true);
  /** Bumped by every submit and every view change; a completion whose token is stale is ignored. */
  const submitSeq = useRef(0);
  const primaryFieldRef = useRef<HTMLElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const problemRef = useRef<HTMLDivElement | null>(null);
  const listChipRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** Where focus goes once a failed submit re-enables the form. */
  const failureFocus = useRef<"password" | "problem" | null>(null);

  const viewKey = tab === "discovered" ? "list" : `${tab}:${found?.id ?? "blank"}`;
  const shownProblem = problem && problem.key === viewKey ? problem : null;
  const loading = inflightKey === viewKey;
  const navLocked = inflightKey !== null;
  const lockedHere =
    tab === "credentials" && !!found && !!lock && lock.id === found.id && Date.now() < lock.until;
  const lockLeft = lockedHere && lock ? Math.max(1, Math.ceil((lock.until - Date.now()) / 1000)) : 0;
  const onList = tab === "discovered" || tab === "credentials";

  const setPrimaryRef = useCallback((el: HTMLInputElement | null) => {
    primaryFieldRef.current = el;
  }, []);
  const setPasswordRef = useCallback((el: HTMLInputElement | null) => {
    passwordRef.current = el;
  }, []);

  const isCurrent = (token: number) => mounted.current && submitSeq.current === token;

  // ── Moving between views ─────────────────────────────────────────────────
  /** Forget any submit still in flight: its completion is now stale. */
  function invalidate() {
    submitSeq.current += 1;
    setInflightKey(null);
    setBusyId(null);
  }

  function clearAccount() {
    setUsername("");
    setPassword("");
    setShowPassword(false);
    setCarriedAccount(false);
  }

  function showList() {
    invalidate();
    setProblem(null);
    clearAccount();
    setTab("discovered");
  }

  function openCredentialsFor(cam: DiscoveredCamera) {
    invalidate();
    setProblem(null);
    clearAccount();
    setFound(cam);
    setTab("credentials");
  }

  /**
   * The manual form for a camera we found. Credentials are cleared by default;
   * only the credentials form's own "Enter the stream address instead" carries
   * them over (NO_STREAM_PATH recovery — the operator already typed them), and
   * the form says so.
   */
  function openManualFor(cam: DiscoveredCamera, carryAccount = false) {
    invalidate();
    setProblem(null);
    if (!carryAccount) clearAccount();
    setCarriedAccount(carryAccount && (!!username || !!password));
    setFound(cam);
    setName(normalizeCameraName(cam.name));
    setRtspUrl(suggestRtspUrl(cam));
    setManufacturer(cam.manufacturer ?? "");
    setModel(cam.model ?? "");
    setTab("manual");
  }

  /** "Enter details": a form for a camera we know nothing about — nothing carried in. */
  function openBlankManual() {
    invalidate();
    setProblem(null);
    clearAccount();
    setFound(null);
    setName("");
    setRtspUrl("");
    setManufacturer("");
    setModel("");
    setTab("manual");
  }

  // The modal stays mounted while the caller switches which camera is being set
  // up, so follow a CHANGED prefill (not the initial one — the initial state
  // already reflects it).
  const lastPrefill = useRef(prefill);
  useEffect(() => {
    if (!prefill || prefill === lastPrefill.current) return;
    lastPrefill.current = prefill;
    if (acceptsCredentials(prefill)) openCredentialsFor(prefill);
    else openManualFor(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // ── Focus ────────────────────────────────────────────────────────────────
  // On mount remember what opened the dialog and hand focus back when it goes:
  // the parent unmounts this component to close it, so the Dialog primitive's
  // own restore-on-close (which keys off `open` toggling) never runs.
  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      mounted.current = false;
      if (opener && opener !== document.body && document.contains(opener)) opener.focus?.();
    };
  }, []);

  // A switch of view must not strand focus on a control that has just left the
  // page: a form opens with focus on its first field (Username on the
  // credentials form), the list keeps it where it is unless that control went.
  const lastView = useRef(viewKey);
  useEffect(() => {
    if (lastView.current === viewKey) return;
    lastView.current = viewKey;
    const target = primaryFieldRef.current;
    if (target) {
      target.focus();
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !contentRef.current?.contains(active)) {
      listChipRef.current?.focus();
    }
  }, [viewKey]);

  // After a failed submit the form is enabled again; put focus where the
  // operator acts next — the password when that is what was wrong, otherwise the
  // message that says what happened.
  useEffect(() => {
    if (!shownProblem || inflightKey !== null) return;
    const want = failureFocus.current;
    if (!want) return;
    failureFocus.current = null;
    if (want === "password") {
      passwordRef.current?.focus();
      passwordRef.current?.select();
    } else {
      problemRef.current?.focus();
    }
  }, [shownProblem, inflightKey]);

  // A disabled fieldset cannot hold keyboard focus. Keep the operator on the
  // enabled Close button while the camera is being checked.
  useEffect(() => {
    if (navLocked) closeRef.current?.focus();
  }, [navLocked]);

  // ── Lockout cooldown ─────────────────────────────────────────────────────
  // Timestamp-based, not decrement-per-tick: a throttled background tab must not
  // stretch the minute.
  useEffect(() => {
    if (!lock) return;
    const timer = setInterval(() => {
      if (Date.now() >= lock.until) {
        setLock(null);
        setLockNote("");
        setProblem((p) => (p && p.code === "LOCKED" ? null : p));
      } else {
        setLockTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lock]);

  function startLock(id: string, message: string) {
    setLock({ id, until: Date.now() + LOCK_COOLDOWN_MS, message });
    // One-shot announcement, written once per lockout: the visible countdown
    // ticks every second and must not be a live region (ClaimStep, WARP-631).
    setLockNote(`Camera locked. Add camera is switched off for about ${LOCK_COOLDOWN_MS / 1000} seconds.`);
  }

  // ── Validation ───────────────────────────────────────────────────────────
  const nameValid = /^[a-z0-9_]{1,64}$/.test(name);
  const urlValid = /^rtsps?:\/\/.+/.test(rtspUrl);
  // A password only makes sense with a username; the server refuses one without.
  const manualAccountValid = !password || !!username.trim();
  const canSubmit = nameValid && urlValid && manualAccountValid && !loading;
  const canSubmitCredentials = !!username.trim() && !!password && !loading && !lockedHere;

  // ── Submits ──────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const key = viewKey;
    const token = ++submitSeq.current;
    setInflightKey(key);
    setProblem(null);
    setShowPassword(false); // WARP-3135: every attempt re-masks
    try {
      await addCameraManual(
        name,
        rtspUrl,
        manufacturer || undefined,
        model || undefined,
        username.trim() || undefined,
        password || undefined,
      );
    } catch (err) {
      if (!isCurrent(token)) return;
      const code = codeOf(err);
      failureFocus.current = code && PASSWORD_FAULT_CODES.has(code) ? "password" : "problem";
      setInflightKey(null);
      setProblem({ key, message: translateError(err, "camera"), code });
      return;
    }
    onAdded();
    if (isCurrent(token)) {
      setInflightKey(null);
      onClose();
    }
  }

  async function handleCredentialsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!found || !canSubmitCredentials) return;

    const target = found;
    const key = viewKey;
    const token = ++submitSeq.current;
    setInflightKey(key);
    setProblem(null);
    setShowPassword(false); // WARP-3135: every attempt re-masks
    try {
      await addDiscoveredCameraWithCredentials(target.id, username.trim(), password);
    } catch (err) {
      // The view moved on while this was being checked: nothing to show here.
      if (!isCurrent(token)) return;
      const code = codeOf(err);
      // translateError maps the API's AUTH_FAILED / LOCKED / NO_STREAM_PATH /
      // UNREACHABLE codes to their own copy. The fields are kept so a typo can be
      // corrected without retyping everything.
      const message = translateError(err, "camera");
      failureFocus.current = code && PASSWORD_FAULT_CODES.has(code) ? "password" : "problem";
      setInflightKey(null);
      setProblem({ key, message, code });
      if (code === "LOCKED") startLock(target.id, message);
      return;
    }
    // The camera IS in Frigate now, whichever view the operator is on — so the
    // list refreshes and they are told; only the window itself is theirs to keep.
    toast(`Added ${cameraLabel(target)}.`, "success");
    onAdded();
    if (isCurrent(token)) {
      setInflightKey(null);
      onClose();
    }
  }

  async function handleAccept(camera: DiscoveredCamera) {
    if (!onAccept) return;
    const token = ++submitSeq.current;
    setInflightKey("list");
    setBusyId(camera.id);
    setProblem(null);
    try {
      await onAccept(camera);
    } catch (err) {
      if (!isCurrent(token)) return;
      setInflightKey(null);
      setBusyId(null);
      setProblem({ key: "list", message: translateError(err, "camera"), code: codeOf(err) });
      return;
    }
    if (isCurrent(token)) {
      setInflightKey(null);
      setBusyId(null);
      onClose();
    }
  }

  // ── Copy ─────────────────────────────────────────────────────────────────
  const vendor = vendorHintFor(manufacturer);
  // Example for the hint + placeholder: the manufacturer's real path, never a
  // guessed /stream1 (WARP-3505).
  const example = exampleStreamUrl(manufacturer, found?.ip);

  const describedBy = shownProblem || lockedHere ? ERROR_ID : undefined;
  const accountInvalid = !!shownProblem?.code && ACCOUNT_FAULT_CODES.has(shownProblem.code);

  /**
   * The failure message. role="alert" announces it once as it appears — except
   * during a lockout, where the one-shot polite region does that and a second
   * announcement would only repeat it.
   */
  const problemBlock = (
    <>
      {lockedHere && lock ? (
        <div
          id={ERROR_ID}
          ref={problemRef}
          tabIndex={-1}
          className="type-footnote rounded-lg px-3 py-2"
          style={{ color: "var(--danger-ink)", background: "rgba(239,68,68,0.1)" }}
        >
          {lock.message}
          <span className="tabular-nums block mt-1">You can check again in {formatCountdown(lockLeft)}. The camera may stay locked longer.</span>
        </div>
      ) : (
        shownProblem && (
          <div
            id={ERROR_ID}
            ref={problemRef}
            tabIndex={-1}
            role="alert"
            className="type-footnote rounded-lg px-3 py-2"
            style={{ color: "var(--danger-ink)", background: "rgba(239,68,68,0.1)" }}
          >
            {shownProblem.message}
          </div>
        )
      )}
    </>
  );

  return (
    // `flush`: sectioned layout — the full-width header divider + the panes own
    // their padding. The Dialog primitive (WARP-289) supplies role="dialog",
    // aria-modal, Escape, the Tab trap, scroll lock and the portal.
    <Dialog
      open
      onClose={onClose}
      labelledBy={TITLE_ID}
      maxWidth="md"
      flush
      initialFocusRef={primaryFieldRef}
      // A stray click on the backdrop must not abandon a check that may be about
      // to add the camera. Escape and the Close button stay deliberate exits.
      closeOnBackdrop={!navLocked}
    >
      <div ref={contentRef}>
        {/* Header */}
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <h2 id={TITLE_ID} className="type-title-3" style={{ color: "var(--text)" }}>
            Add camera
          </h2>
          <button ref={closeRef} onClick={onClose} className="icon-btn" aria-label="Close" type="button">
            <X size={20} />
          </button>
        </div>

        {/* Tabs — only worth showing when picking from the network is an option.
            Locked while anything is being checked (F3). */}
        {cameras.length > 0 && (
          <div className="chiprow px-4 pt-3">
            <button
              type="button"
              ref={listChipRef}
              disabled={navLocked}
              onClick={() => {
                if (tab !== "discovered") showList();
              }}
              className={"chip disabled:opacity-50 disabled:cursor-not-allowed" + (onList ? " on" : "")}
              aria-current={onList ? "true" : undefined}
            >
              <Radar size={14} />
              <span>On your network ({cameras.length})</span>
            </button>
            <button
              type="button"
              disabled={navLocked}
              onClick={() => {
                if (tab !== "manual") openBlankManual();
              }}
              className={"chip disabled:opacity-50 disabled:cursor-not-allowed" + (tab === "manual" ? " on" : "")}
              aria-current={tab === "manual" ? "true" : undefined}
            >
              <Plus size={14} />
              <span>Enter details</span>
            </button>
          </div>
        )}

        {tab === "discovered" ? (
          <div className="p-4 space-y-2">
            <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              Cameras we can see on your network. Pick one to add it.
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="space-y-2">
              {cameras.map((cam) => {
                const ready = (cam.status ?? "unverified") === "ready";
                const busy = busyId === cam.id;
                return (
                  <li
                    key={cam.id}
                    className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Video size={15} style={{ color: "var(--brand)", flexShrink: 0 }} />
                      <div className="min-w-0">
                        <p className="type-footnote font-medium truncate" style={{ color: "var(--text)" }}>
                          {cameraLabel(cam)}
                        </p>
                        <p className="type-caption-2 truncate" style={{ color: "var(--text-muted)" }}>
                          {[cam.ip, cam.manufacturer].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    </div>
                    {ready ? (
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={busy || navLocked || !onAccept}
                        onClick={() => handleAccept(cam)}
                      >
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Add
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={navLocked}
                        onClick={() => (acceptsCredentials(cam) ? openCredentialsFor(cam) : openManualFor(cam))}
                      >
                        Set up
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {problemBlock}
          </div>
        ) : tab === "credentials" && found ? (
          <form onSubmit={handleCredentialsSubmit} aria-busy={loading} className="p-4">
            {/* F7: the whole form is inert while the camera is being checked — a
                half-edited password must not be sent, and a second submit must not
                be a second failed sign-in. */}
            <fieldset disabled={loading} className="space-y-4 min-w-0">
              <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                We found <strong style={{ color: "var(--text)" }}>{cameraLabel(found)}</strong> at{" "}
                <strong style={{ color: "var(--text)" }}>{found.ip}</strong>
                {found.manufacturer ? ` (${found.manufacturer})` : ""} but it needs a sign-in before we
                can watch it. Enter the username and password you set on the camera — we'll use them to
                find its video.
              </p>

              <div>
                <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="camera-cred-username">
                  Username
                  <Required />
                </label>
                {/* autoComplete="off", not "username": this is a CAMERA's account.
                    "username"/"current-password" would let the browser offer the
                    Droplet admin login here, and one wrong guess can lock the
                    camera (see PasswordField). */}
                <input
                  id="camera-cred-username"
                  ref={setPrimaryRef}
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={128}
                  aria-required="true"
                  aria-invalid={accountInvalid ? true : undefined}
                  aria-describedby={describedBy}
                  className={INPUT_CLASS}
                  style={INPUT_STYLE}
                />
              </div>

              <PasswordField
                id="camera-cred-password"
                label="Password"
                required
                value={password}
                onChange={setPassword}
                shown={showPassword}
                onToggle={() => setShowPassword((s) => !s)}
                inputRef={setPasswordRef}
                describedBy={describedBy}
                invalid={accountInvalid}
              />

              {problemBlock}

              {/* Visible while a check runs. Always mounted so the text is
                  announced when it appears. */}
              <p
                role="status"
                className={loading ? "type-caption-1" : "sr-only"}
                style={loading ? { color: "var(--text-muted)" } : undefined}
              >
                {loading ? PROBING_STATUS : null}
              </p>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => (cameras.length > 0 ? showList() : onClose())}
                  className="btn ghost flex-1 type-subheadline"
                >
                  {cameras.length > 0 ? "Back" : "Cancel"}
                </button>
                <button
                  type="submit"
                  disabled={!canSubmitCredentials}
                  className="btn primary flex-1 type-subheadline disabled:opacity-50"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                  {loading ? "Checking…" : "Add camera"}
                </button>
              </div>

              <button
                type="button"
                className="type-footnote underline inline-flex items-center min-h-[36px] rounded-[var(--radius-input)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                style={{ color: "var(--text-muted)" }}
                onClick={() => openManualFor(found, true)}
              >
                Enter the stream address instead
              </button>
            </fieldset>
            {/* One-shot lockout announcement (ClaimStep, WARP-631): written once when
                the lockout starts, cleared when it ends. Outside the fieldset so it
                is never inert. */}
            <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="camera-lockout-announcement">
              {lockNote}
            </span>
          </form>
        ) : (
          <form onSubmit={handleSubmit} aria-busy={loading} className="p-4">
            <fieldset disabled={loading} className="space-y-4 min-w-0">
              {cameras.length === 0 && onScan && (
                // No candidates: offer the sweep here too, so the operator isn't
                // forced to guess an RTSP URL just because they opened this modal.
                <div
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                  style={{ background: "var(--brand-subtle)" }}
                >
                  <span className="type-caption-1" style={{ color: "var(--text)" }}>
                    {discoveryOnline
                      ? "Don't know the details? Look for cameras on your network."
                      : "Camera discovery isn't running, so we can't look for cameras automatically."}
                  </span>
                  {discoveryOnline && (
                    <button type="button" className="btn sm" onClick={onScan} disabled={scanning}>
                      {scanning ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
                      Scan
                    </button>
                  )}
                </div>
              )}

              {found && (
                <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  We found <strong style={{ color: "var(--text)" }}>{found.ip}</strong> but couldn't open
                  its video.{" "}
                  {vendor && (
                    <>
                      {vendor.label} cameras usually use{" "}
                      <code style={{ fontFamily: "var(--font-mono)" }}>{example}</code>.{" "}
                    </>
                  )}
                  Your camera's manual has the exact stream address.
                </p>
              )}

              {/* Camera name — the Frigate key, normalised as it is typed */}
              <div>
                <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="camera-name">
                  Camera name
                  <Required />
                </label>
                <input
                  id="camera-name"
                  ref={setPrimaryRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(normalizeCameraName(e.target.value))}
                  placeholder="front_door"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-required="true"
                  className={INPUT_CLASS}
                  style={INPUT_STYLE}
                  maxLength={64}
                />
                <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }}>
                  Lowercase letters, numbers and underscores
                </p>
              </div>

              {/* RTSP URL */}
              <div>
                <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="camera-rtsp">
                  Stream address (RTSP)
                  <Required />
                </label>
                <input
                  id="camera-rtsp"
                  type="text"
                  value={rtspUrl}
                  onChange={(e) => setRtspUrl(e.target.value)}
                  placeholder={example}
                  aria-required="true"
                  className={`${INPUT_CLASS} font-mono text-sm`}
                  style={INPUT_STYLE}
                />
                {rtspUrl && !urlValid && (
                  <p className="type-caption-2 mt-1" style={{ color: "var(--danger-ink)" }}>
                    Must start with rtsp:// or rtsps://
                  </p>
                )}
              </div>

              {/* Camera account (optional) — merged into the address server-side */}
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="camera-username">
                      Username
                    </label>
                    <input
                      id="camera-username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={128}
                      aria-invalid={accountInvalid ? true : undefined}
                      aria-describedby={describedBy}
                      className={INPUT_CLASS}
                      style={INPUT_STYLE}
                    />
                  </div>
                  <PasswordField
                    id="camera-password"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    shown={showPassword}
                    onToggle={() => setShowPassword((s) => !s)}
                    inputRef={setPasswordRef}
                    describedBy={describedBy}
                    invalid={accountInvalid}
                  />
                </div>
                <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  Optional. Only needed if the camera asks for a sign-in and the address above doesn't
                  already include one.
                </p>
                {carriedAccount && (
                  <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                    We kept the username and password you just entered. Change them here if they're
                    wrong.
                  </p>
                )}
                {password && !username.trim() && (
                  <p className="type-caption-1" style={{ color: "var(--danger-ink)" }}>
                    Enter the username that goes with this password
                  </p>
                )}
              </div>

              {/* Optional fields */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="camera-manufacturer">
                    Manufacturer
                  </label>
                  <input
                    id="camera-manufacturer"
                    type="text"
                    value={manufacturer}
                    onChange={(e) => setManufacturer(e.target.value)}
                    placeholder="Reolink"
                    className={INPUT_CLASS}
                    style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="camera-model">
                    Model
                  </label>
                  <input
                    id="camera-model"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="RLC-810A"
                    className={INPUT_CLASS}
                    style={INPUT_STYLE}
                  />
                </div>
              </div>

              {/* Error */}
              {problemBlock}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={onClose} className="btn ghost flex-1 type-subheadline">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="btn primary flex-1 type-subheadline disabled:opacity-50"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  Add camera
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </Dialog>
  );
}
