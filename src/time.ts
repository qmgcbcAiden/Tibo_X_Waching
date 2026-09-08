import { DateTime } from "luxon";
import type { TimeKind, TimeResolution } from "./types.js";

export const SHANGHAI_ZONE = "Asia/Shanghai";
const PACIFIC_ZONE = "America/Los_Angeles";

const WEEKDAYS = ["", "一", "二", "三", "四", "五", "六", "日"];

export function shanghaiDay(instant: Date | string = new Date()): string {
  const value = typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant);
  return value.setZone(SHANGHAI_ZONE).toFormat("yyyy-MM-dd");
}

export function formatShanghai(instant: Date | string): string {
  const value = typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant);
  const local = value.setZone(SHANGHAI_ZONE);
  return `${local.toFormat("yyyy-MM-dd")} 周${WEEKDAYS[local.weekday]} ${local.toFormat("HH:mm")}`;
}

export function shanghaiDayBoundsUtc(day: string): { start: string; end: string } {
  const start = DateTime.fromISO(day, { zone: SHANGHAI_ZONE }).startOf("day");
  return { start: start.toUTC().toISO()!, end: start.plus({ days: 1 }).toUTC().toISO()! };
}

export function nextShanghaiMidnight(instant: Date | string = new Date()): string {
  const value = typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant);
  return value.setZone(SHANGHAI_ZONE).plus({ days: 1 }).startOf("day").toUTC().toISO()!;
}

export function isAtOrAfterShanghaiTime(instant: Date, hhmm: string): boolean {
  return DateTime.fromJSDate(instant).setZone(SHANGHAI_ZONE).toFormat("HH:mm") >= hhmm;
}

export function isCrossDayWindow(instant: Date): boolean {
  const value = DateTime.fromJSDate(instant).setZone(SHANGHAI_ZONE);
  return value.hour > 0 || value.minute >= 1;
}

export interface ModelTime {
  timeKind?: TimeKind;
  sourceTimeText: string | null;
  sourceTimezone: string | null;
  scheduledAt: string | null;
}

const MAX_SCHEDULE_DAYS = 30;
const PAST_GRACE_MINUTES = 5;
const MODEL_TOLERANCE_MS = 60_000;
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12
};
const WEEKDAY_NUMBERS: Record<string, number> = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6, sunday: 7, sun: 7
};

interface ClockValue { hour: number; minute: number }

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function result(
  postedAt: DateTime,
  sourceTimeText: string | null,
  sourceTimezone: "PST" | "PDT" | "PT" | null,
  timezoneSource: "explicit" | "default_pt" | null,
  modelScheduledAt: string | null,
  candidate: DateTime | null,
  status: TimeResolution["status"],
  reasonCode: string,
  reason: string,
  canSchedule = false
): TimeResolution {
  const candidateIso = candidate?.toUTC().toISO({ suppressMilliseconds: true }) ?? null;
  return {
    postedAtUtc: postedAt.toUTC().toISO({ suppressMilliseconds: true })!,
    postedAtSourceTimezone: "UTC",
    postedAtDisplay: formatShanghai(postedAt.toISO()!),
    sourceTimeText,
    sourceTimezone,
    timezoneSource,
    timezoneAssumption: timezoneSource === "default_pt" ? "原文没有注明时区，按 PT（America/Los_Angeles）计算" : null,
    modelScheduledAt,
    candidateScheduledAt: candidateIso,
    displayTime: candidateIso ? formatShanghai(candidateIso) : null,
    status,
    reasonCode,
    reason,
    canSchedule
  };
}

