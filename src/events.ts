import type { Store } from "./db.js";
import type { NotificationService } from "./notifier.js";
import type { Classification, NotificationFacts, NotificationMessage, QuotaEvent, TweetRecord } from "./types.js";
import { formatShanghai, millisecondsUntil } from "./time.js";
import { resolveTimeEvidence } from "./time.js";
import { stableId } from "./text.js";
import { logger } from "./logger.js";

function productKey(products: string[]): string {
  return [...new Set(products.map((item) => item.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .join("+");
}

function isSchedulableStatus(status: NonNullable<Classification["timeResolution"]>["status"]): boolean {
  return status === "exact" || status === "approximate";
}

function sourceBody(classification: Classification, tweet: TweetRecord, scheduledAt?: string | null): string {
  const productLabel = classification.products.join("、") || "Codex / ChatGPT Work";
  const summary = scheduledAt
    ? classification.eventType === "BANKED_RESET"
      ? `Tibo ${classification.verdict === "UNCERTAIN" ? "可能预告" : "预告"}${productLabel} 的可存储重置次数预计将在指定时间到账，可存 30 天。`
      : `Tibo ${classification.verdict === "UNCERTAIN" ? "可能预告" : "预告"}${productLabel}额度将在指定时间刷新。`
    : classification.summaryZh;
  const parts = [summary];
  const time = classification.timeResolution;
  if (time && time.status !== "none") {
    parts.push(`Tibo 发帖：${time.postedAtDisplay}`);
    if (time.sourceTimeText) parts.push(`原文时间：${time.sourceTimeText}`);
    if (time.timezoneAssumption) parts.push(time.timezoneAssumption);
    if (scheduledAt) parts.push(`主人这边的时间：${formatShanghai(scheduledAt)}`);
    else if (time.reason) parts.push(`时间说明：${time.reason}`);
  } else if (scheduledAt) {
    parts.push(`主人这边的时间：${formatShanghai(scheduledAt)}`);
  }
  return parts.join("\n\n");
}

export class EventProcessor {
  constructor(
    private readonly store: Store,
    private readonly notifier: NotificationService
  ) {}

  async process(tweet: TweetRecord, classification: Classification, now = new Date()): Promise<void> {
    if (classification.verdict === "NO" || classification.eventType === "OTHER") return;
    if (classification.verdict === "UNCERTAIN") {
      const suspected: NotificationMessage = {
        id: stableId("suspected", tweet.id),
        category: "suspected",
        priority: 4,
        title: "[Tibo额度] 疑似额度动态",
        body: sourceBody(classification, tweet, classification.scheduledAt),
        tweetId: tweet.id,
        facts: this.facts(classification, tweet, "suspected", classification.scheduledAt)
      };
      await this.notifier.broadcast(suspected, now);
      return;
    }

    if ((classification.eventType === "RESET_SCHEDULED" || classification.eventType === "BANKED_RESET") && classification.scheduledAt) {
      await this.processScheduled(tweet, classification, now);
      return;
    }
    if (classification.eventType === "RESET_NOW") {
      await this.processConfirmed(tweet, classification, now);
      return;
    }
    await this.processUnscheduled(tweet, classification, now);
  }

  async revalidatePendingReminders(now = new Date()): Promise<void> {
    for (const reminder of this.store.getPendingReminders()) {
      const event = this.store.getEvent(reminder.eventId);
      const tweet = event ? this.store.getTweet(event.firstTweetId) : null;
      const classification = tweet ? this.store.getClassification(tweet.id) : null;
      if (!event || !tweet || !classification) {
        await this.cancelLegacyReminder(reminder.eventId, tweet, classification, "旧排期缺少帖子或分类证据", now);
        continue;
      }
      const resolution = classification.timeResolution ?? resolveTimeEvidence({
        timeKind: classification.timeKind,
        sourceTimeText: classification.sourceTimeText,
        sourceTimezone: classification.sourceTimezone,
        scheduledAt: classification.scheduledAt
      }, tweet);
      const unchanged = isSchedulableStatus(resolution.status)
        && resolution.canSchedule
        && resolution.candidateScheduledAt
        && Math.abs(new Date(resolution.candidateScheduledAt).getTime() - new Date(reminder.dueAt).getTime()) <= 60_000;
      if (unchanged) {
        if (!classification.timeResolution) {
          this.store.saveClassification(tweet.id, { ...classification, timeResolution: resolution });
        }
        continue;
      }
      const reason = isSchedulableStatus(resolution.status)
        ? "新时间证据与旧排期不一致，旧到点任务已取消"
        : resolution.reason;
      const rejectedResolution = isSchedulableStatus(resolution.status)
        ? { ...resolution, status: "conflict" as const, reasonCode: "legacy_schedule_mismatch", canSchedule: false, reason }
        : { ...resolution, canSchedule: false, reason };
      await this.cancelLegacyReminder(
        reminder.eventId,
        tweet,
        { ...classification, scheduledAt: null, timeKind: "vague", timeResolution: rejectedResolution },
        reason,
        now
      );
    }
  }

  private async cancelLegacyReminder(
    eventId: string,
    tweet: TweetRecord | null,
    classification: Classification | null,
    reason: string,
    now: Date
  ): Promise<void> {
    this.store.cancelReminder(eventId);
    this.store.updateEvent(eventId, { scheduledAt: null });
    if (tweet && classification) this.store.saveClassification(tweet.id, classification);
    const metaKey = `time-revalidation:${eventId}`;
    if (this.store.getMeta(metaKey)) return;
    this.store.setMeta(metaKey, now.toISOString());
    const facts: NotificationFacts = {
      eventType: classification?.eventType ?? "RESET_SCHEDULED",
      products: classification?.products.length ? classification.products : ["Codex", "ChatGPT Work"],
      summaryZh: "旧版本保存的一条额度刷新排期未能通过新的时间证据校验，已取消旧到点任务。",
      certainty: "scheduled",
      timeStatus: "conflict",
      timeIssue: reason,
      callToAction: classification?.eventType === "BANKED_RESET" ? "check_banked_reset" : "use_remaining_before_reset"
    };
    if (tweet) {
      facts.sourceUrl = tweet.url;
      facts.postedAtDisplay = formatShanghai(tweet.postedAt);
    }
    const time = classification?.timeResolution;
    if (time?.sourceTimeText) facts.sourceTimeText = time.sourceTimeText;
    if (time?.displayTime) facts.displayTime = time.displayTime;
    if (time?.timezoneSource) facts.timezoneSource = time.timezoneSource;
    if (time?.timezoneAssumption) facts.timezoneAssumption = time.timezoneAssumption;
    const correction: NotificationMessage = {
      id: stableId("time-revalidation", eventId),
      category: "scheduled",
      priority: 2,
      title: "[Tibo额度] 旧排期时间需要重新确认",
      body: `${facts.summaryZh}\n\n${reason}`,
      eventId,
      facts
    };
    if (tweet) correction.tweetId = tweet.id;
    await this.notifier.broadcast(correction, now);
  }

  async processDueReminders(now = new Date()): Promise<void> {
    const due = this.store.getDueReminders(now.toISOString());
    for (const reminder of due) {
      const event = this.store.getEvent(reminder.eventId);
      const isBanked = event?.eventType === "BANKED_RESET";
      const lateness = -millisecondsUntil(reminder.dueAt, now);
      const message: NotificationMessage = {
        id: stableId("due", reminder.eventId, reminder.dueAt),
        category: "due",
        priority: isBanked ? 2 : 1,
        title: lateness > 60_000
          ? isBanked
            ? `[Tibo额度] 可存重置到账提醒（延迟${Math.ceil(lateness / 60_000)}分钟）`
            : `[Tibo额度] 到点提醒（延迟${Math.ceil(lateness / 60_000)}分钟）`
          : reminder.title,
        body: reminder.body,
        eventId: reminder.eventId,
        scheduledFor: reminder.dueAt,
        facts: this.dueFacts(reminder.eventId, reminder.dueAt, Math.max(0, Math.ceil(lateness / 60_000)))
      };
      const sendWindowMs = isBanked ? 30 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
      if (lateness <= sendWindowMs) {
        await this.notifier.broadcast(message, now);
        this.store.markReminder(reminder.id, "sent");
        this.store.updateEvent(reminder.eventId, { lastNotificationAt: now.toISOString() });
      } else {
        this.notifier.queueForAll({ ...message, priority: 2 }, now.toISOString());
        this.store.markReminder(reminder.id, "expired");
      }
    }
  }

  private async processScheduled(tweet: TweetRecord, classification: Classification, now: Date): Promise<void> {
    const scheduledAt = classification.scheduledAt!;
    const isBanked = classification.eventType === "BANKED_RESET";
    const id = stableId(isBanked ? "event-banked" : "event", productKey(classification.products), scheduledAt);
    const event: QuotaEvent = {
      id,
      eventType: classification.eventType,
      products: classification.products,
      verdict: "YES",
      scheduledAt,
      firstTweetId: tweet.id,
      latestTweetId: tweet.id,
      lastNotificationAt: null,
      confirmedAt: null
    };
    const created = this.store.createEvent(event);
    if (!created) {
      this.store.updateEvent(id, { latestTweetId: tweet.id });
      return;
    }

    this.store.upsertReminder({
      id: stableId("reminder", id),
      eventId: id,
      dueAt: scheduledAt,
      state: "pending",
      title: isBanked ? "[Tibo额度] 到点提醒：可存重置预计已到账" : "[Tibo额度] 到点提醒：额度预计已刷新",
      body: isBanked
        ? `Tibo 预告的可存储重置次数预计已经到账。\n\n主人这边的时间：${formatShanghai(scheduledAt)}\n\n可存 30 天，记得确认是否到账。`
        : `Tibo 预告的额度刷新时间已经到达。\n\n主人这边的时间：${formatShanghai(scheduledAt)}`
    });
    // A first-run backfill can discover an announcement after its due time.
    // The scheduler will send one due notification (or digest it if stale), so
    // do not spend another call on an already-obsolete announcement.
    if (millisecondsUntil(scheduledAt, now) <= 0) return;

    const message: NotificationMessage = {
      id: stableId(isBanked ? "banked" : "scheduled", tweet.id),
      category: isBanked ? "banked" : "scheduled",
      priority: isBanked ? 3 : 2,
      title: isBanked ? "[Tibo额度] 可存重置预计到账" : `[Tibo额度预告] ${formatShanghai(scheduledAt)}`,
      body: sourceBody(classification, tweet, scheduledAt),
      eventId: id,
      tweetId: tweet.id,
      facts: this.facts(classification, tweet, "scheduled", scheduledAt),
      scheduledFor: scheduledAt
    };
    await this.notifier.broadcast(message, now);
    this.store.updateEvent(id, { lastNotificationAt: now.toISOString() });
  }

  private async processConfirmed(tweet: TweetRecord, classification: Classification, now: Date): Promise<void> {
    const pending = this.store.findPendingScheduledEventNear(
      classification.products,
      tweet.postedAt,
      6 * 60 * 60 * 1000
    );
    if (pending) {
      const reminder = this.store.getReminderForEvent(pending.id);
      const dueAt = reminder ? new Date(reminder.dueAt).getTime() : Number.NaN;
      const withinCoalesceWindow = Number.isFinite(dueAt)
        && Math.abs(new Date(tweet.postedAt).getTime() - dueAt) <= 60 * 60 * 1000;
      this.store.updateEvent(pending.id, { latestTweetId: tweet.id, confirmedAt: tweet.postedAt });
      if (reminder?.state === "pending") {
        this.store.cancelReminder(pending.id);
        await this.sendConfirmed(tweet, classification, pending.id, now);
        return;
      }
      if (reminder?.state === "sent" && withinCoalesceWindow) {
        logger.info("confirmation_coalesced", { eventId: pending.id, tweetId: tweet.id });
        return;
      }
      await this.sendConfirmed(tweet, classification, pending.id, now);
      return;
    }

    const id = stableId("event-confirmed", productKey(classification.products), tweet.id);
    const created = this.store.createEvent({
      id,
      eventType: "RESET_NOW",
      products: classification.products,
      verdict: "YES",
      scheduledAt: null,
      firstTweetId: tweet.id,
      latestTweetId: tweet.id,
      lastNotificationAt: null,
      confirmedAt: tweet.postedAt
    });
    if (created) await this.sendConfirmed(tweet, classification, id, now);
  }

  private async sendConfirmed(tweet: TweetRecord, classification: Classification, eventId: string, now: Date): Promise<void> {
    await this.notifier.broadcast({
      id: stableId("confirmed", eventId, tweet.id),
      category: "confirmed",
      priority: 1,
      title: "[Tibo额度] 已确认重置",
      body: sourceBody(classification, tweet),
      eventId,
      tweetId: tweet.id,
      facts: this.facts(classification, tweet, "confirmed")
    }, now);
    this.store.updateEvent(eventId, { lastNotificationAt: now.toISOString(), confirmedAt: tweet.postedAt });
  }

  private async processUnscheduled(tweet: TweetRecord, classification: Classification, now: Date): Promise<void> {
    const id = stableId("event-unscheduled", classification.eventType, tweet.id);
    const created = this.store.createEvent({
      id,
      eventType: classification.eventType,
      products: classification.products,
      verdict: "YES",
      scheduledAt: null,
      firstTweetId: tweet.id,
      latestTweetId: tweet.id,
      lastNotificationAt: null,
      confirmedAt: classification.eventType === "RESET_NOW" ? tweet.postedAt : null
    });
    if (!created) return;
    const category = classification.eventType === "BANKED_RESET" ? "banked" : "scheduled";
    await this.notifier.broadcast({
      id: stableId(category, tweet.id),
      category,
      priority: 3,
      title: classification.eventType === "BANKED_RESET" ? "[Tibo额度] Banked reset 预告" : "[Tibo额度] 额度预告",
      body: sourceBody(classification, tweet),
      eventId: id,
      tweetId: tweet.id,
      facts: this.facts(classification, tweet, "scheduled")
    }, now);
    this.store.updateEvent(id, { lastNotificationAt: now.toISOString() });
  }

  private facts(
    classification: Classification,
    tweet: TweetRecord,
    certainty: "confirmed" | "scheduled" | "suspected",
    scheduledAt?: string | null
  ): NotificationFacts {
    const isBanked = classification.eventType === "BANKED_RESET";
    const summaryZh = isBanked && !/30\s*天|三十天/.test(classification.summaryZh)
      ? `${classification.summaryZh} Banked reset 可存 30 天。`
      : classification.summaryZh;
    const facts: NotificationFacts = {
      eventType: classification.eventType,
      products: classification.products.length > 0 ? classification.products : ["Codex", "ChatGPT Work"],
      summaryZh,
      sourceUrl: tweet.url,
      certainty
    };
    if (scheduledAt) {
      facts.scheduledAt = scheduledAt;
      facts.displayTime = formatShanghai(scheduledAt);
    }
    const time = classification.timeResolution;
    if (time && time.status !== "none") {
      facts.postedAtDisplay = time.postedAtDisplay;
      if (time.sourceTimeText) facts.sourceTimeText = time.sourceTimeText;
      if (time.displayTime) facts.displayTime = time.displayTime;
      if (time.timezoneSource) facts.timezoneSource = time.timezoneSource;
      if (time.timezoneAssumption) facts.timezoneAssumption = time.timezoneAssumption;
      facts.timeStatus = time.status;
      if (!isSchedulableStatus(time.status) && time.reason) facts.timeIssue = time.reason;
    }
    if (classification.eventType === "RESET_SCHEDULED") facts.callToAction = "use_remaining_before_reset";
    if (isBanked) facts.callToAction = "check_banked_reset";
    return facts;
  }

  private dueFacts(eventId: string, dueAt: string, latenessMinutes: number): NotificationFacts {
    const event = this.store.getEvent(eventId);
    const isBanked = event?.eventType === "BANKED_RESET";
    const facts: NotificationFacts = {
      eventType: isBanked ? "BANKED_RESET" : "RESET_NOW",
      products: event?.products.length ? event.products : ["Codex", "ChatGPT Work"],
      summaryZh: isBanked
        ? "Tibo 预告的可存储重置次数预计已经到账，请确认是否到账；这类额度可存 30 天。"
        : "Tibo 预告的额度刷新时间已经到达，请查看额度是否已经刷新。",
      displayTime: formatShanghai(dueAt),
      scheduledAt: dueAt,
      certainty: "confirmed",
      latenessMinutes
    };
    if (isBanked) facts.callToAction = "check_banked_reset";
    return facts;
  }
}
