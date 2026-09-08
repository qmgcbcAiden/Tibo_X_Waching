import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatcherApp } from "../src/app.js";
import type { Classification, TweetRecord } from "../src/types.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function post(id: string, postedAt: string): TweetRecord {
  return {
    id,
    url: `https://x.com/thsottiaux/status/${id}`,
    authorHandle: "thsottiaux",
    postedAt,
    rawText: "ordinary product news",
    cleanText: "ordinary product news",
    isReply: false,
    isRepost: false,
    isQuote: false
  };
}

const negative: Classification = {
  verdict: "NO",
  eventType: "OTHER",
  confidence: 0.99,
  products: [],
  summaryZh: "非额度事件",
  evidence: "",
  timeKind: "none",
  sourceTimeText: null,
  sourceTimezone: null,
  scheduledAt: null,
  model: "test"
};

describe("initial backfill", () => {
  it("never classifies visible posts older than the configured first-run window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-app-"));
    tempDirs.push(dir);
    const app = new WatcherApp(testConfig(dir, { backfillHours: 24 }));
    const now = new Date("2026-08-31T03:00:00Z");
    vi.spyOn(app.scraper, "fetchLatest").mockResolvedValue([
      post("old", "2026-08-29T03:00:00Z"),
      post("new", "2026-08-31T02:00:00Z")
    ]);
    const classify = vi.spyOn(app.classifier, "classify").mockResolvedValue(negative);

    await app.poll(now);
    await app.poll(now);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0].id).toBe("new");
    app.store.close();
  });

  it("retries a persisted backfill post even after it is no longer visible on X", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-app-"));
    tempDirs.push(dir);
    const app = new WatcherApp(testConfig(dir, { backfillHours: 24 }));
    const now = new Date("2026-08-31T03:00:00Z");
    vi.spyOn(app.scraper, "fetchLatest")
      .mockResolvedValueOnce([post("retry-me", "2026-08-31T02:00:00Z")])
      .mockResolvedValueOnce([]);
    const classify = vi.spyOn(app.classifier, "classify")
      .mockRejectedValueOnce(new Error("temporary DeepSeek outage"))
      .mockResolvedValueOnce(negative);

    await app.poll(now);
    await app.poll(new Date(now.getTime() + 4 * 60 * 1000));

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0].id).toBe("retry-me");
    app.store.close();
  });

  it("never promotes a newly discovered stale RSS item after initialization", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-app-"));
    tempDirs.push(dir);
    const app = new WatcherApp(testConfig(dir, { backfillHours: 24 }));
    const now = new Date("2026-08-31T03:00:00Z");
    vi.spyOn(app.scraper, "fetchLatest")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post("late-rss-history", "2026-08-29T03:00:00Z")]);
    const classify = vi.spyOn(app.classifier, "classify").mockResolvedValue(negative);

    await app.poll(now);
    await app.poll(new Date(now.getTime() + 4 * 60 * 1000));

    expect(classify).not.toHaveBeenCalled();
    app.store.close();
  });
});
