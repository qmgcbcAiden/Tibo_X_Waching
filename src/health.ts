import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";
import type { NotificationService } from "./notifier.js";
import type { HealthState, ProbeFetchReport, ProbeSourceName } from "./types.js";
import { shanghaiDay } from "./time.js";
import { stableId, truncate } from "./text.js";

export class HealthMonitor {
  constructor(
    private readonly store: Store,
    private readonly notifier: NotificationService
  ) {}

  async failure(component: HealthState["component"], error: unknown, now = new Date()): Promise<void> {
    const state = this.store.getHealth(component);
    state.consecutiveFailures += 1;
    state.lastError = truncate(error instanceof Error ? error.message : String(error), 400);
    const day = shanghaiDay(now);
    // Alert once per continuous incident. A successful check closes the
    // incident, so another three consecutive failures may alert again even on
    // the same Shanghai calendar day.
    const shouldAlert = state.consecutiveFailures >= 3 && !state.active;
    if (state.consecutiveFailures >= 3) state.active = true;
    if (shouldAlert) state.lastAlertDay = day;
    this.store.saveHealth(state);

    if (shouldAlert) {
      const componentLabel = component === "x" ? "X采集" : component === "deepseek" ? "DeepSeek分类" : "DeepSeek文案";
      await this.notifier.notifyMaintainer({
        id: stableId("health-failure", component, now.toISOString(), randomUUID()),
        category: "health_failure",
        priority: 1,
        title: `[Tibo监控故障] ${componentLabel} 连续失败`,
        body: `连续失败 ${state.consecutiveFailures} 次。\n\n最近错误：${state.lastError}`,
        facts: {
          eventType: "HEALTH_FAILURE",
          products: ["Tibo Watch"],
          summaryZh: `${componentLabel}连续失败 ${state.consecutiveFailures} 次，需要维护者检查。`,
          certainty: "failure",
          healthComponent: component,
          healthError: state.lastError ?? "未知错误"
        }
      }, now);
    }
  }

  success(component: HealthState["component"]): void {
    const state = this.store.getHealth(component);
    const recovered = state.active;
    state.consecutiveFailures = 0;
    state.active = false;
    state.lastError = null;
    if (recovered) state.recoveryPending = true;
    this.store.saveHealth(state);
  }
}

const RSS_SOURCE_LABELS: Partial<Record<ProbeSourceName, string>> = {
  feedly_xcancel: "Feedly",
  xcancel_rss: "XCancel RSS"
};

export class SourceHealthMonitor {
  constructor(
    private readonly store: Store,
    private readonly notifier: NotificationService
  ) {}

  async process(report: ProbeFetchReport, now = new Date()): Promise<void> {
    // When every source is down, the existing overall X incident owns the alert.
    // Skipping source transitions here prevents duplicate failure/recovery notices.
    if (report.successfulSources.length === 0) return;
    const failedNow: string[] = [];
    const recoveredNow: string[] = [];
    const errors: string[] = [];

    for (const result of report.sourceResults) {
      const label = RSS_SOURCE_LABELS[result.source];
      if (!label) continue;
      const state = this.store.getSourceHealth(result.source);
      state.lastStatus = result.status;
      state.lastCheckedAt = report.completedAt;
      state.updatedAt = report.completedAt;
      if (result.status === "success") {
        if (state.active) recoveredNow.push(label);
        state.consecutiveFailures = 0;
        state.active = false;
        state.lastError = null;
      } else {
        state.consecutiveFailures += 1;
        state.lastError = result.error;
        if (state.consecutiveFailures >= 3 && !state.active) {
          state.active = true;
          failedNow.push(label);
          if (result.error) errors.push(`${label}：${result.error}`);
        }
      }
      this.store.saveSourceHealth(state);
    }

    if (failedNow.length > 0) {
      await this.notifier.notifyMaintainer({
        id: stableId("rss-source-failure", failedNow.sort().join(","), report.startedAt),
        category: "health_failure",
        priority: 1,
        title: `[Tibo监控故障] ${failedNow.join("、")} 连续失败`,
        body: `${failedNow.join("、")} 已连续三轮采集失败。\n\n${errors.join("\n")}`,
        facts: {
          eventType: "HEALTH_FAILURE",
          products: ["Tibo Watch"],
          summaryZh: `${failedNow.join("、")} 已连续三轮采集失败，但其他来源仍可用，需要维护者检查。`,
          certainty: "failure",
          healthComponent: failedNow.join("、"),
          healthError: errors.join("；") || "连续三轮采集失败"
        }
      }, now);
    }

    if (recoveredNow.length > 0) {
      await this.notifier.notifyMaintainer({
        id: stableId("rss-source-recovery", recoveredNow.sort().join(","), report.startedAt),
        category: "health_recovery",
        priority: 5,
        title: `[Tibo监控恢复] ${recoveredNow.join("、")} 已恢复`,
        body: `${recoveredNow.join("、")} 已重新采集成功。`,
        facts: {
          eventType: "HEALTH_RECOVERY",
          products: ["Tibo Watch"],
          summaryZh: `${recoveredNow.join("、")} 已重新采集成功，来源恢复正常。`,
          certainty: "recovered",
          healthComponent: recoveredNow.join("、")
        }
      }, now);
    }
  }
}
