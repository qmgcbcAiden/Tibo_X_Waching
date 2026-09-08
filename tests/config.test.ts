import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPasswordHash } from "../src/admin-auth.js";

function environment(targets: unknown): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_FLASH_MODEL: "flash",
    DEEPSEEK_PRO_MODEL: "pro",
    SERVERCHAN_TARGETS_JSON: JSON.stringify(targets)
  };
}

describe("notification target configuration", () => {
  it("accepts one bootstrap administrator", () => {
    const config = loadConfig(environment([
      { name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }
    ]));
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0]?.role).toBe("maintainer");
    expect(config.xBrowserEnabled).toBe(true);
    expect(config.xFeedlyEnabled).toBe(true);
    expect(config.xFeedlyStreamUrl).toContain(encodeURIComponent("feed/https://rss.xcancel.com/thsottiaux/rss"));
    expect(config.xXcancelRssEnabled).toBe(false);
  });

  it("still requires exactly one administrator", () => {
    expect(() => loadConfig(environment([
      { name: "user", sendKey: "SCT_USER_TEST", role: "recipient" }
    ]))).toThrow(/maintainer/);
  });

  it("loads administration settings while runtime validation remains isolated from the watcher", () => {
    const base = environment([
      { name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }
    ]);
    expect(loadConfig({ ...base, ADMIN_ENABLED: "true" }).adminEnabled).toBe(true);
    const config = loadConfig({
      ...base,
      ADMIN_ENABLED: "true",
      ADMIN_DOMAIN: "watch.example.com",
      ADMIN_PASSWORD_HASH: createPasswordHash("this-is-a-very-long-password")
    });
    expect(config.adminEnabled).toBe(true);
    expect(config.deepseekCopyModel).toBe("pro");
    expect(config.copyDraftModel).toBe("flash");
    expect(config.copyRepairModel).toBe("pro");
    expect(config.copyDraftMaxTokens).toBe(4096);
    expect(config.copyMaxTokens).toBe(16384);
    expect(config.copyDigestMaxTokens).toBe(24576);
  });

  it("allows higher copy token ceilings without changing notification length limits", () => {
    const config = loadConfig({
      ...environment([{ name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }]),
      COPY_MAX_TOKENS: "32768",
      COPY_DIGEST_MAX_TOKENS: "49152"
    });
    expect(config.copyMaxTokens).toBe(32768);
    expect(config.copyDigestMaxTokens).toBe(49152);
  });

  it("supports separate draft and repair models while keeping the legacy repair alias", () => {
    const base = environment([{ name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }]);
    const explicit = loadConfig({
      ...base,
      DEEPSEEK_COPY_MODEL: "legacy-pro",
      COPY_DRAFT_MODEL: "fast-draft",
      COPY_REPAIR_MODEL: "careful-repair",
      COPY_DRAFT_MAX_TOKENS: "4096"
    });
    expect(explicit.copyDraftModel).toBe("fast-draft");
    expect(explicit.copyRepairModel).toBe("careful-repair");

    const legacy = loadConfig({ ...base, DEEPSEEK_COPY_MODEL: "legacy-pro" });
    expect(legacy.copyDraftModel).toBe("flash");
    expect(legacy.copyRepairModel).toBe("legacy-pro");
  });

  it("requires at least one enabled monitoring source", () => {
    expect(() => loadConfig({
      ...environment([{ name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }]),
      X_BROWSER_ENABLED: "false",
      X_FEEDLY_ENABLED: "false",
      X_XCANCEL_RSS_ENABLED: "false"
    })).toThrow(/至少需要启用一个/);
  });
});
