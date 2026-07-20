import "@testing-library/jest-dom/vitest";

// Mock next/navigation
import { vi } from "vitest";
import { configure } from "@testing-library/react";

// Testing Library's default asyncUtilTimeout is 1000 ms, measured in wall
// clock. That is ample for a single file but not for this suite: CI runs
// ~380 files across a handful of workers on a shared runner, so a component
// whose effect resolves in ~20 ms locally can take far longer to commit its
// post-fetch render when every core is saturated. The result is a findBy/
// waitFor that times out on CI and passes every time it is re-run or run in
// isolation — a flake that reads like a real failure and stalls unrelated PRs
// (WARP-1421: voice.enroll on #1149, FeaturesCard on #1142).
//
// Raising the ceiling costs nothing on the happy path — these helpers poll and
// resolve as soon as the DOM settles, so a passing assertion is no slower. It
// only changes how long a genuinely-failing one waits before reporting.
configure({ asyncUtilTimeout: 5000 });

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  })),
  // WARP-331: the /chat page reads ?c=<id> via useSearchParams to react to
  // sidebar clicks. Default to an empty params bag — tests that need a
  // populated `c` should override per-file.
  useSearchParams: vi.fn(() => new URLSearchParams()),
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
