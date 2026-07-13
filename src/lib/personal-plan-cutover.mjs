import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const FORMAT = "nge-personal-plan-cutover-v1";
const TREE_INDICES = [-1, 0, 1, 2];
const DEFAULT_TARGET_LOCAL_TASK_ID = "wk20260713-personal-ip";

export function parsePersonalPlanCutoverArgs(args) {
  const values = [...args];
  const command = values[0] === "prepare" || values[0] === "apply" ? values.shift() : "prepare";
  const options = { command };
  for (const arg of values) {
    if (arg.startsWith("--manifest=") && arg.length > 11) options.manifestPath = arg.slice(11);
    else if (arg.startsWith("--work-date=") && arg.length > 12) options.workDate = arg.slice(12);
    else if (arg.startsWith("--retained-task-id=") && arg.length > 19) options.retainedLocalTaskId = arg.slice(19);
    else if (arg.startsWith("--obsolete-task-id=") && arg.length > 19) options.obsoleteLocalTaskId = arg.slice(19);
    else if (arg.startsWith("--target-task-id=") && arg.length > 17) options.targetLocalTaskId = arg.slice(17);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (command === "apply") {
    if (!options.manifestPath) throw new Error("cutover apply requires an explicit manifest");
    if (Object.keys(options).some((key) => !["command", "manifestPath"].includes(key))) {
      throw new Error("cutover apply accepts only an explicit manifest");
    }
    return options;
  }
  if (options.manifestPath) throw new Error("cutover prepare does not accept a manifest");
  if (!options.workDate || !options.retainedLocalTaskId || !options.obsoleteLocalTaskId) {
    throw new Error("cutover prepare requires work date and both source task ids");
  }
  if (options.targetLocalTaskId && options.targetLocalTaskId !== DEFAULT_TARGET_LOCAL_TASK_ID) {
    throw new Error("cutover requires the approved consolidated target");
  }
  options.targetLocalTaskId ||= DEFAULT_TARGET_LOCAL_TASK_ID;
  return options;
}

export function isLegacyDuplicateCandidate({ task, sentLegacyGuids, managedGuids, subtasks }) {
  return Boolean(
    task?.guid
    && !task?.parent_guid
    && sentLegacyGuids?.has(task.guid)
    && !managedGuids?.has(task.guid)
    && !isCompleted(task)
    && task?.due?.is_all_day === true
    && Array.isArray(subtasks)
    && subtasks.length === 0,
  );
}

export function classifyPersonalPlanCutover({
  workDate,
  retainedLocalTaskId,
  obsoleteLocalTaskId,
  targetLocalTaskId,
  remoteParents,
  remoteChildrenByParent,
  managedLinks,
  legacyTaskGuids,
}) {
  validateWorkDate(workDate);
  requireDistinctLocalIds(retainedLocalTaskId, obsoleteLocalTaskId, targetLocalTaskId);
  requireApprovedTarget(targetLocalTaskId);
  const parents = Array.isArray(remoteParents) ? remoteParents : [];
  const links = Array.isArray(managedLinks) ? managedLinks : [];
  const sentLegacyGuids = asSet(legacyTaskGuids);
  const managedGuids = new Set(links.map((link) => link.taskGuid));
  const childMap = asChildMap(remoteChildrenByParent);
  const retainedLinks = linksFor(links, retainedLocalTaskId);
  const obsoleteLinks = linksFor(links, obsoleteLocalTaskId);
  const targetLinks = linksFor(links, targetLocalTaskId);

  const legacyParents = parents.filter((task) => isLegacyDuplicateCandidate({
    task,
    sentLegacyGuids,
    managedGuids,
    subtasks: childMap.get(task.guid) || [],
  })).sort(byGuid);

  const completedHistoricalParents = parents.filter(isCompleted).sort(byGuid);
  if (completedHistoricalParents.length !== 5) {
    throw new Error("cutover requires exactly five completed historical parents");
  }

  if (targetLinks.length !== 0) {
    if (retainedLinks.length !== 0 || obsoleteLinks.length !== 0) {
      throw new Error("cutover source links must be empty after apply");
    }
    const targetTree = exactManagedTree({
      label: "target",
      localTaskId: targetLocalTaskId,
      links,
      parents,
      childMap,
    });
    if (legacyParents.length !== 0) {
      throw new Error("completed cutover requires zero legacy duplicate parents");
    }
    return {
      state: "already_applied",
      counts: {
        legacyParents: 0,
        completedHistoricalParents: completedHistoricalParents.length,
        retainedLinks: 0,
        obsoleteLinks: 0,
        targetLinks: targetTree.links.length,
        remoteDeletes: 0,
      },
    };
  }

  if (legacyParents.length !== 5) throw new Error("cutover requires exactly five legacy duplicate parents");

  const retainedTree = exactManagedTree({
    label: "retained",
    localTaskId: retainedLocalTaskId,
    links,
    parents,
    childMap,
  });
  const obsoleteTree = exactManagedTree({
    label: "obsolete",
    localTaskId: obsoleteLocalTaskId,
    links,
    parents,
    childMap,
  });
  const retainedSerialized = serializedTree(retainedTree);
  const obsoleteSerialized = serializedTree(obsoleteTree);

  const legacyEntries = legacyParents.map(remoteEntry);
  const historyEntries = completedHistoricalParents.map(remoteEntry);
  const obsoleteChildren = obsoleteSerialized.children;
  const deletionOrder = [
    ...legacyEntries.map((item) => ({ ...item, kind: "legacy_parent" })),
    ...obsoleteChildren.map((item) => ({ ...item, kind: "obsolete_child" })),
    { ...obsoleteSerialized.parent, kind: "obsolete_parent" },
  ];

  return {
    workDate,
    localIds: { retained: retainedLocalTaskId, obsolete: obsoleteLocalTaskId, target: targetLocalTaskId },
    legacyParents: legacyEntries,
    completedHistoricalParents: historyEntries,
    retainedTree: retainedSerialized,
    obsoleteTree: obsoleteSerialized,
    deletionOrder,
    counts: {
      legacyParents: legacyEntries.length,
      completedHistoricalParents: historyEntries.length,
      retainedLinks: retainedTree.links.length,
      obsoleteLinks: obsoleteTree.links.length,
      remoteDeletes: deletionOrder.length,
    },
  };
}

export async function preparePersonalPlanCutover({
  workDate,
  retainedLocalTaskId,
  obsoleteLocalTaskId,
  targetLocalTaskId,
  manifestDir,
  repo,
  api,
  config,
  now = () => new Date().toISOString(),
}) {
  requirePrepareDependencies({ manifestDir, repo, api });
  requireApprovedTarget(targetLocalTaskId);
  if (!repo.localTaskExists(targetLocalTaskId)) throw new Error("cutover approved target task is missing");
  const snapshot = await readRemoteSnapshot(api, config);
  const classified = classifyPersonalPlanCutover({
    workDate,
    retainedLocalTaskId,
    obsoleteLocalTaskId,
    targetLocalTaskId,
    ...snapshot,
    managedLinks: repo.listAllFeishuLinks(),
    legacyTaskGuids: repo.listSentLegacyTaskGuids(),
  });
  if (classified.state === "already_applied") {
    return { status: "already_applied", verification: "read_only", counts: classified.counts };
  }
  const generatedAt = now();
  const manifest = { format: FORMAT, generatedAt, ...classified };
  await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await fs.chmod(manifestDir, 0o700);
  const stamp = generatedAt.replace(/[^0-9]/g, "").slice(0, 14) || "manifest";
  const manifestPath = path.join(manifestDir, `personal-plan-cutover-${workDate}-${stamp}.json`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.chmod(manifestPath, 0o600);
  return { status: "prepared", counts: classified.counts, manifestPath };
}

export async function applyPersonalPlanCutover({
  manifestPath,
  manifestDir,
  repo,
  api,
  config,
  expectedWorkDate,
}) {
  requireApplyDependencies({ manifestPath, manifestDir, repo, api });
  const manifest = await loadPrivateManifest(manifestPath, manifestDir);
  validateManifest(manifest, expectedWorkDate);
  if (!repo.localTaskExists(manifest.localIds.target)) throw new Error("cutover approved target task is missing");

  const state = localLinkState(repo, manifest);
  if (state === "applied") {
    const snapshot = await readRemoteSnapshot(api, config);
    const verified = classifyPersonalPlanCutover({
      workDate: manifest.workDate,
      retainedLocalTaskId: manifest.localIds.retained,
      obsoleteLocalTaskId: manifest.localIds.obsolete,
      targetLocalTaskId: manifest.localIds.target,
      ...snapshot,
      managedLinks: repo.listAllFeishuLinks(),
      legacyTaskGuids: repo.listSentLegacyTaskGuids(),
    });
    if (verified.state !== "already_applied") throw new Error("cutover completed state is invalid");
    const remoteByGuid = await readManifestStatuses(api, config, manifest);
    revalidateRemoteSnapshot({ manifest, snapshot, remoteByGuid, repo });
    return {
      status: "already_applied",
      counts: { remoteDeleted: 0, alreadyMissing: 9, retainedLinks: 4, removedLinks: 0 },
    };
  }
  if (state !== "initial") throw new Error("cutover link identity changed");

  const snapshot = await readRemoteSnapshot(api, config);
  const remoteByGuid = await readManifestStatuses(api, config, manifest);
  revalidateRemoteSnapshot({ manifest, snapshot, remoteByGuid, repo });
  if (!repo.localTaskExists(manifest.localIds.target)) throw new Error("cutover approved target task is missing");
  let remoteDeleted = 0;
  let alreadyMissing = 0;
  for (const item of manifest.deletionOrder) {
    if (!remoteByGuid.has(item.guid)) {
      alreadyMissing += 1;
      continue;
    }
    try {
      await api.deleteTask(config, item.guid);
      remoteDeleted += 1;
    } catch (error) {
      if (error?.status === 404 && manifest.deletionOrder.some((candidate) => candidate.guid === item.guid)) {
        alreadyMissing += 1;
        continue;
      }
      throw new Error("cutover remote deletion failed", { cause: error });
    }
  }

  const linkResult = repo.applyPersonalPlanLinkCutover({
    retainedLocalTaskId: manifest.localIds.retained,
    obsoleteLocalTaskId: manifest.localIds.obsolete,
    targetLocalTaskId: manifest.localIds.target,
    retainedLinks: manifest.retainedTree.links,
    obsoleteLinks: manifest.obsoleteTree.links,
  });
  return {
    status: linkResult.status === "already_applied" ? "already_applied" : "applied",
    counts: {
      remoteDeleted,
      alreadyMissing,
      retainedLinks: linkResult.retainedLinks,
      removedLinks: linkResult.removedLinks,
    },
  };
}

async function readRemoteSnapshot(api, config) {
  const remoteParents = await api.listTasklistTasks(config);
  const entries = await Promise.all(remoteParents.map(async (parent) => [
    parent.guid,
    await api.listSubtasks(config, parent.guid),
  ]));
  return { remoteParents, remoteChildrenByParent: Object.fromEntries(entries) };
}

function exactManagedTree({ label, localTaskId, links, parents, childMap }) {
  const treeLinks = linksFor(links, localTaskId);
  if (!sameIndices(treeLinks)) throw new Error(`${label} personal IP must be an exact four-link tree`);
  const parentLink = treeLinks[0];
  if (parentLink.parentGuid) throw new Error(`${label} personal IP must be an exact four-link tree`);
  const parent = parents.find((task) => task.guid === parentLink.taskGuid);
  if (!parent || isCompleted(parent)) throw new Error(`${label} personal IP remote parent is invalid`);
  const childLinks = treeLinks.slice(1);
  if (childLinks.some((link) => link.parentGuid !== parentLink.taskGuid)) {
    throw new Error(`${label} personal IP must be an exact four-link tree`);
  }
  const children = childMap.get(parentLink.taskGuid) || [];
  const childGuids = new Set(children.map((task) => task.guid));
  if (children.length !== 3 || childLinks.some((link) => !childGuids.has(link.taskGuid))) {
    throw new Error(`${label} personal IP remote children must exactly match its links`);
  }
  return {
    links: treeLinks.map(linkIdentity),
    parent,
    children: childLinks.map((link) => children.find((task) => task.guid === link.taskGuid)),
  };
}

function serializedTree(tree) {
  return {
    links: tree.links,
    parent: remoteEntry(tree.parent),
    children: tree.children.map((task, checkpointIndex) => ({
      ...remoteEntry(task),
      parentGuid: tree.parent.guid,
      checkpointIndex,
    })),
  };
}

function revalidateRemoteSnapshot({ manifest, snapshot, remoteByGuid, repo }) {
  const parents = snapshot.remoteParents;
  const childMap = asChildMap(snapshot.remoteChildrenByParent);
  const currentHistorical = parents.filter(isCompleted);
  if (currentHistorical.length !== 5) throw new Error("cutover completed history changed");
  for (const item of manifest.completedHistoricalParents) requireSameRemote(item, remoteByGuid, false);
  requireSameRemote(manifest.retainedTree.parent, remoteByGuid, false);
  for (const item of manifest.retainedTree.children) requireSameRemote(item, remoteByGuid, false);
  for (const item of manifest.deletionOrder) requireSameRemote(item, remoteByGuid, true);

  const sentLegacyGuids = new Set(repo.listSentLegacyTaskGuids());
  const managedGuids = new Set(repo.listAllFeishuLinks().map((link) => link.taskGuid));
  const currentCandidates = parents.filter((task) => isLegacyDuplicateCandidate({
    task,
    sentLegacyGuids,
    managedGuids,
    subtasks: childMap.get(task.guid) || [],
  }));
  const manifestLegacy = new Set(manifest.legacyParents.map((item) => item.guid));
  const currentCandidateGuids = new Set(currentCandidates.map((task) => task.guid));
  if (manifest.legacyParents.some((item) => remoteByGuid.has(item.guid) && !currentCandidateGuids.has(item.guid))) {
    throw new Error("cutover legacy candidate changed");
  }
  if (currentCandidates.some((task) => !manifestLegacy.has(task.guid))) {
    throw new Error("cutover candidate set changed");
  }

  const retainedChildren = childMap.get(manifest.retainedTree.parent.guid) || [];
  const retainedExpected = new Set(manifest.retainedTree.children.map((item) => item.guid));
  if (retainedChildren.length !== retainedExpected.size
    || retainedChildren.some((task) => !retainedExpected.has(task.guid))) {
    throw new Error("cutover managed tree children changed");
  }
  const obsoleteChildren = childMap.get(manifest.obsoleteTree.parent.guid) || [];
  const obsoleteExpected = new Set(manifest.obsoleteTree.children.map((item) => item.guid));
  if (obsoleteChildren.some((task) => !obsoleteExpected.has(task.guid))) {
    throw new Error("cutover managed tree children changed");
  }
}

async function readManifestStatuses(api, config, manifest) {
  const expected = [
    ...manifest.completedHistoricalParents,
    manifest.retainedTree.parent,
    ...manifest.retainedTree.children,
    ...manifest.deletionOrder,
  ];
  const remoteByGuid = new Map();
  for (const item of expected) {
    if (remoteByGuid.has(item.guid)) continue;
    try {
      const response = await api.getTask(config, item.guid);
      const task = response?.data?.task || response?.task || response?.data;
      if (!task?.guid) throw new Error("missing task status");
      remoteByGuid.set(item.guid, task);
    } catch (error) {
      if (error?.status === 404) continue;
      throw new Error("cutover remote status check failed", { cause: error });
    }
  }
  return remoteByGuid;
}

function requireSameRemote(expected, remoteByGuid, allowMissing) {
  const current = remoteByGuid.get(expected.guid);
  if (!current) {
    if (allowMissing) return;
    throw new Error("cutover remote candidate changed");
  }
  if (remoteSignature(current) !== expected.signature) throw new Error("cutover remote candidate changed");
}

function localLinkState(repo, manifest) {
  const retained = repo.listFeishuLinks(manifest.localIds.retained);
  const obsolete = repo.listFeishuLinks(manifest.localIds.obsolete);
  const target = repo.listFeishuLinks(manifest.localIds.target);
  if (sameLinks(target, manifest.retainedTree.links) && retained.length === 0 && obsolete.length === 0) return "applied";
  if (sameLinks(retained, manifest.retainedTree.links)
    && sameLinks(obsolete, manifest.obsoleteTree.links)
    && target.length === 0) return "initial";
  return "changed";
}

async function loadPrivateManifest(manifestPath, manifestDir) {
  const base = await fs.realpath(manifestDir);
  const info = await fs.lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("cutover manifest must be a private regular file");
  }
  const actual = await fs.realpath(manifestPath);
  const relative = path.relative(base, actual);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cutover manifest must be inside the private cutover directory");
  }
  return JSON.parse(await fs.readFile(actual, "utf8"));
}

