# 飞书接入说明

## MVP 目标

第一版不做完整 App。先做：

1. 你在飞书群里发自然语言任务。
2. 飞书事件回调把消息打到本地服务。
3. 本地服务把任务写入 FounderOS 时间管理知识库。
4. 每天 08:30 运行调度脚本，选出 1-3 个关键任务。
5. 调度结果写入每日计划，并通过飞书机器人发回群里。

## 本地启动

```powershell
Copy-Item .env.example .env
npm test
npm run start
```

健康检查：

```powershell
Invoke-RestMethod http://localhost:8787/health
```

## 手动入池

```powershell
npm run ingest -- "新增任务：2026-07-08 前完成直播助教分工确认"
```

## 手动生成今日计划

```powershell
npm run dispatch
```

如果 `.env` 里没有 `FEISHU_WEBHOOK_URL`，脚本只会写入知识库，不会发飞书。

## 飞书配置

### 发送消息

配置飞书群自定义机器人 Webhook：

```text
FEISHU_WEBHOOK_URL=
FEISHU_WEBHOOK_SECRET=
```

### 创建飞书正式任务

群机器人 Webhook 只能发群消息，不能创建飞书正式任务。要让系统在飞书里创建任务清单，需要企业自建应用 OpenAPI 配置：

```text
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_TASKLIST_GUID=
FEISHU_TASK_ASSIGNEE_ID=
```

必填：

- `FEISHU_APP_ID`：飞书开放平台企业自建应用的 App ID。
- `FEISHU_APP_SECRET`：同一个应用的 App Secret。
- `FEISHU_TASKLIST_GUID`：飞书任务清单链接里的 `guid`。

推荐让应用自己创建任务清单，这样应用就是清单所有者，后续创建任务最稳定：

```powershell
npm.cmd run create:tasklist -- "N哥时间管理大师"
```

该命令会自动把新清单的 `guid` 写入 `.env`。

可选：

- `FEISHU_TASK_ASSIGNEE_ID`：你的飞书用户 ID。第一版可不填，不填时创建任务但不指定负责人。

应用权限：

```text
task:task:write
task:tasklist:write
```

或：

```text
task:task:writeonly
```

配置完成后运行：

```powershell
npm.cmd run dispatch
```

预期结果：

1. 知识库生成每日计划。
2. 飞书任务里创建一个父任务：`YYYY-MM-DD N哥今日关键任务`。
3. 父任务下创建 1-3 个子任务。
4. 群聊收到今日任务摘要和飞书任务链接。

当前应用拥有的任务清单：

```text
https://applink.feishu.cn/client/todo/task_list?guid=5d2a28f3-91b5-49a3-a034-e2ed2d49dfec
```

如果用户看不到这个清单，需要把用户加入清单成员：

```powershell
npm.cmd run tasklist:add-member -- <你的open_id> open_id user editor
```

如果拿到的是飞书后台的 `user_id`，则运行：

```powershell
npm.cmd run tasklist:add-member -- <你的user_id> user_id user editor
```

### 接收消息

飞书企业自建应用事件订阅地址：

```text
POST http://你的公网地址/feishu/events
```

本地开发需要公网隧道，例如内网穿透工具。第一版也可以先不接事件订阅，用 `npm run ingest` 手动入池验证规则。

## 08:30 自动调度

Windows 任务计划程序建议每天 08:30 执行：

```powershell
cd /d D:\CODEX项目\N哥的时间管理大师
npm run dispatch
```

## 知识库文件

结构化任务池：

```text
C:\Users\jranl\WPSDrive\196914891\WPS云盘\林恩光的知识库\01_FounderOS_林总个人OS\08_时间管理大师\任务数据\active-tasks.md
```

每日计划：

```text
C:\Users\jranl\WPSDrive\196914891\WPS云盘\林恩光的知识库\01_FounderOS_林总个人OS\08_时间管理大师\每日计划\YYYY-MM-DD.md
```
