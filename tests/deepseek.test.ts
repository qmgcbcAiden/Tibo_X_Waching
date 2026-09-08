import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db.js";
import { DeepSeekClassifier } from "../src/deepseek.js";
import type { TweetRecord } from "../src/types.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];
const tweet: TweetRecord = {
  id: "1",
  url: "https://x.com/thsottiaux/status/1",
  authorHandle: "thsottiaux",
  postedAt: "2026-08-30T12:00:00Z",
  rawText: "Your reset will land at 6pm PST",
  cleanText: "Your reset will land at 6pm PST",
  isReply: false,
  isRepost: false,
  isQuote: false
};

function modelResponse(
  overrides: Record<string, unknown> = {},
  options: {
    finishReason?: string;
    content?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  } = {}
): Response {
  const output = {
    verdict: "YES",
    event_type: "RESET_SCHEDULED",
    confidence: 0.95,
    products: ["Codex", "ChatGPT Work"],
    summary_zh: "额度将在指定时间刷新",
    evidence: "reset will land",
    time_kind: "exact",
    source_time_text: "6pm PST",
    source_timezone: "PST",
    scheduled_at: "2026-08-31T02:00:00Z",
    ...overrides
  };
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: options.finishReason,
      message: { content: options.content ?? JSON.stringify(output) }
    }],
    usage: options.usage
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function lengthResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "length", message: { content: "" } }],
    usage: {
      prompt_tokens: 313,
      completion_tokens: 700,
      total_tokens: 1013,
      completion_tokens_details: { reasoning_tokens: 700 }
    }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("DeepSeek routing", () => {
  it("accepts a high-confidence Flash result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const fetchMock = vi.fn(async () => modelResponse());
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.scheduledAt).toBe("2026-08-31T02:00:00Z");
    const request = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).thinking).toEqual({ type: "disabled" });
  });

  it("uses Pro when Flash is uncertain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelResponse({ verdict: "UNCERTAIN", confidence: 0.6 }))
      .mockResolvedValueOnce(modelResponse({ event_type: "RESET_NOW", time_kind: "none", source_time_text: null, source_timezone: null, scheduled_at: null }));
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("deepseek-v4-pro");
  });

  it("uses Pro after invalid Flash JSON", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const invalid = new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }));
    const fetchMock = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(modelResponse());
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("deepseek-v4-pro");
  });

  it("classifies Tibo Astra compensation as a banked reset with approximate timing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const tiboTweet: TweetRecord = {
      id: "2095651088502591861",
      url: "https://x.com/thsottiaux/status/2095651088502591861",
      authorHandle: "thsottiaux",
      postedAt: "2026-09-03T23:12:09.000Z",
      rawText: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can. First one will land in ~ 3 hours. There is still time to create your account if you don't have one.",
      cleanText: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can. First one will land in ~ 3 hours. There is still time to create your account if you don't have one.",
      isReply: false,
      isRepost: false,
      isQuote: false
    };
    const fetchMock = vi.fn(async () => modelResponse({
      event_type: "BANKED_RESET",
      products: ["paid ChatGPT plan", "Astra"],
      summary_zh: "Tibo 说 paid ChatGPT plan 用户因 Astra 暂未开放会每天补一个 banked reset，第一枚约 3 小时后到账。",
      evidence: "First one will land in ~ 3 hours.",
      time_kind: "approximate",
      source_time_text: "in ~ 3 hours",
      source_timezone: null,
      scheduled_at: null
    }));
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tiboTweet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      verdict: "YES",
      eventType: "BANKED_RESET",
      products: ["paid ChatGPT plan", "Astra"],
      timeKind: "approximate",
      scheduledAt: "2026-09-04T02:12:09Z"
    });
    expect(result.timeResolution).toMatchObject({
      status: "approximate",
      reasonCode: "relative_duration",
      displayTime: "2026-09-04 周五 10:12",
      canSchedule: true
    });
  });

  it("treats storable reset credits as banked reset intent without requiring the exact phrase", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const storableTweet: TweetRecord = {
      id: "stored-reset-credit",
      url: "https://x.com/thsottiaux/status/stored-reset-credit",
      authorHandle: "thsottiaux",
      postedAt: "2026-09-03T12:00:00Z",
      rawText: "Paid ChatGPT plan users who do not have Astra yet will receive one reset credit per day. These credits can be stored for 30 days before expiring.",
      cleanText: "Paid ChatGPT plan users who do not have Astra yet will receive one reset credit per day. These credits can be stored for 30 days before expiring.",
      isReply: false,
      isRepost: false,
      isQuote: false
    };
    const fetchMock = vi.fn(async () => modelResponse({
      event_type: "BANKED_RESET",
      products: ["paid ChatGPT plan", "Astra"],
      summary_zh: "Tibo 说未获得 Astra 的 paid ChatGPT plan 用户会每天得到一个可存储的重置额度。",
      evidence: "reset credit per day",
      time_kind: "vague",
      source_time_text: "per day",
      source_timezone: null,
      scheduled_at: null
    }));
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(storableTweet);
    expect(result).toMatchObject({
      verdict: "YES",
      eventType: "BANKED_RESET",
      timeKind: "vague",
      scheduledAt: null
    });
    const request = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit;
    const systemPrompt = JSON.parse(String(request.body)).messages[0].content as string;
    expect(systemPrompt).toContain("Do not require the exact English phrase");
    expect(systemPrompt).toContain("stored for 30 days");
  });

  it("escalates truncated empty Flash output and records token usage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    store.saveTweet(tweet, true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse())
      .mockResolvedValueOnce(modelResponse());
    const classifier = new DeepSeekClassifier(config, fetchMock as unknown as typeof fetch, store);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("deepseek-v4-pro");
    const calls = store.getModelCallsForTweet(tweet.id);
    expect(calls[0]).toMatchObject({
      stage: "classify_flash",
      model: "deepseek-v4-flash",
      status: "failed",
      httpStatus: 200,
      inputTokens: 313,
      outputTokens: 700,
      totalTokens: 1013
    });
    expect(calls[0]?.error).toContain("truncated before JSON content");
    store.close();
  });

  it("normalizes a protocol-level negative event alias without escalating", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const fetchMock = vi.fn(async () => modelResponse({
      verdict: "NO",
      event_type: "NOT_RELEVANT",
      confidence: 0.99,
      products: [],
      time_kind: "none",
      source_time_text: null,
      source_timezone: null,
      scheduled_at: null
    }));
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("NO");
    expect(result.eventType).toBe("OTHER");
  });

  it("keeps unknown event types strict for positive results", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelResponse({ event_type: "BONUS" }))
      .mockResolvedValueOnce(modelResponse());
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("deepseek-v4-pro");
  });

  it("uses Pro when the Flash verdict and event type contradict each other", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelResponse({ verdict: "NO", event_type: "RESET_NOW", confidence: 0.99 }))
      .mockResolvedValueOnce(modelResponse({ event_type: "RESET_NOW", time_kind: "none", source_time_text: null, source_timezone: null, scheduled_at: null }));
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.verdict).toBe("YES");
  });

  it("uses Pro when Flash time conflicts with deterministic parsing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelResponse({ scheduled_at: "2026-08-31T03:00:00Z" }))
      .mockResolvedValueOnce(modelResponse());
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.timeResolution).toMatchObject({ status: "exact", canSchedule: true });
  });

  it("keeps a positive Pro event but refuses to schedule conflicting time evidence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-deepseek-"));
    tempDirs.push(dir);
    const conflict = { scheduled_at: "2026-08-31T03:00:00Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelResponse(conflict))
      .mockResolvedValueOnce(modelResponse(conflict));
    const classifier = new DeepSeekClassifier(testConfig(dir), fetchMock as unknown as typeof fetch);
    const result = await classifier.classify(tweet);
    expect(result.verdict).toBe("YES");
    expect(result.scheduledAt).toBeNull();
    expect(result.timeResolution).toMatchObject({ status: "conflict", reasonCode: "model_program_mismatch", canSchedule: false });
  });
});
