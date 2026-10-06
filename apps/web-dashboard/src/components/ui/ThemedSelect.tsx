"use client";

import {
  forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import "./themed-select.css";

type Choice = { value: string; label: string; disabled: boolean; group: string | null; title: string };
type Popup = { choices: Choice[]; active: number; value: string; label: string; host: Element; style: CSSProperties };
const GAP = 8;

/**
 * A themed popup with a real select as its label and form control.
 * Keeping the DOM options also supports composite option/optgroup components,
 * native validity, refs, and the callers' existing change-event contracts.
 * The popup enters the browser's top layer to escape scrolling cards and
 * transformed dialogs, while remaining a descendant of its modal for AT.
 */
export const ThemedSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function ThemedSelect({ children, className, onPointerDown, onMouseDown, onClick, onKeyDown, onBlur, ...props }, forwardedRef) {
    const selectRef = useRef<HTMLSelectElement | null>(null);
    const popupRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef({ text: "", time: 0 });
    const [popup, setPopup] = useState<Popup | null>(null);
    const popupId = useId();
    const custom = !props.multiple && !(props.size && props.size > 1);
    const close = useCallback(() => {
      // A dismissal must not leave focus on a removed listbox. Outside
      // clicks that already moved focus keep their destination.
      if (popupRef.current?.contains(document.activeElement)) selectRef.current?.focus();
      setPopup(null);
    }, []);
    const ref = useCallback((element: HTMLSelectElement | null) => {
      selectRef.current = element;
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    }, [forwardedRef]);

    function open(key?: string) {
      const select = selectRef.current;
      if (!select || select.matches(":disabled") || !custom) return;
      const choices = Array.from(select.options).filter((option) => !option.hidden && !option.closest("optgroup")?.hidden).map((option) => {
        const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
        return {
          value: option.value, label: option.label || "Choose…", title: option.title,
          disabled: option.disabled || Boolean(group?.disabled), group: group?.label ?? null,
        };
      });
      if (!choices.length) return;
      const label = Array.from(select.labels ?? []).map((source) => {
        // A wrapping label's textContent includes every native option label.
        const copy = source.cloneNode(true) as HTMLLabelElement;
        copy.querySelectorAll("select").forEach((control) => control.remove());
        return copy.textContent?.trim();
      }).filter(Boolean).join(" ");
      select.focus();
      searchRef.current = { text: "", time: 0 };
      const computed = getComputedStyle(select);
      const token = (scoped: string, fallback: string) => computed.getPropertyValue(scoped).trim() || computed.getPropertyValue(fallback).trim();
      let active = Math.max(0, choices.findIndex((choice) => choice.value === select.value));
      if (key === "Home") active = Math.max(0, choices.findIndex((choice) => !choice.disabled));
      else if (key === "End") active = choices.findLastIndex((choice) => !choice.disabled);
      else if (key && key.length === 1 && key !== " ") {
        const match = choices.findIndex((choice) => !choice.disabled && choice.label.toLocaleLowerCase().startsWith(key.toLocaleLowerCase()));
        if (match !== -1) active = match;
        searchRef.current = { text: key.toLocaleLowerCase(), time: Date.now() };
      }
      setPopup({
        choices,
        active: Math.max(0, active),
        value: select.value,
        label: label || "Options",
        host: select.closest('[role="dialog"]') ?? document.body,
        style: {
          "--select-surface": token("--surface", "--color-surface-elevated"),
          "--select-hover": token("--surface-2", "--color-surface-secondary"),
          "--select-text": token("--text", "--color-label-primary"),
          "--select-muted": token("--text-muted", "--color-label-secondary"),
          "--select-brand": token("--brand", "--aurora-ink"),
        } as CSSProperties,
      });
    }

    function choose(index: number) {
      const select = selectRef.current;
      const choice = popup?.choices[index];
      if (!select || select.matches(":disabled") || !choice || choice.disabled) return;
      if (choice.value !== select.value) {
        // Dispatch the native event so React supplies a genuine ChangeEvent,
        // including target/currentTarget, instead of fabricating an event.
        select.value = choice.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      close();
      select.focus();
    }

    function move(direction: number | "first" | "last") {
      if (!popup) return;
      const enabled = popup.choices.map((choice, index) => choice.disabled ? -1 : index).filter((index) => index >= 0);
      if (!enabled.length) return;
      const current = enabled.indexOf(popup.active);
      const next = direction === "first" ? enabled[0] : direction === "last" ? enabled[enabled.length - 1]
        : current === -1 ? (direction === 1 ? enabled[0] : enabled[enabled.length - 1])
        : enabled[(current + direction + enabled.length) % enabled.length];
      setPopup({ ...popup, active: next });
    }

    function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (!custom || event.defaultPrevented || props.disabled) return;
      if (event.key === "Tab") { close(); return; }
      if (event.key === "Escape" && popup) {
        event.preventDefault(); event.stopPropagation(); close(); return;
      }
      if (event.altKey && event.key === "ArrowUp" && popup) {
        event.preventDefault(); close(); return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        if (!popup) open(event.key);
        else if (event.key === "Enter" || event.key === " ") choose(popup.active);
        else move(event.key === "Home" ? "first" : event.key === "End" ? "last" : event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!popup) { open(event.key); return; }
        const now = Date.now();
        const text = (now - searchRef.current.time < 700 ? searchRef.current.text : "") + event.key.toLocaleLowerCase();
        searchRef.current = { text, time: now };
        const needle = [...text].every((character) => character === text[0]) ? text[0] : text;
        const start = needle.length === 1 ? popup.active + 1 : popup.active;
        for (let offset = 0; offset < popup.choices.length; offset++) {
          const index = (start + offset) % popup.choices.length;
          const choice = popup.choices[index];
          if (!choice.disabled && choice.label.toLocaleLowerCase().startsWith(needle)) {
            setPopup({ ...popup, active: index }); break;
          }
        }
      }
    }

    useEffect(() => {
      if (props.disabled) close();
    }, [props.disabled, close]);

    // Async option lists, a parent reset, or a disabled fieldset must never
    // leave a stale popup offering a choice the current form cannot accept.
    useLayoutEffect(() => {
      const select = selectRef.current;
      if (!popup || !select) return;
      const options = Array.from(select.options).filter((option) => !option.hidden && !option.closest("optgroup")?.hidden);
      if (select.matches(":disabled") || select.value !== popup.value || options.length !== popup.choices.length ||
        options.some((option, index) => {
          const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
          const choice = popup.choices[index];
          return option.value !== choice.value || (option.label || "Choose…") !== choice.label ||
            (option.disabled || Boolean(group?.disabled)) !== choice.disabled || (group?.label ?? null) !== choice.group;
        })) close();
    });

    useEffect(() => {
      if (!popup) return;
      const outside = (event: Event) => {
        if (!popupRef.current?.contains(event.target as Node) && event.target !== selectRef.current) close();
      };
      const scroll = (event: Event) => {
        if (!popupRef.current?.contains(event.target as Node)) close();
      };
      document.addEventListener("pointerdown", outside);
      document.addEventListener("mousedown", outside);
      window.addEventListener("scroll", scroll, true);
      window.addEventListener("resize", close);
      return () => {
        document.removeEventListener("pointerdown", outside);
        document.removeEventListener("mousedown", outside);
        window.removeEventListener("scroll", scroll, true);
        window.removeEventListener("resize", close);
      };
    }, [Boolean(popup), close]); // The listeners only need the live refs.

    useLayoutEffect(() => {
      const menu = popupRef.current;
      const select = selectRef.current;
      if (!popup || !menu || !select) return;
      // Browsers with Popover support paint above overflow/transform ancestors.
      // The fixed-position fallback compensates for the modal's transformed origin.
      if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) menu.showPopover();
      menu.style.top = "0px";
      menu.style.left = "0px";
      const trigger = select.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(180, trigger.width), 420, window.innerWidth - GAP * 2)}px`;
      const above = Math.max(0, trigger.top - GAP * 2);
      const below = Math.max(0, window.innerHeight - trigger.bottom - GAP * 2);
      const space = Math.max(above, below);
      menu.style.maxHeight = `${Math.min(360, space)}px`;
      const origin = menu.getBoundingClientRect();
      const top = below >= origin.height || below >= above ? trigger.bottom + GAP : trigger.top - GAP - origin.height;
      const left = Math.max(GAP, Math.min(trigger.left, window.innerWidth - GAP - origin.width));
      menu.style.top = `${Math.max(GAP, top) - origin.top}px`;
      menu.style.left = `${left - origin.left}px`;
    }, [Boolean(popup)]);

    useLayoutEffect(() => {
      if (!popup) return;
      // Native select accessibility ignores a custom active descendant.
      // Put actual focus on the highlighted option while the list is open.
      const option = document.getElementById(`${popupId}-${popup.active}`);
      option?.focus({ preventScroll: true });
      option?.scrollIntoView?.({ block: "nearest" });
    }, [popup?.active, popupId]);

    const groups = popup?.choices.reduce<{ label: string | null; items: { choice: Choice; index: number }[] }[]>((result, choice, index) => {
      let group = result[result.length - 1];
      if (!group || group.label !== choice.group) {
        group = { label: choice.group, items: [] };
        result.push(group);
      }
      group.items.push({ choice, index });
      return result;
    }, []);

    return <>
      <select
        {...props}
        ref={ref}
        className={`${custom ? "themed-select " : ""}${className ?? ""}`.trim()}
        aria-haspopup={custom ? "listbox" : props["aria-haspopup"]}
        aria-expanded={custom ? Boolean(popup) : props["aria-expanded"]}
        aria-controls={popup ? popupId : props["aria-controls"]}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (custom && !event.defaultPrevented && event.button === 0) event.preventDefault();
        }}
        onMouseDown={(event) => {
          onMouseDown?.(event);
          if (custom && !event.defaultPrevented && event.button === 0) event.preventDefault();
        }}
        onClick={(event) => {
          onClick?.(event);
          if (!custom || event.defaultPrevented || props.disabled) return;
          event.preventDefault();
          selectRef.current?.focus();
          if (popup) close(); else open();
        }}
        onBlur={(event) => {
          if (popupRef.current?.contains(event.relatedTarget as Node)) return;
          onBlur?.(event); close();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          handleKeyDown(event);
        }}
      >{children}</select>
      {popup && createPortal(
        <div ref={popupRef} id={popupId} role="listbox" popover="manual" tabIndex={-1}
          className="themed-select-popup" style={popup.style}
          aria-label={props["aria-label"] || popup.label}
          aria-labelledby={props["aria-labelledby"]}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            if (event.relatedTarget === selectRef.current || event.currentTarget.contains(event.relatedTarget as Node)) return;
            close();
          }}
        >
          {groups?.map((group, groupIndex) => <div key={groupIndex} role={group.label ? "group" : undefined} aria-label={group.label ?? undefined}>
            {group.label && <div className="themed-select-group" aria-hidden="true">{group.label}</div>}
            {group.items.map(({ choice, index }) => <div key={index} id={`${popupId}-${index}`} role="option" tabIndex={-1} aria-selected={choice.value === selectRef.current?.value}
              aria-disabled={choice.disabled || undefined} data-active={index === popup.active || undefined}
              className="themed-select-option" title={choice.title || choice.label}
              onPointerMove={() => !choice.disabled && index !== popup.active && setPopup({ ...popup, active: index })}
              onClick={() => choose(index)}>
              <span>{choice.label}</span>
              {choice.value === selectRef.current?.value && <Check size={14} aria-hidden="true" />}
            </div>)}
          </div>)}
        </div>, popup.host,
      )}
    </>;
  },
);
