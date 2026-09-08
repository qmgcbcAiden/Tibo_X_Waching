import { describe, expect, it } from "vitest";
import { formatShanghai, resolveScheduledTime, resolveTimeEvidence, shanghaiDay } from "../src/time.js";

describe("time conversion", () => {
  const postedAt = "2026-08-30T12:00:00.000Z";

  it("treats PST as fixed UTC-8", () => {
    const result = resolveScheduledTime({
      sourceTimeText: "reset will land at 6pm PST",
      sourceTimezone: "PST",
      scheduledAt: null
    }, postedAt);
    expect(result).toBe("2026-08-31T02:00:00Z");
    expect(formatShanghai(result!)).toBe("2026-08-31 周一 10:00");
  });

  it("anchors a date-less PST clock to Tibo's Pacific posting date", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "exact",
      sourceTimeText: "at 6pm PST",
      sourceTimezone: "PST",
      scheduledAt: "2026-08-31T02:00:00Z"
    }, {
      postedAt: "2026-08-30T19:24:37.000Z",
      cleanText: "Your Codex and ChatGPT Work reset will land at 6pm PST."
    });
    expect(resolution).toMatchObject({
      postedAtDisplay: "2026-08-31 周一 03:24",
      candidateScheduledAt: "2026-08-31T02:00:00Z",
      displayTime: "2026-08-31 周一 10:00",
      status: "exact",
      canSchedule: true
    });
  });

  it("treats PDT and summer PT as UTC-7", () => {
    const pdt = resolveScheduledTime({
      sourceTimeText: "6pm PDT",
      sourceTimezone: "PDT",
      scheduledAt: null
    }, postedAt);
    const pt = resolveScheduledTime({
      sourceTimeText: "6pm PT",
      sourceTimezone: "PT",
      scheduledAt: null
    }, postedAt);
    expect(formatShanghai(pdt!)).toBe("2026-08-31 周一 09:00");
    expect(pt).toBe(pdt);
  });

  it("uses the Shanghai calendar day", () => {
    expect(shanghaiDay("2026-08-30T17:00:00Z")).toBe("2026-08-31");
  });

  it("rejects implausible model timestamps", () => {
    expect(resolveScheduledTime({
      sourceTimeText: "next year maybe",
      sourceTimezone: null,
      scheduledAt: "2028-01-01T00:00:00Z"
    }, postedAt)).toBeNull();
  });

  it("defaults an omitted timezone to PT and records the assumption", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "exact",
      sourceTimeText: "tomorrow at 18:00",
      sourceTimezone: null,
      scheduledAt: "2026-09-01T01:00:00Z"
    }, {
      postedAt: "2026-08-30T12:00:00Z",
      cleanText: "The reset will land tomorrow at 18:00"
    });
    expect(resolution).toMatchObject({
      status: "exact",
      sourceTimezone: "PT",
      timezoneSource: "default_pt",
      candidateScheduledAt: "2026-09-01T01:00:00Z"
    });
    expect(resolution.timezoneAssumption).toContain("原文没有注明时区");
  });

  it("supports noon, weekdays, and English month dates", () => {
    const noon = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "next Friday at noon PST", sourceTimezone: "PST",
      scheduledAt: "2026-09-11T20:00:00Z"
    }, { postedAt: "2026-08-31T12:00:00Z", cleanText: "Reset next Friday at noon PST" });
    expect(noon.candidateScheduledAt).toBe("2026-09-11T20:00:00Z");

    const month = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "September 1 at midnight PDT", sourceTimezone: "PDT",
      scheduledAt: "2026-09-01T07:00:00Z"
    }, { postedAt: "2026-08-31T12:00:00Z", cleanText: "Reset September 1 at midnight PDT" });
    expect(month).toMatchObject({ status: "exact", candidateScheduledAt: "2026-09-01T07:00:00Z" });
  });

  it("does not roll a passed time-only clock into the next day", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "at 6pm", sourceTimezone: null,
      scheduledAt: "2026-09-01T01:00:00Z"
    }, {
      postedAt: "2026-09-01T02:00:00Z",
      cleanText: "The reset will land at 6pm"
    });
    expect(resolution).toMatchObject({
      status: "conflict",
      reasonCode: "candidate_before_post",
      candidateScheduledAt: "2026-09-01T01:00:00Z",
      canSchedule: false
    });
  });

  it("allows a clock no more than five minutes before the post", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "at 6pm PST", sourceTimezone: "PST",
      scheduledAt: "2026-09-01T02:00:00Z"
    }, {
      postedAt: "2026-09-01T02:04:59Z",
      cleanText: "The reset lands at 6pm PST"
    });
    expect(resolution.status).toBe("exact");
  });

  it("rejects DST gaps and folds for dynamic PT", () => {
    const gap = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "today at 2:30am PT", sourceTimezone: "PT",
      scheduledAt: "2026-03-08T10:30:00Z"
    }, { postedAt: "2026-03-08T08:00:00Z", cleanText: "Reset today at 2:30am PT" });
    expect(gap.reasonCode).toBe("dst_nonexistent");

    const fold = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "today at 1:30am PT", sourceTimezone: "PT",
      scheduledAt: "2026-11-01T08:30:00Z"
    }, { postedAt: "2026-11-01T07:00:00Z", cleanText: "Reset today at 1:30am PT" });
    expect(fold.reasonCode).toBe("dst_ambiguous");
  });

  it("requires a literal source quote and model/program agreement", () => {
    const missingQuote = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "tomorrow at 6pm PST", sourceTimezone: "PST",
      scheduledAt: "2026-08-31T02:00:00Z"
    }, { postedAt, cleanText: "The reset happens soon" });
    expect(missingQuote.reasonCode).toBe("source_not_in_post");

    const mismatch = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "at 6pm PST", sourceTimezone: "PST",
      scheduledAt: "2026-08-31T03:00:00Z"
    }, { postedAt, cleanText: "The reset lands at 6pm PST" });
    expect(mismatch.reasonCode).toBe("model_program_mismatch");
  });

  it("keeps vague expressions auditable without creating a schedule", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "vague", sourceTimeText: "during the day", sourceTimezone: null, scheduledAt: null
    }, { postedAt, cleanText: "We will credit users during the day" });
    expect(resolution).toMatchObject({ status: "vague", canSchedule: false, candidateScheduledAt: null });
  });

  it("computes Tibo's approximate banked reset landing time from the X post timestamp", () => {
    const cleanText = "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can. First one will land in ~ 3 hours. There is still time to create your account if you don't have one.";
    const resolution = resolveTimeEvidence({
      timeKind: "approximate",
      sourceTimeText: "in ~ 3 hours",
      sourceTimezone: null,
      scheduledAt: null
    }, {
      postedAt: "2026-09-03T23:12:09.000Z",
      cleanText
    });
    expect(resolution).toMatchObject({
      postedAtDisplay: "2026-09-04 周五 07:12",
      candidateScheduledAt: "2026-09-04T02:12:09Z",
      displayTime: "2026-09-04 周五 10:12",
      status: "approximate",
      reasonCode: "relative_duration",
      canSchedule: true
    });
    expect(resolveScheduledTime({
      timeKind: "approximate",
      sourceTimeText: "in ~ 3 hours",
      sourceTimezone: null,
      scheduledAt: null
    }, "2026-09-03T23:12:09.000Z")).toBe("2026-09-04T02:12:09Z");
  });

  it("supports approximate relative minutes without trusting a model ISO", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "approximate",
      sourceTimeText: "in about 90 minutes",
      sourceTimezone: null,
      scheduledAt: null
    }, {
      postedAt: "2026-09-03T23:12:09Z",
      cleanText: "First reset lands in about 90 minutes"
    });
    expect(resolution).toMatchObject({
      status: "approximate",
      candidateScheduledAt: "2026-09-04T00:42:09Z",
      displayTime: "2026-09-04 周五 08:42",
      canSchedule: true
    });
    const withIso = resolveTimeEvidence({
      timeKind: "approximate",
      sourceTimeText: "in about 90 minutes",
      sourceTimezone: null,
      scheduledAt: "2026-09-04T00:42:09Z"
    }, {
      postedAt: "2026-09-03T23:12:09Z",
      cleanText: "First reset lands in about 90 minutes"
    });
    expect(withIso).toMatchObject({ status: "invalid", reasonCode: "approximate_with_iso", canSchedule: false });
  });

  it("refuses ambiguous numeric dates instead of treating them as the post day", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "9/1 at 6pm PST", sourceTimezone: "PST",
      scheduledAt: "2026-09-02T02:00:00Z"
    }, { postedAt, cleanText: "Reset 9/1 at 6pm PST" });
    expect(resolution).toMatchObject({ status: "invalid", reasonCode: "unsupported_numeric_date", canSchedule: false });
  });

  it("refuses an X post timestamp without an explicit UTC offset", () => {
    const resolution = resolveTimeEvidence({
      timeKind: "exact", sourceTimeText: "at 6pm PST", sourceTimezone: "PST",
      scheduledAt: "2026-09-01T02:00:00Z"
    }, { postedAt: "2026-08-31T12:00:00", cleanText: "Reset at 6pm PST" });
    expect(resolution).toMatchObject({ status: "invalid", reasonCode: "invalid_posted_at", canSchedule: false });
  });
});
