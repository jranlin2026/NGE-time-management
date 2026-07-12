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
      for (const block of schedule?.blocks || []) {
        const localTask = tasks.findById(block.taskId);
        if (!localTask) continue;
        const parentFields = managedFields(localTask, -1, localTask.title, localTask.description, block.startsAt, block.endsAt, localTask.status === "done");
        const parent = await ensureRemote({
          localTask,
          checkpointIndex: -1,
          parentGuid: null,
          fields: parentFields,
          remoteTasks: remoteParents,
        });
        const remoteChildren = await api.listSubtasks(config, parent.taskGuid);
        for (const [checkpointIndex, checkpoint] of (localTask.checkpoints || []).entries()) {
          const childFields = managedFields(localTask, checkpointIndex, checkpoint.title, "", null, block.endsAt, checkpoint.completed);
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
}

function managedFields(localTask, checkpointIndex, summary, description, startAt, dueAt, completed) {
  const managedMarker = `[nge-managed:${stableMarker(localTask.id, checkpointIndex)}]`;
  return {
    summary,
    description: [description || "", managedMarker].filter(Boolean).join("\n"),
    managedMarker,
    clientToken: stableClientToken(localTask.id, checkpointIndex),
    ...(startAt ? { startAt } : {}),
    ...(dueAt ? { dueAt } : {}),
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
