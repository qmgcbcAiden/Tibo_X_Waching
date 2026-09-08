import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { TweetRecord } from "./types.js";
import { cleanTweetText } from "./text.js";
import { logger } from "./logger.js";
import { DateTime } from "luxon";

interface ExtractedTweet {
  id: string;
  url: string;
  authorHandle: string;
  postedAt: string;
  text: string;
  isReply: boolean;
  isRepost: boolean;
  isQuote: boolean;
}

export interface FetchLatestOptions {
  /** On first startup, keep scrolling until newly loaded posts cross this instant. */
  since?: string;
  maxScrolls?: number;
}

/** DOM-only extractor shared by the browser and HTML-fixture tests. */
export function extractTimelineEntries(document: Document, expectedHandle: string): ExtractedTweet[] {
  const selector = 'article[itemtype="https://schema.org/SocialMediaPosting"], article[data-testid="tweet"]';
  const articles = Array.from(document.querySelectorAll(selector))
    .filter((article) => !article.parentElement?.closest(selector));
  const results: ExtractedTweet[] = [];

  for (const article of articles) {
    const schemaUrl = article.getAttribute("itemid")
      ?? article.querySelector(':scope > meta[itemprop="url"]')?.getAttribute("content")
      ?? "";
    const schemaId = schemaUrl.match(/\/status\/(\d+)/)?.[1] ?? "";
    const schemaAuthor = article
      .querySelector(':scope > div[itemprop="author"] meta[itemprop="alternateName"]')
      ?.getAttribute("content") ?? "";
    const schemaText = article.querySelector(':scope > meta[itemprop="text"]')?.getAttribute("content") ?? "";
    const schemaPostedAt = article
      .querySelector(':scope > meta[itemprop="datePublished"]')
      ?.getAttribute("content") ?? "";
    if (
      schemaId
      && schemaAuthor.toLowerCase() === expectedHandle.toLowerCase()
      && schemaText
      && schemaPostedAt
    ) {
      const articleText = article.textContent ?? "";
      results.push({
        id: schemaId,
        url: `https://x.com/${expectedHandle}/status/${schemaId}`,
        authorHandle: expectedHandle.toLowerCase(),
        postedAt: schemaPostedAt,
        text: schemaText,
        isReply: /Replying to/i.test(articleText),
        isRepost: Array.from(article.querySelectorAll('[data-testid="socialContext"]'))
          .some((node) => /\breposted\b/i.test(node.textContent ?? "")),
        isQuote: Boolean(article.querySelector("article"))
      });
      continue;
    }

    const direct = <T extends Element>(elements: T[]): T[] =>
      elements.filter((element) => element.closest(selector) === article);
    const directLinks = direct(Array.from(article.querySelectorAll<HTMLAnchorElement>("a[href]")));
    const statusLink = directLinks.find((link) => {
      const href = link.getAttribute("href") ?? "";
      return new RegExp(`^/${expectedHandle}/status/(\\d+)`, "i").test(href);
    });
    if (!statusLink) continue;
    const href = statusLink.getAttribute("href") ?? "";
    const match = href.match(/\/status\/(\d+)/);
    if (!match?.[1]) continue;

    const handles = directLinks.map((link) => link.textContent?.trim() ?? "");
    const author = handles.find((text) => text.toLowerCase() === `@${expectedHandle.toLowerCase()}`);
    if (!author) continue;

    const textNodes = direct(Array.from(article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')));
    const timeNodes = direct(Array.from(article.querySelectorAll<HTMLTimeElement>("time[datetime]")));
    const socialNodes = direct(Array.from(article.querySelectorAll<HTMLElement>('[data-testid="socialContext"]')));
    const text = textNodes[0]?.innerText?.trim() ?? textNodes[0]?.textContent?.trim() ?? "";
    const postedAt = timeNodes[0]?.getAttribute("datetime") ?? "";
    if (!postedAt || !text) continue;

    const articleText = article.textContent ?? "";
    results.push({
      id: match[1],
      url: `https://x.com/${expectedHandle}/status/${match[1]}`,
      authorHandle: expectedHandle.toLowerCase(),
      postedAt,
      text,
      isReply: /Replying to/i.test(articleText),
      isRepost: socialNodes.some((node) => /reposted/i.test(node.textContent ?? "")),
      isQuote: Boolean(article.querySelector(selector))
    });
  }
  return results;
}

const EXTRACTOR_SOURCE = extractTimelineEntries.toString();

/** X exposes datePublished/time[datetime] as an absolute ISO instant. */
export function normalizeXPostedAt(value: string): string | null {
  const source = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(source)) return null;
  const parsed = DateTime.fromISO(source, { setZone: true });
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

export class XScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly config: AppConfig) {}

  async start(): Promise<void> {
    if (this.context) {
      if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
      return;
    }
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: ["--disable-dev-shm-usage", "--disable-background-networking", "--window-position=-10000,-10000"]
    });
    this.context = await this.browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      viewport: { width: 1280, height: 1600 }
    });
    await this.context.route("**/*", async (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "media", "font"].includes(resourceType)) await route.abort();
      else await route.continue();
    });
    this.page = await this.context.newPage();
  }

  async stop(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async fetchLatest(options: FetchLatestOptions = {}): Promise<TweetRecord[]> {
    await this.start();
    const page = this.page!;
    try {
      const url = `https://x.com/${this.config.xHandle}`;
      const response = await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
    if (response && response.status() >= 400) {
      throw new Error(`X anonymous timeline returned HTTP ${response.status()}`);
    }
    try {
      await page.waitForSelector("article", { state: "attached", timeout: 35_000 });
    } catch {
      logger.warn("x_timeline_missing_retrying_reload", {
        title: await page.title().catch(() => ""),
        bodyPreview: await page.locator("body").innerText({ timeout: 2_000 }).then((value) => value.slice(0, 300)).catch(() => "")
      });
      await page.reload({ waitUntil: "commit", timeout: 30_000 });
      await page.waitForSelector("article", { state: "attached", timeout: 35_000 });
    }

    const first = await this.extract(page);
    const unique = new Map(first.map((tweet) => [tweet.id, tweet]));
    const sinceMs = options.since ? new Date(options.since).getTime() : null;
    const maxScrolls = options.maxScrolls ?? (sinceMs === null ? 1 : 20);
    let stagnantScrolls = 0;

    for (let index = 0; index < maxScrolls; index += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 1200)));
      await page.waitForTimeout(1_000);
      const batch = await this.extract(page);
      const additions = batch.filter((tweet) => !unique.has(tweet.id));
      for (const tweet of additions) unique.set(tweet.id, tweet);

      stagnantScrolls = additions.length === 0 ? stagnantScrolls + 1 : 0;
      if (sinceMs !== null && additions.length > 0) {
        const validTimes = additions
          .map((tweet) => new Date(tweet.postedAt).getTime())
          .filter(Number.isFinite);
        if (validTimes.length > 0 && validTimes.every((value) => value <= sinceMs)) break;
      }
      if (stagnantScrolls >= 2 || sinceMs === null) break;
    }

    const tweets = [...unique.values()]
      .map((entry): TweetRecord | null => {
        const postedAt = normalizeXPostedAt(entry.postedAt);
        if (!postedAt) {
          logger.warn("x_tweet_timestamp_rejected", { tweetId: entry.id });
          return null;
        }
        return {
        id: entry.id,
        url: entry.url,
        authorHandle: entry.authorHandle,
        postedAt,
        rawText: entry.text,
        cleanText: cleanTweetText(entry.text),
        isReply: entry.isReply,
        isRepost: entry.isRepost,
        isQuote: entry.isQuote
        };
      })
      .filter((entry): entry is TweetRecord => entry !== null)
      .sort((a, b) => new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime());

    if (tweets.length === 0) {
      const body = (await page.locator("body").innerText({ timeout: 5_000 })).slice(0, 500);
      if (/log in|sign up|something went wrong|rate limit/i.test(body)) {
        throw new Error("X anonymous timeline is unavailable or requires authentication");
      }
      throw new Error("X timeline loaded without parseable posts");
    }
      logger.info("x_timeline_fetched", { count: tweets.length });
      return tweets;
    } finally {
      await page.close().catch(() => undefined);
      if (this.page === page) this.page = null;
    }
  }

  private async extract(page: Page): Promise<ExtractedTweet[]> {
    return page.evaluate(
      ({ source, handle }) => {
        const extractor = new Function(`return (${source})`)() as (doc: Document, value: string) => ExtractedTweet[];
        return extractor(document, handle);
      },
      { source: EXTRACTOR_SOURCE, handle: this.config.xHandle }
    );
  }
}
