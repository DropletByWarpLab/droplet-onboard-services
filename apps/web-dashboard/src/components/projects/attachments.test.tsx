// Work-item attachments (WARP-1505): the upload transport, the Attachments
// section in the detail drawer, the upload queue, and files on comments.
//
// Everything below the transport tests drives the real DetailDrawer against a
// canned network (the same `@/lib/auth` mock style as detail.test.tsx) and a
// fake XMLHttpRequest, because upload progress cannot come from fetch.

import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DetailDrawer } from "./detail";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import { uploadAttachment, PmRequestError } from "./usePm";
import { translateError } from "@/lib/friendly-errors";
import type { PmAttachment, PmWorkItem } from "./types";

const { toast, net } = vi.hoisted(() => ({
  toast: vi.fn(),
  net: {
    calls: [] as { url: string; method: string; body?: unknown }[],
    user: { id: "u1", role: "owner" } as { id: string; role?: string },
    attachments: [] as unknown[],
    maxBytes: 26214400 as number | undefined,
    list: "ok" as "ok" | "loading" | "error",
    comments: [] as unknown[],
    activity: [] as unknown[],
    deleteStatus: 200,
    commentStatus: 201,
  },
}));

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: net.user }),
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const pathname = new URL(url, "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    net.calls.push({ url, method, body });
    const reply = (status: number, resBody: unknown) =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(resBody) } as Response);

    if (url.endsWith("/attachments") && method === "GET") {
      if (net.list === "loading") return new Promise<Response>(() => undefined);
      if (net.list === "error") return reply(500, { error: "internal" });
      return reply(200, { attachments: net.attachments, limits: { maxBytes: net.maxBytes } });
    }
    if (/\/attachments\/[^/]+$/.test(url) && method === "DELETE") {
      return reply(net.deleteStatus, net.deleteStatus < 400 ? { deleted: "x" } : { error: "attachment_forbidden" });
    }
    if (url.endsWith("/comments") && method === "POST") {
      if (net.commentStatus >= 400) return reply(net.commentStatus, { error: "work_item_not_found" });
      return reply(201, {
        comment: { id: "c-new", workItemId: "w1", authorId: "u1", commentHtml: "<p>hi</p>", createdAt: "2026-06-22T21:16:00.000Z" },
      });
    }
    if (pathname.endsWith("/comments")) return reply(200, { comments: net.comments, nextCursor: null, total: net.comments.length });
    if (pathname.endsWith("/activity")) return reply(200, { activity: net.activity, nextCursor: null, total: net.activity.length });
    if (url.includes("/work-items?parent=")) return reply(200, { work_items: [], nextCursor: null, total: 0 });
    if (url.endsWith("/labels")) return reply(200, { labels: [] });
    if (url.endsWith("/users")) return reply(200, { users: [] });
    return reply(200, {});
  }),
}));

/** Just enough XMLHttpRequest to drive uploads: records what was sent and lets
 *  a test deliver progress and the response by hand. */
