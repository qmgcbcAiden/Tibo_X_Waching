import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatcherApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { SourceHealthMonitor } from "../src/health.js";
import type { NotificationService } from "../src/notifier.js";
import { sanitizeProbeError } from "../src/tweet-sources.js";
import type {
  Classification,
  NotificationMessage,
  ProbeFetchReport,
  ProbeSourceResult,
  TweetRecord
} from "../src/types.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-probe-"));
  tempDirs.push(dir);
  return new Store(`${dir}/probe.sqlite`);
}

function tweet(id: string, overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id,
    url: `https://x.com/thsottiaux/status/${id}`,
    authorHandle: "thsottiaux",
    postedAt: new Date().toISOString(),
    rawText: "ordinary product news",
    cleanText: "ordinary product news",
    isReply: false,
    isRepost: false,
    isQuote: false,
    ...overrides
  };
}

const negative: Classification = {
  verdict: "NO",
  eventType: "OTHER",
  confidence: 0.99,
  products: [],
  summaryZh: "非额度事件",
  evidence: "ordinary product news",
  timeKind: "none",
  sourceTimeText: null,
  sourceTimezone: null,
  scheduledAt: null,
  model: "test"
};

function source(source: ProbeSourceResult["source"], status: ProbeSourceResult["status"], error: string | null = null): ProbeSourceResult {
  return { source, status, durationMs: 12, itemCount: status === "success" ? 3 : 0, latestItemAt: null, error };
}

function report(results: ProbeSourceResult[], startedAt = new Date().toISOString()): ProbeFetchReport {
  const total = results.reduce((sum, item) => sum + item.itemCount, 0);
  return {
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 100).toISOString(),
    durationMs: 100,
    enabledSources: results.map((item) => item.source),
    successfulSources: results.filter((item) => item.status === "success").map((item) => item.source),
    sourceResults: results,
    totalItemCount: total,
    uniqueItemCount: total,
    crossSourceDuplicates: 0
  };
}

describe("probe persistence", () => {
  it("stores mutually exclusive dispositions and classification totals", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-probe-app-"));
    tempDirs.push(dir);
    const app = new WatcherApp(testConfig(dir));
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    vi.spyOn(app.scraper, "fetchLatest").mockResolvedValue([
      tweet("ok"),
      tweet("reply", { isReply: true }),
      tweet("repost", { isRepost: true }),
      tweet("quote", { isQuote: true }),
      tweet("stale", { postedAt: stale }),
      tweet("other", { authorHandle: "someone_else" })
    ]);
    vi.spyOn(app.classifier, "classify").mockResolvedValue(negative);

    await app.poll();

    const list = app.store.getAnalysisSummaries("probe", 0, 20, new Date(0).toISOString());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ activityKind: "probe", probeStatus: "completed", newItemCount: 6 });
    const runId = Number(list.items[0]!.tweetId.split(":")[1]);
    expect(app.store.getProbeActivityDetail(runId)).toMatchObject({
      kind: "probe",
      probe: {
        classifiableCount: 1,
        replyCount: 1,
        repostCount: 1,
        quoteCount: 1,
        staleCount: 1,
        otherExcludedCount: 1,
        classificationSuccessCount: 1,
        classificationFailureCount: 0
      }
    });
    app.store.close();
  });

  it("records all-source failure, processing failure, and interrupted runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-probe-errors-"));
    tempDirs.push(dir);
    const app = new WatcherApp(testConfig(dir));
    vi.spyOn(app.tweetSources, "fetchLatest").mockResolvedValueOnce({
      tweets: [],
      report: report([source("x_browser", "failed", "blocked")])
    }).mockRejectedValueOnce(new Error("unexpected token SCT_SECRET_123456"));

    await expect(app.poll()).rejects.toThrow(/All X monitoring sources failed/);
    await expect(app.poll()).rejects.toThrow(/unexpected token/);
    const running = app.store.createProbeRun(new Date().toISOString(), ["x_browser"], 300);
    expect(app.store.markRunningProbeRunsInterrupted()).toBe(1);

    const rows = app.store.getAnalysisSummaries("probe", 0, 20, new Date(0).toISOString()).items;
    expect(rows.map((item) => item.probeStatus)).toEqual(expect.arrayContaining([
      "all_failed", "processing_failed", "interrupted"
    ]));
    const processing = rows.find((item) => item.probeStatus === "processing_failed")!;
    const detail = app.store.getProbeActivityDetail(Number(processing.tweetId.split(":")[1]));
    expect(JSON.stringify(detail)).not.toContain("SCT_SECRET_123456");
    expect(app.store.getProbeActivityDetail(running)).toMatchObject({ probe: { status: "interrupted" } });
    app.store.close();
  });

  it("cleans only expired probe history and cascades source summaries", () => {
    const store = tempStore();
    const old = "2026-01-01T00:00:00.000Z";
    const run = store.createProbeRun(old, ["feedly_xcancel"], 300);
    store.saveProbeFetchReport(run, report([source("feedly_xcancel", "success")], old));
    store.finishProbeRun(run, "completed", {
      existingCount: 0, newCount: 0, classifiableCount: 0, replyCount: 0,
      repostCount: 0, quoteCount: 0, staleCount: 0, otherExcludedCount: 0,
      classificationSuccessCount: 0, classificationFailureCount: 0
    }, "2026-01-01T00:01:00.000Z");
    store.saveTweet(tweet("keep"), true);
    const health = store.getSourceHealth("feedly_xcancel");
    health.consecutiveFailures = 2;
    health.updatedAt = new Date().toISOString();
    store.saveSourceHealth(health);

    expect(store.cleanupProbeRetention("2026-02-01T00:00:00.000Z")).toBe(1);
    expect(store.getProbeActivityDetail(run)).toBeNull();
    expect(store.getTweet("keep")).not.toBeNull();
    expect(store.getSourceHealth("feedly_xcancel").consecutiveFailures).toBe(2);
    store.close();
  });
});

