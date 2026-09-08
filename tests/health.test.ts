import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db.js";
import { HealthMonitor } from "../src/health.js";
import type { NotificationService } from "../src/notifier.js";
import type { NotificationMessage } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("copywriter health monitoring", () => {
  it("alerts once per continuous incident and permits a second incident on the same day", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-health-"));
    tempDirs.push(dir);
    const store = new Store(`${dir}/health.sqlite`);
    const notifyMaintainer = vi.fn(async (_message: NotificationMessage) => ({ targetName: "owner", status: "sent" as const }));
    const monitor = new HealthMonitor(store, { notifyMaintainer } as unknown as NotificationService);
    const dayOne = new Date("2026-08-31T03:00:00Z");
    await monitor.failure("copywriter", new Error("copy failed"), dayOne);
    await monitor.failure("copywriter", new Error("copy failed"), dayOne);
    expect(notifyMaintainer).not.toHaveBeenCalled();
    await monitor.failure("copywriter", new Error("copy failed"), dayOne);
    await monitor.failure("copywriter", new Error("copy failed"), dayOne);
    expect(notifyMaintainer).toHaveBeenCalledTimes(1);
    expect(store.getHealth("copywriter").active).toBe(true);
    await monitor.failure("copywriter", new Error("copy still failed"), dayOne);
    expect(notifyMaintainer).toHaveBeenCalledTimes(1);

    monitor.success("copywriter");
    expect(store.getHealth("copywriter").recoveryPending).toBe(true);
    await monitor.failure("copywriter", new Error("copy failed again"), dayOne);
    await monitor.failure("copywriter", new Error("copy failed again"), dayOne);
    await monitor.failure("copywriter", new Error("copy failed again"), dayOne);
    expect(notifyMaintainer).toHaveBeenCalledTimes(2);
    const firstId = notifyMaintainer.mock.calls[0]?.[0].id;
    const secondId = notifyMaintainer.mock.calls[1]?.[0].id;
    expect(secondId).not.toBe(firstId);
    store.close();
  });
});