function validateManifest(manifest, expectedWorkDate) {
  if (manifest?.format !== FORMAT) throw new Error("unsupported cutover manifest");
  validateWorkDate(manifest.workDate);
  if (expectedWorkDate && manifest.workDate !== expectedWorkDate) throw new Error("cutover work date changed");
  requireDistinctLocalIds(manifest.localIds?.retained, manifest.localIds?.obsolete, manifest.localIds?.target);
  requireApprovedTarget(manifest.localIds.target);
  if (manifest.legacyParents?.length !== 5
    || manifest.completedHistoricalParents?.length !== 5
    || manifest.retainedTree?.links?.length !== 4
    || manifest.obsoleteTree?.links?.length !== 4
    || manifest.deletionOrder?.length !== 9) {
    throw new Error("cutover manifest counts are invalid");
  }
  if (!sameIndices(manifest.retainedTree.links) || !sameIndices(manifest.obsoleteTree.links)) {
    throw new Error("cutover manifest tree shape is invalid");
  }
  if (!validTreeBinding(manifest.retainedTree, manifest.localIds.retained)
    || !validTreeBinding(manifest.obsoleteTree, manifest.localIds.obsolete)) {
    throw new Error("cutover manifest tree binding is invalid");
  }
  const requiredEntries = [
    ...manifest.legacyParents,
    ...manifest.completedHistoricalParents,
    manifest.retainedTree.parent,
    ...manifest.retainedTree.children,
    manifest.obsoleteTree.parent,
    ...manifest.obsoleteTree.children,
    ...manifest.deletionOrder,
  ];
  const deletionGuids = manifest.deletionOrder.map((item) => item.guid);
  const protectedGuids = new Set([
    manifest.retainedTree.parent.guid,
    ...manifest.retainedTree.children.map((item) => item.guid),
    ...manifest.completedHistoricalParents.map((item) => item.guid),
  ]);
  const retainedGuids = treeGuids(manifest.retainedTree);
  const obsoleteGuids = treeGuids(manifest.obsoleteTree);
  const historyGuids = manifest.completedHistoricalParents.map((item) => item.guid);
  if (requiredEntries.some((item) => !item?.guid || !item?.signature)
    || new Set(deletionGuids).size !== deletionGuids.length
    || deletionGuids.some((guid) => protectedGuids.has(guid))
    || !uniqueAndDisjoint([retainedGuids, obsoleteGuids, historyGuids])) {
    throw new Error("cutover manifest identities are invalid");
  }
  const expectedOrder = [
    ...[...manifest.legacyParents].sort(byGuid).map((item) => ({ ...item, kind: "legacy_parent" })),
    ...manifest.obsoleteTree.children.map((item) => ({ ...item, kind: "obsolete_child" })),
    { ...manifest.obsoleteTree.parent, kind: "obsolete_parent" },
  ];
  if (!manifest.deletionOrder.every((item, index) => samePlainRecord(item, expectedOrder[index]))) {
    throw new Error("cutover manifest deletion sequence is invalid");
  }
}

