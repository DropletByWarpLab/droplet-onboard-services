"use client";

/**
 * The composer's model picker (WARP-904, WARP-3048, WARP-3043).
 *
 * A themed menu button, not a native `<select>`: the browser paints a
 * select's open list itself, outside every token (components/ui/useMenuButton
 * + pick-menu.css, as the Workshop's Work in chip). The items are
 * `menuitemradio` with exactly one `aria-checked`, captioned with where the
 * model runs ("Local" or its provider) and "· vision" when it can see images.
 *
 * A cloud model's turns — and the drive content they carry — leave the box,
 * so the CLOSED trigger says so: a Cloud icon and `· {Provider}` beside the
 * name, outside the name's clamp so a long name cannot push it out of view.
 */
import Link from "next/link";
import { Check, ChevronDown, Cloud } from "lucide-react";
import { useModels } from "@/lib/hooks/useModels";
import { isLocalProvider } from "@/lib/provider";
import { useMenuButton } from "@/components/ui/useMenuButton";
import "@/components/ui/pick-menu.css";

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

// Keyed by BOTH local names: `local` is what the gateway emits now, `ollama`
// is what pre-WARP-1926 persisted rows still carry.
const PROVIDER_LABEL: Record<string, string> = {
  local: "Local",
  ollama: "Local",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const providerLabel = (provider: string) =>
  isLocalProvider(provider) ? "Local" : (PROVIDER_LABEL[provider] ?? provider);

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const { models, isLoading } = useModels();
  const menu = useMenuButton({ disabled: isLoading });

  // No model at all: the chat page's empty state says so and links to
  // /models. (Still render while loading, when we don't yet know the count.)
  if (!isLoading && models.length === 0) return null;

  // WARP-3048 — /chat holds a thread's model while the list is degraded and
  // never falls a thread back to the cloud, so `value` can name a model that
  // is not listed right now. The picker names that model, marked
  // unavailable — never another one.
  const held = Boolean(value) && !isLoading && !models.some((m) => m.id === value);

  // WARP-3048 — one model: there is nothing to choose here, but hiding the
  // pill left the composer naming no model at all. The models brief
  // (WARP-1116) asks for a read-only chip instead — dot + name — that leads
  // to /models, where models are installed and switched.
  if (!isLoading && models.length === 1 && !held) {
    const only = models[0];
    return (
      <Link
        href="/models"
        className="chat-model chat-model-link"
        aria-label={`Model: ${only.name} — manage on Models`}
        title="Manage models"
      >
        <span className="dot" aria-hidden="true" />
        <span className="chat-model-name">{only.name}</span>
      </Link>
    );
  }

  const selected = models.find((m) => m.id === value);
  const cloudProvider = selected && !isLocalProvider(selected.provider) ? selected.provider : null;
  const name = isLoading ? "Loading models..." : (selected?.name ?? (value || "Choose a model"));
  const suffix = held ? "· unavailable" : cloudProvider ? `· ${providerLabel(cloudProvider)}` : "";

  const pick = (id: string) => {
    onChange(id);
    menu.close(true);
  };

  return (
    <div ref={menu.rootRef} className="chat-model-wrap">
      <button
        ref={menu.buttonRef}
        type="button"
        className="chat-model"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menu.menuId : undefined}
        aria-label={`Model: ${name}${suffix ? ` ${suffix}` : ""}`}
        title="Model"
        disabled={isLoading}
        onClick={menu.onButtonClick}
        onKeyDown={menu.onButtonKeyDown}
      >
        {cloudProvider ? (
          <Cloud size={13} className="chat-model-cloud" aria-hidden="true" />
        ) : (
          <span className="dot" aria-hidden="true" />
        )}
        <span className="chat-model-name">{name}</span>
        {suffix && (
          <>
            {" "}
            <span className="chat-model-provider">{suffix}</span>
          </>
        )}
        <ChevronDown size={13} className="chat-model-chevron" aria-hidden="true" />
      </button>

      {menu.open && (
        <div
          ref={menu.menuRef}
          id={menu.menuId}
          role="menu"
          aria-label="Model"
          className="pick-menu"
          data-align={menu.align}
          onKeyDown={menu.onMenuKeyDown}
        >
          {held && <ModelItem id={value} name={value} caption="unavailable" checked onPick={pick} />}
          {models.map((m) => (
            <ModelItem
              key={m.id}
              id={m.id}
              name={m.name}
              caption={`${providerLabel(m.provider)}${m.capabilities?.vision ? " · vision" : ""}`}
              checked={m.id === value}
              onPick={pick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelItem({
  id,
  name,
  caption,
  checked,
  onPick,
}: {
  id: string;
  name: string;
  caption: string;
  checked: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-label={`${name} · ${caption}`}
      tabIndex={-1}
      className="pick-item"
      onClick={() => onPick(id)}
    >
      <span className="pick-item-text">
        <span className="pick-item-name">{name}</span>
        <span className="pick-item-caption">{caption}</span>
      </span>
      {checked && <Check size={14} className="pick-check" aria-hidden="true" />}
    </button>
  );
}
