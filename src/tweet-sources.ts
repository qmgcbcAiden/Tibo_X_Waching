import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { FeedlyXSource, XCancelRssSource } from "./rss-sources.js";
import { truncate } from "./text.js";
import type {
  ProbeFetchResult,
  ProbeSourceName,
  ProbeSourceResult,
  TweetRecord
} from "./types.js";
import { XScraper, type FetchLatestOptions } from "./x-scraper.js";

export interface TweetSource {
  readonly name: ProbeSourceName;
  readonly priority: number;
  fetchLatest(options?: FetchLatestOptions): Promise<TweetRecord[]>;
}

export class TweetSourceManager {
  constructor(readonly sources: TweetSource[]) {
    if (sources.length === 0) throw new Error("At least one X monitoring source must be enabled");
  }

  enabledSourceNames(): ProbeSourceName[] {
    return this.sources.map((source) => source.name);
  }

  async fetchLatest(options: FetchLatestOptions = {}, startedAt = new Date()): Promise<ProbeFetchResult> {
    const results = await Promise.allSettled(
      this.sources.map(async (source) => {
        const sourceStarted = Date.now();
        try {
          const tweets = await source.fetchLatest(options);
          return { source, tweets, durationMs: Date.now() - sourceStarted };
        } catch (error) {
          throw { source, error, durationMs: Date.now() - sourceStarted };
        }
      })
    );
    const successes: Array<{ source: TweetSource; tweets: TweetRecord[]; durationMs: number }> = [];
    const sourceResults: ProbeSourceResult[] = [];

    results.forEach((result, index) => {
      const source = this.sources[index]!;
      if (result.status === "fulfilled") {
        successes.push(result.value);
        sourceResults.push({
          source: source.name,
          status: "success",
          durationMs: result.value.durationMs,
          itemCount: result.value.tweets.length,
          latestItemAt: latestItemAt(result.value.tweets),
          error: null
        });
      } else {
        const reason = result.reason as { error?: unknown; durationMs?: number } | unknown;
        const detail = reason && typeof reason === "object" && "error" in reason
          ? (reason as { error: unknown }).error
          : reason;
        const error = detail instanceof Error ? detail : new Error(String(detail));
        sourceResults.push({
          source: source.name,
          status: "failed",
          durationMs: reason && typeof reason === "object" && "durationMs" in reason
            ? Number((reason as { durationMs: number }).durationMs)
            : 0,
          itemCount: 0,
          latestItemAt: null,
          error: sanitizeProbeError(error)
        });
        logger.warn("x_source_failed", { source: source.name, error });
      }
    });

    const merged = new Map<string, { tweet: TweetRecord; priority: number }>();
    for (const { source, tweets } of successes) {
      for (const tweet of tweets) {
        const existing = merged.get(tweet.id);
        if (!existing || source.priority < existing.priority) {
          merged.set(tweet.id, { tweet, priority: source.priority });
        }
      }
    }
    logger.info("x_sources_merged", {
      successfulSources: successes.map(({ source }) => source.name),
      failedSourceCount: sourceResults.filter((item) => item.status === "failed").length,
      uniqueTweets: merged.size
    });
    const tweets = [...merged.values()]
      .map(({ tweet }) => tweet)
      .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
    const completedAt = new Date();
    const totalItemCount = sourceResults.reduce((sum, item) => sum + item.itemCount, 0);
    return {
      tweets,
      report: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        enabledSources: this.enabledSourceNames(),
        successfulSources: successes.map(({ source }) => source.name),
        sourceResults,
        totalItemCount,
        uniqueItemCount: tweets.length,
        crossSourceDuplicates: Math.max(0, totalItemCount - tweets.length)
      }
    };
  }
}

function latestItemAt(tweets: TweetRecord[]): string | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const tweet of tweets) {
    const timestamp = Date.parse(tweet.postedAt);
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

export function sanitizeProbeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return truncate(raw
    .replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, (url) => url.split(/[?#]/, 1)[0] ?? "[URL]")
    .replace(/SCT[A-Za-z0-9_-]{5,}/g, "[REDACTED_SENDKEY]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:api[_-]?key|token|cookie|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim(), 240);
}

export function createTweetSourceManager(
  config: AppConfig,
  scraper: XScraper,
  fetchImpl: typeof fetch = fetch
): TweetSourceManager {
  const sources: TweetSource[] = [];
  if (config.xBrowserEnabled) {
    sources.push({
      name: "x_browser",
      priority: 0,
      fetchLatest: (options) => scraper.fetchLatest(options)
    });
  }
  if (config.xXcancelRssEnabled) sources.push(new XCancelRssSource(config, fetchImpl));
  if (config.xFeedlyEnabled) sources.push(new FeedlyXSource(config, fetchImpl));
  return new TweetSourceManager(sources);
}
