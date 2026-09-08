import { loadConfig } from "./config.js";
import { WatcherApp } from "./app.js";
import { logger } from "./logger.js";
import { AdminServer } from "./admin.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new WatcherApp(config);
  let admin: AdminServer | null = null;
  if (config.adminEnabled) {
    admin = new AdminServer(config, app.store, app.notifier);
    try {
      await admin.start();
    } catch (error) {
      admin = null;
      logger.error("admin_start_failed_watcher_continues", { error });
    }
  }
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_requested", { signal });
    await admin?.close().catch((error) => logger.warn("admin_shutdown_failed", { error }));
    await app.stop();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  try {
    await app.run();
  } finally {
    await admin?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  logger.error("watcher_fatal", { error });
  process.exitCode = 1;
});
