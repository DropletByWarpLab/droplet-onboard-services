/**
 * Onboarding-Flow redesign §2 — the setup wizard's light/dark toggle.
 *
 * It reuses the shared `useTheme()` so the wizard's choice is the same
 * preference the rest of the dashboard reads; flipping it applies the `.dark`
 * document class the dark tokens key off. Rendered without a ThemeProvider (a
 * step under unit test) it must no-op rather than throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "@/lib/theme";
import { WizardThemeToggle } from "./WizardThemeToggle";

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

beforeEach(() => {
  mockMatchMedia(false); // prefers-color-scheme: light
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("WizardThemeToggle", () => {
  it("renders Light + Dark options and flips the document theme class", () => {
    render(
      <ThemeProvider>
        <WizardThemeToggle />
      </ThemeProvider>,
    );
    const light = screen.getByRole("button", { name: /light theme/i });
    const dark = screen.getByRole("button", { name: /dark theme/i });
    // System default resolves to light (matchMedia → not dark).
    expect(light).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(dark);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("droplet-theme")).toBe("dark");

    fireEvent.click(light);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(light).toHaveAttribute("aria-pressed", "true");
  });

  it("renders nothing when mounted outside a ThemeProvider (no throw)", () => {
    const { container } = render(<WizardThemeToggle />);
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: /light theme/i }),
    ).not.toBeInTheDocument();
  });
});
