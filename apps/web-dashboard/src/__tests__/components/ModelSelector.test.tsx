import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { useState } from "react";

// Mutable state the mocked hook reads, so each test can vary the model list.
const state = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  isLoading: false,
}));
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({ models: state.models, isLoading: state.isLoading }),
}));

import { ModelSelector } from "@/components/ModelSelector";

const VISION = {
  id: "gpt-4o",
  provider: "openai",
  name: "GPT-4o",
  context_window: 128000,
  capabilities: { vision: true, tools: true },
};
const LOCAL = {
  id: "mistral:7b-instruct",
  provider: "ollama",
  name: "Mistral 7B",
  context_window: null,
  capabilities: { vision: false, tools: false },
};
const ANTHROPIC = {
  id: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  name: "Claude 3.5 Sonnet",
  context_window: 200000,
  capabilities: { vision: false, tools: true },
};

/** The closed picker: a menu button named `Model: …`. */
const trigger = () => screen.getByRole("button", { name: /^Model: / });
const openMenu = () => {
  fireEvent.click(trigger());
  return screen.getByRole("menu", { name: "Model" });
};

/** The page's side of the picker: it owns the value. */
function Harness({ initial, onChange }: { initial: string; onChange?: (id: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ModelSelector
      value={value}
      onChange={(id) => {
        onChange?.(id);
        setValue(id);
      }}
    />
  );
}

beforeEach(() => {
  state.models = [VISION, LOCAL];
  state.isLoading = false;
});

// ── WARP-3043: a themed menu button, not a native <select> ──
//
// The browser paints a select's open list itself (a light OS list on
// Windows), outside every token. The picker is the WAI-ARIA menu button the
// Workshop's Work in chip uses (components/ui/useMenuButton).
describe("ModelSelector — a themed menu button (WARP-3043)", () => {
  it("renders no native select: the trigger is a menu button", () => {
    const { container } = render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(container.querySelector("select")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    const button = trigger();
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAccessibleName("Model: Mistral 7B");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("lists every model as a menuitemradio, exactly one checked", () => {
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    const items = within(openMenu()).getAllByRole("menuitemradio");
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.getAttribute("aria-checked") === "true")).toEqual([
      screen.getByRole("menuitemradio", { name: "Mistral 7B · Local" }),
    ]);
  });

  it("opens on the checked item; arrows, Home and End move focus; Escape closes and returns focus", () => {
    state.models = [VISION, LOCAL, ANTHROPIC];
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Model" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("choosing an item reports its id, closes the menu and returns focus to the trigger", () => {
    const onChange = vi.fn();
    render(<ModelSelector value="mistral:7b-instruct" onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^GPT-4o · / }));
    expect(onChange).toHaveBeenCalledWith("gpt-4o");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("a loading list is a disabled trigger with today's copy", () => {
    state.models = [];
    state.isLoading = true;
    render(<ModelSelector value="" onChange={() => {}} />);
    const button = trigger();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Loading models...");
  });
});

describe("ModelSelector — vision marker", () => {
  it("marks vision-capable models in their item's caption", () => {
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    openMenu();
    expect(screen.getByRole("menuitemradio", { name: "GPT-4o · OpenAI · vision" })).toBeInTheDocument();
    // The non-vision model carries no marker.
    expect(screen.getByRole("menuitemradio", { name: "Mistral 7B · Local" })).toBeInTheDocument();
  });

  it("draws no separate badge beside the trigger (the provider rides on the trigger itself)", () => {
    render(<ModelSelector value="gpt-4o" onChange={() => {}} />);
    expect(screen.queryByText("Vision")).toBeNull();
    expect(screen.queryByText("OpenAI", { exact: true })).toBeNull();
  });
});

// ── The only visible sign that a turn leaves the box ──
//
// A cloud model's turns (and the drive content they carry) go to a third
// party. The closed trigger must say so — a Cloud icon and `· {Provider}` —
// not only the open menu.
describe("ModelSelector — the closed trigger names a cloud provider (WARP-3043)", () => {
  it("a local model: a dot, the name, no cloud marker", () => {
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    const button = trigger();
    expect(button).toHaveTextContent("Mistral 7B");
    expect(button).not.toHaveTextContent(/·/);
    expect(button.querySelector(".chat-model-cloud")).toBeNull();
    expect(button.querySelector(".dot")).not.toBeNull();
  });

  it("choosing an anthropic model puts a Cloud icon and `· Anthropic` on the CLOSED trigger", () => {
    state.models = [LOCAL, ANTHROPIC];
    render(<Harness initial="mistral:7b-instruct" />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude 3.5 Sonnet · Anthropic" }));
    expect(screen.queryByRole("menu")).toBeNull();

    const button = trigger();
    expect(button).toHaveAccessibleName("Model: Claude 3.5 Sonnet · Anthropic");
    // Visible, not only announced: the suffix sits outside the clamped name.
    expect(button.querySelector(".chat-model-provider")?.textContent).toBe("· Anthropic");
    expect(button.querySelector(".chat-model-name")?.textContent).toBe("Claude 3.5 Sonnet");
    expect(button.querySelector(".chat-model-cloud")).not.toBeNull();
    expect(button.querySelector(".dot")).toBeNull();
  });
});

// ── WARP-904: cloud key-gating ──
//
// ModelSelector never queries the keys API itself — it renders whatever
// `useModels()` returns, and `/api/llm/models` (ai-gateway's provider
// router) already excludes a cloud provider's models until its API key
// is configured (services/ai-gateway/providers/{anthropic,openai}_cloud.py
// — `list_models()` returns `[]` when `self.api_key` is unset). This
// test locks in that ModelSelector doesn't second-guess or re-add
// anything the gated list already left out.
describe("ModelSelector — cloud key-gating (reuses /api/llm/models)", () => {
  it("never offers a cloud provider whose key isn't configured (absent from the gated list)", () => {
    // OpenAI has no key configured device-wide: the gateway already
    // dropped it from the response, so it's simply not in `models`.
    state.models = [LOCAL, ANTHROPIC];
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    openMenu();
    expect(screen.queryByRole("menuitemradio", { name: /^GPT-4o/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Claude 3.5 Sonnet · Anthropic" })).toBeInTheDocument();
  });

  it("once a key is added and the list refetches, the newly-gated model becomes selectable", () => {
    // Before: only local + anthropic (no OpenAI key yet).
    state.models = [LOCAL, ANTHROPIC];
    const { rerender } = render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    openMenu();
    expect(screen.queryByRole("menuitemradio", { name: /^GPT-4o/ })).not.toBeInTheDocument();

    // After: the key was saved in Settings and useModels()'s SWR poll
    // picked up the refreshed /api/llm/models response.
    state.models = [LOCAL, ANTHROPIC, VISION];
    rerender(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(screen.getByRole("menuitemradio", { name: "GPT-4o · OpenAI · vision" })).toBeInTheDocument();
  });
});

// ── WARP-3048: one model → a read-only chip that leads to /models ──
//
// Hiding the pill when there was nothing to choose left a single-model box's
// composer naming no model at all, with no hint where models are managed.
// The models brief (WARP-1116) asks for a read-only chip linking to /models.
describe("ModelSelector — single-model chip (WARP-3048)", () => {
  it("renders a read-only chip linking to /models when exactly one model exists", () => {
    state.models = [LOCAL];
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);

    const chip = screen.getByRole("link", {
      name: "Model: Mistral 7B — manage on Models",
    });
    expect(chip).toHaveAttribute("href", "/models");
    expect(chip).toHaveTextContent("Mistral 7B");
    // Read-only: nothing to pick from.
    expect(screen.queryByRole("button", { name: /^Model: / })).toBeNull();
  });

  it("keeps the menu button for two or more models", () => {
    state.models = [LOCAL, VISION];
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing when no model is available (the page's empty state explains)", () => {
    state.models = [];
    const { container } = render(<ModelSelector value="" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ── WARP-3048 review: a thread's model that is not in the list right now ──
//
// /chat holds a thread's model while the list is degraded (a model swap can
// stop the box's runtime answering the listing) and never falls a thread
// back to the cloud. The picker names the held model — never another one.
describe("ModelSelector — a held model missing from the list (WARP-3048)", () => {
  it("names the held model, marked unavailable, and checks it in the menu", () => {
    render(<ModelSelector value="qwen3:14b" onChange={() => {}} />);

    expect(trigger()).toHaveAccessibleName("Model: qwen3:14b · unavailable");
    expect(trigger()).toHaveTextContent("qwen3:14b · unavailable");
    openMenu();
    const held = screen.getByRole("menuitemradio", { name: "qwen3:14b · unavailable" });
    expect(held).toHaveAttribute("aria-checked", "true");
  });

  it("does not show the single-model chip for a model the thread is not on", () => {
    state.models = [VISION];
    render(<ModelSelector value="qwen3:14b" onChange={() => {}} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(trigger()).toHaveAccessibleName("Model: qwen3:14b · unavailable");
  });
});
