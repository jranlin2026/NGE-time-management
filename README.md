# N哥的时间管理大师

一个运行在 Mac 上、通过飞书主动管理个人任务的本地时间管理负责人。

核心目标：

- 管理未来 30 天任务池。
- 每天 08:30 主动挑出 1-3 个关键任务。
- 通过飞书收集任务、下发今日计划。
- 把任务池和每日计划保存到 FounderOS 知识库。
- 自动提醒任务开始，连续两次无响应时缩小任务并重排。
- 支持飞书卡片按钮和文字反馈。
- 使用本机 Codex 理解自然语言，SQLite 保存主数据。
- 由 macOS `launchd` 开机启动、异常重启和恢复计划。
- 以知识库中的项目 Markdown 为事实源，自动生成周计划、每日执行任务，并在证据验收通过后回写项目进度。

## 自动项目执行循环

知识库使用以下目录：

```text
项目/                     # 项目事实源
周计划/                   # 周计划草稿与已确认版本
项目变更记录/             # 每次交付验收或计划变更的审计记录
```

首次启动会为个人 IP 和极享 OS 创建 `draft` 项目模板。先在模板的受管区填写里程碑、交付项、权重和验收标准，再通过飞书卡片确认启用；系统只改动 `time-manager:managed` 标记之间的内容，自由笔记不会被覆盖。

每周日 22:00（默认 `Asia/Shanghai`）生成未来一周草稿并发送确认卡。点击“确认周计划”后才会生效；点击“申请调整”后，回复 `调整周计划｜具体原因` 生成新版本。周一 08:00 尚未确认时，未确认草稿不会进入执行，系统继续使用最近已确认方向和当前任务池，并保留确认提醒。

每日计划最多 5 项，默认只使用可用时间的 70%。当两个重点项目各 2 项、各 120 分钟的最低投入无法在容量内满足时，计划会显示容量不足警告，不会偷偷突破上限。可通过以下环境变量调整：

```text
TIME_MASTER_WEEKLY_PLAN_TIME=22:00
TIME_MASTER_CAPACITY_RATIO=0.7
```

项目交付任务点击“完成”后进入待验收，不会直接增加进度。提交格式：

```text
提交结果：任务名｜链接或说明
```

可访问且与验收标准匹配的链接可自动判定；飞书图片或系统无法可靠检查的材料必须在验收卡上人工选择“确认通过”或“退回继续做”。通过后系统先完成持久化 Markdown 写入，再以 SQLite 事务最终确认同步状态、项目进度卡和变更记录；若两步之间崩溃，启动恢复会依据持久化回执协调落账。这里不承诺跨 Markdown 与 SQLite 的原子事务；重复消息不会重复增加进度。

## 恢复与运行确认

Mac 休眠、服务异常退出或重启后，系统会废弃过期提醒、重新计算未完成计划，并协调已经写入 Markdown 但尚未完成 SQLite 落账的项目验收。固定提醒使用幂等键，重复启动不会重复创建；周日 22:00 按配置时区计算，夏令时地区也保持本地时间不变。

修改代码后先运行完整验证，再由操作者在可见终端中重启真实服务：

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
pgrep -alf 'scripts/run-manager.mjs'
ps -p <PID> -o pid,etime,%cpu,%mem,command
lsof -nP -a -p <PID> -iTCP -sTCP:ESTABLISHED
```

只重启 `pgrep` 返回的 manager PID。确认空闲 CPU 较低、至少一条已建立 TCP 连接，再在私有飞书群验证：周计划草稿→确认→今日计划→开始→完成→提交证据→检查项目 Markdown 与项目变更记录。不要用生产证据测试破坏性恢复或拒绝路径。

## Mac 快速开始

本项目要求 Node.js 24 或更高版本。

```bash
cp .env.example .env
node --test
node scripts/run-manager.mjs
```

`.env` 至少配置：

```text
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_TASKLIST_GUID=
FEISHU_P2P_CHAT_ID=
TIME_MASTER_USER_ID=
FEISHU_RECEIVE_ID=
FEISHU_RECEIVE_ID_TYPE=open_id
TIME_MASTER_TIMEZONE=Asia/Shanghai
```

`FEISHU_P2P_CHAT_ID` 是要轮询的机器人一对一私聊 `chat_id`；`TIME_MASTER_USER_ID` 是接收固定节点总结的本人 `open_id`。`FEISHU_RECEIVE_ID` 保留给旧的通用发送路径，默认同样填本人 `open_id`；只有发送到群时才把 `FEISHU_RECEIVE_ID_TYPE` 改为 `chat_id`。真实 ID 和密钥只放在本机 `.env`，不要提交。

飞书应用需在开发者后台开通并发布以下权限：

- `im:message` 或 `im:message:readonly`：读取一对一私聊消息。
- `task:task:read` 和 `task:task:write`：读写主任务与子任务。
- `task:tasklist:read` 和 `task:tasklist:write`：读写指定任务清单。

权限名称出现在后台不等于已生效；应确认包含权限的应用版本已发布，且机器人、本人和目标任务清单都在应用的可用范围内。

默认知识库：

```text
/Users/nge/MAC BOOK的WPS云盘/林恩光的知识库/01_FounderOS_林总个人OS/08_时间管理大师
```

默认数据库与导出位于项目的 `data/`，该目录不会进入 Git。

## 固定节点 Codex 自动化

正常运行由一条绑定本项目的本地 Codex 自动化触发，时区为 `Asia/Shanghai`，每天在 00:00、08:00、09:00、12:00、15:00、18:00 和 21:00 执行 `npm run checkpoint`。这是一条自动化的七个调度，不要建立七条重复自动化，也不要同时启动常驻 WebSocket manager。

自动化未运行或 Mac 错过节点时，下一次执行只会按本地检查点记录补跑三类必要节点：未完成的上一工作日 `24:00`、未完成的当日 `08:00`，以及当前时刻已到达的最新节点。中间错过的 `09:00`、`12:00`、`15:00`、`18:00` 或 `21:00` 会被折叠，不会依次重放；已完成节点也不会重复处理。手工补跑时直接执行：

```bash
npm run checkpoint
```

只读诊断不会分析、回复、创建/更新任务或推进检查点：

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/run-checkpoint.mjs --node=09:00 --dry-run
```

