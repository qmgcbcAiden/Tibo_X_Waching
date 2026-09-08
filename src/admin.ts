import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";
import type { NotificationService } from "./notifier.js";
import type {
  AdminDashboardStatus,
  AnalysisFilter,
  AnalysisSummary,
  DashboardTarget
} from "./types.js";
import { formatShanghai, shanghaiDay, shanghaiDayBoundsUtc } from "./time.js";
import { truncate } from "./text.js";
import { logger } from "./logger.js";
import { ADMIN_CSS, ADMIN_JS } from "./admin-assets.js";
import { AdminSessions, LoginRateLimiter, verifyPassword } from "./admin-auth.js";

const SESSION_COOKIE = "tibo_admin";
const BODY_LIMIT = 16 * 1024;
const ADMIN_ASSET_VERSION = "20260901-2";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]!);
}

function maskSendKey(sendKey: string): string {
  return sendKey.length <= 9 ? `${sendKey.slice(0, 3)}***` : `${sendKey.slice(0, 3)}***${sendKey.slice(-4)}`;
}

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || [...name].length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("用户名必须是 1–64 个非控制字符");
  }
  return name;
}

function normalizeSendKey(value: unknown): string {
  const sendKey = typeof value === "string" ? value.trim() : "";
  if (!/^SCT[A-Za-z0-9_-]{5,}$/.test(sendKey)) throw new Error("SendKey 格式无效");
  return sendKey;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return value?.trim() || request.socket.remoteAddress || "unknown";
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > BODY_LIMIT) throw new Error("请求体不能超过 16KB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const content = (await readBody(request)).toString("utf8");
  if (!content) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求内容必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.end();
}

function renderLoginUnversioned(error = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tibo Watch 登录</title><link rel="stylesheet" href="/assets/admin.css"></head><body><main class="login-wrap"><section class="card login-card"><div class="mark">TW</div><h1>Tibo Watch</h1><p class="subtitle">监控在工作，后台只向管理员开放。</p><form method="post" action="/login"><div class="field"><label for="username">管理员用户名</label><input id="username" name="username" autocomplete="username" required></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button class="btn primary" type="submit">进入控制台</button>${error ? `<div class="login-error">${escapeHtml(error)}</div>` : ""}</form></section></main></body></html>`;
}

function versionAdminAssets(html: string): string {
  return html
    .replace("/assets/admin.css\"", `/assets/admin.css?v=${ADMIN_ASSET_VERSION}\"`)
    .replace("/assets/admin.js\"", `/assets/admin.js?v=${ADMIN_ASSET_VERSION}\"`);
}

function renderLogin(error = ""): string {
  return versionAdminAssets(renderLoginUnversioned(error));
}

function renderUserCard(user: DashboardTarget): string {
  const admin = user.role === "maintainer";
  return `<article class="card user-card" data-user="${escapeHtml(user.name)}"><div class="user-summary"><div class="user-row"><div class="identity"><span class="name">${escapeHtml(user.name)}</span><span class="pill ${user.enabled ? "" : "off"}">${admin ? "管理员" : user.enabled ? "接收中" : "已停用"}</span></div><div class="budget">${user.calls}<small> 今日调用</small></div></div><div class="mini-stats"><div class="mini"><b>${user.scheduledDue}</b><span>今日排期</span></div><div class="mini"><b>${user.pendingDigest}</b><span>待汇总</span></div><div class="mini"><b>${escapeHtml(user.maskedSendKey)}</b><span>SendKey</span></div></div><div class="actions"><button class="btn" data-action="preview">生成并发送预览</button><button class="btn" data-action="show-verify">验证通道</button><button class="btn" data-action="toggle-manage">管理</button></div><div class="feedback preview-output" data-feedback aria-live="polite"></div></div><div class="manage-panel" data-manage hidden><form data-action="update"><div class="field"><label>新的 SendKey（留空表示不修改）</label><input name="sendKey" type="password" autocomplete="off" placeholder="${escapeHtml(user.maskedSendKey)}"></div>${admin ? "" : `<label class="toggle"><input name="enabled" type="checkbox" ${user.enabled ? "checked" : ""}> 接收通知</label>`}<div class="actions"><button class="btn primary" type="submit">保存</button>${admin ? "" : `<button class="btn danger" type="button" data-action="show-delete">删除用户</button>`}</div></form><div data-danger></div></div></article>`;
}

