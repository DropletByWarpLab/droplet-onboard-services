import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) => (
    <main>
      <h1>{title}</h1>
      <p>{sub}</p>
      {children}
    </main>
  ),
}));

const authFetch = vi.fn();
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

import DevelopmentSettingsPage from "./page";

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const projectRows = {
  projects: [
    { id: "project-1", name: "Home renovation", identifier: "HOME", kind: "PROJECT" },
    { id: "desk-1", name: "Private support desk", identifier: "HELP", kind: "SERVICE_DESK" },
  ],
};

function renderPage() {
  return render(<DevelopmentSettingsPage />);
}

function serveDefaults() {
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/pm/development/repositories" && (!init?.method || init.method === "GET")) {
      return response({ repositories: [] });
    }
    if (url === "/api/pm/projects") return response(projectRows);
    if (url.endsWith("/available")) return response({ items: [], truncated: false });
    return response({ error: "not_found" }, 404);
  });
}

beforeEach(() => {
  authFetch.mockReset();
  serveDefaults();
});

describe("Development integration settings", () => {
  it("disables provider changes during discovery and re-enables the selector when the request settles", async () => {
    let finishDiscovery!: (value: ReturnType<typeof response>) => void;
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/pm/development/repositories" && (!init?.method || init.method === "GET")) {
        return response({ repositories: [] });
      }
      if (url === "/api/pm/projects") return response(projectRows);
      if (url === "/api/pm/development/repositories/github/available") {
        return new Promise((resolve) => { finishDiscovery = resolve; });
      }
      return response({ error: "not_found" }, 404);
    });

    renderPage();
    await screen.findByText("No repositories configured yet.");
    const provider = screen.getByRole("combobox", { name: "Code host" });
    fireEvent.click(screen.getByRole("button", { name: "Discover repositories" }));

    expect(provider).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discovering…" })).toBeDisabled();
    finishDiscovery(response({ items: [], truncated: false }));

    await waitFor(() => expect(provider).toBeEnabled());
    fireEvent.change(provider, { target: { value: "gitlab" } });
    expect(provider).toHaveValue("gitlab");
  });

  it("an admin discovers and maps repositories through the selected provider, with project-only choices", async () => {
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/pm/development/repositories" && (!init?.method || init.method === "GET")) {
        return response({ repositories: [] });
      }
      if (url === "/api/pm/projects") return response(projectRows);
      if (url === "/api/pm/development/repositories/gitlab/available") {
        return response({
          items: [{
            externalId: "repo-42",
            apiRef: "groups/7/projects/42",
            fullName: "team/renovation",
            webUrl: "https://gitlab.example/team/renovation",
            defaultBranch: "main",
          }],
          truncated: false,
        });
      }
      if (url === "/api/pm/development/repositories/gitlab" && init?.method === "POST") {
        return response({ repository: { id: "mapped-repo" } }, 201);
      }
      return response({ error: "not_found" }, 404);
    });

    renderPage();
    await screen.findByText("No repositories configured yet.");
    const provider = screen.getByRole("combobox", { name: "Code host" });
    fireEvent.change(provider, { target: { value: "gitlab" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover repositories" }));

    expect(await screen.findByText("team/renovation")).toBeInTheDocument();
    const projectPicker = screen.getByRole("combobox", { name: "Map new repositories to" });
    expect(projectPicker).toHaveTextContent("HOME · Home renovation");
    expect(projectPicker).not.toHaveTextContent("HELP · Private support desk");
    fireEvent.change(projectPicker, { target: { value: "project-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      "/api/pm/development/repositories/gitlab",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ externalId: "repo-42", apiRef: "groups/7/projects/42", projectIds: ["project-1"] }),
      }),
    ));
    expect(authFetch).toHaveBeenCalledWith(
      "/api/pm/development/repositories/gitlab/available",
      undefined,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("team/renovation is mapped");
  });

  it("shows an owner/admin gate or provider discovery failure instead of a blank list", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/pm/development/repositories") return response({ error: "role_not_allowed" }, 403);
      if (url === "/api/pm/projects") return response(projectRows);
      if (url.endsWith("/available")) return response({ error: "integration_not_connected" }, 403);
      return response({ error: "not_found" }, 404);
    });

    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("role_not_allowed");
    fireEvent.click(screen.getByRole("button", { name: "Discover repositories" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("integration_not_connected");
  });
});