describe("RSS source incident monitoring", () => {
  it("alerts at three failures, suppresses repeats, recovers immediately, and can alert again", async () => {
    const store = tempStore();
    const notifyMaintainer = vi.fn(async (_message: NotificationMessage) => ({ targetName: "owner", status: "sent" as const }));
    const monitor = new SourceHealthMonitor(store, { notifyMaintainer } as unknown as NotificationService);
    const failing = () => report([
      source("x_browser", "success"),
      source("feedly_xcancel", "failed", "HTTP 503")
    ]);
    await monitor.process(failing());
    await monitor.process(failing());
    expect(notifyMaintainer).not.toHaveBeenCalled();
    await monitor.process(failing());
    await monitor.process(failing());
    expect(notifyMaintainer).toHaveBeenCalledTimes(1);
    expect(notifyMaintainer.mock.calls[0]?.[0]).toMatchObject({ category: "health_failure" });

    await monitor.process(report([source("x_browser", "failed"), source("feedly_xcancel", "success")]));
    expect(notifyMaintainer).toHaveBeenCalledTimes(2);
    expect(notifyMaintainer.mock.calls[1]?.[0]).toMatchObject({
      category: "health_recovery",
      facts: { certainty: "recovered" }
    });

    await monitor.process(failing());
    await monitor.process(failing());
    await monitor.process(failing());
    expect(notifyMaintainer).toHaveBeenCalledTimes(3);
    store.close();
  });

  it("does not alert for anonymous X alone or duplicate overall all-source failures", async () => {
    const store = tempStore();
    const notifyMaintainer = vi.fn(async () => ({ targetName: "owner", status: "sent" as const }));
    const monitor = new SourceHealthMonitor(store, { notifyMaintainer } as unknown as NotificationService);
    for (let index = 0; index < 4; index += 1) {
      await monitor.process(report([source("x_browser", "failed"), source("feedly_xcancel", "success")]));
    }
    for (let index = 0; index < 4; index += 1) {
      await monitor.process(report([source("x_browser", "failed"), source("feedly_xcancel", "failed")]));
    }
    expect(notifyMaintainer).not.toHaveBeenCalled();
    store.close();
  });

  it("combines multiple RSS failures reached in the same round", async () => {
    const store = tempStore();
    const notifyMaintainer = vi.fn(async (_message: NotificationMessage) => ({ targetName: "owner", status: "sent" as const }));
    const monitor = new SourceHealthMonitor(store, { notifyMaintainer } as unknown as NotificationService);
    const failing = () => report([
      source("x_browser", "success"),
      source("feedly_xcancel", "failed", "Feedly unavailable"),
      source("xcancel_rss", "failed", "RSS unavailable")
    ]);
    await monitor.process(failing());
    await monitor.process(failing());
    await monitor.process(failing());
    expect(notifyMaintainer).toHaveBeenCalledTimes(1);
    expect(notifyMaintainer.mock.calls[0]?.[0].facts?.summaryZh).toContain("Feedly、XCancel RSS");
    store.close();
  });
});

describe("probe error redaction", () => {
  it("truncates and removes URLs, credentials, and line breaks", () => {
    const error = sanitizeProbeError(new Error(
      `GET https://example.test/feed?token=abc Authorization: Bearer secret SCT_SECRET_123456\n${"x".repeat(400)}`
    ));
    expect(error.length).toBeLessThanOrEqual(240);
    expect(error).not.toContain("token=abc");
    expect(error).not.toContain("secret");
    expect(error).not.toContain("SCT_SECRET_123456");
    expect(error).not.toContain("\n");
  });
});