function analysisBadge(item: AnalysisSummary): { label: string; css: string } {
  if (item.activityKind === "probe") {
    if (["all_failed", "processing_failed", "interrupted"].includes(item.probeStatus ?? "")) {
      return { label: "异常", css: "failed" };
    }
    if (item.probeStatus === "partial") return { label: "部分", css: "uncertain" };
    if (item.probeStatus === "running") return { label: "探测中", css: "" };
    return { label: "探测", css: "yes" };
  }
  if (item.activityKind === "copy") {
    if (item.copyStatus === "fallback") return { label: "保底", css: "uncertain" };
    if (item.copyStatus === "selected") return { label: "生成中", css: "" };
    return { label: "文案", css: "yes" };
  }
  if (item.failed) return { label: "失败", css: "failed" };
  if (item.verdict === "YES") return { label: "命中", css: "yes" };
  if (item.verdict === "UNCERTAIN") return { label: "疑似", css: "uncertain" };
  if (item.verdict === "NO") return { label: "未命中", css: "" };
  return { label: "待判断", css: "" };
}

function renderAnalysisCard(item: AnalysisSummary): string {
  const badge = analysisBadge(item);
  const important = item.failed || item.verdict === "YES" || item.verdict === "UNCERTAIN";
  const meta = item.activityKind === "probe"
    ? `${item.probeStatus ?? "unknown"}${item.interruptionMinutes ? ` · 探测中断约 ${item.interruptionMinutes} 分钟` : ""}`
    : item.activityKind === "copy"
    ? `${item.isPreview ? "预览" : "生产"} · ${item.targetName ?? "未知用户"} · ${item.copyStatus ?? "selected"}`
    : `${item.eventType ?? "无事件"}${item.flashEscalated ? " · 已升级 Pro" : ""}`;
  return `<article class="analysis-card" id="analysis-${escapeHtml(item.tweetId)}" data-analysis="${escapeHtml(item.tweetId)}" data-important="${important ? "1" : "0"}"><button class="analysis-summary" data-action="detail" type="button"><span class="verdict ${badge.css}">${badge.label}</span><span class="analysis-main"><span class="analysis-title">${escapeHtml(truncate(item.cleanText, 260))}</span><span class="analysis-meta">${escapeHtml(formatShanghai(item.postedAt))} · ${escapeHtml(meta)}</span></span><span class="chevron">›</span></button><div class="timeline" hidden></div></article>`;
}

