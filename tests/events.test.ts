import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db.js";
import { EventProcessor } from "../src/events.js";
import type { NotificationService } from "../src/notifier.js";
import type { Classification, TweetRecord } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tweet(id: string, postedAt: string): TweetRecord {
  return {
    id,
    url: `https://x.com/thsottiaux/status/${id}`,
    authorHandle: "thsottiaux",
    postedAt,
    rawText: "text",
    cleanText: "text",
    isReply: false,
    isRepost: false,
    isQuote: false
  };
}

function classification(eventType: Classification["eventType"], scheduledAt: string | null): Classification {
  return {
    verdict: "YES",
    eventType,
    confidence: 0.99,
    products: ["Codex", "ChatGPT Work"],
    summaryZh: "测试额度事件",
    evidence: "reset",
    timeKind: scheduledAt ? "exact" : "none",
    sourceTimeText: scheduledAt ? "6pm PST" : null,
    sourceTimezone: scheduledAt ? "PST" : null,
    scheduledAt,
    model: "test"
  };
}

function bankedClassification(): Classification {
  const scheduledAt = "2026-09-04T02:12:09Z";
  return {
    verdict: "YES",
    eventType: "BANKED_RESET",
    confidence: 0.99,
    products: ["paid ChatGPT plan", "Astra"],
    summaryZh: "Tibo 说 paid ChatGPT plan 因 Astra 暂未开放会每天补一个 banked reset，第一枚约 3 小时后到账。",
    evidence: "First one will land in ~ 3 hours.",
    timeKind: "approximate",
    sourceTimeText: "in ~ 3 hours",
    sourceTimezone: null,
    scheduledAt,
    model: "test",
    timeResolution: {
      postedAtUtc: "2026-09-03T23:12:09Z",
      postedAtSourceTimezone: "UTC",
      postedAtDisplay: "2026-09-04 周五 07:12",
      sourceTimeText: "in ~ 3 hours",
      sourceTimezone: null,
      timezoneSource: null,
      timezoneAssumption: null,
      modelScheduledAt: null,
      candidateScheduledAt: scheduledAt,
      displayTime: "2026-09-04 周五 10:12",
      status: "approximate",
      reasonCode: "relative_duration",
      reason: "原文提供了近似相对时间，按 X 发帖时间顺延计算",
      canSchedule: true
    }
  };
}

