import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const heartbeatPath = path.join(dataDir, "heartbeat");
try {
  const stat = fs.statSync(heartbeatPath);
  const maximumAgeMs = Number(process.env.HEALTHCHECK_MAX_AGE_MS ?? 20 * 60 * 1000);
  if (Date.now() - stat.mtimeMs > maximumAgeMs) process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