function renderDashboardUnversioned(
  csrf: string,
  status: AdminDashboardStatus,
  users: DashboardTarget[],
  analyses: AnalysisSummary[]
): string {
  const completionRate = status.today.tasks === 0 ? "—" : `${Math.round(status.today.completedTasks / status.today.tasks * 100)}%`;
  if (status.lastPollAt) status.lastPollAt = formatShanghai(status.lastPollAt);
  if (status.nextReminder) status.nextReminder.dueAt = formatShanghai(status.nextReminder.dueAt);
  const reminder = status.nextReminder
    ? `<a class="next-reminder" data-next-reminder href="#analysis-${escapeHtml(status.nextReminder.tweetId)}"><div class="status-label">下一次排期提醒</div><div class="status-value">${escapeHtml(status.nextReminder.products.join("、"))} · ${escapeHtml(status.nextReminder.dueAt)}</div></a>`
    : `<a class="next-reminder" data-next-reminder href="#"><div class="status-label">下一次排期提醒</div><div class="status-value">暂无排期</div></a>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="csrf-token" content="${escapeHtml(csrf)}"><title>Tibo Watch 控制台</title><link rel="stylesheet" href="/assets/admin.css"><script src="/assets/admin.js" defer></script></head><body><div class="shell"><header class="topbar"><div class="brandline"><div class="brand"><div class="mark">TW</div><div><h1>Tibo Watch</h1><div class="subtitle">额度动态与猫娘文案控制台</div></div></div><form action="/logout" method="post"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button class="logout" type="submit">退出</button></form></div><div class="status-strip"><div class="status-item"><div class="status-label">Watcher</div><div class="status-value" data-status="watcher"><span class="dot ${status.watcher === "healthy" ? "" : "bad"}"></span>${status.watcher === "healthy" ? "运行中" : "需留意"}</div></div><div class="status-item"><div class="status-label">X 采集</div><div class="status-value" data-status="x"><span class="dot ${status.x.active || status.pollOverdue ? "bad" : ""}"></span>${status.x.active ? "异常" : "正常"} · 可用 ${status.availableSourceCount}/${status.enabledSourceCount}</div></div><div class="status-item"><div class="status-label">DeepSeek</div><div class="status-value" data-status="deepseek"><span class="dot ${status.deepseek.active ? "bad" : ""}"></span>${status.deepseek.active ? "异常" : "正常"}</div></div><div class="status-item"><div class="status-label">最近轮询</div><div class="status-value" data-last-poll>${escapeHtml(status.lastPollAt ?? "暂无")}</div></div><div class="status-item"><div class="status-label">下一轮询</div><div class="status-value ${status.pollOverdue ? "overdue" : ""}" data-next-poll>${escapeHtml(status.nextPollAt ? formatShanghai(status.nextPollAt) : "暂无")}</div></div>${reminder}</div></header><main class="workspace"><section class="column mobile-active" data-column="users"><div class="section-head"><div><h2>通知用户</h2><p>每个独立 Server酱账号分别计数</p></div><span class="pill">最多 20 人</span></div><details class="card new-card"><summary>＋ 新增通知用户</summary><div class="new-panel"><form data-action="add"><div class="field"><label>用户名（创建后不可修改）</label><input name="name" required maxlength="64" autocomplete="off"></div><div class="field"><label>独立账号的 SendKey</label><input name="sendKey" type="password" required autocomplete="off"></div><button class="btn primary" type="submit">保存用户</button><div class="feedback" data-add-feedback></div></form></div></details><div data-users>${users.map(renderUserCard).join("")}</div></section><section class="column" data-column="deepseek"><div class="section-head"><div><h2>DeepSeek 分析</h2><p data-stream-retention>保留最近 30 天的分类、文案与发送轨迹</p></div><div class="filters"><button class="filter active" data-action="filter" data-filter="all">全部</button><button class="filter" data-action="filter" data-filter="copy">文案</button><button class="filter" data-action="filter" data-filter="hit">命中</button><button class="filter" data-action="filter" data-filter="miss">未命中</button><button class="filter" data-action="filter" data-filter="suspected">疑似</button><button class="filter" data-action="filter" data-filter="failed">失败</button><button class="filter" data-action="filter" data-filter="test">测试</button><button class="filter" data-action="filter" data-filter="probe">探测</button></div></div><div class="metrics"><div class="metric"><span>模型请求</span><b data-metric="requests">${status.today.requests}</b></div><div class="metric"><span data-metric-label="success">任务完成 · ${status.today.fallbacks} 条保底</span><b data-metric="success">${completionRate}</b></div><div class="metric"><span>Flash → Pro</span><b data-metric="ratio">${Math.round(status.today.flashToProRatio * 100)}%</b></div><div class="metric"><span>Token</span><b data-metric="tokens">${status.today.totalTokens.toLocaleString()}</b></div></div><div data-analyses>${analyses.map(renderAnalysisCard).join("") || `<div class="empty">最近 30 天还没有分析记录</div>`}</div><button class="btn load-more" data-action="load-more" data-load-more>加载更多</button></section></main></div><nav class="mobile-tabs"><button class="mobile-tab active" data-action="mobile-tab" data-tab="users">用户</button><button class="mobile-tab" data-action="mobile-tab" data-tab="deepseek">DeepSeek</button></nav></body></html>`;
}

function renderDashboard(
  csrf: string,
  status: AdminDashboardStatus,
  users: DashboardTarget[],
  analyses: AnalysisSummary[]
): string {
  return versionAdminAssets(renderDashboardUnversioned(csrf, status, users, analyses));
}

