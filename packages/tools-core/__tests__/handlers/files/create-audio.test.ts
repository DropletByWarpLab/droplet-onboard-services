import { describe, expect, it, vi } from "vitest";
import createAudio from "../../../src/handlers/files/create-audio.js";
import type { ToolContext } from "../../../src/types.js";
const INPUT = { path: "/speech.wav", text: "Hello", voice: "af_heart" };
const SAVED = { path: INPUT.path, filename: "speech.wav", bytes: 48044, mimeType: "audio/wav", sampleRate: 24000, durationSeconds: 1, voice: "af_heart", warnings: [] };
function context(body: unknown = SAVED, status = 200) {
  const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return { post, ctx: { userId: "alice", ncToken: "nc-token", signal: new AbortController().signal, http: { nextcloud: { post } } } as unknown as ToolContext };
}
describe("create_audio", () => {
  it("sends only bounded text and the installed voice name to the actor-scoped output route", async () => {
    const { ctx, post } = context();
    const result = await createAudio.handler(INPUT, ctx);
    expect(post).toHaveBeenCalledWith("/audio", INPUT, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "nc-token" }, signal: ctx.signal });
    expect(result).toMatchObject({ ok: true, data: { path: INPUT.path, mimeType: "audio/wav", media: { kind: "file", path: INPUT.path, mimeType: "audio/wav" } } });
    expect(createAudio.requiresWrite).toBe(true); expect(createAudio.requiresConfirmation).toBe(false);
    expect(JSON.stringify(createAudio.inputSchema).length + createAudio.description.length).toBeLessThan(2000);
  });
  it("leaves the voice default to the running local server", async () => {
    const { ctx, post } = context(); await createAudio.handler({ path: INPUT.path, text: INPUT.text }, ctx);
    expect(post.mock.calls[0][1]).not.toHaveProperty("voice");
  });
  it.each([{ path: "/Dept/speech.wav" }, { path: "/%2e%2e.wav" }, { path: "/speech.mp3" }, { path: "/speech.wav/" }, { text: "" }, { text: "x".repeat(2001) }, { text: "a\0" }, { voice: "../../model" }])("refuses invalid args before network calls %j", async (bad) => {
    const { ctx, post } = context(); expect((await createAudio.handler({ ...INPUT, ...bad }, ctx)).ok).toBe(false); expect(post).not.toHaveBeenCalled();
  });
  it("requires connected file credentials", async () => {
    const { ctx, post } = context(); ctx.ncToken = undefined;
    expect(await createAudio.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } }); expect(post).not.toHaveBeenCalled();
  });
  it.each([[409, "ALREADY_EXISTS"], [400, "INVALID_ARGS"], [429, "AUDIO_BUSY"], [408, "AUDIO_TIMEOUT"], [413, "TOO_LARGE"], [503, "AUDIO_UNAVAILABLE"]])("maps HTTP %s to useful %s errors", async (status, code) => {
    const { ctx } = context({ error: "An actionable reason." }, status as number);
    expect(await createAudio.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code, message: "An actionable reason." } });
  });
  it.each([{ path: "/victim.wav" }, { mimeType: "text/html" }, { bytes: Infinity }, { durationSeconds: 181 }, { sampleRate: 999999 }, { filename: "other.wav" }])("does not fabricate a file card from malformed metadata %j", async (bad) => {
    const { ctx } = context({ ...SAVED, ...bad }); expect(await createAudio.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code: "AUDIO_UNAVAILABLE" } });
  });
});
