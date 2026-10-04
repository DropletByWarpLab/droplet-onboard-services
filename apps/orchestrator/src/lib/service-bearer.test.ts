import { afterEach, describe, expect, it } from "vitest";
import { serviceBearerHeader, VOICE_IO_TOKEN_ENV } from "./service-bearer.js";

describe("serviceBearerHeader (WARP-3625)", () => {
  afterEach(() => {
    delete process.env[VOICE_IO_TOKEN_ENV];
  });

  it("sends a Bearer header when the token is set", () => {
    process.env[VOICE_IO_TOKEN_ENV] = "  abc123  ";
    expect(serviceBearerHeader(VOICE_IO_TOKEN_ENV)).toEqual({
      Authorization: "Bearer abc123",
    });
  });

  it("sends nothing when the token is unset or blank", () => {
    expect(serviceBearerHeader(VOICE_IO_TOKEN_ENV)).toEqual({});
    process.env[VOICE_IO_TOKEN_ENV] = "   ";
    expect(serviceBearerHeader(VOICE_IO_TOKEN_ENV)).toEqual({});
  });
});