export class AdminServer {
  private readonly sessions: AdminSessions;
  private readonly limiter = new LoginRateLimiter();
  private readonly server: http.Server;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly notifier: NotificationService
  ) {
    this.sessions = new AdminSessions(config.adminSessionHours * 60 * 60 * 1000);
    this.server = http.createServer((request, response) => {
      securityHeaders(response);
      void this.handle(request, response).catch((error) => {
        logger.error("admin_request_failed", { method: request.method, path: request.url?.split("?")[0], error });
        if (!response.headersSent) {
          const message = error instanceof Error ? error.message : "后台处理请求时发生异常";
          sendJson(response, request.url?.startsWith("/api/") ? 400 : 500, { error: message });
        }
        else response.end();
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 64;
  }

  async start(): Promise<void> {
    if (!this.config.adminDomain) throw new Error("启用后台时必须配置 ADMIN_DOMAIN");
    if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(this.config.adminDomain)) {
      throw new Error("ADMIN_DOMAIN 必须是域名或本地主机名，不能包含协议和路径");
    }
    if (!/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{64,}$/.test(this.config.adminPasswordHash)) {
      throw new Error("ADMIN_PASSWORD_HASH 必须是有效的 scrypt 哈希");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.config.adminInternalPort, "0.0.0.0", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    logger.info("admin_started", { port: this.config.adminInternalPort, domain: this.config.adminDomain });
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get port(): number {
    const address = this.server.address();
    return address && typeof address === "object" ? address.port : this.config.adminInternalPort;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://admin.internal");
    if (method === "GET" && url.pathname === "/assets/admin.css") {
      response.setHeader("Content-Type", "text/css; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(ADMIN_CSS);
      return;
    }
    if (method === "GET" && url.pathname === "/assets/admin.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(ADMIN_JS);
      return;
    }

    const token = cookieValue(request, SESSION_COOKIE);
    const session = this.sessions.get(token);
    if (url.pathname === "/login") {
      if (method === "GET") {
        if (session) redirect(response, "/");
        else {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(renderLogin());
        }
        return;
      }
      if (method === "POST") {
        await this.login(request, response);
        return;
      }
    }

    if (!session) {
      if (url.pathname.startsWith("/api/")) sendJson(response, 401, { error: "会话已过期，请重新登录" });
      else redirect(response, "/login");
      return;
    }

    if (method === "POST" && url.pathname === "/logout") {
      const form = new URLSearchParams((await readBody(request)).toString("utf8"));
      if (form.get("_csrf") !== session.csrf) {
        sendJson(response, 403, { error: "CSRF 校验失败" });
        return;
      }
      this.sessions.delete(token);
      response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      redirect(response, "/login");
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/api/") && request.headers["x-csrf-token"] !== session.csrf) {
      sendJson(response, 403, { error: "CSRF 校验失败" });
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      const status = this.dashboardStatus();
      const users = this.dashboardUsers();
      const cutoff = new Date(Date.now() - this.config.adminTraceRetentionDays * 86_400_000).toISOString();
      const analyses = this.store.getAnalysisSummaries("all", 0, 20, cutoff).items;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderDashboard(session.csrf, status, users, analyses));
      return;
    }
    if (method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, { status: this.dashboardStatus(), users: this.dashboardUsers() });
      return;
    }
    if (method === "GET" && url.pathname === "/api/analyses") {
      const rawFilter = url.searchParams.get("filter") ?? "all";
      const filters: AnalysisFilter[] = ["all", "copy", "hit", "miss", "suspected", "failed", "test", "probe"];
      const filter = filters.includes(rawFilter as AnalysisFilter) ? rawFilter as AnalysisFilter : "all";
      const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
      const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
      const retentionDays = filter === "probe" ? this.config.probeRetentionDays : this.config.adminTraceRetentionDays;
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      sendJson(response, 200, this.store.getAnalysisSummaries(filter, cursor, limit, cutoff));
      return;
    }
    const detailMatch = method === "GET" ? url.pathname.match(/^\/api\/analyses\/([^/]+)$/) : null;
    if (detailMatch) {
      const key = decodeURIComponent(detailMatch[1]!);
      const copyMatch = key.match(/^copy:(\d+)$/);
      const probeMatch = key.match(/^probe:(\d+)$/);
      const detail = probeMatch
        ? this.store.getProbeActivityDetail(Number(probeMatch[1]))
        : copyMatch
        ? this.store.getCopyActivityDetail(Number(copyMatch[1]))
        : this.store.getAnalysisDetail(key);
      if (!detail) sendJson(response, 404, { error: "分析记录不存在" });
      else sendJson(response, 200, detail);
      return;
    }
    if (method === "POST" && url.pathname === "/api/users") {
      const body = await readJson(request);
      this.store.addNotificationTarget({
        name: normalizeName(body.name),
        sendKey: normalizeSendKey(body.sendKey),
        role: "recipient"
      });
      sendJson(response, 201, { ok: true });
      return;
    }
    const userMatch = method === "POST" ? url.pathname.match(/^\/api\/users\/([^/]+)\/(update|delete|preview|verify)$/) : null;
    if (userMatch) {
      const name = decodeURIComponent(userMatch[1]!);
      const action = userMatch[2]!;
      if (action === "preview") {
        sendJson(response, 200, await this.notifier.previewTarget(name));
        return;
      }
      const body = await readJson(request);
      if (action === "update") {
        if (typeof body.sendKey === "string" && body.sendKey.trim()) {
          this.store.updateNotificationTargetSendKey(name, normalizeSendKey(body.sendKey));
        }
        if (typeof body.enabled === "boolean") this.store.setNotificationTargetEnabled(name, body.enabled);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (action === "delete") {
        if (body.confirm !== true) throw new Error("删除用户需要二次确认");
        this.store.deleteNotificationTarget(name);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (body.confirm !== true) throw new Error("发送通道验证需要明确确认");
      sendJson(response, 200, await this.notifier.verifyTarget(name));
      return;
    }
    sendJson(response, 404, { error: "页面不存在" });
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = new URLSearchParams((await readBody(request)).toString("utf8"));
    const username = body.get("username")?.trim() ?? "";
    const password = body.get("password") ?? "";
    const ipKey = `ip:${clientIp(request)}`;
    const userKey = `user:${username.toLowerCase()}`;
    if (!this.limiter.canAttempt(ipKey) || !this.limiter.canAttempt(userKey)) {
      response.statusCode = 429;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderLogin("尝试次数过多，请 15 分钟后再试。"));
      return;
    }
    const passwordValid = verifyPassword(password, this.config.adminPasswordHash);
    const valid = username === this.config.adminUsername && passwordValid;
    if (!valid) {
      this.limiter.fail(ipKey);
      this.limiter.fail(userKey);
      response.statusCode = 401;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderLogin("用户名或密码不正确。"));
      return;
    }
    this.limiter.success(ipKey);
    this.limiter.success(userKey);
    const session = this.sessions.create();
    const maxAge = Math.floor(this.config.adminSessionHours * 60 * 60);
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
    redirect(response, "/");
  }

  private dashboardUsers(): DashboardTarget[] {
    const day = shanghaiDay();
    const scheduledDue = this.store.countDueRemindersForDay(day);
    return this.store.listNotificationTargets(true).map((target) => ({
      name: target.name,
      role: target.role,
      enabled: target.enabled,
      maskedSendKey: maskSendKey(target.sendKey),
      calls: this.store.getDailyCalls(target.name, day),
      scheduledDue: target.enabled ? scheduledDue : 0,
      pendingDigest: this.store.countPendingQueue(target.name)
    }));
  }

  private dashboardStatus(): AdminDashboardStatus {
    const x = this.store.getHealth("x");
    const deepseek = this.store.getHealth("deepseek");
    const copywriter = this.store.getHealth("copywriter");
    const deepseekStatus = copywriter.active && !deepseek.active
      ? { ...deepseek, active: true, lastError: copywriter.lastError }
      : deepseek;
    const day = shanghaiDay();
    const bounds = shanghaiDayBoundsUtc(day);
    const stats = this.store.getTodayModelStats(bounds.start, bounds.end);
    const enabledSources = [
      ...(this.config.xBrowserEnabled ? ["x_browser" as const] : []),
      ...(this.config.xFeedlyEnabled ? ["feedly_xcancel" as const] : []),
      ...(this.config.xXcancelRssEnabled ? ["xcancel_rss" as const] : [])
    ];
    const labels = { x_browser: "匿名 X", feedly_xcancel: "Feedly", xcancel_rss: "XCancel RSS" } as const;
    const latest = this.store.getLatestProbeOverview();
    const latestRun = latest.run;
    const availableSourceCount = latestRun ? Number(latestRun.successfulSourceCount ?? 0) : 0;
    const nextPollAt = this.store.getMeta("next_poll_at");
    const pollOverdue = Boolean(nextPollAt && Date.now() > Date.parse(nextPollAt) + 60_000);
    const sources = enabledSources.map((source) => {
      const health = this.store.getSourceHealth(source);
      const result = latest.sources.find((item) => item.source === source);
      return {
        ...health,
        enabled: true,
        label: labels[source],
        lastStatus: result?.status ?? health.lastStatus,
        lastError: result?.error ?? health.lastError,
        lastCheckedAt: latestRun ? String(latestRun.completedAt ?? latestRun.startedAt ?? "") || null : health.lastCheckedAt,
        latestDurationMs: result?.durationMs ?? null,
        latestItemCount: result?.itemCount ?? null,
        latestItemAt: result?.latestItemAt ?? null
      };
    });
    return {
      watcher: x.active || deepseek.active || copywriter.active || pollOverdue ? "degraded" : "healthy",
      x,
      deepseek: deepseekStatus,
      copywriter,
      lastPollAt: this.store.getMeta("last_poll_at"),
      nextPollAt,
      pollOverdue,
      enabledSourceCount: enabledSources.length,
      availableSourceCount,
      sources,
      nextReminder: this.store.getUpcomingReminder(),
      today: stats
    };
  }
}
