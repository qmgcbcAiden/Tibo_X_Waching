export type Verdict = "YES" | "NO" | "UNCERTAIN";

export type EventType =
  | "RESET_NOW"
  | "RESET_SCHEDULED"
  | "BANKED_RESET"
  | "OTHER";

export type TimeKind = "exact" | "approximate" | "vague" | "none";

export type TimeResolutionStatus = "exact" | "approximate" | "vague" | "conflict" | "invalid" | "none";
export type TimezoneSource = "explicit" | "default_pt" | null;

export interface TimeResolution {
  postedAtUtc: string;
  postedAtSourceTimezone: "UTC";
  postedAtDisplay: string;
  sourceTimeText: string | null;
  sourceTimezone: "PST" | "PDT" | "PT" | null;
  timezoneSource: TimezoneSource;
  timezoneAssumption: string | null;
  modelScheduledAt: string | null;
  candidateScheduledAt: string | null;
  displayTime: string | null;
  status: TimeResolutionStatus;
  reasonCode: string;
  reason: string;
  canSchedule: boolean;
}

export interface TweetRecord {
  id: string;
  url: string;
  authorHandle: string;
  postedAt: string;
  rawText: string;
  cleanText: string;
  isReply: boolean;
  isRepost: boolean;
  isQuote: boolean;
}

export interface Classification {
  verdict: Verdict;
  eventType: EventType;
  confidence: number;
  products: string[];
  summaryZh: string;
  evidence: string;
  timeKind: TimeKind;
  sourceTimeText: string | null;
  sourceTimezone: string | null;
  scheduledAt: string | null;
  model: string;
  /** Missing on classifications saved before time-evidence validation existed. */
  timeResolution?: TimeResolution;
}

export interface QuotaEvent {
  id: string;
  eventType: EventType;
  products: string[];
  verdict: Exclude<Verdict, "NO">;
  scheduledAt: string | null;
  firstTweetId: string;
  latestTweetId: string;
  lastNotificationAt: string | null;
  confirmedAt: string | null;
}

export type ReminderState = "pending" | "sent" | "cancelled" | "expired";

export interface ScheduledReminder {
  id: string;
  eventId: string;
  dueAt: string;
  state: ReminderState;
  title: string;
  body: string;
}

export interface NotificationTarget {
  name: string;
  sendKey: string;
  role: "maintainer" | "recipient";
}

