import { describe, expect, it } from "vitest";
import { evaluateSla, parseSlaTerms, type SlaClockInput, type SlaTerms } from "./sla-engine.js";
const date = (iso: string) => new Date(iso);
const terms: SlaTerms = { firstResponseMins: 60, nextResponseMins: 30, resolutionMins: 240, atRiskPercent: 75, calendar: null, nextResponseStartedAt: null, nextResponsePausedMs: 0 };
const base = (over: Partial<SlaClockInput> = {}): SlaClockInput => ({ createdAt: date("2026-10-05T09:00:00Z"), now: date("2026-10-05T09:00:00Z"), clock: "RUNNING", firstRespondedAt: null, solvedAt: null,
  pausedMs: 0, pausedAt: null, terms, previousStatus: "ON_TRACK", ...over });
describe("SLA clock promises", () => {
  it.each([ ["09:44:59", "ON_TRACK"], ["09:45:00", "AT_RISK"], ["10:00:00", "BREACHED"] ])("evaluates exact threshold %s as %s", (time, status) => {
    expect(evaluateSla(base({ now: date(`2026-10-05T${time}Z`) })).slaStatus).toBe(status);
  });
  it("uses elapsed business milliseconds without rounding away a partial minute", () => {
    const result = evaluateSla(base({ now: date("2026-10-05T09:30:30Z") }));
    expect(result.remainingBusinessMs).toBe(1770000);
  });
  it("pauses using the explicit clock, preserves remaining time, and shifts the due date on resume", () => {
    const paused = evaluateSla(base({ now: date("2026-10-05T12:00:00Z"), clock: "PAUSED", pausedAt: date("2026-10-05T09:20:00Z") }));
    expect(paused.slaStatus).toBe("PAUSED");
    expect(paused.remainingBusinessMs).toBe(40 * 60000);
    expect(paused.firstResponseDueAt?.toISOString()).toBe("2026-10-05T12:40:00.000Z");
    const resumed = evaluateSla(base({ now: date("2026-10-05T12:00:00Z"), pausedAt: date("2026-10-05T09:20:00Z"), previousStatus: "PAUSED" }));
    expect(resumed.slaPausedMs).toBe(160n * 60000n);
    expect(resumed.slaPausedAt).toBeNull();
    expect(resumed.firstResponseDueAt).toEqual(paused.firstResponseDueAt);
    expect(resumed.slaStatus).toBe("ON_TRACK");
  });
  it("a weekend Pending interval costs only its open business minutes", () => {
    const calendar = { timezone: "Europe/Bucharest", windows: [1,2,3,4,5].map((day) => ({ day, start: "09:00", end: "17:00" })), holidays: [] };
    const result = evaluateSla(base({ createdAt: date("2026-10-23T13:00:00Z"), pausedAt: date("2026-10-23T13:30:00Z"), now: date("2026-10-26T08:00:00Z"), terms: { ...terms, calendar } }));
    // DST ended over this weekend: Friday 16:30 and Monday 10:00 local.
    expect(result.slaPausedMs).toBe(90n * 60000n);
    expect(result.firstResponseDueAt?.toISOString()).toBe("2026-10-26T08:30:00.000Z");
    expect(result.remainingBusinessMs).toBe(30 * 60000);
  });
  it("a holiday never turns into consumed SLA time", () => {
    const calendar = { timezone: "UTC", windows: [1,2,3,4,5].map((day) => ({ day, start: "09:00", end: "17:00" })), holidays: ["2026-10-06"] };
    const result = evaluateSla(base({ createdAt: date("2026-10-05T16:30:00Z"), now: date("2026-10-06T12:00:00Z"), terms: { ...terms, calendar } }));
    expect(result.firstResponseDueAt?.toISOString()).toBe("2026-10-07T09:30:00.000Z");
    expect(result.slaStatus).toBe("ON_TRACK");
  });
  it("judges a late first reply before dropping the completed target", () => {
    const result = evaluateSla(base({ now: date("2026-10-05T10:15:00Z"), firstRespondedAt: date("2026-10-05T10:15:00Z") }));
    expect(result.firstResponseDueAt).toBeNull(); expect(result.slaStatus).toBe("BREACHED"); expect(result.metric).toBe("firstResponse");
  });
  it("does not lose a breach when the ticket is solved", () => {
    expect(evaluateSla(base({ clock: "STOPPED", solvedAt: date("2026-10-05T10:30:00Z"), firstRespondedAt: date("2026-10-05T09:30:00Z"), previousStatus: "BREACHED" })).slaStatus).toBe("BREACHED");
  });
  it("records MET when stopped within the promise", () => {
    const result = evaluateSla(base({ now: date("2026-10-05T10:00:00Z"), clock: "STOPPED", solvedAt: date("2026-10-05T10:00:00Z"), firstRespondedAt: date("2026-10-05T09:30:00Z") }));
    expect(result.slaStatus).toBe("MET"); expect(result.resolutionDueAt).toBeNull();
  });
  it("the next-response cycle does not inherit pauses before the customer message", () => {
    const result = evaluateSla(base({ createdAt: date("2026-10-05T08:00:00Z"), now: date("2026-10-05T12:15:00Z"), pausedMs: 120*60000, firstRespondedAt: date("2026-10-05T08:30:00Z"), terms: { ...terms, resolutionMins: null, nextResponseStartedAt: "2026-10-05T12:00:00Z", nextResponsePausedMs: 120*60000 } }));
    expect(result.nextResponseDueAt?.toISOString()).toBe("2026-10-05T12:30:00.000Z"); expect(result.remainingBusinessMs).toBe(15 * 60000);
  });
  it("reads frozen calendar/terms and rejects malformed persisted terms", () => {
    expect(() => parseSlaTerms({ ...terms, firstResponseMins: -1 })).toThrow();
    expect(() => parseSlaTerms({ ...terms, calendar: { timezone: "UTC", windows: [], holidays: [] } })).toThrow();
    expect(parseSlaTerms(terms)).toMatchObject({ firstResponseMins: 60, calendar: null });
  });
});