function remoteEntry(task) {
  return { guid: task.guid, parentGuid: task.parent_guid || null, signature: remoteSignature(task) };
}

function remoteSignature(task) {
  const identity = {
    guid: task?.guid || "",
    parentGuid: task?.parent_guid || "",
    summary: task?.summary || "",
    completedAt: String(task?.completed_at || "0"),
    clientToken: task?.client_token || task?.clientToken || "",
    start: normalizeTime(task?.start),
    due: normalizeTime(task?.due),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function normalizeTime(value) {
  if (!value) return null;
  return { timestamp: String(value.timestamp || ""), isAllDay: value.is_all_day === true };
}

function isCompleted(task) {
  return Number(task?.completed_at || 0) > 0;
}

function linksFor(links, localTaskId) {
  return links.filter((link) => link.localTaskId === localTaskId).sort((a, b) => a.checkpointIndex - b.checkpointIndex);
}

function linkIdentity(link) {
  return {
    localTaskId: link.localTaskId,
    checkpointIndex: link.checkpointIndex,
    taskGuid: link.taskGuid,
    parentGuid: link.parentGuid || null,
    snapshotHash: link.snapshotHash || "",
  };
}

function sameIndices(links) {
  return Array.isArray(links)
    && links.length === TREE_INDICES.length
    && links.every((link, index) => link.checkpointIndex === TREE_INDICES[index]);
}

function sameLinks(actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) return false;
  const sorted = [...actual].sort((a, b) => a.checkpointIndex - b.checkpointIndex);
  return sorted.every((link, index) => {
    const candidate = expected[index];
    return link.checkpointIndex === candidate?.checkpointIndex
      && link.taskGuid === candidate?.taskGuid
      && (link.parentGuid || null) === (candidate?.parentGuid || null)
      && link.snapshotHash === (candidate?.snapshotHash || "");
  });
}

function asSet(value) {
  return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
}

function asChildMap(value) {
  return value instanceof Map ? value : new Map(Object.entries(value || {}));
}

function byGuid(a, b) {
  return String(a.guid).localeCompare(String(b.guid));
}

function validateWorkDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw new Error("cutover requires a valid work date");
}