describe("quota event coalescing", () => {
  it("sends a time-conflict notice immediately without creating a reminder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const processor = new EventProcessor(store, { broadcast, queueForAll: vi.fn() } as unknown as NotificationService);
    const post = tweet("conflict", "2026-09-01T02:00:00Z");
    const value: Classification = {
      ...classification("RESET_SCHEDULED", null),
      timeKind: "vague",
      sourceTimeText: "at 6pm",
      sourceTimezone: null,
      timeResolution: {
        postedAtUtc: "2026-09-01T02:00:00Z",
        postedAtSourceTimezone: "UTC",
        postedAtDisplay: "2026-09-01 周二 10:00",
        sourceTimeText: "at 6pm",
        sourceTimezone: "PT",
        timezoneSource: "default_pt",
        timezoneAssumption: "原文没有注明时区，按 PT（America/Los_Angeles）计算",
        modelScheduledAt: "2026-09-01T01:00:00Z",
        candidateScheduledAt: "2026-09-01T01:00:00Z",
        displayTime: "2026-09-01 周二 09:00",
        status: "conflict",
        reasonCode: "candidate_before_post",
        reason: "按发帖当天计算的目标时间早于发帖时间，不能自动顺延",
        canSchedule: false
      }
    };
    await processor.process(post, value, new Date("2026-09-01T02:01:00Z"));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((broadcast.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      category: "scheduled",
      facts: { timeStatus: "conflict", callToAction: "use_remaining_before_reset" }
    });
    expect(store.getPendingReminders()).toHaveLength(0);
    store.close();
  });

  it("creates a banked reset landing reminder without remaining-usage urging", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const processor = new EventProcessor(store, { broadcast, queueForAll: vi.fn() } as unknown as NotificationService);
    const post = tweet("banked-approx", "2026-09-03T23:12:09Z");
    const value = bankedClassification();

    await processor.process(post, value, new Date("2026-09-03T23:13:00Z"));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((broadcast.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      category: "banked",
      priority: 3,
      scheduledFor: "2026-09-04T02:12:09Z",
      facts: {
        eventType: "BANKED_RESET",
        callToAction: "check_banked_reset",
        timeStatus: "approximate",
        displayTime: "2026-09-04 周五 10:12"
      }
    });
    const message = (broadcast.mock.calls as unknown[][])[0]?.[0] as { body: string; facts: { summaryZh: string } };
    expect(message.body).toContain("可存 30 天");
    expect(message.body).not.toMatch(/剩余.{0,24}额度.{0,24}用掉/);
    expect(message.facts.summaryZh).toContain("30 天");

    const [reminder] = store.getPendingReminders();
    expect(reminder).toMatchObject({
      dueAt: "2026-09-04T02:12:09Z",
      state: "pending"
    });
    expect(reminder?.title).toContain("可存重置");
    expect(reminder?.body).toContain("确认是否到账");
    expect(reminder?.body).toContain("可存 30 天");
    store.close();
  });

  it("sends a late banked reset due reminder within the 30-day storage window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const processor = new EventProcessor(store, { broadcast, queueForAll: vi.fn() } as unknown as NotificationService);
    await processor.process(
      tweet("banked-due", "2026-09-03T23:12:09Z"),
      bankedClassification(),
      new Date("2026-09-03T23:13:00Z")
    );
    await processor.processDueReminders(new Date("2026-09-04T05:12:09Z"));

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect((broadcast.mock.calls as unknown[][])[1]?.[0]).toMatchObject({
      category: "due",
      priority: 2,
      title: expect.stringContaining("可存重置"),
      facts: {
        eventType: "BANKED_RESET",
        callToAction: "check_banked_reset",
        summaryZh: expect.stringContaining("30 天")
      }
    });
    const dueMessage = (broadcast.mock.calls as unknown[][])[1]?.[0] as { facts: Record<string, unknown> };
    expect(dueMessage.facts).not.toHaveProperty("postedAtDisplay");
    expect(dueMessage.facts).not.toHaveProperty("sourceTimeText");
    expect(store.getPendingReminders()).toHaveLength(0);
    store.close();
  });

  it("does not send a third message for a confirmation within one hour of due reminder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const queueForAll = vi.fn();
    const notifier = { broadcast, queueForAll } as unknown as NotificationService;
    const processor = new EventProcessor(store, notifier);
    const dueAt = "2026-08-31T02:00:00Z";

    await processor.process(
      tweet("100", "2026-08-30T12:00:00Z"),
      classification("RESET_SCHEDULED", dueAt),
      new Date("2026-08-30T12:01:00Z")
    );
    await processor.processDueReminders(new Date(dueAt));
    await processor.process(
      tweet("101", "2026-08-31T02:30:00Z"),
      classification("RESET_NOW", null),
      new Date("2026-08-31T02:30:00Z")
    );

    expect(broadcast).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("sends an early confirmation and cancels the future reminder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const notifier = { broadcast, queueForAll: vi.fn() } as unknown as NotificationService;
    const processor = new EventProcessor(store, notifier);
    const dueAt = "2026-08-31T04:00:00Z";

    await processor.process(
      tweet("200", "2026-08-31T00:00:00Z"),
      classification("RESET_SCHEDULED", dueAt),
      new Date("2026-08-31T00:01:00Z")
    );
    await processor.process(
      tweet("201", "2026-08-31T02:30:00Z"),
      classification("RESET_NOW", null),
      new Date("2026-08-31T02:30:00Z")
    );

    expect(broadcast).toHaveBeenCalledTimes(2);
    const event = store.findPendingScheduledEventNear(["Codex"], dueAt, 1);
    expect(event).toBeNull();
    store.close();
  });

  it("uses the announced due time, not a delayed scheduler run, for the one-hour merge window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const notifier = { broadcast, queueForAll: vi.fn() } as unknown as NotificationService;
    const processor = new EventProcessor(store, notifier);
    const dueAt = "2026-08-31T02:00:00Z";

    await processor.process(
      tweet("300", "2026-08-30T12:00:00Z"),
      classification("RESET_SCHEDULED", dueAt),
      new Date("2026-08-30T12:01:00Z")
    );
    await processor.processDueReminders(new Date("2026-08-31T03:30:00Z"));
    await processor.process(
      tweet("301", "2026-08-31T03:40:00Z"),
      classification("RESET_NOW", null),
      new Date("2026-08-31T03:40:00Z")
    );

    expect(broadcast).toHaveBeenCalledTimes(3);
    store.close();
  });

  it("does not send an obsolete announcement when first-run backfill finds it after the due time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const notifier = { broadcast, queueForAll: vi.fn() } as unknown as NotificationService;
    const processor = new EventProcessor(store, notifier);
    const dueAt = "2026-08-31T02:00:00Z";
    const discoveredAt = new Date("2026-08-31T02:30:00Z");

    await processor.process(
      tweet("400", "2026-08-30T12:00:00Z"),
      classification("RESET_SCHEDULED", dueAt),
      discoveredAt
    );
    expect(broadcast).not.toHaveBeenCalled();

    await processor.processDueReminders(discoveredAt);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((broadcast.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ category: "due" });
    store.close();
  });

  it("cancels a legacy pending reminder whose source quote cannot be verified", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-events-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/events.sqlite`);
    const broadcast = vi.fn(async () => []);
    const processor = new EventProcessor(store, { broadcast, queueForAll: vi.fn() } as unknown as NotificationService);
    const post = tweet("legacy", "2026-08-30T12:00:00Z");
    store.saveTweet(post, true);
    store.saveClassification(post.id, classification("RESET_SCHEDULED", "2026-08-31T02:00:00Z"));
    store.createEvent({
      id: "legacy-event", eventType: "RESET_SCHEDULED", products: ["Codex", "ChatGPT Work"], verdict: "YES",
      scheduledAt: "2026-08-31T02:00:00Z", firstTweetId: post.id, latestTweetId: post.id,
      lastNotificationAt: null, confirmedAt: null
    });
    store.upsertReminder({
      id: "legacy-reminder", eventId: "legacy-event", dueAt: "2026-08-31T02:00:00Z",
      state: "pending", title: "旧排期", body: "旧排期"
    });
    await processor.revalidatePendingReminders(new Date("2026-08-30T13:00:00Z"));
    expect(store.getReminderForEvent("legacy-event")?.state).toBe("cancelled");
    expect(store.getEvent("legacy-event")?.scheduledAt).toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
    await processor.revalidatePendingReminders(new Date("2026-08-30T14:00:00Z"));
    expect(broadcast).toHaveBeenCalledTimes(1);
    store.close();
  });
});
