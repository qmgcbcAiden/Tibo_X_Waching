import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import type { NotificationTarget } from "./types.js";

const TargetSchema = z.object({
  name: z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "name 不能包含控制字符"),
  sendKey: z.string().trim().regex(/^SCT[A-Za-z0-9_-]{5,}$/, "SendKey 格式无效"),
  role: z.enum(["maintainer", "recipient"])
});

const IntString = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const OptionalUrl = z.string().trim().default("").refine((value) => {
  if (!value) return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "必须是 HTTP(S) URL");

const EnvSchema = z.object({
  X_HANDLE: z.string().min(1).default("thsottiaux"),
  X_BROWSER_ENABLED: z.enum(["true", "false"]).default("true"),
  X_FEEDLY_ENABLED: z.enum(["true", "false"]).default("true"),
  X_FEEDLY_STREAM_URL: OptionalUrl,
  X_XCANCEL_RSS_ENABLED: z.enum(["true", "false"]).default("false"),
  X_XCANCEL_RSS_URL: OptionalUrl,
  X_RSS_USER_AGENT: z.string().trim().min(5).max(160)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "User-Agent 不能包含控制字符")
    .default("TiboWatch-RSS/1.0"),
  POLL_MIN_SECONDS: IntString(180, 30, 3600),
  POLL_MAX_SECONDS: IntString(300, 30, 7200),
  DEEPSEEK_BASE_URL: z.string().url(),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_FLASH_MODEL: z.string().min(1),
  DEEPSEEK_PRO_MODEL: z.string().min(1),
  DEEPSEEK_COPY_MODEL: z.string().min(1).optional(),
  COPY_DRAFT_MODEL: z.string().min(1).optional(),
  COPY_REPAIR_MODEL: z.string().min(1).optional(),
  COPY_DRAFT_MAX_TOKENS: IntString(4096, 1024, 16384),
  COPY_MAX_TOKENS: IntString(16384, 1024, 65536),
  COPY_DIGEST_MAX_TOKENS: IntString(24576, 1024, 65536),
  SERVERCHAN_TARGETS_JSON: z.string().min(2),
  OVERFLOW_DIGEST_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("23:50"),
  BACKFILL_HOURS: IntString(24, 0, 168),
  TZ: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
  DATA_DIR: z.string().default("./data"),
  HEADLESS: z.enum(["true", "false"]).default("false"),
  REQUEST_TIMEOUT_MS: IntString(30_000, 1_000, 120_000),
  COPY_REQUEST_TIMEOUT_MS: IntString(300_000, 1_000, 600_000),
  ADMIN_ENABLED: z.enum(["true", "false"]).default("false"),
  ADMIN_DOMAIN: z.string().trim().default(""),
  ADMIN_USERNAME: z.string().trim().min(1).max(64)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "管理员用户名不能包含控制字符")
    .default("admin"),
  ADMIN_PASSWORD_HASH: z.string().default(""),
  ADMIN_INTERNAL_PORT: IntString(8787, 1024, 65535),
  ADMIN_SESSION_HOURS: IntString(12, 1, 168),
  ADMIN_TRACE_RETENTION_DAYS: IntString(30, 1, 365),
  PROBE_RETENTION_DAYS: IntString(7, 1, 90)
});

