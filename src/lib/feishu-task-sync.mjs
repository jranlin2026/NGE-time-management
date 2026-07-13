import { createHash } from "node:crypto";
import {
  createSubtask,
  createTask,
  listSubtasks,
  listTasklistTasks,
  updateTask,
} from "./feishu-tasks.mjs";

const defaultApi = { createSubtask, createTask, listSubtasks, listTasklistTasks, updateTask };

export function createFeishuTaskSynchronizer({ config, tasks, links, api = defaultApi, scheduleForDate }) {
  return {
    async pushSchedule({ date, schedule }) {
      const results = [];
      const remoteParents = await api.listTasklistTasks(config);
      const scheduleBlocks = schedule?.blocks || [];
      const taskIds = [...new Set(scheduleBlocks.map((block) => block.taskId))];
      const checkpointBlocks = new Map(
        scheduleBlocks
          .filter((block) => Number.isInteger(block.checkpointIndex))
          .map((block) => [checkpointKey(block.taskId, block.checkpointIndex), block]),
      );
      for (const taskId of taskIds) {
        const localTask = tasks.findById(taskId);
        if (!localTask) continue;
        const intervals = (localTask.checkpoints || [])
          .map((checkpoint, checkpointIndex) => checkpointInterval(localTask.id, checkpointIndex, checkpoint, checkpointBlocks))
          .filter(Boolean);
        const parentInterval = bounds(intervals)
          || bounds(scheduleBlocks.filter((block) => block.taskId === localTask.id).map(validInterval).filter(Boolean));
        const parentFields = managedFields(
          localTask,
          -1,
          localTask.title,
          parentDescription(localTask),
          parentInterval?.startAt,
          parentInterval?.dueAt,
          localTask.status === "done",
        );
        const parent = await ensureRemote({
          localTask,
          checkpointIndex: -1,
          parentGuid: null,
          fields: parentFields,
          remoteTasks: remoteParents,
        });
        const remoteChildren = await api.listSubtasks(config, parent.taskGuid);
        for (const [checkpointIndex, checkpoint] of (localTask.checkpoints || []).entries()) {
          const interval = checkpointInterval(localTask.id, checkpointIndex, checkpoint, checkpointBlocks);
          const childFields = managedFields(
            localTask,
            checkpointIndex,
            childSummary(checkpoint, interval, config.timezone),
            childDescription(checkpoint),
            interval ? interval.startAt : checkpoint.completed ? undefined : null,
            interval ? interval.dueAt : checkpoint.completed ? undefined : null,
            checkpoint.completed,
          );
          await ensureRemote({
            localTask,
            checkpointIndex,
            parentGuid: parent.taskGuid,
            fields: childFields,
            remoteTasks: remoteChildren,
          });
        }
        results.push({ localTaskId: localTask.id, parentGuid: parent.taskGuid });
      }
      await clearRemovedTaskSchedules({ date, scheduledTaskIds: new Set(taskIds) });
      return { date, tasks: results };
    },

    async pullProgress({ date }) {
      const completedTasks = [];
      const completedCheckpoints = [];
      if (typeof scheduleForDate !== "function") throw new Error("scheduleForDate is required to pull Feishu progress");
      const schedule = await scheduleForDate(date);
      const taskIds = [...new Set((schedule?.blocks || []).map((block) => block.taskId))];
      const localTasks = taskIds.map((id) => tasks.findById(id)).filter(Boolean);
      const remoteParents = await api.listTasklistTasks(config);
      const parentsByGuid = new Map(remoteParents.map((task) => [task.guid, task]));

      for (const localTask of localTasks) {
        const parentLink = links.findFeishuLink(localTask.id, -1);
        if (!parentLink) continue;
        const remoteParent = parentsByGuid.get(parentLink.taskGuid);
        const parentCompletedAt = completedAt(remoteParent);
        if (parentCompletedAt && localTask.status !== "done") {
          completedTasks.push({ localTaskId: localTask.id, taskGuid: parentLink.taskGuid, completedAt: parentCompletedAt });
        }
        const remoteChildren = await api.listSubtasks(config, parentLink.taskGuid);
        const childrenByGuid = new Map(remoteChildren.map((task) => [task.guid, task]));
        for (const link of links.listFeishuLinks(localTask.id)) {
          if (link.checkpointIndex < 0) continue;
          const timestamp = completedAt(childrenByGuid.get(link.taskGuid));
          if (!timestamp || localTask.checkpoints?.[link.checkpointIndex]?.completed) continue;
          completedCheckpoints.push({ localTaskId: localTask.id, checkpointIndex: link.checkpointIndex, taskGuid: link.taskGuid, completedAt: timestamp });
        }
      }
      return { date, completedTasks, completedCheckpoints };
    },
  };

  async function ensureRemote({ localTask, checkpointIndex, parentGuid, fields, remoteTasks }) {
    const snapshotHash = hash(fields);
    const existing = links.findFeishuLink(localTask.id, checkpointIndex);
    if (!existing) {
      const remote = remoteTasks.find((task) =>
        (task.client_token || task.clientToken) === fields.clientToken
        || String(task.description || "").includes(fields.managedMarker));
      if (remote?.guid) {
        await api.updateTask(config, remote.guid, fields);
        return links.upsertFeishuLink({
          localTaskId: localTask.id,
          checkpointIndex,
          taskGuid: remote.guid,
          parentGuid,
          snapshotHash,
        });
      }
      const response = checkpointIndex === -1
        ? await api.createTask(config, fields)
        : await api.createSubtask(config, parentGuid, fields);
      const taskGuid = extractGuid(response);
      if (!taskGuid) throw new Error(`Feishu task creation returned no guid for ${localTask.id}:${checkpointIndex}`);
      return links.upsertFeishuLink({ localTaskId: localTask.id, checkpointIndex, taskGuid, parentGuid, snapshotHash });
    }
    if (existing.snapshotHash !== snapshotHash) {
      await api.updateTask(config, existing.taskGuid, fields);
      return links.upsertFeishuLink({ ...existing, parentGuid, snapshotHash });
    }
    return existing;
  }

  async function clearRemovedTaskSchedules({ date, scheduledTaskIds }) {
    if (typeof tasks?.listActive !== "function" || typeof links?.listAllFeishuLinks !== "function") return;
    const allLinks = links.listAllFeishuLinks();
    if (!Array.isArray(allLinks)) return;
    const linksByTask = Map.groupBy(allLinks, (link) => link.localTaskId);
    const activeTasks = tasks.listActive();
    if (!Array.isArray(activeTasks)) return;

    for (const localTask of activeTasks) {
      if (scheduledTaskIds.has(localTask.id) || String(localTask.dueAt || "").slice(0, 10) !== date) continue;
      const taskLinks = linksByTask.get(localTask.id) || [];
      const parentLink = taskLinks.find((link) => link.checkpointIndex === -1);
      if (!parentLink) continue;

      await updateLinkedRemote(parentLink, managedFields(
        localTask,
        -1,
        localTask.title,
        parentDescription(localTask),
        null,
        null,
        false,
      ));
      const taskLinksByCheckpoint = new Map(taskLinks.map((link) => [link.checkpointIndex, link]));
      for (const [checkpointIndex, checkpoint] of (localTask.checkpoints || []).entries()) {
        const childLink = taskLinksByCheckpoint.get(checkpointIndex);
        if (!childLink) continue;
        const interval = checkpoint.completed ? checkpointInterval(localTask.id, checkpointIndex, checkpoint, new Map()) : null;
        await updateLinkedRemote(childLink, managedFields(
          localTask,
          checkpointIndex,
          childSummary(checkpoint, interval, config.timezone),
          childDescription(checkpoint),
          interval ? interval.startAt : checkpoint.completed ? undefined : null,
          interval ? interval.dueAt : checkpoint.completed ? undefined : null,
          checkpoint.completed,
        ));
      }
    }
  }

  async function updateLinkedRemote(link, fields) {
    const snapshotHash = hash(fields);
    if (link.snapshotHash === snapshotHash) return link;
    await api.updateTask(config, link.taskGuid, fields);
    return links.upsertFeishuLink({ ...link, snapshotHash });
  }
}

