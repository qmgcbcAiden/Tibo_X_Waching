import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminServer } from "../src/admin.js";
import { createPasswordHash } from "../src/admin-auth.js";
import { Store } from "../src/db.js";
import { NotificationService } from "../src/notifier.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];
const servers: AdminServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ base: string; cookie: string; csrf: string; store: Store }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-admin-"));
  tempDirs.push(dir);
  const config = testConfig(dir, {
    adminEnabled: true,
    adminDomain: "localhost",
    adminUsername: "admin",
    adminPasswordHash: createPasswordHash("this-is-a-very-long-password"),
    adminInternalPort: 0,
    targets: [{ name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }]
  });
  const store = new Store(config.databasePath);
  const notifier = new NotificationService(config, store, async () => new Response(JSON.stringify({ code: 0 }), {
    status: 200, headers: { "Content-Type": "application/json" }
  }));
  const server = new AdminServer(config, store, notifier);
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: "this-is-a-very-long-password" })
  });
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  const cookie = setCookie.split(";")[0]!;
  const page = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  const html = await page.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";
  expect(csrf).not.toBe("");
  return { base, cookie, csrf, store };
}

describe("administration HTTP server", () => {
  it("requires sessions and CSRF, masks SendKeys, and escapes user HTML", async () => {
    const { base, cookie, csrf, store } = await setup();
    const unauthenticated = await fetch(`${base}/api/status`, { redirect: "manual" });
    expect(unauthenticated.status).toBe(401);

    const withoutCsrf = await fetch(`${base}/api/users`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}"
    });
    expect(withoutCsrf.status).toBe(403);

    const name = "<img src=x onerror=alert(1)>";
    const added = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ name, sendKey: "SCT_DONT_LEAK_1234" })
    });
    expect(added.status).toBe(201);

    const page = await fetch(`${base}/`, { headers: { Cookie: cookie } });
    const html = await page.text();
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("SCT_DONT_LEAK_1234");
    expect(html).toContain("SCT***1234");
    expect(html).toMatch(/\/assets\/admin\.css\?v=\d+/);
    expect(html).toMatch(/\/assets\/admin\.js\?v=\d+/);
    expect(html).toContain("data-filter=\"probe\"");

    const script = await fetch(`${base}/assets/admin.js`);
    const stylesheet = await fetch(`${base}/assets/admin.css`);
    expect(script.headers.get("cache-control")).toBe("no-store");
    expect(stylesheet.headers.get("cache-control")).toBe("no-store");
    const scriptText = await script.text();
    const stylesheetText = await stylesheet.text();
    expect(scriptText).toContain("if(detail.probe)");
    expect(scriptText).toContain("else if(detail.copy)");
    expect(scriptText).toContain("Server酱发送状态");
    expect(scriptText).toContain("时间证据");
    expect(scriptText).toContain("旧记录，无完整时间证据");
    expect(stylesheetText).toContain("height:0;flex:1 1 0;overflow:hidden");
    expect(stylesheetText).toContain("height:100%;overflow-x:hidden;overflow-y:scroll");

    const status = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
    const data = await status.json() as { users: Array<{ maskedSendKey: string }> };
    expect(data.users.some((user) => user.maskedSendKey === "SCT***1234")).toBe(true);
    store.close();
  });

  it("rate limits repeated invalid logins", async () => {
    const { base, store } = await setup();
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${base}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "admin", password: "incorrect-long-password" })
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    store.close();
  });

  it("lists previews only under the test filter and exposes delivery in their timeline", async () => {
    const { base, cookie, csrf, store } = await setup();
    const preview = await fetch(`${base}/api/users/owner/preview`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: "{}"
    });
    expect(preview.status).toBe(200);
    const verify = await fetch(`${base}/api/users/owner/verify`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ confirm: true })
    });
    expect(verify.status).toBe(200);

    const regular = await fetch(`${base}/api/analyses?filter=all&cursor=0&limit=20`, {
      headers: { Cookie: cookie }
    });
    expect((await regular.json() as { items: unknown[] }).items).toHaveLength(0);

    const copy = await fetch(`${base}/api/analyses?filter=copy&cursor=0&limit=20`, {
      headers: { Cookie: cookie }
    });
    expect((await copy.json() as { items: unknown[] }).items).toHaveLength(0);

    const list = await fetch(`${base}/api/analyses?filter=test&cursor=0&limit=20`, {
      headers: { Cookie: cookie }
    });
    const data = await list.json() as {
      items: Array<{ tweetId: string; activityKind: string; isPreview: boolean; isTest: boolean }>;
    };
    expect(data.items).toHaveLength(2);
    expect(data.items.every((item) => item.activityKind === "copy" && item.isTest)).toBe(true);
    expect(data.items.some((item) => item.isPreview)).toBe(true);
    expect(data.items.some((item) => !item.isPreview)).toBe(true);

    const previewItem = data.items.find((item) => item.isPreview)!;

    const detail = await fetch(`${base}/api/analyses/${encodeURIComponent(previewItem.tweetId)}`, {
      headers: { Cookie: cookie }
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      kind: "copy",
      copy: { targetName: "owner", isPreview: true },
      attempts: [{ targetName: "owner", status: "sent" }]
    });

    const status = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
    const statusData = await status.json() as {
      status: { today: { tasks: number; completedTasks: number; fallbacks: number } };
    };
    expect(statusData.status.today).toMatchObject({ tasks: 2, completedTasks: 2, fallbacks: 0 });
    store.close();
  });

  it("lists probes only in the probe stream and exposes source status in the dashboard", async () => {
    const { base, cookie, store } = await setup();
    const startedAt = new Date().toISOString();
    const runId = store.createProbeRun(startedAt, ["x_browser"], 300);
    store.saveProbeFetchReport(runId, {
      startedAt,
      completedAt: new Date(Date.parse(startedAt) + 150).toISOString(),
      durationMs: 150,
      enabledSources: ["x_browser"],
      successfulSources: ["x_browser"],
      sourceResults: [{
        source: "x_browser", status: "success", durationMs: 150,
        itemCount: 20, latestItemAt: startedAt, error: null
      }],
      totalItemCount: 20,
      uniqueItemCount: 20,
      crossSourceDuplicates: 0
    });
    store.finishProbeRun(runId, "completed", {
      existingCount: 20, newCount: 0, classifiableCount: 0, replyCount: 0,
      repostCount: 0, quoteCount: 0, staleCount: 0, otherExcludedCount: 0,
      classificationSuccessCount: 0, classificationFailureCount: 0
    }, new Date(Date.parse(startedAt) + 200).toISOString());
    store.setMeta("last_poll_at", startedAt);
    store.setMeta("next_poll_at", new Date(Date.now() + 180_000).toISOString());

    for (const filter of ["all", "failed", "test"] as const) {
      const response = await fetch(`${base}/api/analyses?filter=${filter}`, { headers: { Cookie: cookie } });
      expect((await response.json() as { items: unknown[] }).items).toHaveLength(0);
    }
    const response = await fetch(`${base}/api/analyses?filter=probe`, { headers: { Cookie: cookie } });
    const data = await response.json() as { items: Array<{ tweetId: string; activityKind: string; cleanText: string }> };
    expect(data.items).toEqual([expect.objectContaining({
      tweetId: `probe:${runId}`,
      activityKind: "probe",
      cleanText: "可用 1/1 源 · 合并 20 条 · 新增 0 条"
    })]);
    const detail = await fetch(`${base}/api/analyses/${encodeURIComponent(`probe:${runId}`)}`, {
      headers: { Cookie: cookie }
    });
    expect(await detail.json()).toMatchObject({
      kind: "probe",
      probe: { id: runId, successfulSourceCount: 1 },
      sources: [{ source: "x_browser", status: "success", itemCount: 20 }]
    });
    const status = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
    expect(await status.json()).toMatchObject({
      status: {
        enabledSourceCount: 1,
        availableSourceCount: 1,
        pollOverdue: false,
        sources: [{ source: "x_browser", label: "匿名 X", lastStatus: "success" }]
      }
    });
    store.close();
  });
});
