import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { saveMock, deleteMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  saveProviderKey: saveMock,
  deleteProviderKey: deleteMock,
}));

import { ProviderKeyForm } from "@/components/ProviderKeyForm";

/**
 * WARP-294 — ProviderKeyForm must never render the orchestrator's raw
 * err.message on save / delete failures.
 */
describe("ProviderKeyForm — typed error → friendly copy (WARP-294)", () => {
  beforeEach(() => {
    saveMock.mockReset();
    deleteMock.mockReset();
  });

  it("renders a friendly translation on save failure (no raw message leak)", async () => {
    const SECRET = "ECONNREFUSED 127.0.0.1:5000";
    saveMock.mockRejectedValueOnce(new Error(SECRET));

    render(
      <ProviderKeyForm
        provider="openai"
        label="OpenAI"
        hasKey={false}
        onUpdate={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/paste your api key/i), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      // Wait for some error text to appear.
      expect(
        screen.queryByText((content) =>
          /try again|couldn't|api key/i.test(content),
        ),
      ).toBeTruthy();
    });

    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("renders a friendly translation on delete failure (no raw message leak)", async () => {
    const SECRET = "INTERNAL_ERROR_503";
    deleteMock.mockRejectedValueOnce(new Error(SECRET));

    render(
      <ProviderKeyForm
        provider="anthropic"
        label="Anthropic"
        hasKey={true}
        onUpdate={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /delete key/i }));

    await waitFor(() => {
      expect(
        screen.queryByText((content) =>
          /try again|couldn't|api key/i.test(content),
        ),
      ).toBeTruthy();
    });

    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
  });
});