function requireDistinctLocalIds(...ids) {
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("cutover local task ids must be distinct");
  }
}

function requireApprovedTarget(targetLocalTaskId) {
  if (targetLocalTaskId !== DEFAULT_TARGET_LOCAL_TASK_ID) {
    throw new Error("cutover requires the approved consolidated target");
  }
}

function validTreeBinding(tree, localTaskId) {
  const [parentLink, ...childLinks] = tree.links;
  if (parentLink.localTaskId !== localTaskId
    || parentLink.taskGuid !== tree.parent.guid
    || parentLink.parentGuid
    || tree.parent.parentGuid) return false;
  return tree.children.length === 3 && tree.children.every((child, checkpointIndex) => {
    const link = childLinks[checkpointIndex];
    return child.checkpointIndex === checkpointIndex
      && child.guid === link.taskGuid
      && child.parentGuid === tree.parent.guid
      && link.localTaskId === localTaskId
      && link.checkpointIndex === checkpointIndex
      && link.parentGuid === tree.parent.guid;
  });
}

function treeGuids(tree) {
  return [tree.parent.guid, ...tree.children.map((item) => item.guid)];
}

function uniqueAndDisjoint(groups) {
  const all = groups.flat();
  return groups.every((group) => new Set(group).size === group.length) && new Set(all).size === all.length;
}

function samePlainRecord(actual, expected) {
  if (!actual || !expected) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function requirePrepareDependencies({ manifestDir, repo, api }) {
  if (!manifestDir || !repo?.listAllFeishuLinks || !repo?.listSentLegacyTaskGuids || !repo?.localTaskExists
    || !api?.listTasklistTasks || !api?.listSubtasks) throw new Error("cutover prepare dependencies are incomplete");
}

function requireApplyDependencies({ manifestPath, manifestDir, repo, api }) {
  if (!manifestPath || !manifestDir || !repo?.applyPersonalPlanLinkCutover || !repo?.localTaskExists
    || !api?.listTasklistTasks || !api?.listSubtasks || !api?.getTask || !api?.deleteTask) {
    throw new Error("cutover apply dependencies are incomplete");
  }
}
