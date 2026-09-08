import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Classification,
  AnalysisFilter,
  AnalysisSummary,
  CopyGeneration,
  HealthState,
  ManagedNotificationTarget,
  ModelCallStage,
  ModelCallTrace,
  Mood,
  NotificationCategory,
  NotificationFacts,
  NotificationIntent,
  NotificationMessage,
  NotificationTarget,
  ProbeDispositionStats,
  ProbeFetchReport,
  ProbeRunStatus,
  ProbeSourceName,
  ProbeSourceResult,
  SourceHealthState,
  QuotaEvent,
  ScheduledReminder,
  TweetRecord
} from "./types.js";
import { shanghaiDayBoundsUtc } from "./time.js";

type Row = Record<string, unknown>;

export interface QueueRow {
  id: number;
  messageId: string;
  targetName: string;
  category: NotificationCategory;
  priority: number;
  title: string;
  body: string;
  eventId: string | null;
  notBefore: string;
  expiresAt: string | null;
  state: "pending" | "consumed" | "expired";
  createdAt: string;
  deferReason: string | null;
}

export interface ModelCallInput {
  stage: ModelCallStage;
  model: string;
  tweetId?: string | null;
  messageId?: string | null;
  targetName?: string | null;
  status: ModelCallTrace["status"];
  durationMs: number;
  httpStatus?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  escalationReason?: string | null;
  result?: unknown;
  error?: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tweets (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        author_handle TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        clean_text TEXT NOT NULL,
        is_reply INTEGER NOT NULL,
        is_repost INTEGER NOT NULL,
        is_quote INTEGER NOT NULL,
        eligible INTEGER NOT NULL,
        classification_json TEXT,
        processed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tweets_posted_idx ON tweets(posted_at);

      CREATE TABLE IF NOT EXISTS quota_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        products_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        scheduled_at TEXT,
        first_tweet_id TEXT NOT NULL,
        latest_tweet_id TEXT NOT NULL,
        last_notification_at TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quota_events_schedule_idx ON quota_events(scheduled_at);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        due_at TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES quota_events(id)
      );
      CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(state, due_at);

      CREATE TABLE IF NOT EXISTS daily_budgets (
        target_name TEXT NOT NULL,
        shanghai_day TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(target_name, shanghai_day)
      );

      CREATE TABLE IF NOT EXISTS notification_targets (
        name TEXT PRIMARY KEY,
        send_key TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('maintainer', 'recipient')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_targets_enabled
        ON notification_targets(enabled, role);

      CREATE TABLE IF NOT EXISTS notification_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        shanghai_day TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS attempts_target_day_idx ON notification_attempts(target_name, shanghai_day);

      CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        event_id TEXT,
        not_before TEXT NOT NULL,
        expires_at TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        UNIQUE(message_id, target_name)
      );
      CREATE INDEX IF NOT EXISTS queue_pending_idx ON notification_queue(target_name, state, not_before);

