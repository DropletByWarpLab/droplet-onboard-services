/**
 * WARP-1874 — the zod binding for a video-call link.
 *
 * The rule itself lives in `@droplet/shared-types` (`parseMeetingLink`), so
 * the dashboard can apply the identical check at render time without
 * pulling a server dependency. This module is only the adapter that puts
 * that rule in front of every orchestrator write path — calendar events
 * and team-chat meetings both import it, so there is exactly one place
 * where a string is allowed to become an href.
 *
 * The schema TRANSFORMS to the parser's normalized href rather than passing
 * the request string through. That closes the gap where a value is
 * validated in one parse and rendered from a differently-parsed second one.
 */

import { z } from "zod";
import { MEETING_URL_MAX_LENGTH, parseMeetingLink } from "@droplet/shared-types";

export const meetingUrlSchema = z
  .string()
  .max(MEETING_URL_MAX_LENGTH)
  .transform((raw, ctx) => {
    const link = parseMeetingLink(raw);
    if (!link) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "meetingUrl must be an https:// meeting link (http and other schemes are refused)",
      });
      return z.NEVER;
    }
    return link.url;
  });
