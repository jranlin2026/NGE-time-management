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
```

`FEISHU_RECEIVE_ID` 可选。未填写时，系统会在首次收到你的飞书消息后自动保存发送者 `open_id`；如果要发到专用群，填写群 `chat_id` 并把 `FEISHU_RECEIVE_ID_TYPE` 改为 `chat_id`。

默认知识库：

```text
/Users/nge/MAC BOOK的WPS云盘/林恩光的知识库/01_FounderOS_林总个人OS/08_时间管理大师
```

默认数据库与导出位于项目的 `data/`，该目录不会进入 Git。

## 安装为 Mac 常驻服务

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

Mac 休眠期间不会执行提醒；唤醒后系统会失效旧提醒并发送一张重新计算后的计划。

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