function extractClock(source: string): { clock: ClockValue | null; count: number } {
  const matches = [...source.matchAll(/\b(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2})\b/gi)];
  if (matches.length !== 1) return { clock: null, count: matches.length };
  const value = matches[0]![0]!.toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (value === "noon") return { clock: { hour: 12, minute: 0 }, count: 1 };
  if (value === "midnight") return { clock: { hour: 0, minute: 0 }, count: 1 };
  const twelve = value.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = Number(twelve[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return { clock: null, count: 1 };
    if (twelve[3] === "pm" && hour !== 12) hour += 12;
    if (twelve[3] === "am" && hour === 12) hour = 0;
    return { clock: { hour, minute }, count: 1 };
  }
  const twentyFour = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!twentyFour) return { clock: null, count: 1 };
  const hour = Number(twentyFour[1]);
  const minute = Number(twentyFour[2]);
  return hour <= 23 && minute <= 59
    ? { clock: { hour, minute }, count: 1 }
    : { clock: null, count: 1 };
}

function extractRelativeDuration(source: string): { durationMs: number | null; count: number } {
  const matches = [...source.matchAll(
    /\bin\s*(?:(?:~|about|around|approximately|approx\.?|roughly)\s*)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/gi
  )];
  if (matches.length !== 1) return { durationMs: null, count: matches.length };
  const amount = Number(matches[0]![1]);
  if (!Number.isFinite(amount) || amount <= 0) return { durationMs: null, count: 1 };
  const unit = matches[0]![2]!.toLowerCase();
  const multiplier = unit.startsWith("h") ? 60 * 60 * 1000 : 60 * 1000;
  return { durationMs: Math.round(amount * multiplier), count: 1 };
}

function resolveCalendarDate(source: string, posted: DateTime): { date: DateTime | null; reason?: string } {
  const relative = source.match(/\b(today|tonight|tomorrow)\b/i);
  const weekday = source.match(/\b(?:(this|next)\s+)?(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/i);
  const month = source.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i);
  const kinds = [relative, weekday, month].filter(Boolean).length;
  if (kinds > 1) return { date: null, reason: "原文同时包含多种日期表达，无法唯一确定日期" };

  if (relative) {
    return { date: relative[1]!.toLowerCase() === "tomorrow" ? posted.plus({ days: 1 }) : posted };
  }
  if (weekday) {
    const modifier = weekday[1]?.toLowerCase() ?? "";
    const target = WEEKDAY_NUMBERS[weekday[2]!.toLowerCase()]!;
    if (modifier === "this") return { date: posted.startOf("week").plus({ days: target - 1 }) };
    if (modifier === "next") return { date: posted.startOf("week").plus({ days: target + 6 }) };
    return { date: posted.plus({ days: (target - posted.weekday + 7) % 7 }) };
  }
  if (month) {
    const monthNumber = MONTHS[month[1]!.toLowerCase()]!;
    const day = Number(month[2]);
    const explicitYear = month[3] ? Number(month[3]) : null;
    const years = explicitYear ? [explicitYear] : [posted.year, posted.year + 1];
    for (const year of years) {
      const value = DateTime.fromObject({ year, month: monthNumber, day }, { zone: posted.zoneName ?? PACIFIC_ZONE });
      if (!value.isValid || value.month !== monthNumber || value.day !== day) continue;
      if (explicitYear || value.startOf("day") >= posted.startOf("day")) return { date: value };
    }
    return { date: null, reason: "英文月日无法映射到发帖后 30 天内的日期" };
  }
  return { date: posted };
}

function hasUnsupportedTimezone(source: string): boolean {
  return /\b(?:UTC|GMT|EST|EDT|ET|CST|CDT|CT|MST|MDT|MT|CET|CEST|BST)\b/i.test(source);
}

/**
 * Build an auditable time resolution. The model is treated as an extractor;
 * only this deterministic result may authorize a reminder.
 */
