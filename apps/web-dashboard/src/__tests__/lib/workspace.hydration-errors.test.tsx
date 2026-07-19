/**
 * WARP-1341 — business-only build. The WorkspaceProvider no longer hydrates
 * from the network or localStorage (the old WARP-875 hydration-error matrix
 * died with the dual-mode IA): it is a static "business" context. These tests
 * pin that contract so a future re-introduction of async hydration has to be
 * deliberate.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { WorkspaceProvider, useWorkspace } from "@/lib/workspace";

function Probe() {
  const { workspaceType, isBusiness } = useWorkspace();
  return (
    <div data-testid="ws">
      {workspaceType}:{String(isBusiness)}
    </div>
  );
}

describe("WorkspaceProvider (business-only)", () => {
  it("always reports the business workspace", () => {
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    expect(screen.getByTestId("ws").textContent).toBe("business:true");
  });

  it("useWorkspace throws outside the provider", () => {
    // Render errors in React bubble synchronously in test envs via try/catch.
    expect(() => render(<Probe />)).toThrow(/within WorkspaceProvider/i);
  });
});
