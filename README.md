# Token 用量看板

本地实时 Token 用量统计面板，风格参照 ZCode 的用量统计页。零依赖，纯 Node（仅内置模块），浏览器打开即用，5 秒自动刷新。

## 功能

- **概览指标卡**：总消耗 / 今日 / 各数据源今日 / 缓存命中（今日与累计）/ 对话数 / 活跃与连续天数 / 主力模型
- **52 周活跃热力图**：GitHub 式网格，悬浮查看每日用量
- **每日趋势折线**：近 7 / 30 日切换，按模型分线；点模型名可显示/隐藏对应折线，Y 轴随所选模型重新定标
- **模型用量环形图 + 排行**：按真实模型名聚合
- **模型 Token 分解条形图**：点选任意模型，查看其「输入·未缓存 / 输入·缓存命中 / 输出」三段占比，支持 `#模型名` 深链定位
- **费用面板**：可选——为按量计费的模型配置价目后折算费用（缓存命中按命中价），其余模型只计 token 不折钱；ledger.json 支持逐项账本

## 快速开始

```bash
node usage-server.js
# 浏览器打开 http://127.0.0.1:4620
```

首次启动对历史数据做增量预热（大目录约需 1-2 分钟），之后按字节 offset 增量读取，实时跟随新数据。

## 数据源

| 来源 | 说明 | 配置 |
|---|---|---|
| 会话 transcript（主来源） | Claude Code 兼容格式的 `*.jsonl`，逐行含 `message.usage`（input_tokens / cache_read_input_tokens / output_tokens）与 `providerData.model` | 默认扫描 `~/.workbuddy/projects`，可用 `USAGE_TRANSCRIPT_DIR` 覆盖 |
| 附加 JSONL（可选扩展） | 自己另有按量记账的调用日志（脚本、机器人等）才用得上，没有就完全忽略。每行 `{ "ts": ..., "tokens": {"in":..,"out":..}, "costCNY":.. }` 或按模型细分的 `{ "ts":..., "tokensByModel": {"模型名":{"tin":..,"tout":..,"cost":..}} }` | `USAGE_EXTRA_JSONL="a.jsonl,b.jsonl"` |
| 账本 ledger.json（可选） | 放上级目录：`{ "since": "2026-09-01", "任意分项名": {"costCNY": 123.4}, ... }`，费用面板逐项展示 | 文件路径固定为上级目录 `ledger.json` |

只有会话 transcript 是必需的；附加 JSONL 与 ledger 配置了才参与合并展示，各来源按模型名合并、同一调用只应存在于一个来源，避免重复计数。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `USAGE_PORT` | `4620` | 监听端口（仅绑定 127.0.0.1） |
| `USAGE_TRANSCRIPT_DIR` | `~/.workbuddy/projects` | transcript 根目录 |
| `USAGE_EXTRA_JSONL` | 空 | 附加 JSONL，逗号分隔 |
| `USAGE_PRICED_MODEL` | 空 | 填模型名后对该模型按价目折算费用，默认所有模型只计 token 不折钱 |
| `USAGE_PRICE_CUT` | 远期日期 | 价目切换日（网关调过价才需要设置） |
| `USAGE_DAYS` | `45` | transcript 统计窗口（天） |
| `USAGE_IDLE_MS` | `0` | >0 时启用空闲自退：连续无 HTTP 访问超过该毫秒数即自动退出（配合按需启动，关掉页面后约几分钟释放）；`0`=常驻。`open-dashboard.js` 按需拉起时默认置 `180000`（3 分钟） |

价目表在 `usage-server.js` 顶部 `P_OLD` / `P_NEW` 常量中修改（单位 ¥/M token，默认为占位示例值，接入自家计费网关前请按实际价目替换）。

## 在机器上部署（给 AI 代理的操作指引）

把仓库地址发给自己的 AI 助手（WorkBuddy、Claude Code 等），让它按下面步骤代办即可，全部是本地命令，无需联网安装任何依赖：

1. **前置检查**：确认本机有 Node.js ≥ 18（`node -v`）。没有的话，Windows 上装一个 LTS，或直接复用 WorkBuddy 自带的 node。
2. **放置仓库**：`git clone` 到任意固定目录（示例记作 `<仓库目录>`）。零依赖，clone 完不需要 `npm install`。
3. **确认数据源**：WorkBuddy 的会话记录默认在 `~/.workbuddy/projects`（Windows：`C:\Users\<用户名>\.workbuddy\projects`），与默认值一致则无需任何配置。用其他 Claude Code 兼容客户端的（如 `~/.claude/projects`），设置 `USAGE_TRANSCRIPT_DIR` 指向对应目录即可，两种可以后续各起一个实例分别统计。
4. **启动验证**：在 `<仓库目录>` 运行 `node usage-server.js`，浏览器打开 `http://127.0.0.1:4620`，能看到指标卡和热力图即部署成功。第一次启动会对历史数据做增量预热，之后实时增量。
5. **常驻后台（可选，推荐）**：
   - Windows：注册登录触发的计划任务（命令模板见下方"桌面快捷方式"一节）；
   - macOS / Linux：加入登录项或 cron `@reboot`，例如 `@reboot cd <仓库目录> && node usage-server.js`。
6. **桌面入口（可选，Windows）**：用 `gen-icon.js` 生成图标，再建 `.url` 快捷方式（模板见下）。此后双击图标即打开看板；服务没在跑时，双击 `open-dashboard.js` 的快捷方式也能先拉起服务再开页面。
7. **费用折算（可选）**：只有走按量计费网关的模型需要——设置 `USAGE_PRICED_MODEL=<模型名>`，并把 `P_OLD` / `P_NEW` 改成自家价目；纯订阅或免费额度场景跳过即可，费用面板会提示未配置。

排查提示：端口被占用时新实例会静默退出（说明服务已在跑）；页面数字不动时检查 `USAGE_TRANSCRIPT_DIR` 是否指对了目录。

## 配套小工具

- `gen-icon.js`：无依赖生成桌面图标（手写 PNG 编码 + SDF 抗锯齿），`node gen-icon.js --png` 输出预览，无参数输出多帧 `t-icon.ico`（32/64/128 为 BMP 帧，256 为 PNG 帧）
- `open-dashboard.js`：启动入口——检测服务存活，未运行则后台拉起，然后打开默认浏览器

### 桌面快捷方式（Windows）

手写二进制 `.lnk` 因缺少 PIDL 无法被执行（显示可以、双击不行），推荐用 InternetShortcut：

```ini
# 桌面新建 Token看板.url
[InternetShortcut]
URL=http://127.0.0.1:4620/
IconFile=C:\path\to\token-usage.ico
IconIndex=0
```

服务常驻可注册计划任务（登录触发、隐藏窗口）：

```powershell
$a = New-ScheduledTaskAction -Execute node -Argument '<绝对路径>\usage-server.js'
$s = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName TokenDashboard -Action $a -Settings $s -Force
```

重复启动免疫：第二个实例检测到端口占用会静默退出。

## 说明

- 数据只读本机文件，服务仅监听 127.0.0.1，无任何外发
- 缓存命中量计入输入侧总量，同时在看板单独展示
- 需要 Node.js ≥ 18