export interface ManagedNotificationTarget extends NotificationTarget {
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Mood = "shy" | "proud" | "disdain" | "happy" | "sleepy" | "worried";

export type ModelCallStage = "classify_flash" | "classify_pro" | "copy_generate" | "copy_repair";

export interface NotificationFacts {
  eventType: EventType | "HEALTH_FAILURE" | "HEALTH_RECOVERY" | "DIGEST" | "CROSS_DAY" | "CHANNEL_TEST";
  products: string[];
  summaryZh: string;
  sourceUrl?: string;
  shanghaiTime?: string;
  postedAtDisplay?: string;
  sourceTimeText?: string;
  displayTime?: string;
  timezoneSource?: Exclude<TimezoneSource, null>;
  timezoneAssumption?: string;
  timeStatus?: TimeResolutionStatus;
  timeIssue?: string;
  callToAction?: "use_remaining_before_reset" | "check_banked_reset";
  scheduledAt?: string;
  certainty: "confirmed" | "scheduled" | "suspected" | "failure" | "recovered" | "summary" | "test";
  latenessMinutes?: number;
  healthComponent?: string;
  healthError?: string;
  recoveries?: string[];
  digestItems?: Array<{ title: string; summary: string; sourceUrl?: string }>;
}

export type NotificationCategory =
  | "confirmed"
  | "due"
  | "scheduled"
  | "banked"
  | "suspected"
  | "health_failure"
  | "health_recovery"
  | "digest"
  | "cross_day"
  | "channel_test";

export interface NotificationMessage {
  id: string;
  category: NotificationCategory;
  priority: 1 | 2 | 3 | 4 | 5;
  title: string;
  body: string;
  eventId?: string;
  tweetId?: string;
  scheduledFor?: string;
  expiresAt?: string;
  facts?: NotificationFacts;
}

export interface NotificationIntent {
  id: string;
  category: NotificationCategory;
  priority: NotificationMessage["priority"];
  eventId: string | null;
  tweetId: string | null;
  scheduledFor: string | null;
  facts: NotificationFacts;
  fallbackTitle: string;
  fallbackBody: string;
  createdAt: string;
}

export interface CopyGeneration {
  id: number;
  messageId: string;
  targetName: string;
  mood: Mood;
  addressTerm: string;
  title: string;
  body: string;
  model: string;
  status: "selected" | "generated" | "repaired" | "fallback";
  isFallback: boolean;
  isPreview: boolean;
  modelCallId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelCallTrace {
  id: number;
  stage: ModelCallStage;
  model: string;
  tweetId: string | null;
  messageId: string | null;
  targetName: string | null;
  status: "success" | "failed";
  durationMs: number;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  escalationReason: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
}

export interface AdminDashboardStatus {
  watcher: "healthy" | "degraded";
  x: HealthState;
  deepseek: HealthState;
  copywriter: HealthState;
  lastPollAt: string | null;
  nextPollAt: string | null;
  pollOverdue: boolean;
  enabledSourceCount: number;
  availableSourceCount: number;
  sources: ProbeSourceStatus[];
  nextReminder: {
    eventId: string;
    tweetId: string;
    dueAt: string;
    products: string[];
  } | null;
  today: {
    requests: number;
    callSuccesses: number;
    tasks: number;
    completedTasks: number;
    fallbacks: number;
    flashToProRatio: number;
    totalTokens: number;
  };
}

export type AnalysisFilter = "all" | "hit" | "miss" | "suspected" | "failed" | "copy" | "test" | "probe";

export interface AnalysisSummary {
  activityKind: "tweet" | "copy" | "probe";
  tweetId: string;
  url: string;
  postedAt: string;
  cleanText: string;
  verdict: Verdict | null;
  eventType: EventType | null;
  confidence: number | null;
  model: string | null;
  failed: boolean;
  flashEscalated: boolean;
  copyStatus?: CopyGeneration["status"];
  isPreview?: boolean;
  isTest?: boolean;
  targetName?: string;
  probeStatus?: ProbeRunStatus;
  enabledSourceCount?: number;
  availableSourceCount?: number;
  totalItemCount?: number;
  uniqueItemCount?: number;
  newItemCount?: number;
  interruptionMinutes?: number | null;
}

export type ProbeSourceName = "x_browser" | "feedly_xcancel" | "xcancel_rss";
export type ProbeSourceResultStatus = "success" | "failed";
export type ProbeRunStatus = "running" | "completed" | "partial" | "all_failed" | "processing_failed" | "interrupted";

export interface ProbeSourceResult {
  source: ProbeSourceName;
  status: ProbeSourceResultStatus;
  durationMs: number;
  itemCount: number;
  latestItemAt: string | null;
  error: string | null;
}

export interface ProbeFetchReport {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  enabledSources: ProbeSourceName[];
  successfulSources: ProbeSourceName[];
  sourceResults: ProbeSourceResult[];
  totalItemCount: number;
  uniqueItemCount: number;
  crossSourceDuplicates: number;
}

export interface ProbeFetchResult {
  tweets: TweetRecord[];
  report: ProbeFetchReport;
}

export interface ProbeDispositionStats {
  existingCount: number;
  newCount: number;
  classifiableCount: number;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  staleCount: number;
  otherExcludedCount: number;
  classificationSuccessCount: number;
  classificationFailureCount: number;
}

export interface SourceHealthState {
  source: ProbeSourceName;
  consecutiveFailures: number;
  active: boolean;
  lastStatus: ProbeSourceResultStatus | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  updatedAt: string;
}

export interface ProbeSourceStatus extends SourceHealthState {
  enabled: boolean;
  label: string;
  latestDurationMs: number | null;
  latestItemCount: number | null;
  latestItemAt: string | null;
}

export interface DashboardTarget {
  name: string;
  role: NotificationTarget["role"];
  enabled: boolean;
  maskedSendKey: string;
  calls: number;
  scheduledDue: number;
  pendingDigest: number;
}

export interface DeliveryResult {
  targetName: string;
  status: "sent" | "failed" | "unknown" | "deferred";
  attemptId?: number;
  error?: string;
}

export interface HealthState {
  component: "x" | "deepseek" | "copywriter";
  consecutiveFailures: number;
  active: boolean;
  lastAlertDay: string | null;
  lastError: string | null;
  recoveryPending: boolean;
}
