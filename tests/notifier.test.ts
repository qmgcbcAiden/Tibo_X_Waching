import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db.js";
import { NotificationService } from "../src/notifier.js";
import type { NotificationMessage, QuotaEvent } from "../src/types.js";
import { shanghaiDay } from "../src/time.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];
const now = new Date("2026-08-31T03:00:00Z");

function message(index: number, category: NotificationMessage["category"] = "confirmed"): NotificationMessage {
  return {
    id: `message-${category}-${index}`,
    category,
    priority: category === "confirmed" ? 1 : category === "suspected" ? 4 : 2,
    title: `Message ${index}`,
    body: "Body"
  };
}

function successResponse(): Response {
  return new Response(JSON.stringify({ code: 0 }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ServerChan delivery accounting without application limits", () => {
  it("sends more than five messages and keeps today's call count as statistics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir, {
      targets: [{ name: "alice", sendKey: "SCT_ALICE_TEST", role: "maintainer" }]
    });
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    for (let index = 0; index < 8; index += 1) await notifier.broadcast(message(index), now);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(8);
    store.close();
  });

  it("picks up newly added users without restarting the notifier", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir, {
      targets: [{ name: "alice", sendKey: "SCT_ALICE_TEST", role: "maintainer" }]
    });
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    await notifier.broadcast(message(1), now);
    store.addNotificationTarget({ name: "bob", sendKey: "SCT_BOB_TEST", role: "recipient" });
    await notifier.broadcast(message(2), now);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(2);
    expect(store.getDailyCalls("bob", shanghaiDay(now))).toBe(1);
    store.close();
  });

  it("sends and counts independently for every enabled account", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    for (let index = 0; index < 8; index += 1) await notifier.broadcast(message(index), now);
    expect(fetchMock).toHaveBeenCalledTimes(16);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(8);
    expect(store.getDailyCalls("bob", shanghaiDay(now))).toBe(8);
    store.close();
  });

  it("counts HTTP failures once and never retries the original request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 1, message: "failed" }), { status: 500 }));
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    await notifier.broadcast(message(1), now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(1);
    expect(store.getDailyCalls("bob", shanghaiDay(now))).toBe(1);
    store.close();
  });

  it("counts indeterminate network failures once and never retries the original request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => {
      throw new DOMException("request timed out", "AbortError");
    });
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    await notifier.broadcast(message(1), now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(1);
    expect(store.getDailyCalls("bob", shanghaiDay(now))).toBe(1);
    store.close();
  });

  it("does not lock an account after ServerChan returns 429", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 1, message: "rate limited" }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    ));
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    await notifier.broadcast(message(1), now);
    await notifier.broadcast(message(2), now);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(2);
    expect(store.getDailyCalls("bob", shanghaiDay(now))).toBe(2);
    store.close();
  });

  it("sends suspected posts regardless of the existing call count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    for (let index = 0; index < 7; index += 1) await notifier.broadcast(message(index, "suspected"), now);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(7);
    expect(store.getQueued("alice", now.toISOString())).toHaveLength(0);
    store.close();
  });

  it("does not reserve sending capacity for reminders due on the same Shanghai day", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const event: QuotaEvent = {
      id: "scheduled-event",
      eventType: "RESET_SCHEDULED",
      products: ["Codex"],
      verdict: "YES",
      scheduledAt: "2026-08-31T08:00:00Z",
      firstTweetId: "tweet-1",
      latestTweetId: "tweet-1",
      lastNotificationAt: null,
      confirmedAt: null
    };
    store.createEvent(event);
    store.upsertReminder({
      id: "scheduled-reminder",
      eventId: event.id,
      dueAt: event.scheduledAt!,
      state: "pending",
      title: "Due",
      body: "Due"
    });
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    for (let index = 0; index < 7; index += 1) await notifier.broadcast(message(index, "scheduled"), now);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(7);
    expect(store.countDueRemindersForDay(shanghaiDay(now))).toBe(1);
    store.close();
  });

  it("sends previews directly and counts them independently from channel tests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir, {
      targets: [{ name: "alice", sendKey: "SCT_ALICE_TEST", role: "maintainer" }]
    });
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    const preview = await notifier.previewTarget("alice", now);
    expect(preview.delivery.status).toBe("sent");
    const previewIntent = store.db.prepare("SELECT facts_json FROM notification_intents ORDER BY created_at DESC LIMIT 1").get() as { facts_json: string };
    const previewFacts = JSON.parse(previewIntent.facts_json) as {
      postedAtDisplay?: string;
      sourceUrl?: string;
      sourceTimeText?: string;
      displayTime?: string;
      scheduledAt?: string;
    };
    expect(previewFacts.postedAtDisplay).toBe("2026-08-31 周一 03:24");
    expect(previewFacts.sourceUrl).toBeUndefined();
    expect(previewFacts.sourceTimeText).toBe("at 6pm PST");
    expect(previewFacts.displayTime).toBe("2026-08-31 周一 10:00");
    expect(previewFacts.scheduledAt).toBe("2026-08-31T02:00:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(1);
    const result = await notifier.verifyTarget("alice", now);
    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(2);
    store.close();
  });

  it("does not record a ServerChan call when the copywriter throws unexpectedly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir, {
      targets: [{ name: "alice", sendKey: "SCT_ALICE_TEST", role: "maintainer" }]
    });
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => successResponse());
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch, {
      generate: async () => { throw new Error("copy unavailable"); }
    });
    const [result] = await notifier.broadcast(message(1), now);
    expect(result?.status).toBe("deferred");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getDailyCalls("alice", shanghaiDay(now))).toBe(0);
    store.close();
  });

  it("expires failed low-priority deliveries rather than retrying them across days", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 1 }), { status: 500 }));
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    await notifier.broadcast(message(1, "scheduled"), now);
    await notifier.runScheduledHousekeeping(new Date("2026-08-31T16:01:00Z"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getQueued("alice", "2026-09-01T00:00:00Z")).toHaveLength(0);
    store.close();
  });

  it("rolls failed confirmations into one next-day delivery per account", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-delivery-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls <= 2
        ? new Response(JSON.stringify({ code: 1 }), { status: 500 })
        : successResponse();
    });
    const notifier = new NotificationService(config, store, fetchMock as unknown as typeof fetch);
    await notifier.broadcast(message(1, "confirmed"), now);
    const nextDay = new Date("2026-08-31T16:01:00Z");
    await notifier.runScheduledHousekeeping(nextDay);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(store.getDailyCalls("alice", shanghaiDay(nextDay))).toBe(1);
    expect(store.getDailyCalls("bob", shanghaiDay(nextDay))).toBe(1);
    store.close();
  });
});
