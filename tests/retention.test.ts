import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import type { TweetRecord } from "../src/types.js";
import { DatabaseSync } from "node:sqlite";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tweet(id: string, postedAt: string): TweetRecord {
  return {
    id, postedAt, url: `https://x.com/thsottiaux/status/${id}`,
    authorHandle: "thsottiaux", rawText: "reset", cleanText: "reset",
    isReply: false, isRepost: false, isQuote: false
  };
}

describe("trace retention", () => {
  it("backfills standard intents for an upgrade-era pending queue", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-migration-"));
    tempDirs.push(dir);
    const databasePath = `${dir}/legacy.sqlite`;
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, target_name TEXT NOT NULL,
        category TEXT NOT NULL, priority INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        event_id TEXT, not_before TEXT NOT NULL, expires_at TEXT, state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, UNIQUE(message_id, target_name)
      );
      INSERT INTO notification_queue(
        message_id,target_name,category,priority,title,body,event_id,not_before,state,created_at
      ) VALUES(
        'legacy-message','owner','scheduled',2,'旧预告',
        '额度预告。来源：https://x.com/thsottiaux/status/legacy',NULL,
        '2026-08-31T00:00:00Z','pending','2026-08-31T00:00:00Z'
      );
    `);
    legacy.close();
    const store = new Store(databasePath);
    expect(store.getNotificationIntent("legacy-message")?.facts.sourceUrl)
      .toBe("https://x.com/thsottiaux/status/legacy");
    expect(store.getQueued("owner", "9999-01-01T00:00:00Z")[0]?.deferReason).toBeNull();
    store.close();
  });

  it("keeps active reminder facts and pending queue while deleting expired trace rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-retention-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/retention.sqlite`);
    store.saveTweet(tweet("active", "2026-01-01T00:00:00Z"), true);
    store.saveTweet(tweet("inactive", "2026-01-01T00:00:00Z"), true);
    store.createEvent({
      id: "event-active", eventType: "RESET_SCHEDULED", products: ["Codex"], verdict: "YES",
      scheduledAt: "2027-01-01T00:00:00Z", firstTweetId: "active", latestTweetId: "active",
      lastNotificationAt: null, confirmedAt: null
    });
    store.upsertReminder({
      id: "reminder-active", eventId: "event-active", dueAt: "2027-01-01T00:00:00Z",
      state: "pending", title: "due", body: "due"
    });
    store.enqueue({
      id: "pending-message", category: "scheduled", priority: 2,
      title: "queued", body: "queued", eventId: "event-active"
    }, "owner", "2027-01-01T00:00:00Z");
    store.db.prepare("UPDATE notification_intents SET created_at = '2026-01-01T00:00:00Z'").run();
    store.cleanupRetention("2026-08-01T00:00:00Z");
    expect(store.getTweet("active")).not.toBeNull();
    expect(store.getTweet("inactive")).toBeNull();
    expect(store.getNotificationIntent("pending-message")).not.toBeNull();
    expect(store.getQueued("owner", "9999-01-01T00:00:00Z")).toHaveLength(1);
    store.close();
  });
});