运行前必须配置 `FEISHU_P2P_CHAT_ID`。成功时输出一行 `status` 为 `dry_run` 的 JSON，其中写操作计数均为 0；失败时保留输出的脱敏 `error`，不要把 `.env` 或 token 贴入日志。

需要暂停或恢复时，在 Codex 的自动化页面对这一条项目自动化切换“禁用/启用”；保留自动化记录与检查点数据，不用删除来代替暂停。恢复后先跑上述 dry-run，再等待或手工执行一次检查点。

## 待执行的线上验收 runbook

本节是切换的持久清单。每项都要保留脱敏 JSON、时间戳或可见界面证据；没有证据就保持未完成。

- [ ] 确认 `.env` 的私聊 ID、本人 `open_id`、任务清单和应用凭证已配置，且上述飞书权限已随应用版本发布生效。
- [ ] 运行上述 `--node=09:00 --dry-run`，确认 `status` 为 `dry_run`，并确认没有分析、回复、任务写入或检查点推进。
- [ ] 只创建一个标题以 `【自动化验收】` 开头的隔离父任务和两个子任务；回读三个 GUID 及父子关系，手工完成其中一个子任务，再用下一节点回拉验证。不得删除任何现有用户任务；验收任务只有在获得明确批准后才可删除，否则留为清晰的已完成记录。
- [ ] 连续发送两条关联私聊，强制运行一次 `09:00`，确认两条消息合并为一次处理且只回复一次；原样重跑，确认不会重复回复、创建任务或写回。
- [ ] 在飞书完成一个远程子任务，到下一个节点运行检查点，确认本地只产生一个对应完成事件；再跑一次事件数不变。
- [ ] 对需证据的隔离父任务在飞书点击完成，下一节点回拉后确认本地状态是 `pending_acceptance`，而不是直接增加项目进度。
- [ ] 在 Codex 自动化页面确认只有一条绑定本项目的本地自动化，七个节点和 `Asia/Shanghai` 均可见。切换“禁用”并确认不再调度，再切回“启用”并确认下次运行时间可见；不要通过删除记录来验证。
- [ ] 上述验收全部通过后，精确查找旧 manager：

  ```bash
  ps ax -o pid=,command= | rg '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/run-manager.mjs$'
  ```

  只有命令唯一匹配到该完整命令行时，才向那一个 PID 发送 `SIGTERM`：

  ```bash
  kill -TERM <PID>
  ```

  重跑 `ps` 确认精确匹配已消失。不得使用宽泛 `pkill`，也不得关闭无关 Terminal 窗口。

## Legacy/fallback：Mac 常驻 launchd 服务

**仅供旧版回退。Codex 固定节点自动化启用时，不得安装或启用这个 launchd/WebSocket manager，否则两条执行路径会并行。**

确认手动运行可以连接飞书后执行：

```bash
node scripts/install-launchd.mjs
launchctl print gui/$UID/com.nge.time-management-master
```

查看日志：

```bash
tail -f data/logs/manager.stdout.log data/logs/manager.stderr.log
```

停止并卸载：

```bash
node scripts/uninstall-launchd.mjs
```

Mac 休眠期间不会执行提醒；唤醒后系统会失效旧提醒、协调项目写回并发送一张重新计算后的计划。

## 快速开始

```bash
cp .env.example .env
node --test
node scripts/dispatch-today.mjs
node src/server.mjs
```

健康检查：

```bash
curl http://localhost:8787/health
```

## 常用命令

新增任务：

```powershell
npm.cmd run ingest -- "新增任务：2026-07-08 前确认直播助教分工"
```

生成今日计划：

```powershell
npm.cmd run dispatch
```

如果已配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TASKLIST_GUID`，这条命令会同时创建飞书正式任务清单。

启动本地服务：

```powershell
npm.cmd run start
```

## 知识库位置

默认知识库：

```text
C:\Users\jranl\WPSDrive\196914891\WPS云盘\林恩光的知识库\01_FounderOS_林总个人OS\08_时间管理大师
```

结构化任务池：

```text
任务数据\active-tasks.md
```

每日计划：

```text
每日计划\YYYY-MM-DD.md
```

飞书任务清单：

```text
https://applink.feishu.cn/client/todo/task_list?guid=5d2a28f3-91b5-49a3-a034-e2ed2d49dfec
```

## 飞书入口

服务端点：

```text
POST /feishu/events
POST /dispatch/today
GET /health
```

飞书里发送：

```text
今日任务
```

会触发今日计划生成。

其他自然语言消息会先作为新任务入池。

详细配置见：

```text
docs/feishu-setup.md
```
