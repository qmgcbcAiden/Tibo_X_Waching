import type { AppConfig } from "./config.js";
import { PassthroughCopywriter, type NotificationCopywriter } from "./copywriter.js";
import { Store } from "./db.js";
import type {
  DeliveryResult,
  NotificationMessage,
  NotificationTarget
} from "./types.js";
import {
  isAtOrAfterShanghaiTime,
  isCrossDayWindow,
  shanghaiDay,
  shanghaiDayBoundsUtc
} from "./time.js";
import { stableId, truncate } from "./text.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { resolveTimeEvidence } from "./time.js";

interface ServerChanResponse {
  code?: number;
  message?: string;
}

export class NotificationService {
  private readonly copywriter: NotificationCopywriter;
  private copywriterSuccess?: () => void;
  private copywriterFailure?: (error: unknown, now: Date) => Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
    copywriter?: NotificationCopywriter
  ) {
    this.copywriter = copywriter ?? new PassthroughCopywriter(store);
    this.store.bootstrapNotificationTargets(config.targets);
  }

  setCopywriterHealthCallbacks(callbacks: {
    success: () => void;
    failure: (error: unknown, now: Date) => Promise<void>;
  }): void {
    this.copywriterSuccess = callbacks.success;
    this.copywriterFailure = callbacks.failure;
  }

  private targets(): NotificationTarget[] {
    return this.store.listNotificationTargets().map(({ name, sendKey, role }) => ({ name, sendKey, role }));
  }

  async broadcast(message: NotificationMessage, now = new Date()): Promise<DeliveryResult[]> {
    return Promise.all(this.targets().map((target) => this.deliver(message, target, now)));
  }

  async notifyMaintainer(message: NotificationMessage, now = new Date()): Promise<DeliveryResult> {
    const target = this.targets().find((item) => item.role === "maintainer");
    if (!target) throw new Error("Maintainer notification target is missing");
    return this.deliver(message, target, now);
  }

  async previewTarget(name: string, now = new Date()): Promise<{
    title: string;
    body: string;
    mood: string;
    addressTerm: string;
    fallback: boolean;
    delivery: DeliveryResult;
  }> {
    const target = this.store.getNotificationTarget(name);
    if (!target || !target.enabled) throw new Error("通知用户不存在或已停用");
    // Use the real few-shot post as a stable preview fixture. Its X timestamp
    // is 2026-08-30 19:24 UTC (2026-08-31 03:24 for the recipient), while the
    // date-less "6pm PST" belongs to the post's 2026-08-30 PST calendar day.
    const samplePostedAt = DateTime.fromISO("2026-08-30T19:24:37.000Z", { setZone: true });
    const sourceTimeText = "at 6pm PST";
    const targetPst = DateTime.fromObject({
      year: 2026,
      month: 8,
      day: 30,
      hour: 18,
      minute: 0
    }, { zone: "UTC-8" });
    const sampleText = `Your Codex and ChatGPT Work reset will land ${sourceTimeText}.`;
    const timeResolution = resolveTimeEvidence({
      timeKind: "exact",
      sourceTimeText,
      sourceTimezone: "PST",
      scheduledAt: targetPst.toISO()
    }, { postedAt: samplePostedAt.toISO()!, cleanText: sampleText });
    if (!timeResolution.candidateScheduledAt || !timeResolution.displayTime) {
      throw new Error(`无法构造动态预览时间：${timeResolution.reason}`);
    }
    const message: NotificationMessage = {
      id: stableId("preview", name, randomUUID()),
      category: "scheduled",
      priority: 2,
      title: "额度刷新时间记好了喵～",
      body: `动态预览：Tibo 预告 Codex 和 ChatGPT Work 额度将在 ${sourceTimeText} 刷新。`,
      tweetId: "preview-sample",
      scheduledFor: timeResolution.candidateScheduledAt,
      facts: {
        eventType: "RESET_SCHEDULED",
        products: ["Codex", "ChatGPT Work"],
        summaryZh: "这是后台文案预览：Tibo 预告 Codex 和 ChatGPT Work 的额度将在指定时间刷新。",
        postedAtDisplay: timeResolution.postedAtDisplay,
        sourceTimeText,
        displayTime: timeResolution.displayTime,
        timezoneSource: "explicit",
        timeStatus: "exact",
        scheduledAt: timeResolution.candidateScheduledAt,
        certainty: "scheduled",
        callToAction: "use_remaining_before_reset"
      }
    };
    this.store.saveNotificationIntent(message);
    const result = await this.copywriter.generate(message, target, { preview: true });
    const delivery = await this.sendGeneratedCopy(message, target, result.generation, now, {
      queueOnFailure: false
    });
    return {
      title: result.generation.title,
      body: result.generation.body,
      mood: result.generation.mood,
      addressTerm: result.generation.addressTerm,
      fallback: result.generation.isFallback,
      delivery
    };
  }

  async verifyTarget(name: string, now = new Date()): Promise<DeliveryResult> {
    const target = this.store.getNotificationTarget(name);
    if (!target || !target.enabled) throw new Error("通知用户不存在或已停用");
    const message: NotificationMessage = {
      id: stableId("channel-test", name, randomUUID()),
      category: "channel_test",
      priority: 5,
      title: "通道验证消息送到啦喵～",
      body: "这是一条由管理后台发起的 Server酱通道验证消息。",
      facts: {
        eventType: "CHANNEL_TEST",
        products: ["Tibo Watch"],
        summaryZh: "Server酱通知通道验证；收到这条消息表示当前 SendKey 可以正常送达。",
        certainty: "test"
      }
    };
    return this.deliver(message, target, now, { queueOnFailure: false, queueWhenDeferred: false });
  }

  queueForAll(message: NotificationMessage, notBefore = new Date().toISOString()): void {
    for (const target of this.targets()) this.store.enqueue(message, target.name, notBefore, "scheduled_queue");
  }

  async runScheduledHousekeeping(now = new Date()): Promise<void> {
    if (isCrossDayWindow(now)) await this.runCrossDay(now);
    if (isAtOrAfterShanghaiTime(now, this.config.overflowDigestTime)) await this.runDigest(now);
  }

  private async deliver(
    message: NotificationMessage,
    target: NotificationTarget,
    now: Date,
    options: { queueOnFailure?: boolean; queueWhenDeferred?: boolean } = {}
  ): Promise<DeliveryResult> {
    const queueOnFailure = options.queueOnFailure ?? true;
    const queueWhenDeferred = options.queueWhenDeferred ?? true;
    this.store.saveNotificationIntent(message);
    const recoveries = target.role === "maintainer" ? this.pendingRecoveryComponents() : [];
    let copy;
    try {
      const generated = await this.copywriter.generate(message, target, { recoveries });
      copy = generated.generation;
      const isCopywriterAlert = message.facts?.healthComponent === "copywriter";
      if (!isCopywriterAlert) {
        if (generated.modelSucceeded) this.copywriterSuccess?.();
        else await this.copywriterFailure?.(new Error("DeepSeek 文案生成与修正均失败，已使用保底文案"), now);
      }
    } catch (error) {
      if (message.facts?.healthComponent !== "copywriter") await this.copywriterFailure?.(error, now);
      logger.error("notification_copy_generation_failed", { targetName: target.name, messageId: message.id, error });
      if (queueWhenDeferred) this.defer(message, target, now);
      return { targetName: target.name, status: "deferred", error: error instanceof Error ? error.message : String(error) };
    }

    const result = await this.sendGeneratedCopy(message, target, copy, now, { queueOnFailure });
    if (result.status === "sent") this.clearRecoveries(recoveries);
    return result;
  }

  private async sendGeneratedCopy(
    message: NotificationMessage,
    target: NotificationTarget,
    copy: { id: number; title: string; body: string },
    now: Date,
    options: { queueOnFailure: boolean }
  ): Promise<DeliveryResult> {
    const day = shanghaiDay(now);
    const reserved = this.store.reserveAttempt(target.name, day, message, copy.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const endpoint = `https://sctapi.ftqq.com/${encodeURIComponent(target.sendKey)}.send`;
      const form = new URLSearchParams({ title: copy.title.replace(/[\r\n]+/g, " "), desp: copy.body });
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: form,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({})) as ServerChanResponse;
      if (!response.ok || payload.code !== 0) {
        const error = `ServerChan HTTP ${response.status}: ${payload.message ?? "unknown error"}`;
        this.store.updateAttempt(reserved.attemptId, "failed", truncate(error, 500));
        if (options.queueOnFailure) this.deferAfterFailure(message, target, now);
        logger.warn("serverchan_delivery_failed", { targetName: target.name, status: response.status });
        return { targetName: target.name, status: "failed", attemptId: reserved.attemptId, error };
      }
      this.store.updateAttempt(reserved.attemptId, "sent");
      logger.info("serverchan_delivery_sent", {
        targetName: target.name,
        category: message.category,
        dailyCalls: reserved.calls
      });
      return { targetName: target.name, status: "sent", attemptId: reserved.attemptId };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.updateAttempt(reserved.attemptId, "unknown", truncate(detail, 500));
      if (options.queueOnFailure) this.deferAfterFailure(message, target, now);
      logger.warn("serverchan_delivery_unknown", { targetName: target.name, error });
      return { targetName: target.name, status: "unknown", attemptId: reserved.attemptId, error: detail };
    } finally {
      clearTimeout(timeout);
    }
  }

  private defer(message: NotificationMessage, target: NotificationTarget, now: Date): void {
    this.store.enqueue(message, target.name, now.toISOString(), "copy_generation_failed", now.toISOString());
    logger.info("notification_deferred", {
      targetName: target.name,
      messageId: message.id,
      category: message.category
    });
  }

  private deferAfterFailure(message: NotificationMessage, target: NotificationTarget, now: Date): void {
    // The original API call is never retried. The queue is consumed only by a
    // digest (or, for an undelivered confirmation, the next-day roll-up).
    this.store.enqueue(message, target.name, now.toISOString(), "delivery_failed_no_retry", now.toISOString());
  }

  private pendingRecoveryComponents(): string[] {
    return (["x", "deepseek", "copywriter"] as const)
      .filter((component) => this.store.getHealth(component).recoveryPending)
      .map((component) => component === "x" ? "X 采集" : component === "deepseek" ? "DeepSeek 分类" : "DeepSeek 文案");
  }

  private clearRecoveries(labels: string[]): void {
    if (labels.length === 0) return;
    for (const component of ["x", "deepseek", "copywriter"] as const) {
      const state = this.store.getHealth(component);
      if (!state.recoveryPending) continue;
      state.recoveryPending = false;
      this.store.saveHealth(state);
    }
  }

  private async runDigest(now: Date): Promise<void> {
    const day = shanghaiDay(now);
    for (const target of this.targets()) {
      const metaKey = `digest:${day}:${target.name}`;
      if (this.store.getMeta(metaKey)) continue;
      const queued = this.store.getQueued(target.name, now.toISOString())
        .filter((item) => item.priority > 1 || ["suspected", "health_recovery"].includes(item.category));
      const recoveries = target.role === "maintainer" ? this.pendingRecoveryComponents() : [];
      if (queued.length === 0 && recoveries.length === 0) {
        continue;
      }
      const lines = queued.slice(0, 12).map((item) => `- ${item.title}：${truncate(item.body.replace(/\s+/g, " "), 180)}`);
      const message: NotificationMessage = {
        id: stableId("digest", day, target.name),
        category: "digest",
        priority: 1,
        title: `[Tibo监控] ${day} 未即时消息汇总`,
        body: lines.join("\n"),
        facts: {
          eventType: "DIGEST",
          products: ["Codex", "ChatGPT Work"],
          summaryZh: `${day} 有 ${queued.length} 条低优先级消息未即时送达，请合并说明。`,
          certainty: "summary",
          recoveries,
          digestItems: queued.slice(0, 12).map((item) => ({
            title: item.title,
            summary: truncate(item.body.replace(/\s+/g, " "), 220),
            ...(this.store.getNotificationIntent(item.messageId)?.facts.sourceUrl
              ? { sourceUrl: this.store.getNotificationIntent(item.messageId)!.facts.sourceUrl }
              : {})
          }))
        }
      };
      const result = await this.deliver(message, target, now, { queueOnFailure: true, queueWhenDeferred: false });
      if (["sent", "failed", "unknown"].includes(result.status)) {
        this.store.markQueue(queued.map((item) => item.id), "consumed");
        this.store.setMeta(metaKey, result.status);
      }
    }
  }

  private async runCrossDay(now: Date): Promise<void> {
    const currentDay = shanghaiDay(now);
    const { start } = shanghaiDayBoundsUtc(currentDay);
    for (const target of this.targets()) {
      const metaKey = `crossday:${currentDay}:${target.name}`;
      if (this.store.getMeta(metaKey)) continue;
      const old = this.store.getQueued(target.name, now.toISOString())
        .filter((item) => item.createdAt < start);
      const critical = old.filter((item) =>
        item.priority === 1 && ["confirmed", "due"].includes(item.category)
      );
      const expired = old.filter((item) => !critical.includes(item));
      if (expired.length > 0) this.store.markQueue(expired.map((item) => item.id), "expired");
      if (critical.length === 0) {
        this.store.setMeta(metaKey, "empty");
        continue;
      }
      const message: NotificationMessage = {
        id: stableId("crossday", currentDay, target.name),
        category: "cross_day",
        priority: 1,
        title: "[Tibo额度] 延迟送达的确认消息",
        body: critical.slice(0, 12)
          .map((item) => `- ${item.title}：${truncate(item.body.replace(/\s+/g, " "), 220)}`)
          .join("\n"),
        facts: {
          eventType: "CROSS_DAY",
          products: ["Codex", "ChatGPT Work"],
          summaryZh: `有 ${critical.length} 条额度确认消息因昨日发送失败或服务异常而延迟送达。`,
          certainty: "summary",
          digestItems: critical.slice(0, 12).map((item) => ({
            title: item.title,
            summary: truncate(item.body.replace(/\s+/g, " "), 260),
            ...(this.store.getNotificationIntent(item.messageId)?.facts.sourceUrl
              ? { sourceUrl: this.store.getNotificationIntent(item.messageId)!.facts.sourceUrl }
              : {})
          }))
        }
      };
      const result = await this.deliver(message, target, now, { queueOnFailure: true, queueWhenDeferred: false });
      if (["sent", "failed", "unknown"].includes(result.status)) {
        this.store.markQueue(critical.map((item) => item.id), "consumed");
        this.store.setMeta(metaKey, result.status);
      }
    }
  }
}
