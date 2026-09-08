import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COPY_MOODS,
  COPY_MOOD_WEIGHTS,
  COPY_TIME_TOKENS,
  DeepSeekCopywriter,
  completeManagedCopy,
  factsForModel,
  validateCopy
} from "../src/copywriter.js";
import { Store } from "../src/db.js";
import { NotificationService } from "../src/notifier.js";
import type { NotificationMessage, NotificationTarget } from "../src/types.js";
import { shanghaiDay } from "../src/time.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];
const target: NotificationTarget = { name: "alice", sendKey: "SCT_ALICE_TEST", role: "maintainer" };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function message(id: string): NotificationMessage {
  return {
    id,
    category: "scheduled",
    priority: 2,
    title: "额度刷新预告",
    body: "Tibo 预告额度将在指定时间刷新。",
    tweetId: "1",
    scheduledFor: "2026-09-01T02:00:00.000Z",
    facts: {
      eventType: "RESET_SCHEDULED",
      products: ["Codex", "ChatGPT Work"],
      summaryZh: "Tibo 已经预告 Codex 和 ChatGPT Work 的额度将在指定时间刷新。",
      sourceUrl: "https://x.com/thsottiaux/status/1",
      postedAtDisplay: "2026-08-31 周一 20:00",
      sourceTimeText: "6pm PST",
      displayTime: "2026-09-01 周二 10:00",
      timezoneSource: "explicit",
      timeStatus: "exact",
      scheduledAt: "2026-09-01T02:00:00.000Z",
      certainty: "scheduled",
      callToAction: "use_remaining_before_reset"
    }
  };
}

function bankedMessage(id: string): NotificationMessage {
  return {
    id,
    category: "banked",
    priority: 3,
    title: "Banked reset 预计到账",
    body: "Tibo 预告 paid ChatGPT plan 因 Astra access 会获得 banked reset。",
    tweetId: "2095651088502591861",
    scheduledFor: "2026-09-04T02:12:09Z",
    facts: {
      eventType: "BANKED_RESET",
      products: ["paid ChatGPT plan", "Astra"],
      summaryZh: "Tibo 说 paid ChatGPT plan 因 Astra 暂未开放会每天补一个 banked reset，第一枚约 3 小时后到账。Banked reset 可存 30 天。",
      sourceUrl: "https://x.com/thsottiaux/status/2095651088502591861",
      postedAtDisplay: "2026-09-04 周五 07:12",
      sourceTimeText: "in ~ 3 hours",
      displayTime: "2026-09-04 周五 10:12",
      timeStatus: "approximate",
      scheduledAt: "2026-09-04T02:12:09Z",
      certainty: "scheduled",
      callToAction: "check_banked_reset"
    }
  };
}

function bankedDueMessage(id: string): NotificationMessage {
  return {
    id,
    category: "due",
    priority: 2,
    title: "可存重置到账提醒",
    body: "Tibo 预告的可存储重置次数预计已经到账，可存 30 天，记得确认是否到账。",
    scheduledFor: "2026-09-04T02:12:09Z",
    facts: {
      eventType: "BANKED_RESET",
      products: ["paid ChatGPT plan", "Astra"],
      summaryZh: "Tibo 预告的可存储重置次数预计已经到账，请确认是否到账；这类额度可存 30 天。",
      displayTime: "2026-09-04 周五 10:12",
      scheduledAt: "2026-09-04T02:12:09Z",
      certainty: "confirmed",
      callToAction: "check_banked_reset"
    }
  };
}

