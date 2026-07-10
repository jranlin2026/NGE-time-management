import { feishuRequest } from "./feishu-openapi.mjs";

export function canCreateFeishuTasks(config) {
  return Boolean(config.feishuAppId && config.feishuAppSecret && config.feishuTasklistGuid);
}

export function missingTaskConfig(config) {
  const missing = [];
  if (!config.feishuAppId) missing.push("FEISHU_APP_ID");
  if (!config.feishuAppSecret) missing.push("FEISHU_APP_SECRET");
  if (!config.feishuTasklistGuid) missing.push("FEISHU_TASKLIST_GUID");
  return missing;
}

export async function createDailyTaskBundle(config, picked, dateText) {
  if (!canCreateFeishuTasks(config)) {
    return {
      skipped: true,
      reason: `missing ${missingTaskConfig(config).join(", ")}`,
    };
  }

  try {
    const title = `${dateText} N哥今日关键任务`;
    const parent = await createTask(config, {
      summary: title,
      description: renderParentDescription(picked),
      dueDate: dateText,
    });

    const parentGuid = extractTaskGuid(parent);
    const warnings = [];
    const subtasks = [];
    if (parentGuid) {
      for (const { task } of picked) {
        subtasks.push(
          await createSubtask(config, parentGuid, {
            summary: task.title,
            description: renderTaskDescription(task),
            dueDate: task.due || dateText,
          }),
        );
      }
    }

    return {
      skipped: false,
      parent,
      parentGuid,
      parentUrl: makeTaskUrl(parentGuid),
      subtasks,
      warnings,
    };
  } catch (error) {
    return {
      skipped: true,
      reason: error.message,
    };
  }
}

export async function createTask(config, task) {
  const body = buildTaskBody(config, task);
  return feishuRequest(config, "/task/v2/tasks", {
    method: "POST",
    body,
  });
}

export async function updateTask(config, taskGuid, patch) {
  return feishuRequest(config, `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
    method: "PATCH",
    body: buildTaskUpdateBody(patch),
  });
}

export function buildTaskUpdateBody(patch) {
  const task = {};
  const updateFields = [];
  if (patch.summary !== undefined) {
    task.summary = patch.summary;
    updateFields.push("summary");
  }
  if (patch.description !== undefined) {
    task.description = patch.description;
    updateFields.push("description");
  }
  if (patch.dueDate !== undefined) {
    task.due = {
      timestamp: String(new Date(`${patch.dueDate}T18:00:00+08:00`).getTime()),
      is_all_day: true,
    };
    updateFields.push("due");
  }
  if (patch.completedAt !== undefined) {
    task.completed_at = patch.completedAt ? String(new Date(patch.completedAt).getTime()) : "0";
    updateFields.push("completed_at");
  }
  return { task, update_fields: updateFields };
}

export async function createSubtask(config, parentGuid, task) {
  const body = buildTaskBody(config, task, { includeTasklist: false });
  return feishuRequest(config, `/task/v2/tasks/${encodeURIComponent(parentGuid)}/subtasks`, {
    method: "POST",
    body,
  });
}

export async function createTasklist(config, name = "N哥时间管理大师") {
  return feishuRequest(config, "/task/v2/tasklists", {
    method: "POST",
    body: { name },
  });
}

export async function addTasklistMember(config, tasklistGuid, memberId, options = {}) {
  const idType = options.idType || "open_id";
  const memberType = options.memberType || "user";
  const role = options.role || "editor";
  return feishuRequest(
    config,
    `/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/add_members?user_id_type=${encodeURIComponent(idType)}`,
    {
      method: "POST",
      body: {
        members: [
          {
            id: memberId,
            type: memberType,
            role,
          },
        ],
      },
    },
  );
}

function buildTaskBody(config, task, options = {}) {
  const body = {
    summary: task.summary,
    description: task.description || "",
  };

  if (task.dueDate) {
    body.due = {
      timestamp: String(new Date(`${task.dueDate}T18:00:00+08:00`).getTime()),
      is_all_day: true,
    };
  }

  if (config.feishuTasklistGuid) {
    body.tasklists = [
      {
        tasklist_guid: config.feishuTasklistGuid,
      },
    ];
  }

  if (config.feishuTaskAssigneeId) {
    body.members = [
      {
        id: config.feishuTaskAssigneeId,
        type: "user",
        role: "assignee",
      },
    ];
  }

  return body;
}

function renderParentDescription(picked) {
  return [
    "时间管理大师自动创建。",
    "",
    "规则：今天只锁定 1-3 个关键任务，先做第 1 件。完成或卡住，都回到飞书群反馈。",
    "",
    ...picked.map(({ task }, index) => `${index + 1}. ${task.title}\n下一步：${task.nextAction}`),
  ].join("\n");
}

function renderTaskDescription(task) {
  return [
    `项目：${task.project}`,
    `分类：${task.quadrant}`,
    `下一步动作：${task.nextAction}`,
    `完成标准：${task.doneDefinition}`,
    `预计耗时：${task.estimateMinutes} 分钟`,
    "",
    "拖延处理：如果卡住，只做 15 分钟最小动作，不切换到伪工作。",
  ].join("\n");
}

function extractTaskGuid(response) {
  return response?.data?.task?.guid || response?.data?.guid || response?.task?.guid || "";
}

function makeTaskUrl(guid) {
  if (!guid) return "";
  return `https://applink.feishu.cn/client/todo/detail?guid=${guid}&authscene=1`;
}