      CREATE TABLE IF NOT EXISTS health_state (
        component TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        last_alert_day TEXT,
        last_error TEXT,
        recovery_pending INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_intents (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL,
        event_id TEXT,
        tweet_id TEXT,
        scheduled_for TEXT,
        facts_json TEXT NOT NULL,
        fallback_title TEXT NOT NULL,
        fallback_body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_intents_event
        ON notification_intents(event_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_notification_intents_tweet
        ON notification_intents(tweet_id, created_at);

      CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL,
        model TEXT NOT NULL,
        tweet_id TEXT,
        message_id TEXT,
        target_name TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        http_status INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        escalation_reason TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_calls_created
        ON model_calls(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_model_calls_tweet_stage
        ON model_calls(tweet_id, stage, created_at);
      CREATE INDEX IF NOT EXISTS idx_model_calls_message_target
        ON model_calls(message_id, target_name, created_at);

      CREATE TABLE IF NOT EXISTS copy_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        mood TEXT NOT NULL,
        address_term TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'selected',
        is_fallback INTEGER NOT NULL DEFAULT 0,
        is_preview INTEGER NOT NULL DEFAULT 0,
        model_call_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_id, target_name)
      );
      CREATE INDEX IF NOT EXISTS idx_copy_generations_target_created
        ON copy_generations(target_name, is_preview, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_copy_generations_message
        ON copy_generations(message_id, target_name);

      CREATE TABLE IF NOT EXISTS probe_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        duration_ms INTEGER,
        expected_interval_seconds INTEGER NOT NULL,
        enabled_sources_json TEXT NOT NULL,
        enabled_source_count INTEGER NOT NULL,
        successful_source_count INTEGER NOT NULL DEFAULT 0,
        total_item_count INTEGER NOT NULL DEFAULT 0,
        unique_item_count INTEGER NOT NULL DEFAULT 0,
        cross_source_duplicate_count INTEGER NOT NULL DEFAULT 0,
        existing_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        classifiable_count INTEGER NOT NULL DEFAULT 0,
        reply_count INTEGER NOT NULL DEFAULT 0,
        repost_count INTEGER NOT NULL DEFAULT 0,
        quote_count INTEGER NOT NULL DEFAULT 0,
        stale_count INTEGER NOT NULL DEFAULT 0,
        other_excluded_count INTEGER NOT NULL DEFAULT 0,
        classification_success_count INTEGER NOT NULL DEFAULT 0,
        classification_failure_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_probe_runs_started
        ON probe_runs(started_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS probe_source_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        latest_item_at TEXT,
        error TEXT,
        UNIQUE(run_id, source),
        FOREIGN KEY(run_id) REFERENCES probe_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_probe_source_run
        ON probe_source_results(run_id, source);

      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        last_checked_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("notification_attempts", "copy_generation_id", "INTEGER");
    this.ensureColumn("notification_queue", "defer_reason", "TEXT");
    this.backfillLegacyNotificationIntents();
    this.db.exec("PRAGMA optimize;");
  }

  private backfillLegacyNotificationIntents(): void {
    const rows = this.db.prepare(`
      SELECT q.* FROM notification_queue q
      LEFT JOIN notification_intents i ON i.id = q.message_id
      WHERE i.id IS NULL
    `).all() as Row[];
    for (const row of rows) {
      const message: NotificationMessage = {
        id: String(row.message_id),
        category: String(row.category) as NotificationCategory,
        priority: Number(row.priority) as NotificationMessage["priority"],
        title: String(row.title),
        body: String(row.body)
      };
      if (row.event_id) message.eventId = String(row.event_id);
      if (row.expires_at) message.expiresAt = String(row.expires_at);
      this.saveNotificationIntent(message);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((item) => String(item.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  bootstrapNotificationTargets(targets: NotificationTarget[]): void {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM notification_targets").get() as Row;
    if (Number(row.total) > 0) return;
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO notification_targets(name, send_key, role, enabled, created_at, updated_at)
      VALUES(?, ?, ?, 1, ?, ?)
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const target of targets) insert.run(target.name, target.sendKey, target.role, now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listNotificationTargets(includeDisabled = false): ManagedNotificationTarget[] {
    const rows = this.db.prepare(`
      SELECT * FROM notification_targets
      ${includeDisabled ? "" : "WHERE enabled = 1"}
      ORDER BY CASE role WHEN 'maintainer' THEN 0 ELSE 1 END, created_at ASC
    `).all() as Row[];
    return rows.map((row) => ({
      name: String(row.name),
      sendKey: String(row.send_key),
      role: String(row.role) as NotificationTarget["role"],
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  addNotificationTarget(target: NotificationTarget): void {
    if (this.listNotificationTargets(true).length >= 20) throw new Error("最多可配置 20 个通知用户");
    if (target.role === "maintainer") throw new Error("系统只允许一个管理员");
    if (this.getNotificationTarget(target.name)) throw new Error("通知用户名已存在");
    const duplicateKey = this.db.prepare("SELECT 1 AS found FROM notification_targets WHERE send_key = ?")
      .get(target.sendKey);
    if (duplicateKey) throw new Error("SendKey 已被其他用户使用");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notification_targets(name, send_key, role, enabled, created_at, updated_at)
      VALUES(?, ?, 'recipient', 1, ?, ?)
    `).run(target.name, target.sendKey, now, now);
  }

  updateNotificationTargetSendKey(name: string, sendKey: string): void {
    const duplicateKey = this.db.prepare(`
      SELECT 1 AS found FROM notification_targets WHERE send_key = ? AND name <> ?
    `).get(sendKey, name);
    if (duplicateKey) throw new Error("SendKey 已被其他用户使用");
    const result = this.db.prepare(`
      UPDATE notification_targets SET send_key = ?, updated_at = ? WHERE name = ?
    `).run(sendKey, new Date().toISOString(), name);
    if (result.changes === 0) throw new Error("通知用户不存在");
  }

  setNotificationTargetEnabled(name: string, enabled: boolean): void {
    const target = this.getNotificationTarget(name);
    if (!target) throw new Error("通知用户不存在");
    if (target.role === "maintainer" && !enabled) throw new Error("不能停用管理员");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE notification_targets SET enabled = ?, updated_at = ? WHERE name = ?")
        .run(Number(enabled), new Date().toISOString(), name);
      if (!enabled) {
        this.db.prepare(`
          UPDATE notification_queue SET state = 'expired'
          WHERE target_name = ? AND state = 'pending'
        `).run(name);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteNotificationTarget(name: string): void {
    const target = this.getNotificationTarget(name);
    if (!target) throw new Error("通知用户不存在");
    if (target.role === "maintainer") throw new Error("不能删除管理员");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE notification_queue SET state = 'expired'
        WHERE target_name = ? AND state = 'pending'
      `).run(name);
      this.db.prepare("DELETE FROM notification_targets WHERE name = ?").run(name);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getNotificationTarget(name: string): ManagedNotificationTarget | null {
    const row = this.db.prepare("SELECT * FROM notification_targets WHERE name = ?").get(name) as Row | undefined;
    return row ? {
      name: String(row.name),
      sendKey: String(row.send_key),
      role: String(row.role) as NotificationTarget["role"],
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    } : null;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  createProbeRun(startedAt: string, enabledSources: ProbeSourceName[], expectedIntervalSeconds: number): number {
    const result = this.db.prepare(`
      INSERT INTO probe_runs(
        started_at, status, expected_interval_seconds, enabled_sources_json, enabled_source_count
      ) VALUES(?, 'running', ?, ?, ?)
    `).run(startedAt, expectedIntervalSeconds, JSON.stringify(enabledSources), enabledSources.length);
    return Number(result.lastInsertRowid);
  }

  saveProbeFetchReport(runId: number, report: ProbeFetchReport): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE probe_runs SET
          completed_at = ?, duration_ms = ?, successful_source_count = ?,
          total_item_count = ?, unique_item_count = ?, cross_source_duplicate_count = ?
        WHERE id = ?
      `).run(
        report.completedAt, report.durationMs, report.successfulSources.length,
        report.totalItemCount, report.uniqueItemCount, report.crossSourceDuplicates, runId
      );
      const insert = this.db.prepare(`
        INSERT INTO probe_source_results(
          run_id, source, status, duration_ms, item_count, latest_item_at, error
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, source) DO UPDATE SET
          status = excluded.status, duration_ms = excluded.duration_ms,
          item_count = excluded.item_count, latest_item_at = excluded.latest_item_at,
          error = excluded.error
      `);
      for (const source of report.sourceResults) {
        insert.run(
          runId, source.source, source.status, source.durationMs,
          source.itemCount, source.latestItemAt, source.error
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishProbeRun(
    runId: number,
    status: Exclude<ProbeRunStatus, "running">,
    stats: ProbeDispositionStats,
    completedAt: string,
    error: string | null = null
  ): void {
    const row = this.db.prepare("SELECT started_at FROM probe_runs WHERE id = ?").get(runId) as Row | undefined;
    const durationMs = row ? Math.max(0, Date.parse(completedAt) - Date.parse(String(row.started_at))) : 0;
    this.db.prepare(`
      UPDATE probe_runs SET
        completed_at = ?, status = ?, duration_ms = ?, existing_count = ?, new_count = ?,
        classifiable_count = ?, reply_count = ?, repost_count = ?, quote_count = ?,
        stale_count = ?, other_excluded_count = ?, classification_success_count = ?,
        classification_failure_count = ?, error = ?
      WHERE id = ?
    `).run(
      completedAt, status, durationMs, stats.existingCount, stats.newCount,
      stats.classifiableCount, stats.replyCount, stats.repostCount, stats.quoteCount,
      stats.staleCount, stats.otherExcludedCount, stats.classificationSuccessCount,
      stats.classificationFailureCount, error, runId
    );
  }

  markRunningProbeRunsInterrupted(now = new Date().toISOString()): number {
    const result = this.db.prepare(`
      UPDATE probe_runs SET status = 'interrupted', completed_at = ?,
        duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
        error = COALESCE(error, 'Watcher process stopped before this probe completed')
      WHERE status = 'running'
    `).run(now, now);
    return Number(result.changes);
  }

  getSourceHealth(source: ProbeSourceName): SourceHealthState {
    const row = this.db.prepare("SELECT * FROM source_health WHERE source = ?").get(source) as Row | undefined;
    return row ? this.mapSourceHealth(row) : {
      source,
      consecutiveFailures: 0,
      active: false,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
      updatedAt: new Date(0).toISOString()
    };
  }

  saveSourceHealth(state: SourceHealthState): void {
    this.db.prepare(`
      INSERT INTO source_health(
        source, consecutive_failures, active, last_status, last_error, last_checked_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        consecutive_failures = excluded.consecutive_failures,
        active = excluded.active,
        last_status = excluded.last_status,
        last_error = excluded.last_error,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at
    `).run(
      state.source, state.consecutiveFailures, Number(state.active), state.lastStatus,
      state.lastError, state.lastCheckedAt, state.updatedAt
    );
  }

  getLatestProbeOverview(): {
    run: Record<string, unknown> | null;
    sources: ProbeSourceResult[];
  } {
    const row = this.db.prepare("SELECT * FROM probe_runs ORDER BY started_at DESC, id DESC LIMIT 1").get() as Row | undefined;
    if (!row) return { run: null, sources: [] };
    const sources = (this.db.prepare(`
      SELECT * FROM probe_source_results WHERE run_id = ? ORDER BY source ASC
    `).all(Number(row.id)) as Row[]).map((item) => this.mapProbeSourceResult(item));
    return { run: this.mapProbeRun(row), sources };
  }

  tweetExists(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM tweets WHERE id = ?").get(id));
  }

  getTweet(id: string): TweetRecord | null {
    const row = this.db.prepare("SELECT * FROM tweets WHERE id = ?").get(id) as Row | undefined;
    return row ? {
      id: String(row.id),
      url: String(row.url),
      authorHandle: String(row.author_handle),
      postedAt: String(row.posted_at),
      rawText: String(row.raw_text),
      cleanText: String(row.clean_text),
      isReply: Boolean(row.is_reply),
      isRepost: Boolean(row.is_repost),
      isQuote: Boolean(row.is_quote)
    } : null;
  }

  saveTweet(tweet: TweetRecord, eligible: boolean): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO tweets(
        id, url, author_handle, posted_at, raw_text, clean_text,
        is_reply, is_repost, is_quote, eligible, processed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tweet.id, tweet.url, tweet.authorHandle, tweet.postedAt, tweet.rawText, tweet.cleanText,
      Number(tweet.isReply), Number(tweet.isRepost), Number(tweet.isQuote), Number(eligible), new Date().toISOString()
    );
  }

  getTweetsNeedingClassification(limit = 100): TweetRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM tweets
      WHERE eligible = 1 AND classification_json IS NULL
      ORDER BY posted_at ASC
      LIMIT ?
    `).all(limit) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      url: String(row.url),
      authorHandle: String(row.author_handle),
      postedAt: String(row.posted_at),
      rawText: String(row.raw_text),
      cleanText: String(row.clean_text),
      isReply: Boolean(row.is_reply),
      isRepost: Boolean(row.is_repost),
      isQuote: Boolean(row.is_quote)
    }));
  }

  saveClassification(tweetId: string, classification: Classification): void {
    this.db.prepare("UPDATE tweets SET classification_json = ? WHERE id = ?")
      .run(JSON.stringify(classification), tweetId);
  }

  getClassification(tweetId: string): Classification | null {
    const row = this.db.prepare("SELECT classification_json FROM tweets WHERE id = ?").get(tweetId) as Row | undefined;
    return row?.classification_json ? JSON.parse(String(row.classification_json)) as Classification : null;
  }

  saveNotificationIntent(message: NotificationMessage): void {
    const facts = message.facts ?? this.legacyFacts(message);
    this.db.prepare(`
      INSERT OR IGNORE INTO notification_intents(
        id, category, priority, event_id, tweet_id, scheduled_for,
        facts_json, fallback_title, fallback_body, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id, message.category, message.priority, message.eventId ?? null,
      message.tweetId ?? null, message.scheduledFor ?? null, JSON.stringify(facts),
      message.title, message.body, new Date().toISOString()
    );
  }

  getNotificationIntent(id: string): NotificationIntent | null {
    const row = this.db.prepare("SELECT * FROM notification_intents WHERE id = ?").get(id) as Row | undefined;
    return row ? {
      id: String(row.id),
      category: String(row.category) as NotificationCategory,
      priority: Number(row.priority) as NotificationMessage["priority"],
      eventId: row.event_id ? String(row.event_id) : null,
      tweetId: row.tweet_id ? String(row.tweet_id) : null,
      scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
      facts: JSON.parse(String(row.facts_json)) as NotificationFacts,
      fallbackTitle: String(row.fallback_title),
      fallbackBody: String(row.fallback_body),
      createdAt: String(row.created_at)
    } : null;
  }

  recordModelCall(input: ModelCallInput): number {
    const result = this.db.prepare(`
      INSERT INTO model_calls(
        stage, model, tweet_id, message_id, target_name, status, duration_ms,
        http_status, input_tokens, output_tokens, total_tokens, escalation_reason,
        result_json, error, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.stage, input.model, input.tweetId ?? null, input.messageId ?? null,
      input.targetName ?? null, input.status, Math.max(0, Math.round(input.durationMs)),
      input.httpStatus ?? null, input.inputTokens ?? null, input.outputTokens ?? null,
      input.totalTokens ?? null, input.escalationReason ?? null,
      input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null,
      new Date().toISOString()
    );
    return Number(result.lastInsertRowid);
  }

  getModelCallsForTweet(tweetId: string): ModelCallTrace[] {
    const rows = this.db.prepare(`
      SELECT * FROM model_calls WHERE tweet_id = ? ORDER BY created_at ASC, id ASC
    `).all(tweetId) as Row[];
    return rows.map((row) => this.mapModelCall(row));
  }

  getModelCallsForMessage(messageId: string, targetName?: string): ModelCallTrace[] {
    const rows = targetName
      ? this.db.prepare(`
          SELECT * FROM model_calls WHERE message_id = ? AND target_name = ? ORDER BY created_at ASC, id ASC
        `).all(messageId, targetName) as Row[]
      : this.db.prepare(`
          SELECT * FROM model_calls WHERE message_id = ? ORDER BY created_at ASC, id ASC
        `).all(messageId) as Row[];
    return rows.map((row) => this.mapModelCall(row));
  }

  getLastProductionMood(targetName: string): Mood | null {
    const row = this.db.prepare(`
      SELECT mood FROM copy_generations
      WHERE target_name = ? AND is_preview = 0
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(targetName) as Row | undefined;
    return row ? String(row.mood) as Mood : null;
  }

  createCopySelection(input: {
    messageId: string;
    targetName: string;
    mood: Mood;
    model: string;
    isPreview: boolean;
  }): CopyGeneration {
    const existing = this.getCopyGeneration(input.messageId, input.targetName);
    if (existing) return existing;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO copy_generations(
        message_id, target_name, mood, model, is_preview, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(input.messageId, input.targetName, input.mood, input.model, Number(input.isPreview), now, now);
    const created = this.getCopyGeneration(input.messageId, input.targetName);
    if (!created) throw new Error("无法保存文案心情");
    return created;
  }

  finalizeCopyGeneration(input: {
    id: number;
    addressTerm: string;
    title: string;
    body: string;
    status: CopyGeneration["status"];
    isFallback: boolean;
    modelCallId?: number | null;
  }): CopyGeneration {
    this.db.prepare(`
      UPDATE copy_generations
      SET address_term = ?, title = ?, body = ?, status = ?, is_fallback = ?,
          model_call_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.addressTerm, input.title, input.body, input.status, Number(input.isFallback),
      input.modelCallId ?? null, new Date().toISOString(), input.id
    );
    const row = this.db.prepare("SELECT * FROM copy_generations WHERE id = ?").get(input.id) as Row | undefined;
    if (!row) throw new Error("文案生成记录不存在");
    return this.mapCopyGeneration(row);
  }

  getCopyGeneration(messageId: string, targetName: string): CopyGeneration | null {
    const row = this.db.prepare(`
      SELECT * FROM copy_generations WHERE message_id = ? AND target_name = ?
    `).get(messageId, targetName) as Row | undefined;
    return row ? this.mapCopyGeneration(row) : null;
  }

  getCopyGenerationsForMessage(messageId: string): CopyGeneration[] {
    const rows = this.db.prepare(`
      SELECT * FROM copy_generations WHERE message_id = ? ORDER BY target_name ASC
    `).all(messageId) as Row[];
    return rows.map((row) => this.mapCopyGeneration(row));
  }

  createEvent(event: QuotaEvent): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO quota_events(
        id, event_type, products_json, verdict, scheduled_at,
        first_tweet_id, latest_tweet_id, last_notification_at, confirmed_at,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.eventType, JSON.stringify(event.products), event.verdict,
      event.scheduledAt, event.firstTweetId, event.latestTweetId,
      event.lastNotificationAt, event.confirmedAt, now, now
    );
    return result.changes > 0;
  }

  updateEvent(eventId: string, fields: {
    latestTweetId?: string;
    confirmedAt?: string | null;
    lastNotificationAt?: string | null;
    scheduledAt?: string | null;
  }): void {
    const row = this.getEvent(eventId);
    if (!row) return;
    this.db.prepare(`
      UPDATE quota_events
      SET latest_tweet_id = ?, confirmed_at = ?, last_notification_at = ?, scheduled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      fields.latestTweetId ?? row.latestTweetId,
      fields.confirmedAt === undefined ? row.confirmedAt : fields.confirmedAt,
      fields.lastNotificationAt === undefined ? row.lastNotificationAt : fields.lastNotificationAt,
      fields.scheduledAt === undefined ? row.scheduledAt : fields.scheduledAt,
      new Date().toISOString(),
      eventId
    );
  }

  getEvent(id: string): QuotaEvent | null {
    const row = this.db.prepare("SELECT * FROM quota_events WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapEvent(row) : null;
  }

  findPendingScheduledEventNear(products: string[], instant: string, windowMs: number): QuotaEvent | null {
    const center = new Date(instant).getTime();
    const rows = this.db.prepare(`
      SELECT * FROM quota_events
      WHERE scheduled_at IS NOT NULL AND confirmed_at IS NULL
        AND scheduled_at BETWEEN ? AND ?
      ORDER BY ABS(strftime('%s', scheduled_at) - strftime('%s', ?)) ASC
    `).all(
      new Date(center - windowMs).toISOString(),
      new Date(center + windowMs).toISOString(),
      instant
    ) as Row[];
    const wanted = new Set(products.map((item) => item.toLowerCase()));
    const row = rows.find((candidate) => {
      const current = JSON.parse(String(candidate.products_json)) as string[];
      return current.some((item) => wanted.has(item.toLowerCase()));
    });
    return row ? this.mapEvent(row) : null;
  }

  private mapEvent(row: Row): QuotaEvent {
    return {
      id: String(row.id),
      eventType: String(row.event_type) as QuotaEvent["eventType"],
      products: JSON.parse(String(row.products_json)) as string[],
      verdict: String(row.verdict) as QuotaEvent["verdict"],
      scheduledAt: row.scheduled_at ? String(row.scheduled_at) : null,
      firstTweetId: String(row.first_tweet_id),
      latestTweetId: String(row.latest_tweet_id),
      lastNotificationAt: row.last_notification_at ? String(row.last_notification_at) : null,
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null
    };
  }

  upsertReminder(reminder: ScheduledReminder): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO reminders(id, event_id, due_at, state, title, body, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        due_at = excluded.due_at, state = excluded.state,
        title = excluded.title, body = excluded.body, updated_at = excluded.updated_at
    `).run(reminder.id, reminder.eventId, reminder.dueAt, reminder.state, reminder.title, reminder.body, now, now);
  }

  cancelReminder(eventId: string): void {
    this.db.prepare("UPDATE reminders SET state = 'cancelled', updated_at = ? WHERE event_id = ? AND state = 'pending'")
      .run(new Date().toISOString(), eventId);
  }

  getReminderForEvent(eventId: string): ScheduledReminder | null {
    const row = this.db.prepare("SELECT * FROM reminders WHERE event_id = ?").get(eventId) as Row | undefined;
    return row ? {
      id: String(row.id), eventId: String(row.event_id), dueAt: String(row.due_at),
      state: String(row.state) as ScheduledReminder["state"], title: String(row.title), body: String(row.body)
    } : null;
  }

  getDueReminders(now: string): ScheduledReminder[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders WHERE state = 'pending' AND due_at <= ? ORDER BY due_at ASC
    `).all(now) as Row[];
    return rows.map((row) => ({
      id: String(row.id), eventId: String(row.event_id), dueAt: String(row.due_at),
      state: String(row.state) as ScheduledReminder["state"], title: String(row.title), body: String(row.body)
    }));
  }

  getPendingReminders(): ScheduledReminder[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders WHERE state = 'pending' ORDER BY due_at ASC
    `).all() as Row[];
    return rows.map((row) => ({
      id: String(row.id), eventId: String(row.event_id), dueAt: String(row.due_at),
      state: "pending", title: String(row.title), body: String(row.body)
    }));
  }

  markReminder(id: string, state: ScheduledReminder["state"]): void {
    this.db.prepare("UPDATE reminders SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), id);
  }

  countDueRemindersForDay(day: string): number {
    const { start, end } = shanghaiDayBoundsUtc(day);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total FROM reminders
      WHERE state = 'pending' AND due_at >= ? AND due_at < ?
    `).get(start, end) as Row;
    return Number(row.total);
  }

  getDailyCalls(targetName: string, day: string): number {
    const row = this.db.prepare(`
      SELECT calls FROM daily_budgets WHERE target_name = ? AND shanghai_day = ?
    `).get(targetName, day) as Row | undefined;
    return row ? Number(row.calls) : 0;
  }

  reserveAttempt(
    targetName: string,
    day: string,
    message: NotificationMessage,
    copyGenerationId?: number | null
  ): { attemptId: number; calls: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO daily_budgets(target_name, shanghai_day, calls) VALUES(?, ?, 0)
      `).run(targetName, day);
      const current = this.getDailyCalls(targetName, day);
      const calls = current + 1;
      this.db.prepare(`
        UPDATE daily_budgets SET calls = ? WHERE target_name = ? AND shanghai_day = ?
      `).run(calls, targetName, day);
      const result = this.db.prepare(`
        INSERT INTO notification_attempts(
          message_id, target_name, shanghai_day, category, priority, status, attempted_at,
          copy_generation_id
        ) VALUES(?, ?, ?, ?, ?, 'attempting', ?, ?)
      `).run(
        message.id, targetName, day, message.category, message.priority,
        new Date().toISOString(), copyGenerationId ?? null
      );
      this.db.exec("COMMIT");
      return { attemptId: Number(result.lastInsertRowid), calls };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateAttempt(id: number, status: string, error?: string): void {
    this.db.prepare("UPDATE notification_attempts SET status = ?, error = ? WHERE id = ?")
      .run(status, error ?? null, id);
  }

  enqueue(
    message: NotificationMessage,
    targetName: string,
    notBefore: string,
    deferReason?: string,
    createdAt = new Date().toISOString()
  ): void {
    this.saveNotificationIntent(message);
    this.db.prepare(`
      INSERT OR IGNORE INTO notification_queue(
        message_id, target_name, category, priority, title, body,
        event_id, not_before, expires_at, state, created_at, defer_reason
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      message.id, targetName, message.category, message.priority, message.title, message.body,
      message.eventId ?? null, notBefore, message.expiresAt ?? null, createdAt, deferReason ?? null
    );
  }

  getQueued(targetName: string, before: string): QueueRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM notification_queue
      WHERE target_name = ? AND state = 'pending' AND not_before <= ?
      ORDER BY priority ASC, created_at ASC
    `).all(targetName, before) as Row[];
    return rows.map((row) => ({
      id: Number(row.id), messageId: String(row.message_id), targetName: String(row.target_name),
      category: String(row.category) as NotificationCategory, priority: Number(row.priority),
      title: String(row.title), body: String(row.body), eventId: row.event_id ? String(row.event_id) : null,
      notBefore: String(row.not_before), expiresAt: row.expires_at ? String(row.expires_at) : null,
      state: String(row.state) as QueueRow["state"], createdAt: String(row.created_at),
      deferReason: row.defer_reason ? String(row.defer_reason) : null
    }));
  }

  markQueue(ids: number[], state: QueueRow["state"]): void {
    const statement = this.db.prepare("UPDATE notification_queue SET state = ? WHERE id = ?");
    for (const id of ids) statement.run(state, id);
  }

  getHealth(component: HealthState["component"]): HealthState {
    const row = this.db.prepare("SELECT * FROM health_state WHERE component = ?").get(component) as Row | undefined;
    if (!row) {
      return {
        component, consecutiveFailures: 0, active: false,
        lastAlertDay: null, lastError: null, recoveryPending: false
      };
    }
    return {
      component,
      consecutiveFailures: Number(row.consecutive_failures),
      active: Boolean(row.active),
      lastAlertDay: row.last_alert_day ? String(row.last_alert_day) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      recoveryPending: Boolean(row.recovery_pending)
    };
  }

  saveHealth(state: HealthState): void {
    this.db.prepare(`
      INSERT INTO health_state(
        component, consecutive_failures, active, last_alert_day,
        last_error, recovery_pending, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(component) DO UPDATE SET
        consecutive_failures = excluded.consecutive_failures,
        active = excluded.active,
        last_alert_day = excluded.last_alert_day,
        last_error = excluded.last_error,
        recovery_pending = excluded.recovery_pending,
        updated_at = excluded.updated_at
    `).run(
      state.component, state.consecutiveFailures, Number(state.active), state.lastAlertDay,
      state.lastError, Number(state.recoveryPending), new Date().toISOString()
    );
  }

  getUpcomingReminder(): { eventId: string; tweetId: string; dueAt: string; products: string[] } | null {
    const row = this.db.prepare(`
      SELECT r.event_id, r.due_at, q.products_json, q.first_tweet_id
      FROM reminders r
      JOIN quota_events q ON q.id = r.event_id
      WHERE r.state = 'pending'
      ORDER BY r.due_at ASC LIMIT 1
    `).get() as Row | undefined;
    return row ? {
      eventId: String(row.event_id),
      tweetId: String(row.first_tweet_id),
      dueAt: String(row.due_at),
      products: JSON.parse(String(row.products_json)) as string[]
    } : null;
  }

  countPendingQueue(targetName: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total FROM notification_queue
      WHERE target_name = ? AND state = 'pending'
    `).get(targetName) as Row;
    return Number(row.total);
  }

  cleanupRetention(cutoffIso: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM model_calls WHERE created_at < ?").run(cutoffIso);
      this.db.prepare(`
        DELETE FROM copy_generations
        WHERE created_at < ?
          AND message_id NOT IN (
            SELECT message_id FROM notification_queue WHERE state = 'pending'
          )
      `).run(cutoffIso);
      this.db.prepare("DELETE FROM notification_attempts WHERE attempted_at < ?").run(cutoffIso);
      this.db.prepare(`
        DELETE FROM notification_intents
        WHERE created_at < ?
          AND id NOT IN (SELECT message_id FROM notification_queue WHERE state = 'pending')
          AND (event_id IS NULL OR event_id NOT IN (
            SELECT event_id FROM reminders WHERE state = 'pending'
          ))
      `).run(cutoffIso);
      this.db.prepare("DELETE FROM daily_budgets WHERE shanghai_day < date(?, '-5 days')").run(cutoffIso);
      this.db.prepare(`
        DELETE FROM tweets
        WHERE posted_at < ?
          AND id NOT IN (
            SELECT first_tweet_id FROM quota_events q
            WHERE q.id IN (SELECT event_id FROM reminders WHERE state = 'pending')
          )
          AND id NOT IN (
            SELECT latest_tweet_id FROM quota_events q
            WHERE q.id IN (SELECT event_id FROM reminders WHERE state = 'pending')
          )
      `).run(cutoffIso);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA optimize;");
  }

  cleanupProbeRetention(cutoffIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM probe_runs WHERE started_at < ? AND status <> 'running'
    `).run(cutoffIso);
    this.db.exec("PRAGMA optimize;");
    return Number(result.changes);
  }

  getAnalysisSummaries(
    filter: AnalysisFilter,
    offset: number,
    limit: number,
    cutoffIso: string
  ): { items: AnalysisSummary[]; nextCursor: string | null } {
    if (filter === "probe") return this.getProbeSummaries(offset, limit, cutoffIso);
    const rows = this.db.prepare(`
      SELECT t.*,
        EXISTS(
          SELECT 1 FROM model_calls m
          WHERE m.tweet_id = t.id AND m.stage = 'classify_pro'
        ) AS flash_escalated,
        EXISTS(
          SELECT 1 FROM model_calls m
          WHERE m.tweet_id = t.id AND m.status = 'failed'
        ) AS model_failed
      FROM tweets t
      WHERE t.eligible = 1 AND (
        t.posted_at >= ? OR EXISTS (
          SELECT 1 FROM quota_events q
          JOIN reminders r ON r.event_id = q.id
          WHERE r.state = 'pending' AND q.first_tweet_id = t.id
        )
      )
      ORDER BY CASE WHEN EXISTS (
        SELECT 1 FROM quota_events q
        JOIN reminders r ON r.event_id = q.id
        WHERE r.state = 'pending' AND q.first_tweet_id = t.id
      ) THEN 0 ELSE 1 END, t.posted_at DESC, t.id DESC
      LIMIT 1000
    `).all(cutoffIso) as Row[];
    const mapped = rows.map((row): AnalysisSummary => {
      const classification = row.classification_json
        ? JSON.parse(String(row.classification_json)) as Classification
        : null;
      return {
        activityKind: "tweet",
        tweetId: String(row.id),
        url: String(row.url),
        postedAt: String(row.posted_at),
        cleanText: String(row.clean_text),
        verdict: classification?.verdict ?? null,
        eventType: classification?.eventType ?? null,
        confidence: classification?.confidence ?? null,
        model: classification?.model ?? null,
        failed: Boolean(row.model_failed) && !classification,
        flashEscalated: Boolean(row.flash_escalated)
      };
    });
    const copyRows = this.db.prepare(`
      SELECT c.*, i.category
      FROM copy_generations c
      LEFT JOIN notification_intents i ON i.id = c.message_id
      WHERE c.created_at >= ?
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT 1000
    `).all(cutoffIso) as Row[];
    const copyItems = copyRows.map((row): AnalysisSummary => ({
      activityKind: "copy",
      tweetId: `copy:${Number(row.id)}`,
      url: "",
      postedAt: String(row.updated_at),
      cleanText: `${Boolean(row.is_preview) ? "文案预览" : "通知文案"} · ${String(row.target_name)} · ${String(row.title || "生成中")}`,
      verdict: null,
      eventType: null,
      confidence: null,
      model: String(row.model),
      failed: String(row.status) === "fallback",
      flashEscalated: false,
      copyStatus: String(row.status) as CopyGeneration["status"],
      isPreview: Boolean(row.is_preview),
      isTest: Boolean(row.is_preview) || String(row.category) === "channel_test",
      targetName: String(row.target_name)
    }));
    const combined = [...mapped, ...copyItems]
      .sort((left, right) => new Date(right.postedAt).getTime() - new Date(left.postedAt).getTime());
    const filtered = combined.filter((item) => {
      if (filter === "test") return item.isTest === true;
      if (item.isTest) return false;
      if (filter === "copy") return item.activityKind === "copy";
      if (filter === "hit") return item.verdict === "YES";
      if (filter === "miss") return item.verdict === "NO";
      if (filter === "suspected") return item.verdict === "UNCERTAIN";
      if (filter === "failed") return item.failed;
      return true;
    });
    const items = filtered.slice(offset, offset + limit);
    return {
      items,
      nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null
    };
  }

  private getProbeSummaries(
    offset: number,
    limit: number,
    cutoffIso: string
  ): { items: AnalysisSummary[]; nextCursor: string | null } {
    const rows = this.db.prepare(`
      SELECT * FROM probe_runs
      WHERE started_at >= ?
      ORDER BY started_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(cutoffIso, limit + 1, offset) as Row[];
    const items = rows.slice(0, limit).map((row, index): AnalysisSummary => {
      const previous = this.db.prepare(`
        SELECT started_at, completed_at FROM probe_runs
        WHERE started_at < ? OR (started_at = ? AND id < ?)
        ORDER BY started_at DESC, id DESC LIMIT 1
      `).get(String(row.started_at), String(row.started_at), Number(row.id)) as Row | undefined;
      const delayMs = previous?.completed_at
        ? Date.parse(String(row.started_at)) - Date.parse(String(previous.completed_at))
          - Number(row.expected_interval_seconds) * 1000
        : 0;
      const interruptionMinutes = delayMs > 60_000 ? Math.max(1, Math.round(delayMs / 60_000)) : null;
      const available = Number(row.successful_source_count);
      const enabled = Number(row.enabled_source_count);
      return {
        activityKind: "probe",
        tweetId: `probe:${Number(row.id)}`,
        url: "",
        postedAt: String(row.started_at),
        cleanText: `可用 ${available}/${enabled} 源 · 合并 ${Number(row.unique_item_count)} 条 · 新增 ${Number(row.new_count)} 条`,
        verdict: null,
        eventType: null,
        confidence: null,
        model: null,
        failed: ["all_failed", "processing_failed", "interrupted"].includes(String(row.status)),
        flashEscalated: false,
        probeStatus: String(row.status) as ProbeRunStatus,
        enabledSourceCount: enabled,
        availableSourceCount: available,
        totalItemCount: Number(row.total_item_count),
        uniqueItemCount: Number(row.unique_item_count),
        newItemCount: Number(row.new_count),
        interruptionMinutes: index >= 0 ? interruptionMinutes : null
      };
    });
    return { items, nextCursor: rows.length > limit ? String(offset + limit) : null };
  }

  getProbeActivityDetail(runId: number): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM probe_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) return null;
    const previous = this.db.prepare(`
      SELECT started_at, completed_at FROM probe_runs
      WHERE started_at < ? OR (started_at = ? AND id < ?)
      ORDER BY started_at DESC, id DESC LIMIT 1
    `).get(String(row.started_at), String(row.started_at), runId) as Row | undefined;
    const delayMs = previous?.completed_at
      ? Date.parse(String(row.started_at)) - Date.parse(String(previous.completed_at))
        - Number(row.expected_interval_seconds) * 1000
      : 0;
    const sources = (this.db.prepare(`
      SELECT * FROM probe_source_results WHERE run_id = ? ORDER BY source ASC
    `).all(runId) as Row[]).map((item) => this.mapProbeSourceResult(item));
    return {
      kind: "probe",
      probe: this.mapProbeRun(row),
      sources,
      interruptionMinutes: delayMs > 60_000 ? Math.max(1, Math.round(delayMs / 60_000)) : null
    };
  }

  getCopyActivityDetail(copyId: number): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM copy_generations WHERE id = ?").get(copyId) as Row | undefined;
    if (!row) return null;
    const copy = this.mapCopyGeneration(row);
    const intent = this.getNotificationIntent(copy.messageId);
    const attempts = this.db.prepare(`
      SELECT id, message_id, target_name, shanghai_day, category, priority,
             status, attempted_at, error, copy_generation_id
      FROM notification_attempts
      WHERE message_id = ? AND target_name = ?
      ORDER BY attempted_at ASC
    `).all(copy.messageId, copy.targetName) as Row[];
    const queue = this.db.prepare(`
      SELECT message_id, target_name, state, not_before, created_at, defer_reason
      FROM notification_queue
      WHERE message_id = ? AND target_name = ?
      ORDER BY created_at ASC
    `).all(copy.messageId, copy.targetName) as Row[];
    return {
      kind: "copy",
      copy,
      intent,
      modelCalls: this.getModelCallsForMessage(copy.messageId, copy.targetName),
      attempts: attempts.map((item) => ({
        id: Number(item.id), messageId: String(item.message_id), targetName: String(item.target_name),
        day: String(item.shanghai_day), category: String(item.category), status: String(item.status),
        attemptedAt: String(item.attempted_at), error: item.error ? String(item.error) : null,
        copyGenerationId: item.copy_generation_id === null ? null : Number(item.copy_generation_id)
      })),
      queue: queue.map((item) => ({
        messageId: String(item.message_id), targetName: String(item.target_name), state: String(item.state),
        notBefore: String(item.not_before), createdAt: String(item.created_at),
        reason: item.defer_reason ? String(item.defer_reason) : "delayed"
      }))
    };
  }

  getAnalysisDetail(tweetId: string): Record<string, unknown> | null {
    const tweet = this.getTweet(tweetId);
    if (!tweet) return null;
    const row = this.db.prepare("SELECT classification_json FROM tweets WHERE id = ?").get(tweetId) as Row;
    const classification = row.classification_json
      ? JSON.parse(String(row.classification_json)) as Classification
      : null;
    const events = this.db.prepare(`
      SELECT * FROM quota_events WHERE first_tweet_id = ? OR latest_tweet_id = ? ORDER BY created_at ASC
    `).all(tweetId, tweetId) as Row[];
    const eventIds = events.map((item) => String(item.id));
    const intents = this.db.prepare(`
      SELECT * FROM notification_intents
      WHERE tweet_id = ? OR event_id IN (
        SELECT id FROM quota_events WHERE first_tweet_id = ? OR latest_tweet_id = ?
      )
      ORDER BY created_at ASC
    `).all(tweetId, tweetId, tweetId) as Row[];
    const messageIds = intents.map((item) => String(item.id));
    const copies = messageIds.length === 0 ? [] : this.db.prepare(`
      SELECT * FROM copy_generations
      WHERE message_id IN (${messageIds.map(() => "?").join(",")})
      ORDER BY created_at ASC
    `).all(...messageIds) as Row[];
    const attempts = messageIds.length === 0 ? [] : this.db.prepare(`
      SELECT id, message_id, target_name, shanghai_day, category, priority,
             status, attempted_at, error, copy_generation_id
      FROM notification_attempts
      WHERE message_id IN (${messageIds.map(() => "?").join(",")})
      ORDER BY attempted_at ASC
    `).all(...messageIds) as Row[];
    const queue = messageIds.length === 0 ? [] : this.db.prepare(`
      SELECT message_id, target_name, state, not_before, created_at, defer_reason
      FROM notification_queue
      WHERE message_id IN (${messageIds.map(() => "?").join(",")})
      ORDER BY created_at ASC
    `).all(...messageIds) as Row[];
    const reminders = eventIds.length === 0 ? [] : this.db.prepare(`
      SELECT id, event_id, due_at, state, title, body, created_at, updated_at
      FROM reminders WHERE event_id IN (${eventIds.map(() => "?").join(",")})
      ORDER BY due_at ASC
    `).all(...eventIds) as Row[];
    return {
      tweet,
      classification,
      modelCalls: this.getModelCallsForTweet(tweetId),
      events: events.map((item) => ({
        id: String(item.id),
        eventType: String(item.event_type),
        products: JSON.parse(String(item.products_json)) as string[],
        verdict: String(item.verdict),
        scheduledAt: item.scheduled_at ? String(item.scheduled_at) : null,
        confirmedAt: item.confirmed_at ? String(item.confirmed_at) : null
      })),
      intents: intents.map((item) => ({
        id: String(item.id),
        category: String(item.category),
        priority: Number(item.priority),
        eventId: item.event_id ? String(item.event_id) : null,
        facts: JSON.parse(String(item.facts_json)) as NotificationFacts,
        createdAt: String(item.created_at)
      })),
      copies: copies.map((item) => this.mapCopyGeneration(item)),
      reminders: reminders.map((item) => ({
        id: String(item.id), eventId: String(item.event_id), dueAt: String(item.due_at),
        state: String(item.state), title: String(item.title), body: String(item.body)
      })),
      attempts: attempts.map((item) => ({
        id: Number(item.id), messageId: String(item.message_id), targetName: String(item.target_name),
        day: String(item.shanghai_day), category: String(item.category), status: String(item.status),
        attemptedAt: String(item.attempted_at), error: item.error ? String(item.error) : null,
        copyGenerationId: item.copy_generation_id === null ? null : Number(item.copy_generation_id)
      })),
      queue: queue.map((item) => ({
        messageId: String(item.message_id), targetName: String(item.target_name), state: String(item.state),
        notBefore: String(item.not_before), createdAt: String(item.created_at),
        reason: item.defer_reason ? String(item.defer_reason) : "delayed"
      }))
    };
  }

  getTodayModelStats(startIso: string, endIso: string): {
    requests: number;
    callSuccesses: number;
    tasks: number;
    completedTasks: number;
    fallbacks: number;
    flashToProRatio: number;
    totalTokens: number;
  } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        SUM(CASE WHEN stage = 'classify_flash' THEN 1 ELSE 0 END) AS flash_calls,
        SUM(CASE WHEN stage = 'classify_pro' THEN 1 ELSE 0 END) AS pro_calls
      FROM model_calls WHERE created_at >= ? AND created_at < ?
    `).get(startIso, endIso) as Row;
    const classificationTasks = this.db.prepare(`
      SELECT COUNT(DISTINCT m.tweet_id) AS tasks,
        COUNT(DISTINCT CASE WHEN t.classification_json IS NOT NULL THEN m.tweet_id END) AS completed
      FROM model_calls m
      JOIN tweets t ON t.id = m.tweet_id
      WHERE m.created_at >= ? AND m.created_at < ? AND m.tweet_id IS NOT NULL
    `).get(startIso, endIso) as Row;
    const copyTasks = this.db.prepare(`
      SELECT COUNT(*) AS tasks,
        SUM(CASE WHEN status <> 'selected' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) AS fallbacks
      FROM copy_generations WHERE created_at >= ? AND created_at < ?
    `).get(startIso, endIso) as Row;
    const flashCalls = Number(row.flash_calls ?? 0);
    return {
      requests: Number(row.requests ?? 0),
      callSuccesses: Number(row.successes ?? 0),
      tasks: Number(classificationTasks.tasks ?? 0) + Number(copyTasks.tasks ?? 0),
      completedTasks: Number(classificationTasks.completed ?? 0) + Number(copyTasks.completed ?? 0),
      fallbacks: Number(copyTasks.fallbacks ?? 0),
      flashToProRatio: flashCalls === 0 ? 0 : Number(row.pro_calls ?? 0) / flashCalls,
      totalTokens: Number(row.total_tokens ?? 0)
    };
  }

  private mapCopyGeneration(row: Row): CopyGeneration {
    return {
      id: Number(row.id),
      messageId: String(row.message_id),
      targetName: String(row.target_name),
      mood: String(row.mood) as Mood,
      addressTerm: String(row.address_term),
      title: String(row.title),
      body: String(row.body),
      model: String(row.model),
      status: String(row.status) as CopyGeneration["status"],
      isFallback: Boolean(row.is_fallback),
      isPreview: Boolean(row.is_preview),
      modelCallId: row.model_call_id === null || row.model_call_id === undefined ? null : Number(row.model_call_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapModelCall(row: Row): ModelCallTrace {
    return {
      id: Number(row.id),
      stage: String(row.stage) as ModelCallStage,
      model: String(row.model),
      tweetId: row.tweet_id ? String(row.tweet_id) : null,
      messageId: row.message_id ? String(row.message_id) : null,
      targetName: row.target_name ? String(row.target_name) : null,
      status: String(row.status) as ModelCallTrace["status"],
      durationMs: Number(row.duration_ms),
      httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
      inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
      totalTokens: row.total_tokens === null || row.total_tokens === undefined ? null : Number(row.total_tokens),
      escalationReason: row.escalation_reason ? String(row.escalation_reason) : null,
      resultJson: row.result_json ? String(row.result_json) : null,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at)
    };
  }

  private mapProbeRun(row: Row): Record<string, unknown> {
    return {
      id: Number(row.id),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      status: String(row.status),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      expectedIntervalSeconds: Number(row.expected_interval_seconds),
      enabledSources: JSON.parse(String(row.enabled_sources_json)) as ProbeSourceName[],
      enabledSourceCount: Number(row.enabled_source_count),
      successfulSourceCount: Number(row.successful_source_count),
      totalItemCount: Number(row.total_item_count),
      uniqueItemCount: Number(row.unique_item_count),
      crossSourceDuplicateCount: Number(row.cross_source_duplicate_count),
      existingCount: Number(row.existing_count),
      newCount: Number(row.new_count),
      classifiableCount: Number(row.classifiable_count),
      replyCount: Number(row.reply_count),
      repostCount: Number(row.repost_count),
      quoteCount: Number(row.quote_count),
      staleCount: Number(row.stale_count),
      otherExcludedCount: Number(row.other_excluded_count),
      classificationSuccessCount: Number(row.classification_success_count),
      classificationFailureCount: Number(row.classification_failure_count),
      error: row.error ? String(row.error) : null
    };
  }

  private mapProbeSourceResult(row: Row): ProbeSourceResult {
    return {
      source: String(row.source) as ProbeSourceName,
      status: String(row.status) as ProbeSourceResult["status"],
      durationMs: Number(row.duration_ms),
      itemCount: Number(row.item_count),
      latestItemAt: row.latest_item_at ? String(row.latest_item_at) : null,
      error: row.error ? String(row.error) : null
    };
  }

  private mapSourceHealth(row: Row): SourceHealthState {
    return {
      source: String(row.source) as ProbeSourceName,
      consecutiveFailures: Number(row.consecutive_failures),
      active: Boolean(row.active),
      lastStatus: row.last_status ? String(row.last_status) as SourceHealthState["lastStatus"] : null,
      lastError: row.last_error ? String(row.last_error) : null,
      lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
      updatedAt: String(row.updated_at)
    };
  }

  private legacyFacts(message: NotificationMessage): NotificationFacts {
    const mapping: Record<NotificationCategory, NotificationFacts["eventType"]> = {
      confirmed: "RESET_NOW",
      due: "RESET_NOW",
      scheduled: "RESET_SCHEDULED",
      banked: "BANKED_RESET",
      suspected: "OTHER",
      health_failure: "HEALTH_FAILURE",
      health_recovery: "HEALTH_RECOVERY",
      digest: "DIGEST",
      cross_day: "CROSS_DAY",
      channel_test: "CHANNEL_TEST"
    };
    const certainty: Record<NotificationCategory, NotificationFacts["certainty"]> = {
      confirmed: "confirmed",
      due: "confirmed",
      scheduled: "scheduled",
      banked: "scheduled",
      suspected: "suspected",
      health_failure: "failure",
      health_recovery: "recovered",
      digest: "summary",
      cross_day: "summary",
      channel_test: "test"
    };
    const facts: NotificationFacts = {
      eventType: mapping[message.category],
      products: ["Codex", "ChatGPT Work"],
      summaryZh: message.body,
      certainty: certainty[message.category]
    };
    const sourceUrl = message.body.match(/https:\/\/\S+/)?.[0];
    if (sourceUrl) facts.sourceUrl = sourceUrl;
    if (message.scheduledFor) facts.scheduledAt = message.scheduledFor;
    return facts;
  }
}
