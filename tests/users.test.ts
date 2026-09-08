import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("notification user management", () => {
  it("keeps one immutable administrator and manages ordinary users", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-users-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/users.sqlite`);
    store.bootstrapNotificationTargets([
      { name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }
    ]);

    store.addNotificationTarget({ name: "friend", sendKey: "SCT_FRIEND_TEST", role: "recipient" });
    expect(store.listNotificationTargets()).toHaveLength(2);

    store.updateNotificationTargetSendKey("friend", "SCT_FRIEND_NEW");
    expect(store.listNotificationTargets(true).find((target) => target.name === "friend")?.sendKey)
      .toBe("SCT_FRIEND_NEW");

    store.enqueue({
      id: "queued-for-friend",
      category: "suspected",
      priority: 4,
      title: "Queued",
      body: "Queued"
    }, "friend", "2026-08-31T00:00:00Z");
    expect(store.getQueued("friend", "9999-12-31T23:59:59Z")).toHaveLength(1);
    store.setNotificationTargetEnabled("friend", false);
    expect(store.listNotificationTargets()).toHaveLength(1);
    expect(store.listNotificationTargets(true).find((target) => target.name === "friend")?.enabled).toBe(false);
    expect(store.getQueued("friend", "9999-12-31T23:59:59Z")).toHaveLength(0);

    store.setNotificationTargetEnabled("friend", true);
    store.deleteNotificationTarget("friend");
    expect(store.listNotificationTargets(true).map((target) => target.name)).toEqual(["owner"]);
    expect(() => store.setNotificationTargetEnabled("owner", false)).toThrow(/管理员/);
    expect(() => store.deleteNotificationTarget("owner")).toThrow(/管理员/);
    store.close();
  });

  it("rejects duplicate names and SendKeys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-users-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/users.sqlite`);
    store.bootstrapNotificationTargets([
      { name: "owner", sendKey: "SCT_OWNER_TEST", role: "maintainer" }
    ]);
    store.addNotificationTarget({ name: "friend", sendKey: "SCT_FRIEND_TEST", role: "recipient" });
    expect(() => store.addNotificationTarget({ name: "friend", sendKey: "SCT_OTHER_TEST", role: "recipient" }))
      .toThrow(/用户名/);
    expect(() => store.addNotificationTarget({ name: "other", sendKey: "SCT_FRIEND_TEST", role: "recipient" }))
      .toThrow(/SendKey/);
    store.close();
  });
});
