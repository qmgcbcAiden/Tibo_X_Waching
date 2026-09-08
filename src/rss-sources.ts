import he from "he";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { cleanTweetText } from "./text.js";
import type { TweetRecord } from "./types.js";

type FetchImplementation = typeof fetch;

interface FeedlyItem {
  originId?: unknown;
  published?: unknown;
  title?: unknown;
  summary?: { content?: unknown };
  alternate?: Array<{ href?: unknown }>;
  author?: unknown;
}

interface FeedlyContents {
  title?: unknown;
  items?: unknown;
}

function mainPostHtml(html: string): string {
  return html.split(/<hr\b|<blockquote\b/i, 1)[0] ?? "";
}

function htmlToText(html: string): string {
  return cleanTweetText(
    he.decode(html)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
  );
}

function normalizedHandle(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^@/, "").toLowerCase() : "";
}

function tweetId(value: unknown, fallbackUrl?: unknown): string | null {
  const origin = typeof value === "string" ? value.trim() : "";
  if (/^\d{5,}$/.test(origin)) return origin;
  const url = typeof fallbackUrl === "string" ? fallbackUrl : origin;
  return url.match(/\/status\/(\d{5,})/)?.[1] ?? null;
}

function absolutePostedAt(value: unknown): string | null {
  const timestamp = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  const result = new Date(timestamp);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

function classifyEntry(title: string, html: string): Pick<TweetRecord, "isReply" | "isRepost" | "isQuote"> {
  return {
    isReply: /^\s*R to @/i.test(title),
    isRepost: /^\s*RT by @/i.test(title),
    isQuote: /<blockquote(?:\s|>)/i.test(html)
  };
}

function toTweet(input: {
  id: string;
  handle: string;
  postedAt: string;
  title: string;
  html: string;
}): TweetRecord | null {
  const rawText = htmlToText(mainPostHtml(input.html)) || cleanTweetText(input.title);
  const cleanText = cleanTweetText(rawText);
  if (!cleanText) return null;
  return {
    id: input.id,
    url: `https://x.com/${input.handle}/status/${input.id}`,
    authorHandle: input.handle,
    postedAt: input.postedAt,
    rawText,
    cleanText,
    ...classifyEntry(input.title, input.html)
  };
}

export function parseFeedlyContents(payload: unknown, expectedHandle: string): TweetRecord[] {
  if (!payload || typeof payload !== "object") throw new Error("Feedly returned invalid JSON");
  const contents = payload as FeedlyContents;
  if (!Array.isArray(contents.items)) throw new Error("Feedly response does not contain an items array");
  const handle = expectedHandle.toLowerCase();
  const tweets: TweetRecord[] = [];

  for (const raw of contents.items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as FeedlyItem;
    if (normalizedHandle(item.author) !== handle) continue;
    const alternate = Array.isArray(item.alternate)
      ? item.alternate.find((entry) => typeof entry?.href === "string")?.href
      : undefined;
    const id = tweetId(item.originId, alternate);
    const postedAt = absolutePostedAt(item.published);
    if (!id || !postedAt) continue;
    const title = typeof item.title === "string" ? item.title : "";
    const html = typeof item.summary?.content === "string" ? item.summary.content : title;
    const tweet = toTweet({ id, handle, postedAt, title, html });
    if (tweet) tweets.push(tweet);
  }

  if (
    tweets.length === 0
    && typeof contents.title === "string"
    && /not yet whitelist/i.test(contents.title)
  ) {
    throw new Error("Feedly currently exposes only the XCancel whitelist placeholder");
  }
  return tweets.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
}

function xmlValue(item: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = item.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match?.[1]?.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim() ?? "";
}

export function parseXCancelRss(xml: string, expectedHandle: string): TweetRecord[] {
  if (/RSS reader not yet whitelist/i.test(xml)) {
    throw new Error("XCancel RSS reader is not whitelisted yet");
  }
  if (!/<rss(?:\s|>)/i.test(xml) || !/<channel(?:\s|>)/i.test(xml)) {
    throw new Error("XCancel returned invalid RSS XML");
  }
  const handle = expectedHandle.toLowerCase();
  const tweets: TweetRecord[] = [];
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    if (normalizedHandle(htmlToText(xmlValue(item, "dc:creator"))) !== handle) continue;
    const guid = htmlToText(xmlValue(item, "guid"));
    const link = htmlToText(xmlValue(item, "link"));
    const id = tweetId(guid, link);
    const postedAt = absolutePostedAt(htmlToText(xmlValue(item, "pubDate")));
    if (!id || !postedAt) continue;
    const title = htmlToText(xmlValue(item, "title"));
    const html = xmlValue(item, "description") || title;
    const tweet = toTweet({ id, handle, postedAt, title, html });
    if (tweet) tweets.push(tweet);
  }
  return tweets.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
}

abstract class HttpTweetSource {
  abstract readonly name: string;
  abstract readonly priority: number;

  constructor(
    protected readonly config: AppConfig,
    protected readonly fetchImpl: FetchImplementation = fetch
  ) {}

  protected async request(url: string, accept: string): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: accept,
        "User-Agent": this.config.xRssUserAgent
      },
      redirect: "follow",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`${this.name} returned HTTP ${response.status}`);
    return response;
  }
}

export class FeedlyXSource extends HttpTweetSource {
  readonly name = "feedly_xcancel";
  readonly priority = 2;

  async fetchLatest(): Promise<TweetRecord[]> {
    const response = await this.request(this.config.xFeedlyStreamUrl, "application/json");
    const tweets = parseFeedlyContents(await response.json(), this.config.xHandle);
    logger.info("x_source_fetched", { source: this.name, count: tweets.length });
    return tweets;
  }
}

export class XCancelRssSource extends HttpTweetSource {
  readonly name = "xcancel_rss";
  readonly priority = 1;

  async fetchLatest(): Promise<TweetRecord[]> {
    const response = await this.request(this.config.xXcancelRssUrl, "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8");
    const tweets = parseXCancelRss(await response.text(), this.config.xHandle);
    logger.info("x_source_fetched", { source: this.name, count: tweets.length });
    return tweets;
  }
}
