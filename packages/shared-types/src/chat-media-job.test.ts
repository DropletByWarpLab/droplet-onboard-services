import { describe, expect, it } from "vitest";
import { mediaJobMedia, parseOneChatMedia } from "./chat-media";
const id = "e6451c31-5229-40a7-89bc-98d986531c5a";
describe("owner-authorized job descriptors", () => {
  it("round trips a valid descriptor", () => expect(parseOneChatMedia(mediaJobMedia(id))).toEqual(mediaJobMedia(id)));
  it.each(["../x", "bad", "/api/auth", "http://example.com"])("refuses invalid job identifier %s", (jobId) => expect(parseOneChatMedia({ kind: "media_job", jobId, statusUrl: `/api/files/media/${jobId}` })).toBeNull());
  it.each(["/api/auth", "https://example.com", `/api/files/media/${id}/cancel`, `/api/files/media/${id}?owner=victim`])("refuses altered API route %s", (statusUrl) => expect(parseOneChatMedia({ ...mediaJobMedia(id), statusUrl })).toBeNull());
});
