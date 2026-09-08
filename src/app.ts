import fs from "node:fs";
import type { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { DeepSeekClassifier } from "./deepseek.js";
import { DeepSeekCopywriter } from "./copywriter.js";
import { EventProcessor } from "./events.js";
import { HealthMonitor, SourceHealthMonitor } from "./health.js";
import { logger } from "./logger.js";
import { NotificationService } from "./notifier.js";
import type { ProbeDispositionStats, TweetRecord } from "./types.js";
import { XScraper } from "./x-scraper.js";
import { createTweetSourceManager, sanitizeProbeError, type TweetSourceManager } from "./tweet-sources.js";

function randomSeconds(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class WatcherApp {
  readonly store: Store;
  readonly scraper: XScraper;
  readonly tweetSources: TweetSourceManager;
  readonly classifier: DeepSeekClassifier;
  readonly notifier: NotificationService;
  readonly health: HealthMonitor;
  readonly sourceHealth: SourceHealthMonitor;
  readonly events: EventProcessor;
  private stopped = false;
  private xFailureCount = 0;

  constructor(readonly config: AppConfig) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.store = new Store(config.databasePath);
    this.scraper = new XScraper(config);
    this.tweetSources = createTweetSourceManager(config, this.scraper);
    this.classifier = new DeepSeekClassifier(config, fetch, this.store);
    const copywriter = new DeepSeekCopywriter(config, this.store);
    this.notifier = new NotificationService(config, this.store, fetch, copywriter);
    this.health = new HealthMonitor(this.store, this.notifier);
    this.sourceHealth = new SourceHealthMonitor(this.store, this.notifier);
    this.notifier.setCopywriterHealthCallbacks({
      success: () => this.health.success("copywriter"),
      failure: (error, now) => this.health.failure("copywriter", error, now)
    });
    this.events = new EventProcessor(this.store, this.notifier);
  }

  async run(): Promise<void> {
    let nextPollAt = Date.now();
    const interrupted = this.store.markRunningProbeRunsInterrupted();
    if (interrupted > 0) logger.warn("probe_runs_marked_interrupted", { count: interrupted });
    try {
      await this.events.revalidatePendingReminders(new Date());
    } catch (error) {
      logger.error("pending_reminder_revalidation_failed", { error });
    }
    logger.info("watcher_started", {
      handle: this.config.xHandle,
      pollMinSeconds: this.config.pollMinSeconds,
      pollMaxSeconds: this.config.pollMaxSeconds,
      targetCount: this.store.listNotificationTargets().length
    });
    try {
      while (!this.stopped) {
        const now = new Date();
        try {
          await this.events.processDueReminders(now);
          await this.notifier.runScheduledHousekeeping(now);
          this.runRetention(now);
        } catch (error) {
          logger.error("scheduler_tick_failed", { error });
        }

        if (Date.now() >= nextPollAt) {
          try {
            await this.poll(now);
            this.xFailureCount = 0;
            nextPollAt = Date.now() + randomSeconds(this.config.pollMinSeconds, this.config.pollMaxSeconds) * 1000;
            this.store.setMeta("next_poll_at", new Date(nextPollAt).toISOString());
          } catch (error) {
            this.xFailureCount += 1;
            await this.health.failure("x", error, now);
            logger.error("x_poll_failed", { error, consecutiveFailures: this.xFailureCount });
            if (this.xFailureCount >= 3 && this.config.xBrowserEnabled) {
              await this.scraper.restart().catch(() => undefined);
            }
            const backoff = Math.min(
              this.config.pollMaxSeconds * 2 ** Math.min(this.xFailureCount - 1, 4),
              3600
            );
            nextPollAt = Date.now() + backoff * 1000;
            this.store.setMeta("next_poll_at", new Date(nextPollAt).toISOString());
          }
        }
        await sleep(Math.max(1_000, Math.min(15_000, nextPollAt - Date.now())));
      }
    } finally {
      await this.scraper.stop();
      this.store.close();
      logger.info("watcher_stopped");
    }
  }

  async poll(now = new Date()): Promise<void> {
    const initialized = Boolean(this.store.getMeta("initialized_at"));
    const cutoff = now.getTime() - this.config.backfillHours * 60 * 60 * 1000;
    const probeStartedAt = new Date();
    const runId = this.store.createProbeRun(
      probeStartedAt.toISOString(),
      this.tweetSources.enabledSourceNames(),
      this.config.pollMaxSeconds
    );
    const stats = emptyProbeStats();
    let probeFinished = false;
    try {
      const fetched = await this.tweetSources.fetchLatest(
        initialized ? {} : { since: new Date(cutoff).toISOString() },
        probeStartedAt
      );
      this.store.saveProbeFetchReport(runId, fetched.report);
      if (fetched.report.successfulSources.length === 0) {
        this.store.finishProbeRun(runId, "all_failed", stats, fetched.report.completedAt, "All X monitoring sources failed");
        probeFinished = true;
        throw new Error("All X monitoring sources failed");
      }
      await this.sourceHealth.process(fetched.report, now).catch((error) => {
        logger.error("source_health_notification_failed", { error });
      });
      this.health.success("x");
      this.store.setMeta("last_poll_at", fetched.report.completedAt);
      fs.writeFileSync(`${this.config.dataDir}/heartbeat`, fetched.report.completedAt, { encoding: "utf8" });

      for (const tweet of fetched.tweets) {
        if (this.store.tweetExists(tweet.id)) {
          stats.existingCount += 1;
          continue;
        }
        stats.newCount += 1;
        // RSS sources return a rolling history on every request. A newly observed
        // old item must never become a fresh notification after initialization.
        const withinBackfill = new Date(tweet.postedAt).getTime() >= cutoff;
        const disposition = this.disposition(tweet, withinBackfill);
        stats[disposition] += 1;
        this.store.saveTweet(tweet, disposition === "classifiableCount");
      }

      // Retry persisted work even when an older backfill post has scrolled out of
      // X's currently visible anonymous timeline.
      for (const tweet of this.store.getTweetsNeedingClassification()) {
        try {
          const classification = await this.classifier.classify(tweet);
          this.health.success("deepseek");
          this.store.saveClassification(tweet.id, classification);
          await this.events.process(tweet, classification, now);
          stats.classificationSuccessCount += 1;
        } catch (error) {
          stats.classificationFailureCount += 1;
          await this.health.failure("deepseek", error, now);
          logger.error("tweet_classification_failed", { tweetId: tweet.id, error });
        }
      }
      if (!initialized) this.store.setMeta("initialized_at", now.toISOString());
      const status = fetched.report.successfulSources.length === fetched.report.enabledSources.length
        ? "completed"
        : "partial";
      this.store.finishProbeRun(runId, status, stats, new Date().toISOString());
      probeFinished = true;
    } catch (error) {
      if (!probeFinished) {
        this.store.finishProbeRun(
          runId,
          "processing_failed",
          stats,
          new Date().toISOString(),
          sanitizeProbeError(error)
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private isEligible(tweet: TweetRecord): boolean {
    return tweet.authorHandle.toLowerCase() === this.config.xHandle
      && !tweet.isReply
      && !tweet.isRepost
      && !tweet.isQuote
      && tweet.cleanText.length > 0;
  }

  private disposition(
    tweet: TweetRecord,
    withinBackfill: boolean
  ): keyof Pick<ProbeDispositionStats,
    "classifiableCount" | "replyCount" | "repostCount" | "quoteCount" | "staleCount" | "otherExcludedCount"
  > {
    if (tweet.authorHandle.toLowerCase() !== this.config.xHandle || tweet.cleanText.length === 0) return "otherExcludedCount";
    if (tweet.isReply) return "replyCount";
    if (tweet.isRepost) return "repostCount";
    if (tweet.isQuote) return "quoteCount";
    if (!withinBackfill) return "staleCount";
    return "classifiableCount";
  }

  private runRetention(now: Date): void {
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
    if (`${local.hour}:${local.minute}` < "00:10") return;
    const day = `${local.year}-${local.month}-${local.day}`;
    if (this.store.getMeta("last_retention_day") === day) return;
    const cutoff = new Date(now.getTime() - this.config.adminTraceRetentionDays * 86_400_000).toISOString();
    this.store.cleanupRetention(cutoff);
    const probeCutoff = new Date(now.getTime() - this.config.probeRetentionDays * 86_400_000).toISOString();
    this.store.cleanupProbeRetention(probeCutoff);
    this.store.setMeta("last_retention_day", day);
  }
}

function emptyProbeStats(): ProbeDispositionStats {
  return {
    existingCount: 0,
    newCount: 0,
    classifiableCount: 0,
    replyCount: 0,
    repostCount: 0,
    quoteCount: 0,
    staleCount: 0,
    otherExcludedCount: 0,
    classificationSuccessCount: 0,
    classificationFailureCount: 0
  };
}
