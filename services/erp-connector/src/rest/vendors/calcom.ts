/**
 * WARP-2828 / ADR-046 — Cal.com scheduling, as a declarative REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner mints the key entirely inside their own console — name
 * beside their avatar → *My Settings* → *Developer* → *API keys* → *+ Add*,
 * naming the key and setting its expiry. Warp Lab registers nothing, reviews
 * nothing and holds nothing. It works on ANY plan, free included.
 *
 * 🔴 **Do NOT validate the key's prefix.** A hosted live key is `cal_live_…`
 * and a hosted TEST key is `cal_…` with no second segment — there is no
 * `cal_test_` production shape, so a `^cal_(live|test)_` intake pattern REJECTS
 * valid keys. Worse for self-hosted: the prefix is not a vendor constant at
 * all, it is an operator-configurable environment variable
 * (`API_KEY_PREFIX`, default `cal_`), so a self-hoster can mint keys with any
 * prefix they like. This is the Brevo reasoning exactly: a rejecting pattern
 * anchored on an undocumented or configurable prefix is a false rejection that
 * blocks a paying customer for zero security gain. Emptiness is the only thing
 * refused.
 *
 * ## Hosted only, deliberately
 *
 * Cal.com ships two things that answer to the same name, and they run two
 * DIFFERENT API contracts:
 *
 * * **Hosted** — `https://api.cal.com`, one static host, `cursor`/`limit`
 *   pagination, `cal-api-version: 2026-05-01`. That is this profile.
 * * **Self-hosted (`cal.diy`)** — a customer-supplied origin, `take`/`skip`
 *   pagination, `cal-api-version: 2024-08-13`, and a FEATURE-REDUCED build that
 *   excludes Organizations, Workflows, AI Phone and Enterprise SSO. It is a
 *   second profile, not a variable host on this one, and it needs a
 *   `kind: dynamic` egress entry with its own exact-host guard. Not shipped
 *   here — a `limit-offset` profile against a host we have no test instance for
 *   would be a guess presented as an integration.
 *
 * The BOOKING ROW SHAPE is identical across the two, so when the self-hosted
 * profile lands it reuses this field map verbatim. Two profiles are needed for
 * the transport, not for the projection.
 *
 * ## 🔴 Two canonical columns have NO honest source, and they stay undefined
 *
 * `CANONICAL_COLUMNS.appointment` is the PRACTICE-MANAGEMENT vocabulary
 * (WARP-1964, dental): `appt_id`, `appt_time`, `provider_id`, `operatory_id`,
 * `status`, `patient_id`. Cal.com is a general booking product:
 *
 * * **`patient_id`** — Cal.com's `BookingAttendee` has NO `id` field at all
 *   (name, email, displayEmail, timeZone, language, absent, phoneNumber), and
 *   Cal.com serves no `patient` dataset, so there is nothing for a patient id to
 *   point AT. Using the attendee's email would put a contact detail in an
 *   identifier column and silently make a customer's email address a join key.
 * * **`operatory_id`** — Cal.com has no room, chair or operatory concept.
 *   `location` is free text that is variously a meeting URL, a phone number, a
 *   street address, or the literal `"Cal Video"` — four kinds of value for a
 *   column that means one thing.
 *
 * Both are therefore ABSENT from the field map, and `projectCanonicalRow`
 * writes them `undefined`. `calcom-profile.test.ts` PINS them undefined so that a later
 * well-meaning pass cannot stuff the attendee email or the location string into
 * them. That is the honest reading of "this vendor does not carry that fact".
 *
 * ⚠ **Open question this profile does not settle.** The stricter reading of the
 * dataset-naming rule — *two vendors serve the same dataset name only when
 * their rows are interchangeable* — says a scheduling vendor wants a
 * scheduling dataset, not the dental one, and that the real fix is the dataset
 * vocabulary widening ADR-046's own follow-ups call for ("a deliberate, gated
 * change and its own ticket — not an append"). Shipping here with the two
 * columns pinned undefined is the narrower, reversible option; if the widening
 * lands, this profile moves to the new name and the pin becomes unnecessary.
 * Flagged for Romain rather than decided in this file.
 */
import type { RestVendorProfile } from "../profile.js";

export const CALCOM_PROVIDER = "calcom";

/**
 * Cal.com's HOSTED API origin. One static host — so this is a plain
 * `kind: egress` allowlist entry the static scanner reads directly from this
 * literal.
 *
 * `cal.com` is separately registered `kind: reference` — not because the box
 * dials it, but because the BRAND NAME is a hostname: `displayName: "Cal.com"`
 * and the credential help text are string literals, and the WARP-2467 bare-host
 * pass reads literal contents. The alternative was renaming the vendor in its
 * own descriptor to satisfy a scanner.
 */
