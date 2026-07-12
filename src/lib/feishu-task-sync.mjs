import { createHash } from "node:crypto";
import {
  createSubtask,
  createTask,
  listSubtasks,
  listTasklistTasks,
  updateTask,
} from "./feishu-tasks.mjs";

const defaultApi = { createSubtask, createTask, listSubtasks, listTasklistTasks, updateTask };

export function createFeishuTaskSynchronizer({ config, tasks, links, api = defaultApi, clock = () => new Date() }) {
  const knownTaskIds = new Set();

  return {
    async pushSchedule({ date, schedule }) {
      const results = [];
      for (const block of schedule?.blocks || []) {
        const localTask = tasks.findById(block.taskId);
        if (!localTask) continue;
        knownTaskIds.add(localTask.id);
        const parentFields = managedFields(localTask.title, localTask.description, block.startsAt, block.endsAt);
        const parent = await ensureRemote({ localTask, checkpointIndex: -1, parentGuid: null, fields: parentFields });
        for (const [checkpointIndex, checkpoint] of (localTask.checkpoints || []).entries()) {
          const childFields = managedFields(checkpoint.title, "", null, block.endsAt);
          await ensureRemote({ localTask, checkpointIndex, parentGuid: parent.taskGuid, fields: childFields });
        }
        results.push({ localTaskId: localTask.id, parentGuid: parent.taskGuid });
      }
      return { date, tasks: results };
    },

    async pullProgress({ date }) {
      const completedTasks = [];
      const completedCheckpoints = [];
      const localTasks = typeof tasks.listAll === "function"
        ? tasks.listAll()
        : [...knownTaskIds].map((id) => tasks.findById(id)).filter(Boolean);
      const remoteParents = await api.listTasklistTasks(config);
      const parentsByGuid = new Map(remoteParents.map((task) => [task.guid, task]));

      for (const localTask of localTasks) {
        const parentLink = links.findFeishuLink(localTask.id, -1);
        if (!parentLink) continue;
        const remoteParent = parentsByGuid.get(parentLink.taskGuid);
        const parentCompletedAt = completedAt(remoteParent);
        if (parentCompletedAt && localTask.status !== "done") {
          completedTasks.push({ localTaskId: localTask.id, completedAt: parentCompletedAt });
        }
        const remoteChildren = await api.listSubtasks(config, parentLink.taskGuid);
        const childrenByGuid = new Map(remoteChildren.map((task) => [task.guid, task]));
        for (const link of links.listFeishuLinks(localTask.id)) {
          if (link.checkpointIndex < 0) continue;
          const timestamp = completedAt(childrenByGuid.get(link.taskGuid));
          if (!timestamp || localTask.checkpoints?.[link.checkpointIndex]?.completed) continue;
          completedCheckpoints.push({ localTaskId: localTask.id, checkpointIndex: link.checkpointIndex, completedAt: timestamp });
        }
      }
      return { date, completedTasks, completedCheckpoints };
    },
  };

  async function ensureRemote({ localTask, checkpointIndex, parentGuid, fields }) {
    const snapshotHash = hash(fields);
    const existing = links.findFeishuLink(localTask.id, checkpointIndex);
    if (!existing) {
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

function managedFields(summary, description, startAt, dueAt) {
  return {
    summary,
    description: description || "",
    ...(startAt ? { startAt } : {}),
    ...(dueAt ? { dueAt } : {}),
  };
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extractGuid(response) {
  return response?.data?.task?.guid || response?.data?.guid || response?.task?.guid || "";
}

function completedAt(task) {
  const timestamp = Number(task?.completed_at);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}
