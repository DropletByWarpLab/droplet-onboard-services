/**
 * WARP-1112 — the active-model picker on /models.
 *
 * Pins the selection contract: owners/admins can switch among installed local
 * models (calls PATCH via setActiveModel + refreshes the page); members see it
 * read-only; the active model is marked; a lone model shows the honest
 * "nothing else to switch to" note; failures surface an alert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { LocalModelRow } from "@/lib/types";

const setActiveModelMock = vi.fn();
vi.mock("@/lib/api", () => ({
  setActiveModel: (m: string) => setActiveModelMock(m),
}));

import { ActiveModelPicker } from "./ActiveModelPicker";

function rows(names: string[]): LocalModelRow[] {
  return names.map((name) => ({
    name,
    family: name.split(/[:\-]/)[0] ?? name,
    provider: "ollama",
    contextLength: 131072,
    gbOnDisk: null,
    role: null,
    status: "ready" as const,
    tokensPerSec: null,
    diskBarPct: null,
  }));
}

beforeEach(() => {
  setActiveModelMock.mockReset();
  setActiveModelMock.mockResolvedValue({ activeModel: "x", changed: true });
});

describe("<ActiveModelPicker />", () => {
  it("renders nothing when there are no installed models", () => {
    const { container } = render(
      <ActiveModelPicker
        models={[]}
        activeModel={null}
        canManage
        onChanged={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the active model and lets an admin switch to another", async () => {
    const onChanged = vi.fn();
    render(
      <ActiveModelPicker
        models={rows(["gpt-oss:20b", "llama3.2:3b"])}
        activeModel="gpt-oss:20b"
        canManage
        onChanged={onChanged}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /gpt-oss:20b/i }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /llama3\.2:3b/i }));
    await waitFor(() =>
      expect(setActiveModelMock).toHaveBeenCalledWith("llama3.2:3b"),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("does not re-apply the already-active model", () => {
    render(
      <ActiveModelPicker
        models={rows(["gpt-oss:20b", "llama3.2:3b"])}
        activeModel="gpt-oss:20b"
        canManage
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /gpt-oss:20b/i }));
    expect(setActiveModelMock).not.toHaveBeenCalled();
  });

  it("is read-only for members — no radios, who-can-change note, clicks are inert", () => {
    render(
      <ActiveModelPicker
        models={rows(["gpt-oss:20b", "llama3.2:3b"])}
        activeModel="gpt-oss:20b"
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/only owners and admins/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText("llama3.2:3b"));
    expect(setActiveModelMock).not.toHaveBeenCalled();
  });

  it("shows the single-model note and treats the lone model as active", () => {
    render(
      <ActiveModelPicker
        models={rows(["gpt-oss:20b"])}
        activeModel={null}
        canManage
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/only model installed/i)).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /gpt-oss:20b/i }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("surfaces the error copy when the change fails", async () => {
    setActiveModelMock.mockRejectedValueOnce(
      new Error("Model \"x\" isn’t installed on this Droplet."),
    );
    render(
      <ActiveModelPicker
        models={rows(["gpt-oss:20b", "llama3.2:3b"])}
        activeModel="gpt-oss:20b"
        canManage
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /llama3\.2:3b/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/isn.t installed/i),
    );
  });
});
