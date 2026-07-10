# N哥的时间管理大师

一个本地运行的个人时间管理 MVP。

核心目标：

- 管理未来 30 天任务池。
- 每天 08:30 主动挑出 1-3 个关键任务。
- 通过飞书收集任务、下发今日计划。
- 把任务池和每日计划保存到 FounderOS 知识库。

## 快速开始

```powershell
Copy-Item .env.example .env
npm.cmd test
npm.cmd run dispatch
npm.cmd run start
```

健康检查：

```powershell
Invoke-RestMethod http://localhost:8787/health
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
