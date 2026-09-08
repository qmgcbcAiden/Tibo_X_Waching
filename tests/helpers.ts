import type { AppConfig } from "../src/config.js";

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    xHandle: "thsottiaux",
    xBrowserEnabled: true,
    xFeedlyEnabled: false,
    xFeedlyStreamUrl: "https://cloud.feedly.com/v3/streams/contents?streamId=test",
    xXcancelRssEnabled: false,
    xXcancelRssUrl: "https://rss.xcancel.com/thsottiaux/rss",
    xRssUserAgent: "TiboWatch-RSS/1.0",
    pollMinSeconds: 180,
    pollMaxSeconds: 300,
    deepseekBaseUrl: "https://deepseek.example/v1",
    deepseekApiKey: "test-secret",
    deepseekFlashModel: "deepseek-v4-flash",
    deepseekProModel: "deepseek-v4-pro",
    copyDraftModel: "deepseek-v4-flash",
    copyRepairModel: "deepseek-v4-pro",
    copyDraftMaxTokens: 4096,
    deepseekCopyModel: "deepseek-v4-pro",
    copyMaxTokens: 16384,
    copyDigestMaxTokens: 24576,
    targets: [
      { name: "alice", sendKey: "SCT_ALICE_TEST", role: "maintainer" },
      { name: "bob", sendKey: "SCT_BOB_TEST", role: "recipient" }
    ],
    overflowDigestTime: "23:50",
    backfillHours: 24,
    timezone: "Asia/Shanghai",
    dataDir,
    databasePath: `${dataDir}/watcher.sqlite`,
    browserProfilePath: `${dataDir}/browser-profile`,
    headless: true,
    requestTimeoutMs: 1_000,
    copyRequestTimeoutMs: 1_000,
    adminEnabled: false,
    adminDomain: "",
    adminUsername: "admin",
    adminPasswordHash: "",
    adminInternalPort: 8787,
    adminSessionHours: 12,
    adminTraceRetentionDays: 30,
    probeRetentionDays: 7,
    ...overrides
  };
}
