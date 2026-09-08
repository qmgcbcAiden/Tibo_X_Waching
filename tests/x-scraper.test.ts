import fs from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { extractTimelineEntries, normalizeXPostedAt } from "../src/x-scraper.js";

describe("X timeline DOM extraction", () => {
  it("normalizes X absolute timestamps to UTC and rejects timezone-free values", () => {
    expect(normalizeXPostedAt("2026-09-01T10:00:00+08:00")).toBe("2026-09-01T02:00:00.000Z");
    expect(normalizeXPostedAt("2026-09-01T02:00:00.000Z")).toBe("2026-09-01T02:00:00.000Z");
    expect(normalizeXPostedAt("2026-09-01T02:00:00")).toBeNull();
  });
  it("marks replies, reposts and quote posts for strict exclusion", () => {
    const html = fs.readFileSync(new URL("./fixtures/timeline.html", import.meta.url), "utf8");
    const { document } = parseHTML(html);
    const tweets = extractTimelineEntries(document as unknown as Document, "thsottiaux");
    expect(tweets.map((tweet) => tweet.id)).toEqual(["100", "101", "102", "103"]);
    expect(tweets.find((tweet) => tweet.id === "100")).toMatchObject({
      isReply: false, isRepost: false, isQuote: false
    });
    expect(tweets.find((tweet) => tweet.id === "101")?.isQuote).toBe(true);
    expect(tweets.find((tweet) => tweet.id === "102")?.isReply).toBe(true);
    expect(tweets.find((tweet) => tweet.id === "103")?.isRepost).toBe(true);
  });

  it("parses X's schema.org anonymous timeline markup", () => {
    const { document } = parseHTML(`
      <article itemid="https://x.com/thsottiaux/status/200"
        itemtype="https://schema.org/SocialMediaPosting" itemprop="hasPart">
        <meta itemprop="url" content="https://x.com/thsottiaux/status/200">
        <meta itemprop="datePublished" content="2026-08-31T02:00:00.000Z">
        <meta itemprop="text" content="A scheduled reset">
        <div itemprop="author"><meta itemprop="alternateName" content="thsottiaux"></div>
      </article>
      <article itemid="https://x.com/thsottiaux/status/201"
        itemtype="https://schema.org/SocialMediaPosting" itemprop="hasPart">
        <meta itemprop="datePublished" content="2026-08-31T02:30:00.000Z">
        <meta itemprop="text" content="A confirmation with a quote">
        <div itemprop="author"><meta itemprop="alternateName" content="thsottiaux"></div>
        <article><div>quoted card</div></article>
      </article>
    `);
    const tweets = extractTimelineEntries(document as unknown as Document, "thsottiaux");
    expect(tweets).toHaveLength(2);
    expect(tweets[0]).toMatchObject({ id: "200", text: "A scheduled reset", isQuote: false });
    expect(tweets[1]).toMatchObject({ id: "201", isQuote: true });
  });
});
