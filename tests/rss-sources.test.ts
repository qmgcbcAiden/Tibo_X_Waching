import { describe, expect, it, vi } from "vitest";
import { parseFeedlyContents, parseXCancelRss } from "../src/rss-sources.js";
import { TweetSourceManager, type TweetSource } from "../src/tweet-sources.js";
import type { TweetRecord } from "../src/types.js";

const published = Date.parse("2026-08-31T02:00:00.000Z");

function item(id: string, title: string, html = `<p>${title}</p>`, offset = 0) {
  return {
    originId: id,
    published: published + offset,
    title,
    summary: { content: html },
    alternate: [{ href: `https://rss.xcancel.com/thsottiaux/status/${id}#m` }],
    author: "@thsottiaux"
  };
}

describe("Feedly XCancel adapter", () => {
  it("uses the RSS publication instant and canonical X URL", () => {
    const [tweet] = parseFeedlyContents({ items: [item("2094000000000000001", "A reset notice")] }, "thsottiaux");
    expect(tweet).toMatchObject({
      id: "2094000000000000001",
      postedAt: "2026-08-31T02:00:00.000Z",
      url: "https://x.com/thsottiaux/status/2094000000000000001",
      authorHandle: "thsottiaux"
    });
  });

  it("marks replies, reposts and quoted cards for strict exclusion", () => {
    const tweets = parseFeedlyContents({ items: [
      item("2094000000000000001", "Original post"),
      item("2094000000000000002", "R to @someone: hello"),
      item("2094000000000000003", "RT by @someone: hello"),
      item("2094000000000000004", "Own words", "<p>Own words</p><hr><blockquote>quoted post</blockquote>")
    ] }, "thsottiaux");
    expect(tweets.map(({ isReply, isRepost, isQuote }) => ({ isReply, isRepost, isQuote }))).toEqual([
      { isReply: false, isRepost: false, isQuote: false },
      { isReply: true, isRepost: false, isQuote: false },
      { isReply: false, isRepost: true, isQuote: false },
      { isReply: false, isRepost: false, isQuote: true }
    ]);
    expect(tweets[3]?.cleanText).toBe("Own words");
  });

  it("rejects a Feedly response that contains only the whitelist placeholder", () => {
    expect(() => parseFeedlyContents({ title: "RSS reader not yet whitelisted!", items: [] }, "thsottiaux"))
      .toThrow(/placeholder/);
  });
});

describe("direct XCancel RSS adapter", () => {
  it("parses RSS items without treating fetch time as post time", () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[A scheduled reset]]></title>
      <dc:creator>@thsottiaux</dc:creator>
      <description><![CDATA[<p>A scheduled reset<br>at 6pm PST</p>]]></description>
      <pubDate>Sun, 30 Aug 2026 18:00:00 GMT</pubDate>
      <guid>https://rss.xcancel.com/thsottiaux/status/2094000000000000005#m</guid>
      <link>https://rss.xcancel.com/thsottiaux/status/2094000000000000005#m</link>
    </item></channel></rss>`;
    const [tweet] = parseXCancelRss(xml, "thsottiaux");
    expect(tweet).toMatchObject({
      postedAt: "2026-08-30T18:00:00.000Z",
      cleanText: "A scheduled reset at 6pm PST",
      isQuote: false
    });
  });

  it("detects the not-yet-whitelisted response instead of reporting source success", () => {
    expect(() => parseXCancelRss(
      "<?xml version=\"1.0\"?><rss><channel><title>RSS reader not yet whitelisted!</title></channel></rss>",
      "thsottiaux"
    )).toThrow(/not whitelisted/);
  });
});

function tweet(id: string, text: string): TweetRecord {
  return {
    id,
    url: `https://x.com/thsottiaux/status/${id}`,
    authorHandle: "thsottiaux",
    postedAt: "2026-08-31T02:00:00.000Z",
    rawText: text,
    cleanText: text,
    isReply: false,
    isRepost: false,
    isQuote: false
  };
}

describe("multi-source resilience", () => {
  it("keeps working when one source fails and prefers the higher-priority duplicate", async () => {
    const browser: TweetSource = {
      name: "x_browser",
      priority: 0,
      fetchLatest: vi.fn().mockResolvedValue([tweet("2094000000000000001", "browser copy")])
    };
    const feedly: TweetSource = {
      name: "feedly_xcancel",
      priority: 2,
      fetchLatest: vi.fn().mockResolvedValue([
        tweet("2094000000000000001", "feedly copy"),
        tweet("2094000000000000002", "feedly only")
      ])
    };
    const failed: TweetSource = {
      name: "xcancel_rss",
      priority: 1,
      fetchLatest: vi.fn().mockRejectedValue(new Error("not whitelisted"))
    };
    const result = await new TweetSourceManager([browser, failed, feedly]).fetchLatest();
    expect(result.tweets).toHaveLength(2);
    expect(result.tweets.find((entry) => entry.id.endsWith("1"))?.cleanText).toBe("browser copy");
    expect(result.report).toMatchObject({
      totalItemCount: 3,
      uniqueItemCount: 2,
      crossSourceDuplicates: 1,
      successfulSources: ["x_browser", "feedly_xcancel"]
    });
  });

  it("fails the overall poll only when every enabled source fails", async () => {
    const names = ["x_browser", "feedly_xcancel"] as const;
    const sources: TweetSource[] = names.map((name, index) => ({
      name,
      priority: index,
      fetchLatest: vi.fn().mockRejectedValue(new Error(`${name} unavailable`))
    }));
    const result = await new TweetSourceManager(sources).fetchLatest();
    expect(result.tweets).toEqual([]);
    expect(result.report.successfulSources).toEqual([]);
    expect(result.report.sourceResults.every((source) => source.status === "failed")).toBe(true);
  });
});
