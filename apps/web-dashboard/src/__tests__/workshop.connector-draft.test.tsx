/**
 * WARP-2899 (ADR-056 slice L) — the Workshop's half of a connector draft.
 *
 * The backend (feat/warp-2899-rest-profile-drafts) adds, and this suite mocks
 * exactly as that branch defines them:
 *   - the `rest-profile` template, listed by GET /api/workspace/templates;
 *   - `connectorDraft` on GET /api/workspace/:id — `{provider, displayName,
 *     readback, problems}` for a draft, `null` for any other workspace, or
 *     `{error, code}` when the sandbox did not answer (an orchestrator
 *     without WARP-2899 omits the field entirely);
 *   - GET /api/workspace/:id/export — owner/admin PEOPLE only; the body is
 *     `git bundle` bytes (application/octet-stream) with
 *     `Content-Disposition: attachment; filename="<id>-<head7>.bundle"`.
 *
 * The contract here:
 *   1. `rest-profile` has a person's label and blurb.
 *   2. The readback — the server's sentence, verbatim — sits under the
 *      proposal line, with the draft's problems when it is not ready; no
 *      readback for a workspace that is not a draft, an older orchestrator,
 *      or a sandbox that did not answer.
 *   3. `Export bundle` is offered to owner and admin only.
 *   4. The export is an authFetch blob download (the session token rides in
 *      a header, so a plain link could not carry it), saved under the
 *      server's filename only when that name is a plain `<id>-<hex>.bundle`.
 *   5. A refused export says so calmly and downloads nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";

const authFetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
let mockRole: "owner" | "admin" | "family" | "guest" = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: mockRole }, isLoading: false }),
  authFetch: (url: string, init?: RequestInit) => authFetchMock(url, init),
}));

import { WorkspaceContext } from "@/components/workshop/WorkspaceContext";
import {
  bundleFilename,
  exportWorkspace,
  TEMPLATE_LABELS,
  templateLabel,
  WorkspaceApiError,
} from "@/components/workshop/workspaces/api";

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function okBundle(bytes: string, disposition: string | null) {
  const headers = new Headers({ "Content-Type": "application/octet-stream" });
  if (disposition !== null) headers.set("Content-Disposition", disposition);
  return { ok: true, status: 200, headers, blob: async () => new Blob([bytes], { type: "application/octet-stream" }), json: async () => ({}) };
}

const READBACK = "drafts a connector for Acme; nothing on this box will dial api.acme.example until Warp Lab ships it";

const DETAIL = {
  id: "ws-d",
  name: "Acme connector",
  template: "rest-profile",
  status: "proposed",
  proposedTag: "proposal/0.1.0",
  proposedAt: "2026-09-22T10:00:00.000Z",
  createdAt: "2026-09-22T09:00:00.000Z",
  updatedAt: "2026-09-22T10:00:00.000Z",
  userId: "u1",
  git: { id: "ws-d", branch: "work", head: "0123456789abcdef0123", dirty: false, tags: ["proposal/0.1.0"] },
  connectorDraft: { provider: "acme", displayName: "Acme", readback: READBACK, problems: [] as string[] } as unknown,
  runs: [] as unknown[],
};

function wire(detail: Record<string, unknown>, exportResponse?: () => unknown) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/workspace/ws-d") return okJson(detail);
    if (url.startsWith("/api/workspace/ws-d/log")) return okJson({ entries: [] });
    if (url.startsWith("/api/workspace/ws-d/diff")) return okJson({ base: "HEAD", diff: "", truncated: false });
    if (url.startsWith("/api/workspace/ws-d/output")) return okJson({ lastRun: null });
    if (url === "/api/workspace/ws-d/export" && exportResponse) return exportResponse();
    throw new Error(`unexpected ${url}`);
  });
}

const createObjectURL = vi.fn<(b: Blob) => string>(() => "blob:bundle-1");
const revokeObjectURL = vi.fn<(u: string) => void>();
let clicked: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  mockRole = "owner";
  authFetchMock.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  clicked = [];
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function pane() {
  render(<WorkspaceContext workspaceId="ws-d" live={false} />);
  const p = await screen.findByTestId("workspace-context");
  await waitFor(() => expect(p.textContent).toContain("proposal/0.1.0"));
  return p;
}

describe("the rest-profile template (WARP-2899)", () => {
  it("has a person's label and blurb", () => {
    expect(TEMPLATE_LABELS["rest-profile"]).toEqual({
      label: "Connector draft (REST profile)",
      blurb: "Drafts a vendor profile, its guide and its egress entry for Warp Lab to review. Nothing on this box dials the vendor.",
    });
    expect(templateLabel("rest-profile")).toBe("Connector draft (REST profile)");
  });
});

describe("the connector-draft readback (WARP-2899)", () => {
  it("shows the server's sentence verbatim under the proposal line", async () => {
    wire(DETAIL);
    const p = await pane();
    const row = within(p).getByTestId("connector-draft-readback");
    expect(row.textContent).toBe(`This workspace ${READBACK}.`);
    // Under the proposal line: the proposal's <dd> comes before it in the facts.
    const facts = p.querySelector("dl.ws-facts")!;
    const text = facts.textContent ?? "";
    expect(text.indexOf("proposal/0.1.0")).toBeGreaterThan(-1);
    expect(text.indexOf(READBACK)).toBeGreaterThan(text.indexOf("proposal/0.1.0"));
    expect(within(p).queryByTestId("connector-draft-problems")).toBeNull();
  });

  it("lists what keeps a draft from being ready", async () => {
    wire({
      ...DETAIL,
      connectorDraft: {
        provider: "acme",
        displayName: "Acme",
        readback: READBACK,
        problems: ["the guide is missing ## Cost", "no ADR-042 rows"],
      },
    });
    const p = await pane();
    const list = within(p).getByTestId("connector-draft-problems");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["the guide is missing ## Cost", "no ADR-042 rows"]);
  });

  it("shows no readback for a workspace that is not a draft", async () => {
    wire({ ...DETAIL, template: "python-tool", connectorDraft: null });
    const p = await pane();
    expect(within(p).queryByTestId("connector-draft-readback")).toBeNull();
  });

  it("shows no readback when the orchestrator predates WARP-2899 (no field)", async () => {
    const { connectorDraft: _omit, ...older } = DETAIL;
    void _omit;
    wire(older);
    const p = await pane();
    expect(within(p).queryByTestId("connector-draft-readback")).toBeNull();
  });

  it("shows no readback when the sandbox did not answer for the draft", async () => {
    wire({ ...DETAIL, connectorDraft: { error: "sandbox unreachable", code: "SANDBOX_UNREACHABLE" } });
    const p = await pane();
    expect(within(p).queryByTestId("connector-draft-readback")).toBeNull();
    expect(p.textContent).not.toContain("undefined");
  });
});

describe("Export bundle (WARP-2899)", () => {
  it.each(["owner", "admin"] as const)("is offered to the %s", async (role) => {
    mockRole = role;
    wire(DETAIL);
    const p = await pane();
    expect(within(p).getByRole("button", { name: /export bundle/i })).toBeInTheDocument();
  });

  it.each(["family", "guest"] as const)("is not offered to %s", async (role) => {
    mockRole = role;
    wire(DETAIL);
    const p = await pane();
    expect(within(p).queryByRole("button", { name: /export bundle/i })).toBeNull();
  });

  it("downloads the bundle under the server's filename, and says so", async () => {
    wire(DETAIL, () => okBundle("# v2 git bundle\n", 'attachment; filename="ws-d-0123456.bundle"'));
    const p = await pane();
    fireEvent.click(within(p).getByRole("button", { name: /export bundle/i }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(authFetchMock).toHaveBeenCalledWith("/api/workspace/ws-d/export", undefined);
    expect(clicked[0]).toEqual({ href: "blob:bundle-1", download: "ws-d-0123456.bundle" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:bundle-1");
    await waitFor(() => expect(within(p).getByTestId("export-status").textContent).toContain("ws-d-0123456.bundle"));
  });

  it("a refused export says so calmly and downloads nothing", async () => {
    wire(DETAIL, () => okJson({ error: "Forbidden: a person exports a workspace, not a run" }, 403));
    const p = await pane();
    fireEvent.click(within(p).getByRole("button", { name: /export bundle/i }));
    await waitFor(() => expect(within(p).getByTestId("export-status").textContent).toMatch(/couldn't export/i));
    expect(clicked).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("exportWorkspace / bundleFilename (WARP-2899)", () => {
  it("takes the server's name only when it is a plain <id>-<hex>.bundle", () => {
    expect(bundleFilename('attachment; filename="ws-d-0123456.bundle"', "ws-d")).toBe("ws-d-0123456.bundle");
    expect(bundleFilename('attachment; filename="../../evil.sh"', "ws-d")).toBe("ws-d.bundle");
    expect(bundleFilename('attachment; filename="other-0123456.bundle"', "ws-d")).toBe("ws-d.bundle");
    expect(bundleFilename('attachment; filename="ws-d-0123456.bundle.exe"', "ws-d")).toBe("ws-d.bundle");
    expect(bundleFilename(null, "ws-d")).toBe("ws-d.bundle");
  });

  it("throws the route's refusal with its status, and fetches nothing else", async () => {
    authFetchMock.mockImplementation(async () => okJson({ error: "No such workspace" }, 404));
    const err = await exportWorkspace("ws-x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(404);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock.mock.calls[0]![0]).toBe("/api/workspace/ws-x/export");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