export const CALCOM_API_ORIGIN = "https://api.cal.com";

/**
 * 🔴 THE SINGLE MOST LOAD-BEARING CONSTANT IN THIS PROFILE.
 *
 * `cal-api-version` is `required: true` on `GET /v2/bookings`, and omitting it
 * is WORSE than a 400 — Cal.com's own note: *"Not passing the correct value
 * will default to an older version of this endpoint."* The hosted spec still
 * serves `GetBookingsOutput_2024_08_13` alongside the current one, so an
 * unversioned request gets the OLD take/skip endpoint with a differently shaped
 * pagination object. A profile that forgot this header would page through the
 * first rows, find no `nextCursor` where it looked, and report a COMPLETE
 * incremental sync over a fraction of the data.
 *
 * ⚠ The value is PER ENDPOINT, not per vendor: `GET /v2/bookings` is
 * `2026-05-01` while `POST /v2/bookings` is `2026-02-25` on the same API. Any
 * dataset added here must have its own value looked up — carrying this one
 * across is the ADR-046 §2 per-dataset failure, one level up from the
 * watermark. It lives in `constantHeaders` only because this profile serves
 * exactly one endpoint today.
 */
export const CALCOM_BOOKINGS_API_VERSION = "2026-05-01";

/**
 * 120 requests per minute for API-key authentication, verbatim from Cal.com's
 * rate-limit page → one request per 500 ms.
 *
 * A published ceiling, so unlike Square this profile paces against it. Cal.com
 * says it can be raised on request; the floor is what a customer gets without
 * asking, so the floor is what the box assumes.
 */
export const CALCOM_MIN_REQUEST_INTERVAL_MS = 500;

export const CALCOM_PROFILE: RestVendorProfile = {
  provider: CALCOM_PROVIDER,
  baseUrl: { kind: "static", origin: CALCOM_API_ORIGIN },
  // A genuine RFC-6750 Bearer scheme. Cal.com's own parameter description:
  // "value must be `Bearer <token>` where `<token>` is api key prefixed with
  // cal_, managed user access token, or OAuth access token".
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{apiKey}}" },
  constantHeaders: { "cal-api-version": CALCOM_BOOKINGS_API_VERSION },
  // `GET /v2/me` returns the key's own user and nothing else — no pagination,
  // one row, and a 401 on it is unambiguous evidence about the key.
  probePath: "/v2/me",
  minRequestIntervalMs: CALCOM_MIN_REQUEST_INTERVAL_MS,
  datasets: [
    {
      dataset: "booking",
      path: "/v2/bookings",
      watermark: {
        name: "afterUpdatedAt",
        location: "query",
        format: "iso",
        // A genuine last-modified filter — which matters here because a
        // booking's `status` moves after creation (accepted → cancelled), and
        // a creation-time filter would freeze every cancellation out of view.
        complete: true,
      },
      // Hosted pagination: request param `cursor`, response
      // `pagination.nextCursor` (opaque, nullable). Page size is `limit`
      // (max 100, default 50) — NOT `take`, which is the SELF-HOSTED spelling.
      pagination: { kind: "cursor", nextCursorPath: "pagination.nextCursor", cursorParam: "cursor" },
      rowsPath: "data",
      fieldMap: {
        // `uid`, NOT `id`. `uid` is the API's own addressing key, used as
        // `{bookingUid}` in every other bookings path; `id` is a numeric
        // per-row key that is not the documented identifier.
        booking_id: "uid",
        starts_at: "start",
        ends_at: "end",
        status: "status",
        // LOSSY and knowingly so: round-robin and collective event types return
        // MULTIPLE hosts and this column holds one. The first host is the
        // organiser in Cal.com's own ordering, which is the closest thing to
        // "the staff member" the canonical column means.
        staff_id: "hosts[0].id",
        // 🔴 `customer_id` stays UNMAPPED and `customer_name` carries the
        // attendee instead. Cal.com's `BookingAttendee` has no `id` field at
        // all — only name, email, displayEmail, timeZone, language, absent and
        // phoneNumber — so there is no identifier to put in an `_id` column.
        // Using the email would make a contact detail a join key, which is the
        // exact defect `customer_name` was added to this dataset to avoid.
        customer_name: "attendees[0].name",
        service_name: "title",
        created_at: "createdAt",
        // The watermark's own value, landing in a column for the first time:
        // `appointment` is one of the datasets WARP-2464 withheld `updated_at`
        // from, so while Cal.com served that name its complete
        // `afterUpdatedAt` filter had nowhere to go.
        updated_at: "updatedAt",
      },
    },
  ],
};