function validCopyResponse(): Response {
  const body = [
    "哼，我才不是特意提醒笨蛋主人喵～ (￢_￢)",
    "Tibo 是在 2026-08-31 周一 20:00 发帖的，原文写着 6pm PST，主人这边的时间预计是 2026-09-01 周二 10:00，Codex 和 ChatGPT Work 都会刷新喵～ (￣▽￣)",
    "刷新前赶紧把现在剩余的额度用掉，别等清零才后悔喵～ (｀・ω・´)",
    "（才、才不是担心笨蛋主人会浪费额度呢……）\n快点记好，我才不会一直催你喵～ (￣^￣)"
  ].join("\n\n");
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      title: "额度刷新时间记好了喵～",
      body,
      addressTerm: "笨蛋主人"
    }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function copyResponse(output: { title: string; body: string; addressTerm: string }): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 80, completion_tokens: 60, total_tokens: 140 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("catgirl copywriter", () => {
  it("contains all six approved moods and exact event weights", () => {
    expect(COPY_MOODS).toEqual(["shy", "proud", "disdain", "happy", "sleepy", "worried"]);
    expect(COPY_MOOD_WEIGHTS.confirmed).toEqual({
      shy: 15, proud: 25, disdain: 10, happy: 40, sleepy: 5, worried: 5
    });
    expect(COPY_MOOD_WEIGHTS.suspected.worried).toBe(45);
    expect(COPY_MOOD_WEIGHTS.health.worried).toBe(70);
  });

  it("does not repeat a recipient's previous production mood", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn(async () => validCopyResponse());
    const copywriter = new DeepSeekCopywriter(config, store, fetchMock as unknown as typeof fetch);
    const first = await copywriter.generate(message("copy-1"), target);
    const second = await copywriter.generate(message("copy-2"), target);
    expect(second.generation.mood).not.toBe(first.generation.mood);
    expect(first.generation.body).toContain("2026-09-01 周二 10:00");
    expect(first.generation.body).not.toContain("https://x.com/thsottiaux/status/1");
    const firstRequest = (fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit | undefined;
    const firstPayload = JSON.parse(String(firstRequest?.body));
    expect(firstPayload.model).toBe("deepseek-v4-flash");
    expect(firstPayload.thinking).toEqual({ type: "disabled" });
    expect(firstPayload.max_tokens).toBe(4096);
    const modelFacts = JSON.parse(firstPayload.messages[1].content).immutable_facts;
    expect(JSON.stringify(modelFacts)).not.toContain("2026-08-31 周一 20:00");
    expect(JSON.stringify(modelFacts)).not.toContain("6pm PST");
    expect(JSON.stringify(modelFacts)).toContain(COPY_TIME_TOKENS.postedAt);
    expect(JSON.stringify(modelFacts)).toContain(COPY_TIME_TOKENS.sourceTime);
    store.close();
  });

  it("passes banked reset action semantics to the model payload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const facts = bankedMessage("banked-payload").facts!;
    const body = [
      "笨蛋主人，本喵抓到 banked reset 计划了喵～ (￢_￢)",
      "Tibo 是在 2026-09-04 周五 07:12 发帖的，原文写的是 in ~ 3 hours，paid ChatGPT plan 和 Astra 的 banked reset 按主人这边的时间预计会在 2026-09-04 周五 10:12 到账喵～ (￣▽￣)",
      "到点后记得确认 banked reset 是否到账；Banked reset 可存 30 天，别把它当成普通刷新清零提醒喵～ (｀・ω・´)",
      "（才不是怕主人漏看到账呢……）\n本喵只是顺手提醒一下喵～ (￣^￣)"
    ].join("\n\n");
    expect(validateCopy({ title: "Banked reset 快到啦喵", body, addressTerm: "笨蛋主人" }, facts, "banked", "shy")).toEqual([]);

    const fetchMock = vi.fn(async () => copyResponse({ title: "Banked reset 快到啦喵", body, addressTerm: "笨蛋主人" }));
    const result = await new DeepSeekCopywriter(config, store, fetchMock as unknown as typeof fetch)
      .generate(bankedMessage("banked-payload"), target);
    expect(result.generation.status).toBe("generated");
    const payload = JSON.parse(String(((fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit).body));
    expect(payload.thinking).toEqual({ type: "disabled" });
    const style = JSON.parse(payload.messages[1].content).style_constraints;
    expect(style.action_semantics).toContain("确认");
    expect(style.action_semantics).toContain("30 天");
    expect(style.action_semantics).toContain("禁止");
    expect(style.action_semantics).toContain("不要求使用英文 banked reset");
    expect(style.remaining_usage_action).toBeUndefined();
    store.close();
  });

  it("uses short output limits and facts for banked reset due reminders", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const body = [
      "主人，到点啦，本喵来催你看一眼喵～ (≧▽≦)",
      "按主人这边的时间是 2026-09-04 周五 10:12，本喵看好啦，涉及 paid ChatGPT plan、Astra。",
      "快确认可存储重置是否到账；这类额度可存 30 天喵～ (￣▽￣)",
      "（才不是怕主人漏看呢……）\n看完就好，别拖啦喵～ (￣^￣)"
    ].join("\n\n");
    const fetchMock = vi.fn(async () => copyResponse({ title: "可存重置到账啦喵", body, addressTerm: "主人" }));
    const result = await new DeepSeekCopywriter(config, store, fetchMock as unknown as typeof fetch)
      .generate(bankedDueMessage("banked-due-short"), target);
    expect(result.generation.status).toBe("generated");
    expect([...result.generation.body].length).toBeLessThanOrEqual(260);
    expect(validateCopy(result.generation, bankedDueMessage("banked-due-short").facts!, "due", result.generation.mood)).toEqual([]);
    const payload = JSON.parse(String(((fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit).body));
    const userPrompt = JSON.parse(payload.messages[1].content);
    expect(userPrompt.output_limits).toEqual({ title_chars: "4-32", body_chars: "80-260" });
    expect(userPrompt.immutable_facts).not.toHaveProperty("postedAtDisplay");
    expect(userPrompt.immutable_facts).not.toHaveProperty("sourceTimeText");
    store.close();
  });

  it("keeps preview moods out of production history", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const copywriter = new DeepSeekCopywriter(config, store, vi.fn(async () => validCopyResponse()) as unknown as typeof fetch);
    await copywriter.generate(message("preview-1"), target, { preview: true });
    expect(store.getLastProductionMood(target.name)).toBeNull();
    store.close();
  });

  it("repairs once, falls back, and only then consumes one ServerChan call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir, { targets: [target] });
    const store = new Store(config.databasePath);
    const modelFetch = vi.fn(async () => new Response("not-json", { status: 200 }));
    const serverFetch = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" }
    }));
    const copywriter = new DeepSeekCopywriter(config, store, modelFetch as unknown as typeof fetch);
    const notifier = new NotificationService(config, store, serverFetch as unknown as typeof fetch, copywriter);
    const now = new Date("2026-08-31T03:00:00Z");
    const [result] = await notifier.broadcast(message("fallback-1"), now);
    expect(modelFetch).toHaveBeenCalledTimes(2);
    expect(serverFetch).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe("sent");
    expect(store.getDailyCalls(target.name, shanghaiDay(now))).toBe(1);
    expect(store.getCopyGeneration("fallback-1", target.name)?.isFallback).toBe(true);
    const fallback = store.getCopyGeneration("fallback-1", target.name)!;
    expect([...fallback.body].length).toBeLessThanOrEqual(500);
    expect(validateCopy(fallback, message("fallback-1").facts!, "scheduled", fallback.mood)).toEqual([]);
    store.close();
  });

  it("rejects markdown, emoji, and abusive address terms", () => {
    const facts = message("validation").facts!;
    const body = "笨蛋主人，Tibo 已经预告 Codex 和 ChatGPT Work 会计划刷新额度喵～ (￢_￢)\n\n他在 2026-08-31 周一 20:00 发帖，原文写着 6pm PST，主人这边的时间是 2026-09-01 周二 10:00喵～ (￣▽￣)\n\n把现在剩余的额度赶紧用掉，别磨蹭喵～ (｀・ω・´)\n\n（才不是担心主人浪费掉呢……）\n我才不会一直提醒你喵～ (￣^￣)";
    expect(validateCopy({ title: "计划提醒已经准备好喵", body: `${body}\n\n**加粗**`, addressTerm: "主人" }, facts, "scheduled"))
      .toContain("禁止 Markdown");
    expect(validateCopy({ title: "计划提醒已经准备好喵", body: `${body}\n\n😀`, addressTerm: "主人" }, facts, "scheduled"))
      .toContain("禁止 Emoji");
    expect(validateCopy({ title: "计划提醒已经准备好喵", body, addressTerm: "傻逼" }, facts, "scheduled"))
      .toContain("称呼或正文超出玩笑式毒舌边界");
    expect(validateCopy({ title: "计划提醒已经准备好喵", body: `${body}\nhttps://x.com/thsottiaux/status/1`, addressTerm: "主人" }, facts, "scheduled"))
      .toContain("实际通知禁止输出原帖链接");
  });

  it("enforces readable kaomoji density, mutter brackets, and remaining-usage urging", () => {
    const facts = message("style-validation").facts!;
    const body = [
      "笨蛋主人，本喵来提醒额度计划了喵～ (￢_￢)",
      "Tibo 在 2026-08-31 周一 20:00 发帖，原文写着 6pm PST；Codex 和 ChatGPT Work 按主人这边的时间会在 2026-09-01 周二 10:00 刷新喵～ (￣▽￣)",
      "刷新前赶紧把现在剩余的额度用掉，别浪费喵～ (｀・ω・´)",
      "（才、才不是怕主人忘掉呢……）\n记好了喵～ (￣^￣)"
    ].join("\n\n");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body, addressTerm: "笨蛋主人" }, facts, "scheduled", "shy")).toEqual([]);

    const tooFew = body.replace(" (｀・ω・´)", "").replace(" (￣^￣)", "");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body: tooFew, addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .toContain("正文颜文字数量必须为 3-5 个");
    const clumped = body.replace(" (￢_￢)", " (￢_￢) (¬_¬)");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body: clumped, addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .toContain("每个非空行最多放一个颜文字");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body: body.replace("（才、才不是怕主人忘掉呢……）", "小声嘟囔：才不是怕主人忘掉呢"), addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .toContain("小声嘟囔必须放在中文全角括号内");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body: body.replace("主人这边的时间", "上海时间"), addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .toContain("换算时间必须称为主人这边的时间，禁止地理时区标签");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body: body.replace("Tibo 在 2026-08-31 周一 20:00 发帖，原文写着 6pm PST；Codex 和 ChatGPT Work 按主人这边的时间会在 2026-09-01 周二 10:00 刷新喵～ (￣▽￣)", "Tibo 发帖时间：2026-08-31 周一 20:00喵～ (￣▽￣)\n原文时间：6pm PST\n主人这边的时间：2026-09-01 周二 10:00"), addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .toContain("时间说明必须写成一到两句猫娘话，禁止字段清单");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body: body.replace("刷新前赶紧把现在剩余的额度用掉，别浪费", "刷新前记得看一眼"), addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .toContain("刷新前预告必须催促主人赶紧把剩余额度用掉");
  });

  it("accepts a natural Chinese rendering of an English source-time expression", () => {
    const facts = {
      ...message("semantic-time").facts!,
      sourceTimeText: "tomorrow at 6pm PST"
    };
    const body = [
      "笨蛋主人，本喵来告诉你这条计划消息喵～ (￢_￢)",
      "Tibo 是在 2026-08-31 周一 20:00 发帖的，原文说的是明天下午6点（PST），Codex 和 ChatGPT Work 换成主人这边的时间会在 2026-09-01 周二 10:00 刷新喵～ (￣▽￣)",
      "刷新前赶紧把现在剩余的额度用掉，别浪费喵～ (｀・ω・´)",
      "（才、才不是怕主人忘掉呢……）\n记好了喵～ (￣^￣)"
    ].join("\n\n");
    expect(validateCopy({ title: "额度刷新计划记好啦喵", body, addressTerm: "笨蛋主人" }, facts, "scheduled", "shy"))
      .not.toContain("缺少原文时间语义");
  });

  it("accepts a natural Chinese rendering of an approximate relative source-time expression", () => {
    const facts = bankedMessage("relative-semantic").facts!;
    const body = [
      "笨蛋主人，本喵抓到可存储重置计划了喵～ (￢_￢)",
      "Tibo 是在 2026-09-04 周五 07:12 发帖的，原文说大约 3 小时后；paid ChatGPT plan 和 Astra 的可存储重置次数按主人这边的时间预计会在 2026-09-04 周五 10:12 到账喵～ (￣▽￣)",
      "到点后记得确认可存储重置是否到账；这类额度可存 30 天，别把它当成普通刷新清零提醒喵～ (｀・ω・´)",
      "（才不是怕主人漏看到账呢……）\n本喵只是顺手提醒一下喵～ (￣^￣)"
    ].join("\n\n");
    expect(validateCopy({ title: "可存重置快到啦喵", body, addressTerm: "笨蛋主人" }, facts, "banked", "shy"))
      .not.toContain("缺少原文时间语义");
  });

  it("enforces banked reset confirmation and storage-window wording", () => {
    const facts = bankedMessage("banked-validation").facts!;
    const body = [
      "笨蛋主人，本喵抓到可存储重置计划了喵～ (￢_￢)",
      "Tibo 是在 2026-09-04 周五 07:12 发帖的，原文写的是 in ~ 3 hours，paid ChatGPT plan 和 Astra 的可存储重置次数按主人这边的时间预计会在 2026-09-04 周五 10:12 到账喵～ (￣▽￣)",
      "到点后记得确认可存储重置是否到账；这类额度可存 30 天，别把它当成普通刷新清零提醒喵～ (｀・ω・´)",
      "（才不是怕主人漏看到账呢……）\n本喵只是顺手提醒一下喵～ (￣^￣)"
    ].join("\n\n");
    expect(validateCopy({ title: "可存重置快到啦喵", body, addressTerm: "笨蛋主人" }, facts, "banked", "shy")).toEqual([]);
    expect(validateCopy({
      title: "可存重置快到啦喵",
      body: body.replace("到点后记得确认可存储重置是否到账；", ""),
      addressTerm: "笨蛋主人"
    }, facts, "banked", "shy")).toContain("Banked reset 通知必须提醒确认是否到账");
    expect(validateCopy({
      title: "可存重置快到啦喵",
      body: body.replace("这类额度可存 30 天，", ""),
      addressTerm: "笨蛋主人"
    }, facts, "banked", "shy")).toContain("Banked reset 通知必须说明可存 30 天");
    expect(validateCopy({
      title: "可存重置快到啦喵",
      body: body.replace("到点后记得确认可存储重置是否到账；这类额度可存 30 天，别把它当成普通刷新清零提醒", "刷新前赶紧把现在剩余的额度用掉，确认到账后也别浪费，这类额度可存 30 天"),
      addressTerm: "笨蛋主人"
    }, facts, "banked", "shy")).toContain("Banked reset 通知禁止催促提前消耗当前剩余额度");
  });

  it("materializes trusted time placeholders and locally fills an omitted placeholder", () => {
    const facts = message("managed-time").facts!;
    const output = {
      title: "额度刷新计划来啦喵",
      body: [
        "笨蛋主人，本喵才不是特意提醒你喵～ (￢_￢)",
        `Tibo 在 ${COPY_TIME_TOKENS.postedAt} 发帖，Codex 和 ChatGPT Work 按主人这边的时间会在 ${COPY_TIME_TOKENS.displayTime} 计划刷新喵～ (￣▽￣)`,
        "刷新前把剩余的额度赶紧用掉喵～ (｀・ω・´)",
        "（才不是怕你浪费额度呢……）\n自己记好喵～ (￣^￣)"
      ].join("\n\n"),
      addressTerm: "笨蛋主人"
    };
    const completed = completeManagedCopy(output, facts, "scheduled", "shy");
    expect(completed.body).toContain("2026-08-31 周一 20:00");
    expect(completed.body).toContain("2026-09-01 周二 10:00");
    expect(completed.body).toContain("6pm PST");
    expect(completed.body).not.toContain("[[");
    expect(validateCopy(completed, facts, "scheduled", "shy")).toEqual([]);
  });

  it("repairs missing banked reset action locally without adding remaining-usage urging", () => {
    const facts = bankedMessage("banked-local-completion").facts!;
    const output = {
      title: "可存重置计划来啦喵",
      body: [
        "笨蛋主人，本喵才不是特意提醒你喵～ (￢_￢)",
        `Tibo 在 ${COPY_TIME_TOKENS.postedAt} 发帖，原文写着 ${COPY_TIME_TOKENS.sourceTime}，paid ChatGPT plan 和 Astra 按主人这边的时间会在 ${COPY_TIME_TOKENS.displayTime} 到账喵～ (￣▽￣)`,
        "到时候自己看好，别说本喵没有提醒喵～ (｀・ω・´)",
        "（才不是专门替你操心呢……）\n记牢啦喵～ (￣^￣)"
      ].join("\n\n"),
      addressTerm: "笨蛋主人"
    };
    const completed = completeManagedCopy(output, facts, "banked", "shy");
    expect(completed.body).toContain("确认可存储重置是否到账");
    expect(completed.body).toContain("可存 30 天");
    expect(completed.body).not.toMatch(/剩余.{0,24}额度.{0,24}用掉/);
    expect(validateCopy(completed, facts, "banked", "shy")).toEqual([]);
  });

  it("repairs missing products and remaining-usage urging locally without a Pro call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const body = [
      "笨蛋主人，本喵带来计划消息喵～ (￢_￢)",
      `Tibo 在 ${COPY_TIME_TOKENS.postedAt} 发帖，原文写着 ${COPY_TIME_TOKENS.sourceTime}，按主人这边的时间会在 ${COPY_TIME_TOKENS.displayTime} 刷新喵～ (￣▽￣)`,
      "到时候自己看好，别说本喵没有提醒喵～ (｀・ω・´)",
      "（才不是专门替你操心呢……）\n记牢啦喵～ (￣^￣)"
    ].join("\n\n");
    const fetchMock = vi.fn(async () => copyResponse({ title: "额度刷新计划来啦喵", body, addressTerm: "笨蛋主人" }));
    const result = await new DeepSeekCopywriter(config, store, fetchMock as unknown as typeof fetch)
      .generate(message("local-completion"), target);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.generation.status).toBe("generated");
    expect(result.generation.body).toContain("Codex、ChatGPT Work");
    expect(result.generation.body).toMatch(/剩下的额度用掉/);
    store.close();
  });

  it("routes invalid JSON to the Pro repair model with independent token ceilings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] })))
      .mockResolvedValueOnce(validCopyResponse());
    const result = await new DeepSeekCopywriter(config, store, fetchMock as unknown as typeof fetch)
      .generate(message("flash-pro-route"), target);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const draft = JSON.parse(String(((fetchMock.mock.calls as unknown[][])[0]?.[1] as RequestInit).body));
    const repair = JSON.parse(String(((fetchMock.mock.calls as unknown[][])[1]?.[1] as RequestInit).body));
    expect(draft).toMatchObject({ model: "deepseek-v4-flash", max_tokens: 4096 });
    expect(repair).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 16384 });
    expect(result.generation.status).toBe("repaired");
    store.close();
  });

  it("routes an invented clock to Pro instead of accepting model-tampered facts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const unsafeBody = [
      "笨蛋主人，本喵来告诉你计划消息喵～ (￢_￢)",
      `Tibo 在 ${COPY_TIME_TOKENS.postedAt} 发帖，原文写的是 7pm PST，Codex 和 ChatGPT Work 按主人这边的时间会在 ${COPY_TIME_TOKENS.displayTime} 计划刷新喵～ (￣▽￣)`,
      "刷新前赶紧把剩余的额度用掉喵～ (｀・ω・´)",
      "（才不是担心你会错过呢……）\n自己记好喵～ (￣^￣)"
    ].join("\n\n");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(copyResponse({ title: "额度刷新计划来啦喵", body: unsafeBody, addressTerm: "笨蛋主人" }))
      .mockResolvedValueOnce(validCopyResponse());
    const result = await new DeepSeekCopywriter(config, store, fetchMock as unknown as typeof fetch)
      .generate(message("tampered-time"), target);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.generation.status).toBe("repaired");
    const calls = store.getModelCallsForMessage("tampered-time");
    expect(calls.find((call) => call.stage === "copy_repair")?.escalationReason)
      .toContain("未经程序托管的时间事实");
    store.close();
  });

  it("keeps immutable facts out of the model payload", () => {
    const facts = message("tokenized-facts").facts!;
    const prepared = factsForModel(facts);
    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain(facts.postedAtDisplay!);
    expect(serialized).not.toContain(facts.sourceTimeText!);
    expect(serialized).not.toContain(facts.displayTime!);
    expect(prepared.scheduledAt).toBeUndefined();
  });

  it("keeps a twelve-item fallback digest within the plain-text limit without original-post links", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-copy-"));
    tempDirs.push(dir);
    const config = testConfig(dir);
    const store = new Store(config.databasePath);
    const modelFetch = vi.fn(async () => new Response("invalid"));
    const copywriter = new DeepSeekCopywriter(config, store, modelFetch as unknown as typeof fetch);
    const urls = Array.from({ length: 12 }, (_, index) => `https://x.com/thsottiaux/status/${1000 + index}`);
    const digestMessage: NotificationMessage = {
      id: "digest-fallback",
      category: "digest",
      priority: 1,
      title: "今日汇总",
      body: "今日汇总",
      facts: {
        eventType: "DIGEST",
        products: ["Codex", "ChatGPT Work"],
        summaryZh: "今天有多条低优先级额度动态没有即时发送，现在合并为一条汇总。",
        certainty: "summary",
        digestItems: urls.map((sourceUrl, index) => ({
          title: `第 ${index + 1} 条`,
          summary: "这是一条需要放入今晚汇总的额度动态事实。",
          sourceUrl
        }))
      }
    };
    const result = await copywriter.generate(digestMessage, target);
    expect([...result.generation.body].length).toBeLessThanOrEqual(1000);
    for (const url of urls) expect(result.generation.body).not.toContain(url);
    expect(result.generation.body).not.toMatch(/(?:^|\n)\s*[-*#>]/);
    expect(validateCopy(result.generation, digestMessage.facts!, "digest", result.generation.mood)).toEqual([]);
    const digestRequest = (modelFetch.mock.calls as unknown[][])[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(digestRequest?.body)).max_tokens).toBe(24576);
    store.close();
  });
});
