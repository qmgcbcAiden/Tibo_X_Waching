# Tibo Watch

**一只帮你盯着 Tibo X 动态的自托管猫娘提醒器。**

Tibo Watch 会持续关注 [@thsottiaux](https://x.com/thsottiaux) 是否发布了 Codex / ChatGPT Work 额度重置相关动态，并在需要行动时通过 Server酱推送到你的微信。它不是通用社媒监控工具，而是为“怕错过额度重置、又不想整天刷新 X”的用户准备的轻量小助手。

当 Tibo 预告“几点刷新”、确认“已经重置”、或提到 banked reset 这类额度信息时，它会用 DeepSeek 判断内容、换算你这边能直接看懂的时间，再发一条有点傲娇、有点嘴硬、但事实不乱改的猫娘通知。

## 它适合谁

- 你经常使用 Codex 或 ChatGPT Work，额度重置时间会影响当天安排。
- 你不想手动刷新 X，也不想把自己绑在一堆 RSS / 自动化平台上。
- 你希望把提醒发给自己或小圈子用户，每个人使用独立 Server酱账号。
- 你有一台可以长期运行 Docker 的 VPS，愿意自托管一个小服务。

## 你会收到什么

Tibo Watch 关注的是“额度相关事件”，而不是 Tibo 的所有普通动态。

- **预告提醒**：Tibo 说额度将在某个时间刷新时，立刻提醒，并催你刷新前把剩余额度用掉。
- **到点提醒**：如果预告里有明确时间，到点后再叫你一次。
- **确认提醒**：Tibo 明确说额度已经重置或已经发放时，优先级最高。
- **疑似提醒**：语义不够确定但可能有关时，也会低打扰地告诉你。
- **异常提醒**：X 采集、DeepSeek 判断或文案生成持续异常时，管理员会收到健康告警。
- **每日汇总**：没有即时送达的低优先级消息会在当天末尾合并说明。

通知文案会保留关键事实，比如 Tibo 发帖时间、原文时间表达、换算后的“主人这边的时间”。原帖链接不会进入微信通知，只在后台时间线里查看，避免消息里混入不必要的技术尾巴。

## 功能亮点

- **多源盯梢**：匿名 X 页面 + Feedly 代理 RSS，XCancel RSS 可在白名单获批后打开。
- **只看真正相关的内容**：排除回复、转发和引用帖，按帖子 ID 去重。
- **AI 分类但本地兜底**：DeepSeek 负责判断语义，本地程序负责校验时间、去重、排期和安全边界。
- **猫娘文案**：每个用户独立生成通知语气，保留二次元味道，也避免事实被模型乱写。
- **轻量后台**：浏览器里管理通知用户、验证通道、发送预览、查看分析时间线。
- **自托管友好**：Docker Compose 一键跑起，Caddy 自动申请 HTTPS 证书，数据落在本地 SQLite。

## 快速开始

推荐部署在一台 ARM64 Ubuntu VPS 上，也可以运行在其他支持 Docker 的 Linux 主机上。服务由两个容器组成：

- `watcher`：监控、判断、通知和管理后台。
- `caddy`：对外提供 HTTPS，并反向代理到后台。

### 1. 准备配置

```bash
cp .env.example .env
chmod 600 .env
mkdir -p data
sudo chown 1000:1000 data
```

打开 `.env`，至少配置这些值：

```dotenv
ADMIN_DOMAIN=tibo-watch.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH='scrypt$REPLACE_WITH_GENERATED_HASH'

DEEPSEEK_BASE_URL=https://your-deepseek-endpoint.example/v1
DEEPSEEK_API_KEY=replace-me
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro

SERVERCHAN_TARGETS_JSON=[{"name":"owner","sendKey":"SCT_REPLACE_OWNER","role":"maintainer"}]
```

其中：

- `ADMIN_DOMAIN` 需要先解析到你的 VPS。
- `SERVERCHAN_TARGETS_JSON` 是首次启动时写入的管理员通知账号。
- `TZ` 保持 `Asia/Shanghai`，通知里会自然称为“主人这边的时间”。

### 2. 生成管理员密码

先构建镜像，再生成后台密码哈希：

```bash
docker compose build
docker compose run --rm watcher node dist/src/cli.js admin-hash
```

把输出完整填入 `.env` 的 `ADMIN_PASSWORD_HASH`。建议保留示例里的单引号，避免 `$` 被 Compose 当成变量。

如果你想在开发机上生成，也可以使用：

```bash
npm ci
npm run admin:hash
```

### 3. 启动服务

确认域名已经指向 VPS，并放行 TCP 80/443 与 UDP 443，然后启动：

```bash
docker compose up -d
docker compose ps
docker compose logs -f watcher caddy
```

Caddy 会自动申请 HTTPS 证书。打开：

```text
https://你的域名
```

登录后就能进入 Tibo Watch 控制台。

## 管理后台

后台只给管理员使用，普通通知用户没有登录账号。

你可以在后台完成这些操作：

- 新增、停用、删除通知用户。
- 更新每个用户的 Server酱 SendKey。
- 给指定用户发送猫娘风格的真实预览消息。
- 验证 Server酱通道是否可达。
- 查看 Tibo 动态判断结果、DeepSeek 调用、文案生成、发送状态和来源探测。

桌面端是左右双栏：左边管用户，右边看 DeepSeek 分析流。手机端会切成顶部状态条 + 底部双标签，方便临时看一眼服务有没有在认真工作。

## 常用命令

匿名抓取测试不会调用 DeepSeek，也不会触发 Server酱发送：

```bash
docker compose run --rm watcher node dist/src/cli.js scrape
```

发送测试通知会给所有启用用户各发 1 条消息：

```bash
docker compose run --rm watcher node dist/src/cli.js notify
```

后台打不开时，可以用 CLI 管理用户：

```bash
docker compose exec watcher node dist/src/cli.js users list
docker compose exec watcher node dist/src/cli.js users add alice
docker compose exec watcher node dist/src/cli.js users update-key alice
docker compose exec watcher node dist/src/cli.js users disable alice
docker compose exec watcher node dist/src/cli.js users enable alice
docker compose exec watcher node dist/src/cli.js users remove alice --yes
```

升级时通常只需要：

```bash
docker compose down
docker compose build --pull
docker compose up -d
```

数据保存在 `data/watcher.sqlite`。备份前建议先停止服务，复制完成后再启动。

## 本地开发

```bash
npm ci
npm run check
npm test
npm run build
docker compose config
```

常用脚本：

- `npm run dev`：本地启动 watcher。
- `npm run scrape:test`：抓取最新动态并输出摘要。
- `npm run notify:test`：发送一轮测试通知。
- `npm run admin:hash`：生成后台管理员密码哈希。

## 常见限制

- X 匿名页面和公共 RSS 代理都不是官方稳定接口，未来可能变慢、失效或改变结构。
- Feedly 代理流可能延迟数十分钟；如果 XCancel RSS 白名单可用，建议启用直连作为补充来源。
- 当前会严格排除引用帖，因此带引用卡片但正文相关的动态可能被跳过。
- VPS 整机离线时，服务无法自我推送离线告警；需要外部存活监控时请额外配置。
- 这个项目默认服务少量自托管用户，不面向大规模通知分发。

## 配置来源速记

默认配置已经写在 [.env.example](.env.example)。一般只需要改后台域名、DeepSeek、Server酱和必要的 X 来源开关：

```dotenv
X_BROWSER_ENABLED=true
X_FEEDLY_ENABLED=true
X_XCANCEL_RSS_ENABLED=false
X_RSS_USER_AGENT=TiboWatch-RSS/1.0
```

白名单获批后，可以把 `X_XCANCEL_RSS_ENABLED` 改成 `true` 并重启服务。
