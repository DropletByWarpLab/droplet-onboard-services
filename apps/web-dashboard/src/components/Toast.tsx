"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { X, AlertCircle, CheckCircle2, Info } from "lucide-react";

type ToastType = "error" | "success" | "info";

/**
 * WARP-1912 — one optional action per toast (the post-upload Undo). Firing
 * the action dismisses its toast, so it can only run once; "available while
 * the toast lives" is the whole contract — there is no background registry
 * to re-offer it from.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

// Auto-dismiss timeout for non-error toasts. Error toasts intentionally
// persist until the user dismisses them — see WCAG 2.2.1 "Timing
// Adjustable" and WARP-297.
const AUTO_DISMISS_MS = 5_000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts([]);
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "error", action?: ToastAction) => {
      const id = ++nextId;
      // WARP-1306 — don't stack an identical twin. Error toasts persist until
      // dismissed (WCAG 2.2.1), so a repeated failure (e.g. re-submitting the
      // Projects New-project dialog against a disabled module) used to pile up
      // duplicates of the same message. An identical (message, type) already on
      // screen means the user is already told; adding a copy is pure noise.
      //
      // WARP-1912 — but when an action is in play (either side), REPLACE the
      // twin instead of dropping the new call. Dropping kept the OLD toast's
      // Undo bound to the OLD batch's paths, so two same-count uploads inside
      // one toast lifetime made Undo delete the wrong files. The fresh id
      // remounts ToastItem (keyed by id), restarting the 5s timer and
      // rebinding Undo to the newest batch; the older batch merely loses its
      // courtesy affordance, which is safe.
      setToasts((prev) => {
        const twin = prev.find(
          (t) => t.message === message && t.type === type,
        );
        if (!twin) return [...prev, { id, message, type, action }];
        // WARP-1306 posture unchanged for plain toasts.
        if (!action && !twin.action) return prev;
        return prev.map((t) =>
          t === twin ? { id, message, type, action } : t,
        );
      });
    },
    [],
  );

  const icons = {
    error: <AlertCircle size={16} />,
    success: <CheckCircle2 size={16} />,
    info: <Info size={16} />,
  };

  const colors = {
    error: "bg-system-red/10 border-system-red/25 text-system-red",
    success: "bg-system-green/10 border-system-green/25 text-system-green",
    info: "bg-accent-subtle border-accent/25 text-accent",
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast region — landmark for screen readers + aria-live polite so
          additions are announced. role="alert" is set per-toast for errors
          to upgrade them to assertive.

          Mobile: clear the 56px bottom tab bar (+ safe-area) the way
          HelpLauncher does, so a toast never covers navigation or lands in
          the home-indicator strip. Inset left as well — `max-w-sm` (384px)
          is wider than a 375px viewport, so a right-anchored toast used to
          overflow the screen edge and clip its own text. */}
      <div
        role="region"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Notifications"
        className="fixed inset-x-4 bottom-[calc(72px+env(safe-area-inset-bottom))] z-[100] flex flex-col gap-2 sm:left-auto sm:right-6 sm:max-w-sm lg:bottom-6"
      >
        {toasts.length >= 3 && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={dismissAll}
              className="type-footnote px-2.5 py-1 rounded-md border border-separator
                bg-surface-secondary/80 backdrop-blur-xl text-label-secondary
                hover:text-label-primary transition-colors"
            >
              Dismiss all
            </button>
          </div>
        )}
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            icon={icons[t.type]}
            colorClass={colors[t.type]}
            onDismiss={() => dismiss(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

interface ToastItemProps {
  toast: Toast;
  icon: React.ReactNode;
  colorClass: string;
  onDismiss: () => void;
}

function ToastItem({ toast, icon, colorClass, onDismiss }: ToastItemProps) {
  // Error toasts never auto-dismiss (WCAG 2.2.1). Other variants run a 5s
  // timer that pauses while the user is hovering or focused on the toast.
  // On mouseleave/blur we restart from a fresh 5s rather than resume —
  // simpler and more forgiving than tracking elapsed time.
  const isPersistent = toast.type === "error";
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = () => {
    if (isPersistent) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onDismissRef.current();
    }, AUTO_DISMISS_MS);
  };

  useEffect(() => {
    startTimer();
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPersistent]);

  const handlePause = () => {
    if (isPersistent) return;
    pausedRef.current = true;
    clearTimer();
  };

  const handleResume = () => {
    if (isPersistent) return;
    if (!pausedRef.current) return;
    pausedRef.current = false;
    startTimer();
  };

  const dismissLabel = `Dismiss ${toast.message || "notification"}`;

  return (
    <div
      data-toast
      role={toast.type === "error" ? "alert" : undefined}
      tabIndex={0}
      onMouseEnter={handlePause}
      onMouseLeave={handleResume}
      onFocus={handlePause}
      onBlur={handleResume}
      className={`flex items-start gap-2.5 px-4 py-3 rounded-lg border shadow-lg
        backdrop-blur-xl type-footnote animate-slide-up ${colorClass}`}
    >
      <span className="flex-shrink-0 mt-0.5">{icon}</span>
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            // Dismissing alongside the click is what makes the action
            // single-fire — there is no second Undo to double-delete with.
            toast.action?.onClick();
            onDismiss();
          }}
          // Text button in the toast's own color: quieter than a filled
          // button (this is a courtesy affordance, not the primary path),
          // louder than the dismiss X. Padding grows the hit area without
          // moving the visual baseline.
          className="flex-shrink-0 font-semibold underline underline-offset-2
            px-1.5 py-1 -my-1 opacity-90 hover:opacity-100 transition-opacity"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