export function resolveTimeEvidence(
  model: ModelTime,
  tweet: { postedAt: string; cleanText: string }
): TimeResolution {
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(tweet.postedAt.trim());
  const postedAt = DateTime.fromISO(tweet.postedAt, { setZone: true });
  const sourceText = model.sourceTimeText?.trim() || null;
  const modelTime = model.scheduledAt?.trim() || null;
  if (!hasExplicitOffset || !postedAt.isValid) {
    const fallback = DateTime.fromMillis(0, { zone: "UTC" });
    return result(fallback, sourceText, null, null, modelTime, null, "invalid", "invalid_posted_at", "X 发帖时间必须是带 Z 或明确偏移的绝对时间");
  }

  const timeKind = model.timeKind ?? (sourceText || modelTime ? "exact" : "none");
  if (timeKind === "none") {
    if (sourceText || modelTime) return result(postedAt, sourceText, null, null, modelTime, null, "invalid", "unexpected_time_fields", "无时间事件却包含时间字段");
    return result(postedAt, null, null, null, null, null, "none", "no_time_expression", "原文没有需要换算的时间表达");
  }
  if (!sourceText) return result(postedAt, null, null, null, modelTime, null, "invalid", "missing_source_time", "模型没有提供原文时间片段");
  if (!normalizeEvidenceText(tweet.cleanText).includes(normalizeEvidenceText(sourceText))) {
    return result(postedAt, sourceText, null, null, modelTime, null, "invalid", "source_not_in_post", "模型提供的时间片段不在原帖中");
  }
  if (timeKind === "approximate") {
    if (modelTime) {
      return result(postedAt, sourceText, null, null, modelTime, null, "invalid", "approximate_with_iso", "近似相对时间由程序按发帖时间计算，模型不应提供 ISO 时间");
    }
    if (model.sourceTimezone?.trim()) {
      return result(postedAt, sourceText, null, null, null, null, "invalid", "approximate_with_timezone", "近似相对时间不应由模型添加时区");
    }
    const relative = extractRelativeDuration(sourceText);
    if (relative.count > 1) {
      return result(postedAt, sourceText, null, null, null, null, "conflict", "multiple_time_candidates", "原文时间片段包含多个相对时长");
    }
    if (relative.durationMs === null) {
      return result(postedAt, sourceText, null, null, null, null, "invalid", "unparseable_relative_time", "无法从原文片段解析受支持的相对时长");
    }
    const candidate = postedAt.plus({ milliseconds: relative.durationMs });
    if (candidate > postedAt.plus({ days: MAX_SCHEDULE_DAYS })) {
      return result(postedAt, sourceText, null, null, null, candidate, "invalid", "candidate_out_of_range", "目标时间超过发帖后 30 天");
    }
    return result(postedAt, sourceText, null, null, null, candidate, "approximate", "relative_duration", "原文提供了近似相对时间，按 X 发帖时间顺延计算", true);
  }
  if (timeKind === "vague") {
    if (modelTime) return result(postedAt, sourceText, null, null, modelTime, null, "invalid", "vague_with_iso", "模糊时间不应包含精确 ISO 时间");
    return result(postedAt, sourceText, null, null, null, null, "vague", "vague_expression", "原文只有模糊时间，无法创建到点任务");
  }

  if (hasUnsupportedTimezone(sourceText)) {
    return result(postedAt, sourceText, null, null, modelTime, null, "invalid", "unsupported_timezone", "原文使用了首版不支持的时区");
  }
  if (/\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/.test(sourceText)) {
    return result(postedAt, sourceText, null, null, modelTime, null, "invalid", "unsupported_numeric_date", "数字日期存在地区歧义，首版不自动排期");
  }
  const explicitZones = [...sourceText.matchAll(/\b(PST|PDT|PT)\b/gi)].map((item) => item[1]!.toUpperCase());
  const distinctZones = [...new Set(explicitZones)];
  if (distinctZones.length > 1) {
    return result(postedAt, sourceText, null, null, modelTime, null, "conflict", "multiple_timezones", "原文时间片段包含多个时区");
  }
  const explicitZone = (distinctZones[0] ?? null) as "PST" | "PDT" | "PT" | null;
  const claimedZone = model.sourceTimezone?.trim().toUpperCase() || null;
  if (explicitZone && claimedZone && claimedZone !== explicitZone) {
    return result(postedAt, sourceText, explicitZone, "explicit", modelTime, null, "conflict", "timezone_mismatch", "模型时区与原文不一致");
  }
  if (!explicitZone && claimedZone && claimedZone !== "PT") {
    return result(postedAt, sourceText, null, "default_pt", modelTime, null, "conflict", "invented_timezone", "原文没有时区，但模型添加了其他时区");
  }
  const sourceTimezone = explicitZone ?? "PT";
  const timezoneSource = explicitZone ? "explicit" : "default_pt";
  const zone = sourceTimezone === "PST" ? "UTC-8" : sourceTimezone === "PDT" ? "UTC-7" : PACIFIC_ZONE;
  const postedInZone = postedAt.setZone(zone);
  const extracted = extractClock(sourceText);
  if (extracted.count > 1) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, null, "conflict", "multiple_time_candidates", "原文时间片段包含多个钟点");
  }
  if (!extracted.clock) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, null, "invalid", "unparseable_time", "无法从原文片段解析受支持的钟点");
  }
  const calendar = resolveCalendarDate(sourceText, postedInZone);
  if (!calendar.date) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, null, "conflict", "ambiguous_date", calendar.reason ?? "无法唯一确定日期");
  }
  const candidate = DateTime.fromObject({
    year: calendar.date.year,
    month: calendar.date.month,
    day: calendar.date.day,
    hour: extracted.clock.hour,
    minute: extracted.clock.minute
  }, { zone });
  if (!candidate.isValid || candidate.hour !== extracted.clock.hour || candidate.minute !== extracted.clock.minute) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate.isValid ? candidate : null, "conflict", "dst_nonexistent", "PT 当地时间落在夏令时跳过区间");
  }
  if (sourceTimezone === "PT" && candidate.getPossibleOffsets().length > 1) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "conflict", "dst_ambiguous", "PT 当地时间在夏令时切换时重复出现");
  }
  if (candidate < postedAt.minus({ minutes: PAST_GRACE_MINUTES })) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "conflict", "candidate_before_post", "按发帖当天计算的目标时间早于发帖时间，不能自动顺延");
  }
  if (candidate > postedAt.plus({ days: MAX_SCHEDULE_DAYS })) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "invalid", "candidate_out_of_range", "目标时间超过发帖后 30 天");
  }
  if (!modelTime || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(modelTime)) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "invalid", "model_time_missing", "模型没有提供带时区的 ISO 时间用于交叉校验");
  }
  const modelDate = DateTime.fromISO(modelTime, { setZone: true });
  if (!modelDate.isValid) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "invalid", "model_time_invalid", "模型 ISO 时间无效");
  }
  if (Math.abs(modelDate.toMillis() - candidate.toMillis()) > MODEL_TOLERANCE_MS) {
    return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "conflict", "model_program_mismatch", "模型时间与程序按原文重算的结果不一致");
  }
  return result(postedAt, sourceText, sourceTimezone, timezoneSource, modelTime, candidate, "exact", "validated", "原文、发帖时间、时区和模型结果一致", true);
}

/**
 * Resolve explicit Pacific clock expressions and supported relative durations
 * deterministically. PST/PDT are fixed offsets; PT follows America/Los_Angeles DST.
 */
export function resolveScheduledTime(model: ModelTime, postedAt: string): string | null {
  const evidence = resolveTimeEvidence(
    { ...model, timeKind: model.timeKind ?? "exact" },
    { postedAt, cleanText: model.sourceTimeText ?? "" }
  );
  return ["exact", "approximate"].includes(evidence.status) || evidence.reasonCode === "model_time_missing"
    ? evidence.candidateScheduledAt
    : null;
}

export function millisecondsUntil(instant: string, now = new Date()): number {
  return DateTime.fromISO(instant).toMillis() - now.getTime();
}
