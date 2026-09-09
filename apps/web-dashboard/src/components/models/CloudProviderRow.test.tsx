/**
 * WARP-2871 — cloud provider row on the Models page.
 *
 * `cloudProviderState` is the one place the badge is decided from
 * (hasKey × escape × role). The component tests carry the WARP-294 contract
 * forward from the retired ProviderKeyForm: a failed save/remove must render
 * friendly copy, never the orchestrator's raw message.
 */
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

import { CloudProviderRow, cloudProviderState } from "./CloudProviderRow";
import type { CloudAccessInfo, CloudProviderRow as Row } from "@/lib/types";

function row(over: Partial<Row> = {}): Row {
  return {
    provider: "openai",
    enabled: false,
    hasKey: true,
    lastUsedAt: null,
    spendUsd: 0,
    ...over,
  };
}

function access(over: Partial<CloudAccessInfo> = {}): CloudAccessInfo {
  return {
    escapeEnabled: true,
    escapeChangedBy: null,
    escapeChangedAt: null,
    allowedForYou: true,
    ...over,
  };
}

describe("cloudProviderState (WARP-2871)", () => {
  it("hasKey null → Unknown (gateway could not be asked), never 'Not set up'", () => {
    expect(cloudProviderState(row({ hasKey: null }), access())).toEqual({
      kind: "muted",
      label: "Unknown",
    });
  });

  it("hasKey false → Not set up", () => {
    expect(cloudProviderState(row({ hasKey: false }), access())).toEqual({
      kind: "muted",
      label: "Not set up",
    });
  });

  it("key saved but escape off → info 'Key saved · cloud off'", () => {
    expect(
      cloudProviderState(row(), access({ escapeEnabled: false, allowedForYou: false })),
    ).toEqual({ kind: "info", label: "Key saved · cloud off" });
  });

  it("escape on, role blocks the caller → warn 'Blocked for your role'", () => {
    expect(cloudProviderState(row(), access({ allowedForYou: false }))).toEqual({
      kind: "warn",
      label: "Blocked for your role",
    });
  });

  it("escape on, verdict unknown → muted 'Key saved'", () => {
    expect(cloudProviderState(row(), access({ allowedForYou: null }))).toEqual({
      kind: "muted",
      label: "Key saved",
    });
  });

  it("escape on + key + allowed → ok Ready", () => {
    expect(cloudProviderState(row(), access())).toEqual({ kind: "ok", label: "Ready" });
  });
});

describe("<CloudProviderRow /> key actions (WARP-2871, WARP-294 carried over)", () => {
  beforeEach(() => {
    saveMock.mockReset();
    deleteMock.mockReset();
  });

  it("renders a friendly translation on save failure (no raw message leak)", async () => {
    const SECRET = "ECONNREFUSED 127.0.0.1:5000";
    saveMock.mockRejectedValueOnce(new Error(SECRET));
    render(
      <CloudProviderRow
        row={row({ hasKey: false })}
        cloudAccess={access()}
        canManage
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add key/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the key/i), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("renders a friendly translation on remove failure (no raw message leak)", async () => {
    const SECRET = "INTERNAL_ERROR_503";
    deleteMock.mockRejectedValueOnce(new Error(SECRET));
    render(
      <CloudProviderRow
        row={row({ provider: "anthropic" })}
        cloudAccess={access()}
        canManage
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remove anthropic key/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove key$/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
  });

  it("a 403 on save says who can manage keys", async () => {
    saveMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    render(
      <CloudProviderRow row={row()} cloudAccess={access()} canManage onChanged={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /replace key/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the key/i), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Only owners and admins can manage keys.",
      ),
    );
  });

  it("member gets no key buttons at all", () => {
    render(
      <CloudProviderRow
        row={row()}
        cloudAccess={access()}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