export interface AppConfig {
  xHandle: string;
  xBrowserEnabled: boolean;
  xFeedlyEnabled: boolean;
  xFeedlyStreamUrl: string;
  xXcancelRssEnabled: boolean;
  xXcancelRssUrl: string;
  xRssUserAgent: string;
  pollMinSeconds: number;
  pollMaxSeconds: number;
  deepseekBaseUrl: string;
  deepseekApiKey: string;
  deepseekFlashModel: string;
  deepseekProModel: string;
  copyDraftModel: string;
  copyRepairModel: string;
  copyDraftMaxTokens: number;
  /** Legacy alias retained for callers that still display one copy model. */
  deepseekCopyModel: string;
  copyMaxTokens: number;
  copyDigestMaxTokens: number;
  targets: NotificationTarget[];
  overflowDigestTime: string;
  backfillHours: number;
  timezone: "Asia/Shanghai";
  dataDir: string;
  databasePath: string;
  browserProfilePath: string;
  headless: boolean;
  requestTimeoutMs: number;
  copyRequestTimeoutMs: number;
  adminEnabled: boolean;
  adminDomain: string;
  adminUsername: string;
  adminPasswordHash: string;
  adminInternalPort: number;
  adminSessionHours: number;
  adminTraceRetentionDays: number;
  probeRetentionDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  let rawTargets: unknown;
  try {
    rawTargets = JSON.parse(parsed.SERVERCHAN_TARGETS_JSON);
  } catch {
    throw new Error("SERVERCHAN_TARGETS_JSON 必须是有效 JSON");
  }
  const targets = z.array(TargetSchema).min(1).max(20).parse(rawTargets);
  if (new Set(targets.map((target) => target.name)).size !== targets.length) {
    throw new Error("Server酱目标 name 必须唯一");
  }
  if (targets.filter((target) => target.role === "maintainer").length !== 1) {
    throw new Error("Server酱目标中必须且只能有一个 maintainer");
  }
  if (new Set(targets.map((target) => target.sendKey)).size !== targets.length) {
    throw new Error("接收者必须使用不同账号的 SendKey");
  }
  if (parsed.POLL_MAX_SECONDS < parsed.POLL_MIN_SECONDS) {
    throw new Error("POLL_MAX_SECONDS 不能小于 POLL_MIN_SECONDS");
  }
  if (![parsed.X_BROWSER_ENABLED, parsed.X_FEEDLY_ENABLED, parsed.X_XCANCEL_RSS_ENABLED].includes("true")) {
    throw new Error("至少需要启用一个 X 动态来源");
  }
  const dataDir = path.resolve(parsed.DATA_DIR);
  const xHandle = parsed.X_HANDLE.replace(/^@/, "").toLowerCase();
  const xcancelRssUrl = parsed.X_XCANCEL_RSS_URL || `https://rss.xcancel.com/${xHandle}/rss`;
  const feedlyStreamId = encodeURIComponent(`feed/${xcancelRssUrl}`);
  return {
    xHandle,
    xBrowserEnabled: parsed.X_BROWSER_ENABLED === "true",
    xFeedlyEnabled: parsed.X_FEEDLY_ENABLED === "true",
    xFeedlyStreamUrl: parsed.X_FEEDLY_STREAM_URL
      || `https://cloud.feedly.com/v3/streams/contents?streamId=${feedlyStreamId}&count=20`,
    xXcancelRssEnabled: parsed.X_XCANCEL_RSS_ENABLED === "true",
    xXcancelRssUrl: xcancelRssUrl,
    xRssUserAgent: parsed.X_RSS_USER_AGENT,
    pollMinSeconds: parsed.POLL_MIN_SECONDS,
    pollMaxSeconds: parsed.POLL_MAX_SECONDS,
    deepseekBaseUrl: parsed.DEEPSEEK_BASE_URL.replace(/\/$/, ""),
    deepseekApiKey: parsed.DEEPSEEK_API_KEY,
    deepseekFlashModel: parsed.DEEPSEEK_FLASH_MODEL,
    deepseekProModel: parsed.DEEPSEEK_PRO_MODEL,
    copyDraftModel: parsed.COPY_DRAFT_MODEL ?? parsed.DEEPSEEK_FLASH_MODEL,
    copyRepairModel: parsed.COPY_REPAIR_MODEL ?? parsed.DEEPSEEK_COPY_MODEL ?? parsed.DEEPSEEK_PRO_MODEL,
    copyDraftMaxTokens: parsed.COPY_DRAFT_MAX_TOKENS,
    deepseekCopyModel: parsed.DEEPSEEK_COPY_MODEL ?? parsed.COPY_REPAIR_MODEL ?? parsed.DEEPSEEK_PRO_MODEL,
    copyMaxTokens: parsed.COPY_MAX_TOKENS,
    copyDigestMaxTokens: parsed.COPY_DIGEST_MAX_TOKENS,
    targets,
    overflowDigestTime: parsed.OVERFLOW_DIGEST_TIME,
    backfillHours: parsed.BACKFILL_HOURS,
    timezone: parsed.TZ,
    dataDir,
    databasePath: path.join(dataDir, "watcher.sqlite"),
    browserProfilePath: path.join(dataDir, "browser-profile"),
    headless: parsed.HEADLESS === "true",
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    copyRequestTimeoutMs: parsed.COPY_REQUEST_TIMEOUT_MS,
    adminEnabled: parsed.ADMIN_ENABLED === "true",
    adminDomain: parsed.ADMIN_DOMAIN,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPasswordHash: parsed.ADMIN_PASSWORD_HASH,
    adminInternalPort: parsed.ADMIN_INTERNAL_PORT,
    adminSessionHours: parsed.ADMIN_SESSION_HOURS,
    adminTraceRetentionDays: parsed.ADMIN_TRACE_RETENTION_DAYS,
    probeRetentionDays: parsed.PROBE_RETENTION_DAYS
  };
}