function parentDescription(task) {
  return [
    task.project ? `项目：${task.project}` : "",
    task.nextAction ? `第一步：${task.nextAction}` : "",
    Number.isFinite(task.estimateMinutes) ? `预计投入：${task.estimateMinutes}分钟` : "",
    task.doneDefinition ? `完成标准：${task.doneDefinition}` : "",
    task.description || "",
  ].filter(Boolean).join("\n");
}

function childDescription(checkpoint) {
  return [
    `预计：${checkpoint.minutes || 15}分钟`,
    `完成标准：${checkpoint.doneDefinition || checkpoint.title}`,
    checkpoint.feedback ? `反馈：${checkpoint.feedback}` : "完成后在飞书勾选本子任务。",
  ].join("\n");
}

function childSummary(checkpoint, interval, timezone = "Asia/Shanghai") {
  if (!interval) return checkpoint.title;
  return `${localTime(interval.startAt, timezone)}–${localEndTime(interval, timezone)}｜${checkpoint.title}`;
}

function localTime(value, timezone) {
  const parts = localParts(value, timezone);
  return `${parts.hour}:${parts.minute}`;
}

function localEndTime(interval, timezone) {
  const start = localParts(interval.startAt, timezone);
  const end = localParts(interval.dueAt, timezone);
  if (end.hour === "00" && end.minute === "00" && localDateKey(start) !== localDateKey(end)) return "24:00";
  return `${end.hour}:${end.minute}`;
}