class FakeXHR {
  static all: FakeXHR[] = [];
  method = "";
  url = "";
  withCredentials = false;
  body: FormData | null = null;
  status = 0;
  responseText = "";
  aborted = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    FakeXHR.all.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, json: unknown) {
    this.status = status;
    this.responseText = typeof json === "string" ? json : JSON.stringify(json);
    this.onload?.();
  }
  get file(): File {
    return this.body?.get("file") as File;
  }
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const att = (id: string, over: Partial<PmAttachment> = {}): PmAttachment => ({
  id,
  workItemId: "w1",
  commentId: null,
  fileName: `${id}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 2048,
  previewable: false,
  uploadedById: "u1",
  createdAt: hoursAgo(2),
  ...over,
});

const makeFile = (name: string, type = "text/plain") => new File(["abc"], name, { type });

/** A file that reports `bytes` without allocating them. */
const sizedFile = (name: string, bytes: number) => {
  const f = makeFile(name);
  Object.defineProperty(f, "size", { value: bytes });
  return f;
};

const NAMES: Record<string, string> = { u1: "Ada Lovelace", u2: "Grace Hopper" };

const ITEM: PmWorkItem = {
  id: "w1",
  projectId: "p",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: null,
  stateId: "s1",
  state: { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  priority: "none",
  parentId: null,
  cycleId: null,
  department: null,
  assignees: [],
  labels: [],
  startDate: null,
  dueDate: null,
  sortOrder: 1,
  completedAt: null,
  createdById: null,
  commentCount: 0,
  subItemCount: 0,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function renderDrawer({ strict = false, readOnly = false, onClose = () => undefined } = {}) {
  const tree = (readonlyMode: boolean) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, NAMES[id] ?? "Tester")}>
        <DetailDrawer item={ITEM} readOnly={readonlyMode} onClose={onClose} onChanged={() => undefined} />
      </PeopleContext.Provider>
    </SWRConfig>
  );
  const wrapped = (readonlyMode: boolean) => strict ? <StrictMode>{tree(readonlyMode)}</StrictMode> : tree(readonlyMode);
  const view = render(wrapped(readOnly));
  return { ...view, setReadOnly: (readonlyMode: boolean) => view.rerender(wrapped(readonlyMode)) };
}

const progress = (xhr: FakeXHR, loaded: number, total: number) => act(() => xhr.progress(loaded, total));
const respond = (xhr: FakeXHR, status: number, json: unknown) => act(() => xhr.respond(status, json));
const getsOf = (suffix: string) => net.calls.filter((c) => c.method === "GET" && new URL(c.url, "http://localhost").pathname.endsWith(suffix)).length;
const section = () => screen.getByRole("group", { name: /^Attachments/ });
/** The upload rows. The same sentence is also in a live region for screen readers. */
const uploadRows = () => screen.findByRole("list", { name: "Uploads" });
const composerInput = () => screen.getByLabelText("Choose files to attach to the comment");
const sectionInput = () => screen.getByLabelText("Choose files to attach");
const filesDrag = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });

beforeEach(() => {
  net.calls.length = 0;
  net.user = { id: "u1", role: "owner" };
  net.attachments = [];
  net.maxBytes = 26214400;
  net.list = "ok";
  net.comments = [];
  net.activity = [];
  net.deleteStatus = 200;
  net.commentStatus = 201;
  FakeXHR.all = [];
  toast.mockClear();
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Transport ──────────────────────────────────────────────────────────────

describe("uploadAttachment", () => {
  it("posts one multipart file in the field `file` with credentials", async () => {
    const file = makeFile("a.txt");
    const done = uploadAttachment("w1", file, {});
    const xhr = FakeXHR.all[0];
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/pm/work-items/w1/attachments");
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.file.name).toBe("a.txt");
    const saved = att("a1");
    xhr.respond(201, { attachment: saved });
    await expect(done).resolves.toEqual(saved);
  });

  it("attaches to a comment through the comment_id query", () => {
    void uploadAttachment("w1", makeFile("a.txt"), { commentId: "c 1" }).catch(() => undefined);
    expect(FakeXHR.all[0].url).toBe("/api/pm/work-items/w1/attachments?comment_id=c%201");
  });

  it("reports upload progress as a 0..1 fraction", () => {
    const onProgress = vi.fn();
    void uploadAttachment("w1", makeFile("a.txt"), { onProgress }).catch(() => undefined);
    FakeXHR.all[0].progress(25, 100);
    expect(onProgress).toHaveBeenCalledWith(0.25);
  });

  it("rejects with a PmRequestError carrying status and the wire code", async () => {
    const done = uploadAttachment("w1", makeFile("a.exe"), {});
    FakeXHR.all[0].respond(415, { error: "attachment_type_blocked" });
    const err = await done.catch((e) => e);
    expect(err).toBeInstanceOf(PmRequestError);
    expect(err).toMatchObject({ status: 415, code: "attachment_type_blocked" });
    // translateError(e, "projects") keeps working on it — no snake_case on screen.
    expect(translateError(err, "projects")).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("carries the server's maxBytes on a 413", async () => {
    const done = uploadAttachment("w1", makeFile("a.bin"), {});
    FakeXHR.all[0].respond(413, { error: "attachment_too_large", maxBytes: 1000 });
    await expect(done).rejects.toMatchObject({ status: 413, code: "attachment_too_large", maxBytes: 1000 });
  });

  it("still rejects with the status when the body is not JSON (a proxy's error page)", async () => {
    const done = uploadAttachment("w1", makeFile("a.bin"), {});
    FakeXHR.all[0].respond(413, "<html>Request Entity Too Large</html>");
    const err = await done.catch((e) => e);
    expect(err).toBeInstanceOf(PmRequestError);
    expect(err.status).toBe(413);
    expect(err.code).toBeUndefined();
  });

  it("rejects with a network-flavoured error when the request cannot be sent", async () => {
    const done = uploadAttachment("w1", makeFile("a.txt"), {});
    FakeXHR.all[0].onerror?.();
    const err = await done.catch((e) => e);
    expect(translateError(err, "projects")).toBe(translateError({ code: "NETWORK" }, "projects"));
  });

  it("aborts the request when its signal fires, and never sends on a spent signal", async () => {
    const ctl = new AbortController();
    const done = uploadAttachment("w1", makeFile("a.txt"), { signal: ctl.signal });
    ctl.abort();
    expect(FakeXHR.all[0].aborted).toBe(true);
    await expect(done).rejects.toMatchObject({ name: "AbortError" });

    FakeXHR.all = [];
    await expect(uploadAttachment("w1", makeFile("b.txt"), { signal: ctl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(FakeXHR.all).toHaveLength(0);
  });
});

// ── The section: list and states ───────────────────────────────────────────

describe("Attachments section — list", () => {
  it("sits after Sub-issues and before Comments, with a count", async () => {
    net.attachments = [att("a1"), att("a2")];
    renderDrawer();
    const group = await screen.findByRole("group", { name: /^Attachments/ });
    expect(within(group).getByText("2")).toBeInTheDocument();
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByText("Sub-issues"), group)).toBe(true);
    expect(follows(group, screen.getByText("Comments"))).toBe(true);
  });

  it("renders name as a download link, then size · uploader · time", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf", sizeBytes: 1_258_291, uploadedById: "u1", createdAt: hoursAgo(2) })];
    renderDrawer();
    const link = await within(section()).findByRole("link", { name: "plan.pdf" });
    expect(link).toHaveAttribute("href", "/api/pm/attachments/a1");
    expect(link).toHaveAttribute("download");
    expect(within(section()).getByText("1.2 MB · Ada Lovelace · 2 hours ago")).toBeInTheDocument();
  });

  it("formats small sizes in KB and an unknown uploader as Droplet AI", async () => {
    net.attachments = [att("a1", { sizeBytes: 2048, uploadedById: null })];
    renderDrawer();
    expect(await within(section()).findByText(/^2 KB · Droplet AI · /)).toBeInTheDocument();
  });

  it("shows a thumbnail only for previewable files, from the inline URL", async () => {
    net.attachments = [
      att("img1", { fileName: "shot.png", mimeType: "image/png", previewable: true }),
      // Looks like an image by name and type, but the server did not verify it.
      att("doc1", { fileName: "diagram.png", mimeType: "image/png", previewable: false }),
    ];
    renderDrawer();
    await within(section()).findByRole("link", { name: "shot.png" });
    const rows = within(section()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("img")).toHaveAttribute("src", "/api/pm/attachments/img1?inline=1");
    expect(rows[1].querySelector("img")).toBeNull();
  });
});

describe("Attachments section — states", () => {
  it("empty: says so and hints how to add, with the limit computed from the server", async () => {
    net.maxBytes = 10 * 1024 * 1024;
    renderDrawer();
    expect(await within(section()).findByText("No attachments yet.")).toBeInTheDocument();
    expect(
      within(section()).getByText("Drop files here, paste an image, or choose files. Up to 10 MB each."),
    ).toBeInTheDocument();
  });

  it("loading: a skeleton row, not the empty line", async () => {
    net.list = "loading";
    renderDrawer();
    const group = await screen.findByRole("group", { name: /^Attachments/ });
    expect(group.querySelector(".pm-skel")).not.toBeNull();
    expect(within(group).queryByText("No attachments yet.")).not.toBeInTheDocument();
  });

  it("error: a quiet line with Try again, which refetches", async () => {
    net.list = "error";
    renderDrawer();
    expect(await within(section()).findByText("Couldn't load attachments.")).toBeInTheDocument();
    const before = getsOf("/attachments");
    net.list = "ok";
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    fireEvent.click(within(section()).getByRole("button", { name: "Try again" }));
    expect(await within(section()).findByRole("link", { name: "plan.pdf" })).toBeInTheDocument();
    expect(getsOf("/attachments")).toBeGreaterThan(before);
  });

  it("keeps showing the list when a later refresh fails", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    renderDrawer();
    await within(section()).findByRole("link", { name: "plan.pdf" });
    // An upload finishing triggers a refresh; make that refresh fail.
    fireEvent.change(sectionInput(), { target: { files: [makeFile("b.txt")] } });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    const before = getsOf("/attachments");
    net.list = "error";
    respond(FakeXHR.all[0], 201, { attachment: att("b1", { fileName: "b.txt" }) });
    await waitFor(() => expect(getsOf("/attachments")).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
    expect(within(section()).getByRole("link", { name: "plan.pdf" })).toBeInTheDocument();
    expect(within(section()).queryByText("Couldn't load attachments.")).not.toBeInTheDocument();
  });

  it("read-only roles get the list with no add or remove controls (hidden, not disabled)", async () => {
    net.user = { id: "u9", role: "guest" };
    net.attachments = [att("a1", { fileName: "plan.pdf", uploadedById: "u9" })];
    renderDrawer();
    await within(section()).findByRole("link", { name: "plan.pdf" });
    expect(screen.queryByRole("button", { name: "Add files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Add attachments" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose files to attach")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
  });

  it("read-only empty state has no how-to-add hint", async () => {
    net.user = { id: "u9", role: "guest" };
    renderDrawer();
    expect(await within(section()).findByText("No attachments yet.")).toBeInTheDocument();
    expect(within(section()).queryByText(/Drop files here/)).not.toBeInTheDocument();
  });

  it("an explicitly read-only owner drawer preserves downloads and hides every attachment mutation", async () => {
    net.user = { id: "u1", role: "owner" };
    net.attachments = [att("a1", { fileName: "plan.pdf", uploadedById: "u2" })];
    renderDrawer({ readOnly: true });
    const link = await within(section()).findByRole("link", { name: "plan.pdf" });
    expect(link).toHaveAttribute("href", "/api/pm/attachments/a1");
    expect(link).toHaveAttribute("download");
    expect(screen.queryByRole("button", { name: "Add files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Add attachments" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose files to attach")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    fireEvent.drop(section(), filesDrag([makeFile("readonly.txt")]));
    fireEvent.paste(section(), { clipboardData: { files: [makeFile("readonly.png", "image/png")] } });
    expect(FakeXHR.all).toHaveLength(0);
    // Viewing the drawer sends a presence heartbeat, but cannot mutate files.
    expect(net.calls.filter((c) => c.method !== "GET" && !(c.method === "POST" && c.url === "/api/pm/work-items/w1/presence"))).toHaveLength(0);
  });

  it("has a focusable add area and a real Add files button that opens the picker", async () => {
    renderDrawer();
    const zone = await screen.findByRole("group", { name: "Add attachments" });
    expect(zone).toHaveAttribute("tabindex", "0");
    const button = within(zone).getByRole("button", { name: "Add files" });
    expect(button).toHaveAttribute("type", "button");
    const click = vi.spyOn(sectionInput(), "click");
    fireEvent.click(button);
    expect(click).toHaveBeenCalled();
  });
});

// ── Uploading ──────────────────────────────────────────────────────────────

describe("Attachments section — uploading", () => {
  it("each picked file is its own request, shows progress, then the list and activity refresh", async () => {
    renderDrawer();
    const input = await screen.findByLabelText("Choose files to attach");
    fireEvent.change(input, { target: { files: [makeFile("a.txt")] } });

    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    const xhr = FakeXHR.all[0];
    expect(xhr.url).toBe("/api/pm/work-items/w1/attachments");
    expect(xhr.file.name).toBe("a.txt");

    const bar = await screen.findByRole("progressbar", { name: "Uploading a.txt" });
    progress(xhr, 50, 100);
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
    expect(within(section()).getByText("50%")).toHaveAttribute("aria-hidden", "true"); // visible only; the bar speaks for itself
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // One polite live region announces the upload, rather than every percent.
    const live = section().querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("Uploading 1 file");

    const listBefore = getsOf("/attachments");
    const activityBefore = getsOf("/activity");
    net.attachments = [att("a1", { fileName: "a.txt" })];
    respond(xhr, 201, { attachment: att("a1", { fileName: "a.txt" }) });

    expect(await within(section()).findByRole("link", { name: "a.txt" })).toBeInTheDocument();
    expect(getsOf("/attachments")).toBeGreaterThan(listBefore);
    expect(getsOf("/activity")).toBeGreaterThan(activityBefore);
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("runs at most three uploads at a time", async () => {
    renderDrawer();
    const input = await screen.findByLabelText("Choose files to attach");
    fireEvent.change(input, { target: { files: ["1", "2", "3", "4", "5"].map((n) => makeFile(`f${n}.txt`)) } });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    expect(screen.getAllByRole("progressbar")).toHaveLength(5);

    respond(FakeXHR.all[0], 201, { attachment: att("x1") });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all.map((x) => x.file.name)).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
  });

  it("a file over the limit fails at once, states the limit, and sends nothing", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    fireEvent.change(sectionInput(), { target: { files: [sizedFile("huge.mov", 30 * 1024 * 1024)] } });
    expect(within(await uploadRows()).getByText("huge.mov is larger than 25 MB.")).toBeInTheDocument();
    expect(section().querySelector('[aria-live="polite"]')).toHaveTextContent("huge.mov is larger than 25 MB.");
    expect(FakeXHR.all).toHaveLength(0);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("huge.mov is larger than 25 MB.")).not.toBeInTheDocument();
  });

  const REJECTIONS = [
    {
      status: 413,
      body: { error: "attachment_too_large", maxBytes: 5 * 1024 * 1024 },
      file: "big.bin",
      says: "big.bin is larger than 5 MB.",
    },
    {
      status: 415,
      body: { error: "attachment_type_blocked" },
      file: "tool.exe",
      says: "tool.exe can't be added — executable files aren't allowed.",
    },
    {
      status: 415,
      body: { error: "attachment_type_mismatch" },
      file: "fake.png",
      says: "fake.png doesn't look like the file type its name says.",
    },
    {
      status: 507,
      body: { error: "attachment_storage_full" },
      file: "a.zip",
      says: translateError({ code: "attachment_storage_full" }, "projects"),
    },
    {
      status: 400,
      body: { error: "attachment_empty" },
      file: "empty.txt",
      says: translateError({ code: "attachment_empty" }, "projects"),
    },
  ];

  it.each(REJECTIONS)("a $status $body.error reads as a plain sentence and stays dismissable", async ({ status, body, file, says }) => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    fireEvent.change(sectionInput(), { target: { files: [makeFile(file)] } });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    respond(FakeXHR.all[0], status, body);
    expect(within(await uploadRows()).getByText(says)).toBeInTheDocument();
    expect(screen.queryByText(/attachment_/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    // A failed row is not a progress row.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("a 413 with no usable body falls back to the limit the list reported", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    fireEvent.change(sectionInput(), { target: { files: [makeFile("big.bin")] } });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    respond(FakeXHR.all[0], 413, "<html>Request Entity Too Large</html>");
    expect(await within(await uploadRows()).findByText("big.bin is larger than 25 MB.")).toBeInTheDocument();
  });

  it("pasting an image into the add area uploads it, naming an unnamed one image.png", async () => {
    renderDrawer();
    const zone = await screen.findByRole("group", { name: "Add attachments" });
    const shot = new File(["x"], "", { type: "image/png" });
    const handled = fireEvent.paste(zone, { clipboardData: { files: [shot] } });
    expect(handled).toBe(false); // default prevented: we took the paste
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0].file.name).toBe("image.png");
    expect(FakeXHR.all[0].url).toBe("/api/pm/work-items/w1/attachments");
  });

  it("a paste with no files in the add area is left alone", async () => {
    renderDrawer();
    const zone = await screen.findByRole("group", { name: "Add attachments" });
    expect(fireEvent.paste(zone, { clipboardData: { files: [], getData: () => "just text" } })).toBe(true);
    expect(FakeXHR.all).toHaveLength(0);
  });

  it("closing the drawer stops uploads still in flight", async () => {
    const { unmount } = renderDrawer();
    fireEvent.change(await screen.findByLabelText("Choose files to attach"), { target: { files: [makeFile("a.txt")] } });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    unmount();
    expect(FakeXHR.all[0].aborted).toBe(true);
  });

  it("uploads still start under StrictMode's mount, unmount, mount", async () => {
    renderDrawer({ strict: true });
    fireEvent.change(await screen.findByLabelText("Choose files to attach"), { target: { files: [makeFile("a.txt")] } });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0].aborted).toBe(false);
  });
});

// ── Dropping ───────────────────────────────────────────────────────────────

describe("Drawer drop target", () => {
  it("shows a calm hint while a file drag is over, and uploads the drop to the item", async () => {
    renderDrawer();
    const title = await screen.findByRole("heading", { name: "First task" });
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
    fireEvent.dragEnter(title, filesDrag());
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();

    const dropped = makeFile("dropped.txt");
    expect(fireEvent.drop(title, filesDrag([dropped]))).toBe(false); // default prevented
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0].url).toBe("/api/pm/work-items/w1/attachments");
    expect(FakeXHR.all[0].file.name).toBe("dropped.txt");
  });

  it("does not flicker when the drag crosses child elements (depth counter)", async () => {
    renderDrawer();
    const title = await screen.findByRole("heading", { name: "First task" });
    const area = await screen.findByRole("group", { name: "Add attachments" });
    fireEvent.dragEnter(title, filesDrag());
    fireEvent.dragEnter(area, filesDrag()); // into a child: enter before leave
    fireEvent.dragLeave(title, filesDrag());
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
    fireEvent.dragLeave(area, filesDrag());
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
  });

  it("ignores drags that carry no files", async () => {
    renderDrawer();
    const title = await screen.findByRole("heading", { name: "First task" });
    const text = { dataTransfer: { types: ["text/plain"], files: [] } };
    fireEvent.dragEnter(title, text);
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
    expect(fireEvent.dragOver(title, text)).toBe(true);
    expect(fireEvent.drop(title, text)).toBe(true);
    expect(FakeXHR.all).toHaveLength(0);
  });

  it("a drop on the add area lands on the item too", async () => {
    renderDrawer();
    const zone = await screen.findByRole("group", { name: "Add attachments" });
    fireEvent.drop(zone, filesDrag([makeFile("z.txt")]));
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0].url).toBe("/api/pm/work-items/w1/attachments");
  });

  it("read-only roles: no hint, no upload, but the browser still must not open the file", async () => {
    net.user = { id: "u9", role: "guest" };
    renderDrawer();
    const title = await screen.findByRole("heading", { name: "First task" });
    fireEvent.dragEnter(title, filesDrag());
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
    expect(fireEvent.drop(title, filesDrag([makeFile("nope.txt")]))).toBe(false);
    expect(FakeXHR.all).toHaveLength(0);
  });

  it("a stray file drop anywhere in the window does not navigate away while the drawer is open", async () => {
    renderDrawer();
    await screen.findByRole("heading", { name: "First task" });
    expect(fireEvent.drop(document.body, filesDrag([makeFile("stray.txt")]))).toBe(false);
    expect(fireEvent.dragOver(document.body, filesDrag())).toBe(false);
    // Anything that is not a file drag is untouched.
    expect(fireEvent.drop(document.body, { dataTransfer: { types: ["text/plain"], files: [] } })).toBe(true);
  });
});

// ── Removing ───────────────────────────────────────────────────────────────

describe("Removing an attachment", () => {
  it("confirms first, then DELETEs, refreshes, and puts focus back in the add area", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf", uploadedById: "u1" })];
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan.pdf" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove this file?" });
    expect(within(dialog).getByText("It will be deleted from this item and can't be recovered.")).toBeInTheDocument();
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(false);

    const listBefore = getsOf("/attachments");
    const activityBefore = getsOf("/activity");
    net.attachments = [];
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(net.calls.find((c) => c.method === "DELETE")?.url).toBe("/api/pm/attachments/a1"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "plan.pdf" })).not.toBeInTheDocument());
    expect(getsOf("/attachments")).toBeGreaterThan(listBefore);
    expect(getsOf("/activity")).toBeGreaterThan(activityBefore);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove this file?" })).not.toBeInTheDocument());
    expect(screen.getByRole("group", { name: "Add attachments" })).toHaveFocus();
  });

  it("cancel removes nothing", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this file?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove this file?" })).not.toBeInTheDocument());
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(false);
    // Back where the keyboard user was, not stranded.
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove plan.pdf" })).toHaveFocus());
  });

  it("rechecks permission when a removal confirmation was opened before the drawer became read-only", async () => {
    net.user = { id: "u1", role: "owner" };
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    const { setReadOnly } = renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan.pdf" }));
    await screen.findByRole("dialog", { name: "Remove this file?" });
    setReadOnly(true);
    const dialog = screen.getByRole("dialog", { name: "Remove this file?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove this file?" })).not.toBeInTheDocument());
    expect(net.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "plan.pdf" })).toBeInTheDocument();
  });

  it("a failed delete toasts plain copy, keeps the row, and keeps the dialog open to retry", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    net.deleteStatus = 403;
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this file?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Only the person who added a file, or an owner or admin, can remove it.", "error"),
    );
    expect(screen.getByRole("dialog", { name: "Remove this file?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "plan.pdf" })).toBeInTheDocument();
  });

  it("only the uploader or an owner/admin gets a remove button", async () => {
    net.user = { id: "u2", role: "family" };
    net.attachments = [
      att("mine", { fileName: "mine.pdf", uploadedById: "u2" }),
      att("theirs", { fileName: "theirs.pdf", uploadedById: "u1" }),
      att("ai", { fileName: "ai.pdf", uploadedById: null }),
    ];
    const { unmount } = renderDrawer();
    await within(section()).findByRole("link", { name: "theirs.pdf" });
    expect(screen.getByRole("button", { name: "Remove mine.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove theirs.pdf" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove ai.pdf" })).not.toBeInTheDocument();
    unmount();

    net.user = { id: "u3", role: "admin" };
    renderDrawer();
    await within(section()).findByRole("link", { name: "theirs.pdf" });
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
  });

  it("Escape closes only the confirm, not the drawer behind it", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this file?" });
    // The Tab guard must not swallow this: dialogs close from a window listener.
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove this file?" })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("Tab inside the confirm is not hijacked by the drawer's focus trap", async () => {
    net.attachments = [att("a1", { fileName: "plan.pdf" })];
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Remove plan.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this file?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    // fireEvent returns false when a handler called preventDefault — which is
    // what pulls focus back into the drawer and strands the confirm's buttons.
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true);
  });
});

// ── Comments ───────────────────────────────────────────────────────────────

const COMMENT = { id: "c1", workItemId: "w1", authorId: "u1", commentHtml: "<p>look at this</p>", createdAt: hoursAgo(1), updatedAt: hoursAgo(1) };

describe("Files on comments", () => {
  it("lists a comment's own files under it, with download links and a thumbnail for images", async () => {
    net.comments = [COMMENT];
    net.attachments = [
      att("onc", { commentId: "c1", fileName: "shot.png", mimeType: "image/png", previewable: true }),
      att("onc2", { commentId: "c1", fileName: "notes.txt" }),
      att("item", { commentId: null, fileName: "plan.pdf" }),
    ];
    renderDrawer();
    const files = await screen.findByRole("list", { name: "Files attached to this comment" });
    const shot = within(files).getByRole("link", { name: "shot.png" });
    expect(shot).toHaveAttribute("href", "/api/pm/attachments/onc");
    expect(shot).toHaveAttribute("download");
    expect(shot.querySelector("img")).toHaveAttribute("src", "/api/pm/attachments/onc?inline=1");
    const notes = within(files).getByRole("link", { name: /notes\.txt/ });
    expect(notes).toHaveAttribute("href", "/api/pm/attachments/onc2");
    expect(notes.querySelector("img")).toBeNull();
    expect(within(files).queryByRole("link", { name: "plan.pdf" })).not.toBeInTheDocument();
    // The section lists everything on the item, so a comment's file can be removed from there.
    expect(within(section()).getAllByRole("listitem")).toHaveLength(3);
  });

  it("a comment with no files renders no empty list", async () => {
    net.comments = [COMMENT];
    renderDrawer();
    await screen.findByText("look at this");
    expect(screen.queryByRole("list", { name: "Files attached to this comment" })).not.toBeInTheDocument();
  });
});

describe("Comment composer — files", () => {
  const send = () => screen.getByRole("button", { name: /Send/ });
  const type = (value: string) => fireEvent.change(screen.getByLabelText("Write a comment"), { target: { value } });

  it("posts the comment first, then uploads each staged file to that comment", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    type("see attached");
    fireEvent.change(composerInput(), { target: { files: [makeFile("a.txt"), makeFile("b.txt")] } });

    // Staged, not sent: nothing leaves until Send.
    const staged = screen.getByRole("list", { name: "Files to attach" });
    expect(within(staged).getByText("a.txt")).toBeInTheDocument();
    expect(within(staged).getByText("b.txt")).toBeInTheDocument();
    expect(FakeXHR.all).toHaveLength(0);
    expect(net.calls.some((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBe(false);

    fireEvent.click(send());
    await waitFor(() => expect(FakeXHR.all).toHaveLength(2));

    const post = net.calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"));
    expect(post?.body).toEqual({ comment_html: "<p>see attached</p>" });
    expect(FakeXHR.all.map((x) => x.url)).toEqual([
      "/api/pm/work-items/w1/attachments?comment_id=c-new",
      "/api/pm/work-items/w1/attachments?comment_id=c-new",
    ]);
    expect(FakeXHR.all.map((x) => x.file.name)).toEqual(["a.txt", "b.txt"]);
    // Staging is cleared once sent, and the composer is free again.
    expect(screen.queryByRole("list", { name: "Files to attach" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Write a comment")).toHaveValue("");
  });

  it("with no text, staged files alone enable Send and post an empty paragraph", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    expect(send()).toBeDisabled();
    fireEvent.change(composerInput(), { target: { files: [makeFile("a.txt")] } });
    expect(send()).toBeEnabled();
    fireEvent.click(send());
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(net.calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))?.body).toEqual({
      comment_html: "<p></p>",
    });
  });

  it("keeps the drawer's focus trap working from the last control (a hidden input must not be the last stop)", async () => {
    renderDrawer();
    // Empty composer: Send is disabled, so the Attach button is the last real control.
    const attach = await screen.findByRole("button", { name: "Attach files" });
    attach.focus();
    // The Dialog wraps Tab from its last focusable back to its first. It counts
    // every enabled input, hidden file inputs included, so one placed last would
    // let Tab walk out of the modal instead.
    expect(fireEvent.keyDown(attach, { key: "Tab" })).toBe(false);
    // Editing places item actions before Close; Tab wraps to that first control.
    expect(screen.getByRole("button", { name: "Item actions" })).toHaveFocus();
  });

  it("a staged file can be removed before sending", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    fireEvent.change(composerInput(), { target: { files: [makeFile("a.txt"), makeFile("b.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove a.txt" }));
    const staged = screen.getByRole("list", { name: "Files to attach" });
    expect(within(staged).queryByText("a.txt")).not.toBeInTheDocument();
    expect(within(staged).getByText("b.txt")).toBeInTheDocument();
  });

  it("⌘↵ still submits, files included", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    type("quick");
    fireEvent.change(composerInput(), { target: { files: [makeFile("a.txt")] } });
    fireEvent.keyDown(screen.getByLabelText("Write a comment"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
  });

  it("when the comment posts but a file fails: keeps the comment, toasts the count, leaves the row dismissable", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    type("hello");
    fireEvent.change(composerInput(), { target: { files: [makeFile("tool.exe")] } });
    fireEvent.click(send());
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    respond(FakeXHR.all[0], 415, { error: "attachment_type_blocked" });

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Comment sent, but 1 file couldn't be uploaded.", "error"));
    expect(
      within(await uploadRows()).getByText("tool.exe can't be added — executable files aren't allowed."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Write a comment")).toHaveValue(""); // the comment is not lost or re-sent
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/executable files/)).not.toBeInTheDocument();
  });

  it("pluralises the failure toast", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    fireEvent.change(composerInput(), { target: { files: [makeFile("a.exe"), makeFile("b.exe")] } });
    fireEvent.click(send());
    await waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    for (const xhr of FakeXHR.all) respond(xhr, 415, { error: "attachment_type_blocked" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Comment sent, but 2 files couldn't be uploaded.", "error"));
  });

  it("a failed comment POST keeps the text and the staged files, tells the user, and starts no upload", async () => {
    renderDrawer();
    await within(section()).findByText("No attachments yet.");
    type("hello");
    fireEvent.change(composerInput(), { target: { files: [makeFile("a.txt")] } });
    net.commentStatus = 404;
    fireEvent.click(send());
    // the composer's existing failure toast (DASH-002) — this slice only owns what happens to the files
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(screen.getByLabelText("Write a comment")).toHaveValue("hello");
    expect(within(screen.getByRole("list", { name: "Files to attach" })).getByText("a.txt")).toBeInTheDocument();
    expect(FakeXHR.all).toHaveLength(0);
  });

  it("pasting an image stages it for the comment and swallows only that paste", async () => {
    renderDrawer();
    const box = await screen.findByLabelText("Write a comment");
    const shot = new File(["x"], "", { type: "image/png" });
    expect(fireEvent.paste(box, { clipboardData: { files: [shot], getData: () => "" } })).toBe(false);
    expect(within(screen.getByRole("list", { name: "Files to attach" })).getByText("image.png")).toBeInTheDocument();
    expect(FakeXHR.all).toHaveLength(0);

    fireEvent.click(send());
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0].url).toBe("/api/pm/work-items/w1/attachments?comment_id=c-new");
    expect(FakeXHR.all[0].file.name).toBe("image.png");
  });

  it("a plain-text paste behaves exactly as before", async () => {
    renderDrawer();
    const box = await screen.findByLabelText("Write a comment");
    expect(fireEvent.paste(box, { clipboardData: { files: [], getData: () => "pasted words" } })).toBe(true);
    expect(screen.queryByRole("list", { name: "Files to attach" })).not.toBeInTheDocument();
  });

  it("a drop on the composer attaches to the comment, not the item", async () => {
    renderDrawer();
    const box = await screen.findByLabelText("Write a comment");
    fireEvent.dragEnter(box, filesDrag());
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument(); // the drawer-wide hint stays out of the way
    expect(fireEvent.drop(box, filesDrag([makeFile("d.txt")]))).toBe(false);

    expect(FakeXHR.all).toHaveLength(0); // not uploaded to the item
    expect(within(screen.getByRole("list", { name: "Files to attach" })).getByText("d.txt")).toBeInTheDocument();
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument(); // and no stuck hint

    fireEvent.click(send());
    await waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0].url).toBe("/api/pm/work-items/w1/attachments?comment_id=c-new");
  });

  it("the drawer hint comes back after the drag leaves the composer", async () => {
    renderDrawer();
    const box = await screen.findByLabelText("Write a comment");
    const title = await screen.findByRole("heading", { name: "First task" });
    fireEvent.dragEnter(title, filesDrag());
    fireEvent.dragEnter(box, filesDrag());
    fireEvent.dragLeave(title, filesDrag());
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
    fireEvent.dragEnter(title, filesDrag());
    fireEvent.dragLeave(box, filesDrag());
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
  });
});

// ── Activity ───────────────────────────────────────────────────────────────

describe("Activity — attachment verbs", () => {
  const row = (id: string, verb: string, over: Record<string, unknown> = {}) => ({
    id,
    workItemId: "w1",
    actorId: "u1",
    verb,
    field: "attachment",
    oldValue: null,
    newValue: null,
    createdAt: hoursAgo(1),
    ...over,
  });

  it("reads 'added <file>' and 'removed <file>', with plain fallbacks", async () => {
    net.activity = [
      row("1", "attachment_added", { newValue: "spec.pdf" }),
      row("2", "attachment_removed", { oldValue: "old.png" }),
      row("3", "attachment_added"),
      row("4", "attachment_removed"),
    ];
    renderDrawer();
    expect(await screen.findByText("added spec.pdf")).toBeInTheDocument();
    expect(screen.getByText("removed old.png")).toBeInTheDocument();
    expect(screen.getByText("added an attachment")).toBeInTheDocument();
    expect(screen.getByText("removed an attachment")).toBeInTheDocument();
  });

  it("leaves the other verbs' text alone", async () => {
    net.activity = [row("1", "state_changed", { field: "state" }), row("2", "commented", { field: null })];
    renderDrawer();
    expect(await screen.findByText("changed the state")).toBeInTheDocument();
    expect(screen.getByText("added a comment")).toBeInTheDocument();
  });
});

// ── Copy ───────────────────────────────────────────────────────────────────

describe("friendly errors — attachment codes", () => {
  it("maps the spec'd codes to plain-language copy", () => {
    const t = (code: string) => translateError({ code }, "projects");
    expect(t("attachment_forbidden")).toBe("Only the person who added a file, or an owner or admin, can remove it.");
    expect(t("attachment_not_found")).toBe("That file isn't available anymore. It may have been removed.");
    expect(t("attachment_storage_full")).toBe(
      "The Droplet is out of storage space, so the file wasn't saved. Free up some space and try again.",
    );
    expect(t("comment_not_found")).toBe("That comment isn't available anymore. Refresh and try again.");
  });

  it("gives every attachment code its own copy, never the generic fallback or a raw code", () => {
    const fallback = translateError({ code: "something_unmapped" }, "projects");
    for (const code of [
      "attachment_bad_request",
      "attachment_file_required",
      "attachment_empty",
      "attachment_too_large",
      "attachment_type_blocked",
      "attachment_type_mismatch",
      "attachment_forbidden",
      "attachment_not_found",
      "attachment_storage_full",
      "comment_not_found",
    ]) {
      const copy = translateError({ code }, "projects");
      expect(copy, code).not.toBe(fallback);
      expect(copy, code).not.toMatch(/[a-z]+_[a-z]+/);
      expect(copy, code).not.toContain("!");
    }
    expect(translateError({ code: "attachment_empty" }, "projects").toLowerCase()).toContain("empty");
  });
});

// ── Tokens ─────────────────────────────────────────────────────────────────

describe("styling stays on existing tokens", () => {
  it("has no hex literals in the attachments component or its CSS block", () => {
    const tsx = readFileSync(path.join(__dirname, "attachments.tsx"), "utf-8");
    expect(tsx).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const css = readFileSync(path.join(__dirname, "../../app/projects/projects.css"), "utf-8");
    const block = css.slice(css.indexOf("attachments (WARP-1505)"));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // No new custom properties either: it only reads the ones the surface already defines.
    expect(block).not.toMatch(/--pm-[a-z-]+\s*:/);
    expect(block).not.toMatch(/^\s*--[a-z-]+\s*:/m);
  });
});
