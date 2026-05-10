import "@testing-library/jest-dom/vitest";

// Mock next/navigation
import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  })),
}));

// Mock next/link to render a plain <a>
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => {
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    return `<a href="${href}" ${Object.entries(props).map(([k, v]) => `${k}="${v}"`).join(" ")}>${children}</a>`;
  },
}));

// WARP-225: jsdom doesn't ship ResizeObserver, but recharts'
// ResponsiveContainer relies on it. Polyfill with a no-op so chart
// components can render in vitest without each test having to wire
// it up locally.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Suppress console noise in tests
vi.spyOn(console, "error").mockImplementation(() => {});