function localParts(value, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
}

function localDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function checkpointKey(taskId, checkpointIndex) {
  return `${taskId}:${checkpointIndex}`;
}

function checkpointInterval(taskId, checkpointIndex, checkpoint, checkpointBlocks) {
  return validInterval(checkpointBlocks.get(checkpointKey(taskId, checkpointIndex)))
    || (checkpoint.completed ? validInterval(checkpoint) : null);
}

function validInterval(value) {
  const startAt = value?.startsAt;
  const dueAt = value?.endsAt;
  const start = Date.parse(startAt);
  const due = Date.parse(dueAt);
  return Number.isFinite(start) && Number.isFinite(due) && due > start ? { startAt, dueAt, start, due } : null;
}

function bounds(intervals) {
  if (!intervals.length) return null;
  return {
    startAt: intervals.reduce((first, interval) => interval.start < first.start ? interval : first).startAt,
    dueAt: intervals.reduce((last, interval) => interval.due > last.due ? interval : last).dueAt,
  };
}

function managedFields(localTask, checkpointIndex, summary, description, startAt, dueAt, completed) {
  const managedMarker = `[nge-managed:${stableMarker(localTask.id, checkpointIndex)}]`;
  return {
    summary,
    description: [description || "", managedMarker].filter(Boolean).join("\n"),
    managedMarker,
    clientToken: stableClientToken(localTask.id, checkpointIndex),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(completed ? { completedAt: localTask.completedAt || localTask.updatedAt || "1970-01-01T00:00:00.000Z" } : {}),
  };
}

function stableMarker(localTaskId, checkpointIndex) {
  return createHash("sha256").update(`${localTaskId}:${checkpointIndex}`).digest("hex").slice(0, 32);
}

function stableClientToken(localTaskId, checkpointIndex) {
  return `nge-${createHash("sha256").update(`${localTaskId}:${checkpointIndex}`).digest("hex")}`;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extractGuid(response) {
  return response?.data?.task?.guid || response?.data?.subtask?.guid || response?.data?.guid || response?.task?.guid || "";
}

function completedAt(task) {
  const timestamp = Number(task?.completed_at);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}
