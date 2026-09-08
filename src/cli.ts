import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { NotificationService } from "./notifier.js";
import { stableId } from "./text.js";
import { shanghaiDay } from "./time.js";
import { XScraper } from "./x-scraper.js";
import { createPasswordHash } from "./admin-auth.js";
import { DeepSeekCopywriter } from "./copywriter.js";
import { createTweetSourceManager } from "./tweet-sources.js";

function normalizeName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("用户名必须是 1–64 个非控制字符");
  }
  return name;
}

function normalizeSendKey(value: string): string {
  const sendKey = value.trim();
  if (!/^SCT[A-Za-z0-9_-]{5,}$/.test(sendKey)) throw new Error("SendKey 格式无效");
  return sendKey;
}

function maskSendKey(sendKey: string): string {
  return sendKey.length <= 9 ? `${sendKey.slice(0, 3)}***` : `${sendKey.slice(0, 3)}***${sendKey.slice(-4)}`;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const previousRaw = input.isRaw;
    let value = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(previousRaw ?? false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("已取消"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

async function scrape(): Promise<void> {
  const config = loadConfig();
  const scraper = new XScraper(config);
  const sources = createTweetSourceManager(config, scraper);
  try {
    const fetched = await sources.fetchLatest();
    const summary = fetched.tweets.map((tweet) => ({
      id: tweet.id,
      postedAt: tweet.postedAt,
      eligible: !tweet.isReply && !tweet.isRepost && !tweet.isQuote,
      isReply: tweet.isReply,
      isRepost: tweet.isRepost,
      isQuote: tweet.isQuote,
      preview: tweet.cleanText.slice(0, 100)
    }));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await scraper.stop();
  }
}

async function notify(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  try {
    const notifier = new NotificationService(config, store, fetch, new DeepSeekCopywriter(config, store));
    const results = await notifier.broadcast({
      id: stableId("manual-test", new Date().toISOString()),
      category: "channel_test",
      priority: 5,
      title: "[Tibo监控] Server酱测试",
      body: "这是一条人工触发的测试消息。它会给每个启用账号分别发送 1 条通知。",
      facts: {
        eventType: "CHANNEL_TEST",
        products: ["Tibo Watch"],
        summaryZh: "这是人工触发的 Server酱通知通道验证。",
        certainty: "test"
      }
    });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    store.close();
  }
}

async function manageUsers(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  store.bootstrapNotificationTargets(config.targets);
  const action = process.argv[3] ?? "list";
  try {
    if (action === "list") {
      const day = shanghaiDay();
      const rows = store.listNotificationTargets(true);
      process.stdout.write(`上海日期：${day}\n`);
      process.stdout.write("用户\t角色\t状态\t今日调用\tSendKey\n");
      for (const target of rows) {
        const role = target.role === "maintainer" ? "管理员" : "用户";
        process.stdout.write(`${target.name}\t${role}\t${target.enabled ? "启用" : "停用"}\t${store.getDailyCalls(target.name, day)}\t${maskSendKey(target.sendKey)}\n`);
      }
      return;
    }

    const name = normalizeName(process.argv[4]);
    if (action === "add") {
      const sendKey = normalizeSendKey(await readSecret("请输入新用户的 Server酱 SendKey（输入不显示）："));
      store.addNotificationTarget({ name, sendKey, role: "recipient" });
      process.stdout.write(`已新增通知用户：${name}\n`);
      return;
    }
    if (action === "update-key") {
      const sendKey = normalizeSendKey(await readSecret("请输入新的 Server酱 SendKey（输入不显示）："));
      store.updateNotificationTargetSendKey(name, sendKey);
      process.stdout.write(`已更新 ${name} 的 SendKey\n`);
      return;
    }
    if (action === "enable" || action === "disable") {
      store.setNotificationTargetEnabled(name, action === "enable");
      process.stdout.write(`已${action === "enable" ? "启用" : "停用"}通知用户：${name}\n`);
      return;
    }
    if (action === "remove") {
      if (process.argv[5] !== "--yes") throw new Error("删除操作需在用户名后添加 --yes");
      store.deleteNotificationTarget(name);
      process.stdout.write(`已删除通知用户：${name}\n`);
      return;
    }
    throw new Error("未知的 users 操作");
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "scrape") await scrape();
  else if (command === "notify") await notify();
  else if (command === "users") await manageUsers();
  else if (command === "admin-hash") {
    const password = await readSecret("请输入至少 20 位的后台管理员密码（输入不显示）：");
    process.stdout.write(`${createPasswordHash(password)}\n`);
  }
  else {
    process.stderr.write("Usage: node dist/src/cli.js <scrape|notify|users|admin-hash>\n");
    process.stderr.write("Users: users <list|add NAME|update-key NAME|enable NAME|disable NAME|remove NAME --yes>\n");
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`操作失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
