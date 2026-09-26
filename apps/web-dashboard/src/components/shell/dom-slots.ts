"use client";
/**
 * WARP-3043 — DOM slots: a page offers an element, and a component mounted
 * elsewhere portals into it.
 *
 * HelpLauncher is mounted once, by AuthGate, beside the routed page. On /chat
 * and the Workshop its floating button would sit over the docked composer's
 * send button, so those pages offer a slot in their header instead and the
 * launcher portals its trigger there. The launcher needs no route logic: a
 * page that offers the slot gets the header trigger, every other page keeps
 * the floating one.
 *
 * `useRegister()` returns a stable callback ref: it takes the slot on mount
 * and gives it back on unmount only if it still owns it (a page mounting
 * over another must not be cleared by the old one leaving). `useTarget()`
 * reads the current element through `useSyncExternalStore`.
 */
import { useCallback, useRef, useSyncExternalStore } from "react";

export interface DomSlot {
  /** A callback ref for the element that is the slot. */
  useRegister(): (el: HTMLElement | null) => void;
  /** The registered element, or null. */
  useTarget(): HTMLElement | null;
}

export function createDomSlot(): DomSlot {
  let target: HTMLElement | null = null;
  const listeners = new Set<() => void>();

  const set = (next: HTMLElement | null) => {
    if (target === next) return;
    target = next;
    listeners.forEach((l) => l());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const snapshot = () => target;
  const serverSnapshot = () => null;

  return {
    useRegister() {
      const owned = useRef<HTMLElement | null>(null);
      return useCallback((el: HTMLElement | null) => {
        if (el) {
          owned.current = el;
          set(el);
          return;
        }
        if (owned.current && target === owned.current) set(null);
        owned.current = null;
      }, []);
    },
    useTarget() {
      return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
    },
  };
}

/** The page header's Help slot (/chat, the Workshop). */
export const helpSlot = createDomSlot();
