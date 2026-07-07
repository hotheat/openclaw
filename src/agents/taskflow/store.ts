import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../../infra/file-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createTaskFlowId, createTaskFlowItemId } from "./ids.js";
import { renderTaskFlowMarkdown } from "./markdown.js";
import { resolveTaskFlowPaths } from "./paths.js";
import { TASK_FLOW_ITEM_STATUSES } from "./types.js";
import type {
  TaskFlow,
  TaskFlowAccess,
  TaskFlowError,
  TaskFlowEvidence,
  TaskFlowEvidenceInput,
  TaskFlowForegroundConflict,
  TaskFlowItem,
  TaskFlowItemInput,
  TaskFlowItemStatus,
  TaskFlowPermission,
  TaskFlowReadResult,
  TaskFlowRevisionConflict,
  TaskFlowScope,
  TaskFlowSubscriber,
  TaskFlowSubscriberInput,
  TaskFlowWarning,
  TaskFlowWriteResult,
  TaskFlowWriteSuccess,
} from "./types.js";

const log = createSubsystemLogger("agents/taskflow");

const LOCK_OPTIONS = {
  stale: 30_000,
  retries: {
    retries: 60,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 250,
  },
} as const;

type TaskFlowIndexEntry = {
  taskFlowId: string;
  ownerAgentId: string;
  ownerSessionKey: string;
  status: TaskFlow["status"];
  scope: TaskFlowScope;
  snapshotPath: string;
  updatedAt: string;
};

type TaskFlowIndex = {
  version: 1;
  taskFlows: Record<string, TaskFlowIndexEntry>;
};

type TaskFlowAuditEvent = {
  taskFlowId: string;
  revision: number;
  operation: string;
  changedItemIds: string[];
  actorSessionKey?: string;
  createdAt: string;
};

type AppendEvent = (eventPath: string, event: TaskFlowAuditEvent) => Promise<void>;

export const TASK_FLOW_APPLY_OPERATIONS = [
  "upsert_items",
  "set_item_status",
  "attach_evidence",
  "set_active_item",
  "subscribe_channel",
  "park_taskflow",
  "resume_taskflow",
  "revoke_access",
  "complete_taskflow",
  "cancel_taskflow",
] as const;

export type TaskFlowApplyOperation = (typeof TASK_FLOW_APPLY_OPERATIONS)[number];

const TASK_FLOW_APPLY_OPERATION_SET = new Set<string>(TASK_FLOW_APPLY_OPERATIONS);
const TASK_FLOW_ITEM_STATUS_SET = new Set<string>(TASK_FLOW_ITEM_STATUSES);

export type CreateTaskFlowParams = {
  agentId: string;
  ownerSessionKey: string;
  title: string;
  scope?: TaskFlowScope;
  items?: TaskFlowItemInput[];
  subscribers?: TaskFlowSubscriberInput[];
  permissions?: Array<{
    sessionKey: string;
    access: TaskFlowAccess;
    grantedBySessionKey: string;
    expiresAt?: string;
  }>;
};

export type ApplyTaskFlowOperationParams = {
  agentId: string;
  sessionKey: string;
  taskFlowId?: string;
  expectedRevision?: number;
  operation: TaskFlowApplyOperation;
  items?: TaskFlowItemInput[];
  itemId?: string;
  status?: TaskFlowItemStatus;
  evidence?: TaskFlowEvidenceInput;
  subscriber?: TaskFlowSubscriberInput;
  reason?: string;
  targetSessionKey?: string;
};

export type ReadTaskFlowParams = {
  agentId: string;
  sessionKey: string;
  taskFlowId?: string;
};

export type GrantTaskFlowAccessParams = {
  agentId: string;
  sessionKey: string;
  taskFlowId: string;
  targetSessionKey: string;
  access: TaskFlowAccess;
  expiresAt?: string;
};

export type RevokeTaskFlowAccessForSessionParams = {
  taskFlowId?: string;
  targetSessionKey: string;
  requesterSessionKey?: string;
  revokeReason: NonNullable<TaskFlowPermission["revokedReason"]>;
};

export type RevokeTaskFlowAccessForSessionResult =
  | {
      status: "success";
      revokedTaskFlowIds: string[];
    }
  | TaskFlowError;

export type TaskFlowCommitEvent = {
  snapshot: TaskFlow;
  operation: string;
  changedItems: string[];
  warnings: TaskFlowWarning[];
  markdown: string;
  actorSessionKey?: string;
};

export type TaskFlowStoreOptions = {
  agentDir: string;
  stateDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  itemIdFactory?: () => string;
  appendEvent?: AppendEvent;
  /**
   * Invoked once after every successfully committed revision (create / update /
   * grant / revoke / park). Wire this to dispatch downstream hooks so that every
   * revision emits exactly once regardless of the calling path — including the
   * auto-park, shared-grant, and revoke paths that previously bypassed the hook.
   * Errors thrown by the callback are swallowed so a failing consumer cannot
   * roll back a write that already landed on disk.
   */
  onCommitted?: (event: TaskFlowCommitEvent) => Promise<void> | void;
};

function emptyIndex(): TaskFlowIndex {
  return { version: 1, taskFlows: {} };
}

function isForeground(status: TaskFlow["status"]): boolean {
  return status === "active" || status === "blocked";
}

function isTerminalItemStatus(status: TaskFlowItemStatus): boolean {
  return status === "completed" || status === "canceled";
}

function shouldAutoCompleteTaskFlow(taskFlow: TaskFlow): boolean {
  return (
    isForeground(taskFlow.status) &&
    taskFlow.items.length > 0 &&
    taskFlow.items.every((item) => isTerminalItemStatus(item.status))
  );
}

function resolveAutoCompletedTaskFlowStatus(taskFlow: TaskFlow): TaskFlow["status"] {
  return taskFlow.items.some((item) => item.status === "completed") ? "completed" : "canceled";
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  await fs.rename(tempPath, filePath);
}

function makeError(code: TaskFlowError["code"], message: string): TaskFlowError {
  return { status: "error", code, message };
}

function isTaskFlowApplyOperation(value: unknown): value is TaskFlowApplyOperation {
  return typeof value === "string" && TASK_FLOW_APPLY_OPERATION_SET.has(value);
}

function isTaskFlowItemStatus(value: unknown): value is TaskFlowItemStatus {
  return typeof value === "string" && TASK_FLOW_ITEM_STATUS_SET.has(value);
}

function makeForegroundConflict(entry: TaskFlowIndexEntry): TaskFlowForegroundConflict {
  return {
    status: "conflict",
    code: "foreground_conflict",
    taskFlowId: entry.taskFlowId,
    ownerSessionKey: entry.ownerSessionKey,
    message: "Owner session already has a foreground TaskFlow. Park, complete, or cancel it first.",
  };
}

function makeRevisionConflict(params: {
  taskFlow: TaskFlow;
  expectedRevision: number;
  affectedItemIds: string[];
}): TaskFlowRevisionConflict {
  return {
    status: "conflict",
    code: "revision_conflict",
    taskFlowId: params.taskFlow.id,
    expectedRevision: params.expectedRevision,
    actualRevision: params.taskFlow.revision,
    affectedItemIds: params.affectedItemIds,
    message:
      "TaskFlow changed since expectedRevision. Call taskflow_read, merge your intended change, then retry with the latest revision.",
  };
}

function normalizeEvidence(input: TaskFlowEvidenceInput): TaskFlowEvidence {
  return {
    kind: input.kind?.trim() || "note",
    value: input.value.trim(),
    metadata: input.metadata,
  };
}

function normalizeItem(
  input: TaskFlowItemInput,
  idFactory: () => string,
  nowIso: string,
): TaskFlowItem {
  return {
    id: input.id?.trim() || idFactory(),
    title: input.title.trim(),
    status: input.status ?? "pending",
    parentId: input.parentId?.trim() || undefined,
    assigneeAgentId: input.assigneeAgentId?.trim() || undefined,
    sourceSessionKey: input.sourceSessionKey?.trim() || undefined,
    evidence: input.evidence?.map(normalizeEvidence),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function validateItemInputs(items: TaskFlowItemInput[] | undefined): TaskFlowError | undefined {
  const invalid = items?.find(
    (item) => item.status !== undefined && !isTaskFlowItemStatus(item.status),
  );
  if (!invalid) {
    return undefined;
  }
  return makeError("invalid_operation", `unsupported item status: ${String(invalid.status)}`);
}

function normalizeSubscriber(input: TaskFlowSubscriberInput, nowIso: string): TaskFlowSubscriber {
  return {
    channel: input.channel.trim(),
    accountId: input.accountId?.trim() || undefined,
    to: input.to?.trim() || undefined,
    chatId: input.chatId?.trim() || undefined,
    threadId: input.threadId,
    replyToMessageId: input.replyToMessageId,
    createdAt: nowIso,
    metadata: input.metadata,
  };
}

function normalizePermission(
  input: NonNullable<CreateTaskFlowParams["permissions"]>[number],
  nowIso: string,
): TaskFlowPermission {
  return {
    sessionKey: input.sessionKey,
    access: input.access,
    grantedBySessionKey: input.grantedBySessionKey,
    grantedAt: nowIso,
    expiresAt: input.expiresAt,
  };
}

function toIndexEntry(taskFlow: TaskFlow, snapshotPath: string): TaskFlowIndexEntry {
  return {
    taskFlowId: taskFlow.id,
    ownerAgentId: taskFlow.agentId,
    ownerSessionKey: taskFlow.ownerSessionKey,
    status: taskFlow.status,
    scope: taskFlow.scope,
    snapshotPath,
    updatedAt: taskFlow.updatedAt,
  };
}

function findForegroundEntry(
  index: TaskFlowIndex,
  ownerSessionKey: string,
): TaskFlowIndexEntry | null {
  return (
    Object.values(index.taskFlows).find(
      (entry) => entry.ownerSessionKey === ownerSessionKey && isForeground(entry.status),
    ) ?? null
  );
}

function resolveLiveAccess(
  taskFlow: TaskFlow,
  sessionKey: string,
): "owner" | TaskFlowAccess | null {
  if (taskFlow.ownerSessionKey === sessionKey) {
    return "owner";
  }
  const nowMs = Date.now();
  const permission = taskFlow.permissions.find((entry) => {
    if (entry.sessionKey !== sessionKey || entry.revokedAt) {
      return false;
    }
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) {
      return false;
    }
    return true;
  });
  return permission?.access ?? null;
}

function hasLivePermission(
  taskFlow: TaskFlow,
  sessionKey: string,
  required: "read" | "write",
): boolean {
  const access = resolveLiveAccess(taskFlow, sessionKey);
  if (access === "owner") {
    return true;
  }
  if (!access) {
    return false;
  }
  if (required === "read") {
    return true;
  }
  return access === "write_all" || access === "write_assigned";
}

function collectAssignedWritableItemIds(taskFlow: TaskFlow, agentId: string): Set<string> {
  const writable = new Set(
    taskFlow.items.filter((item) => item.assigneeAgentId === agentId).map((item) => item.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of taskFlow.items) {
      if (item.parentId && writable.has(item.parentId) && !writable.has(item.id)) {
        writable.add(item.id);
        changed = true;
      }
    }
  }
  return writable;
}

function canWriteWithAssignedAccess(params: {
  taskFlow: TaskFlow;
  operation: ApplyTaskFlowOperationParams;
  agentId: string;
}): boolean {
  const writable = collectAssignedWritableItemIds(params.taskFlow, params.agentId);
  switch (params.operation.operation) {
    case "set_item_status":
    case "attach_evidence":
    case "set_active_item":
      return Boolean(params.operation.itemId && writable.has(params.operation.itemId));
    case "upsert_items":
      return (
        params.operation.items?.every((input) => {
          if (input.id && writable.has(input.id)) {
            return true;
          }
          return Boolean(input.parentId && writable.has(input.parentId));
        }) ?? false
      );
    default:
      return false;
  }
}

function hasWriteAccess(params: {
  taskFlow: TaskFlow;
  sessionKey: string;
  agentId: string;
  operation: ApplyTaskFlowOperationParams;
}): boolean {
  if (params.operation.operation === "revoke_access") {
    // ACL changes are control-plane: only the owner or the permission's
    // original grantor may revoke; write_all data access does not imply it
    // (ADR 0001 D5).
    return isGrantor(
      params.taskFlow,
      params.sessionKey,
      params.operation.targetSessionKey?.trim() ?? "",
    );
  }
  const access = resolveLiveAccess(params.taskFlow, params.sessionKey);
  if (access === "owner" || access === "write_all") {
    return true;
  }
  if (access !== "write_assigned") {
    return false;
  }
  return canWriteWithAssignedAccess({
    taskFlow: params.taskFlow,
    operation: params.operation,
    agentId: params.agentId,
  });
}

function isGrantor(taskFlow: TaskFlow, sessionKey: string, targetSessionKey: string): boolean {
  if (taskFlow.ownerSessionKey === sessionKey) {
    return true;
  }
  return taskFlow.permissions.some((permission) => {
    if (permission.sessionKey !== targetSessionKey || permission.revokedAt) {
      return false;
    }
    if (permission.expiresAt && Date.parse(permission.expiresAt) <= Date.now()) {
      return false;
    }
    return permission.grantedBySessionKey === sessionKey;
  });
}

async function defaultAppendEvent(eventPath: string, event: TaskFlowAuditEvent): Promise<void> {
  await fs.mkdir(path.dirname(eventPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
}

function addAuditEventGap(
  taskFlow: TaskFlow,
  fromRevision: number,
  toRevision: number,
  detectedAt: string,
) {
  const existingGaps = taskFlow.metadata?.auditEventGaps ?? [];
  taskFlow.metadata = {
    ...taskFlow.metadata,
    auditEventGaps: [...existingGaps, { fromRevision, toRevision, detectedAt }],
  };
}

function buildSuccess(
  taskFlow: TaskFlow,
  changedItems: string[],
  warnings: TaskFlowWarning[],
): TaskFlowWriteSuccess {
  return {
    status: "success",
    taskFlowId: taskFlow.id,
    revision: taskFlow.revision,
    snapshot: taskFlow,
    markdown: renderTaskFlowMarkdown(taskFlow),
    changedItems,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function applyOperationToSnapshot(params: {
  taskFlow: TaskFlow;
  operation: ApplyTaskFlowOperationParams;
  nowIso: string;
  itemIdFactory: () => string;
}): { changedItems: string[]; error?: TaskFlowError } {
  const { taskFlow, operation, nowIso, itemIdFactory } = params;
  const changedItems: string[] = [];

  if (!isTaskFlowApplyOperation(operation.operation)) {
    return {
      changedItems,
      error: makeError(
        "invalid_operation",
        `unsupported operation: ${String(operation.operation)}`,
      ),
    };
  }

  switch (operation.operation) {
    case "upsert_items": {
      if (!operation.items?.length) {
        return { changedItems, error: makeError("invalid_operation", "items required") };
      }
      const itemInputError = validateItemInputs(operation.items);
      if (itemInputError) {
        return { changedItems, error: itemInputError };
      }
      for (const input of operation.items) {
        const id = input.id?.trim();
        const existing = id ? taskFlow.items.find((item) => item.id === id) : undefined;
        if (existing) {
          existing.title = input.title.trim();
          existing.status = input.status ?? existing.status;
          existing.parentId = input.parentId?.trim() || existing.parentId;
          existing.assigneeAgentId = input.assigneeAgentId?.trim() || existing.assigneeAgentId;
          existing.sourceSessionKey = input.sourceSessionKey?.trim() || existing.sourceSessionKey;
          if (input.evidence) {
            existing.evidence = input.evidence.map(normalizeEvidence);
          }
          existing.updatedAt = nowIso;
          changedItems.push(existing.id);
        } else {
          const item = normalizeItem(input, itemIdFactory, nowIso);
          taskFlow.items.push(item);
          changedItems.push(item.id);
        }
      }
      break;
    }
    case "set_item_status": {
      const item = taskFlow.items.find((entry) => entry.id === operation.itemId);
      if (!item || !operation.status) {
        return {
          changedItems,
          error: makeError("invalid_operation", "itemId and status required"),
        };
      }
      if (!isTaskFlowItemStatus(operation.status)) {
        return {
          changedItems,
          error: makeError(
            "invalid_operation",
            `unsupported item status: ${String(operation.status)}`,
          ),
        };
      }
      item.status = operation.status;
      item.updatedAt = nowIso;
      changedItems.push(item.id);
      break;
    }
    case "attach_evidence": {
      const item = taskFlow.items.find((entry) => entry.id === operation.itemId);
      if (!item || !operation.evidence) {
        return {
          changedItems,
          error: makeError("invalid_operation", "itemId and evidence required"),
        };
      }
      item.evidence = [...(item.evidence ?? []), normalizeEvidence(operation.evidence)];
      item.updatedAt = nowIso;
      changedItems.push(item.id);
      break;
    }
    case "set_active_item": {
      if (!operation.itemId || !taskFlow.items.some((item) => item.id === operation.itemId)) {
        return { changedItems, error: makeError("invalid_operation", "known itemId required") };
      }
      taskFlow.activeItemId = operation.itemId;
      changedItems.push(operation.itemId);
      break;
    }
    case "subscribe_channel": {
      if (!operation.subscriber) {
        return { changedItems, error: makeError("invalid_operation", "subscriber required") };
      }
      taskFlow.subscribers.push(normalizeSubscriber(operation.subscriber, nowIso));
      break;
    }
    case "park_taskflow": {
      if (!isForeground(taskFlow.status)) {
        return {
          changedItems,
          error: makeError("invalid_operation", "foreground TaskFlow required"),
        };
      }
      taskFlow.status = "parked";
      taskFlow.parkedAt = nowIso;
      taskFlow.parkedReason = operation.reason?.trim() || undefined;
      break;
    }
    case "resume_taskflow": {
      if (taskFlow.status !== "parked") {
        return { changedItems, error: makeError("invalid_operation", "parked TaskFlow required") };
      }
      taskFlow.status = "active";
      taskFlow.parkedAt = undefined;
      taskFlow.parkedReason = undefined;
      break;
    }
    case "revoke_access": {
      const permission = taskFlow.permissions.find(
        (entry) => entry.sessionKey === operation.targetSessionKey && !entry.revokedAt,
      );
      if (!permission) {
        return {
          changedItems,
          error: makeError("invalid_operation", "active permission required"),
        };
      }
      permission.revokedAt = nowIso;
      // The apply-op path is the manual override (ADR 0001 D5); lifecycle
      // reasons are only written by revokeAccessForSession.
      permission.revokedReason = "manual";
      break;
    }
    case "complete_taskflow": {
      taskFlow.status = "completed";
      taskFlow.completedAt = nowIso;
      break;
    }
    case "cancel_taskflow": {
      taskFlow.status = "canceled";
      taskFlow.completedAt = nowIso;
      break;
    }
    default: {
      return {
        changedItems,
        error: makeError(
          "invalid_operation",
          `unsupported operation: ${String(operation.operation)}`,
        ),
      };
    }
  }

  if (shouldAutoCompleteTaskFlow(taskFlow)) {
    taskFlow.status = resolveAutoCompletedTaskFlowStatus(taskFlow);
    taskFlow.completedAt = nowIso;
  }

  taskFlow.revision += 1;
  taskFlow.updatedAt = nowIso;
  return { changedItems };
}

export function createTaskFlowStore(options: TaskFlowStoreOptions) {
  const paths = resolveTaskFlowPaths(options);
  const now = () => (options.now ? options.now() : new Date());
  const nowIso = () => now().toISOString();
  const taskFlowIdFactory = options.idFactory ?? createTaskFlowId;
  const itemIdFactory = options.itemIdFactory ?? createTaskFlowItemId;
  const appendEvent = options.appendEvent ?? defaultAppendEvent;

  async function readIndex(indexPath: string): Promise<TaskFlowIndex> {
    return await readJsonFile(indexPath, emptyIndex());
  }

  async function readLocalIndex(): Promise<TaskFlowIndex> {
    return await readIndex(paths.localIndexPath);
  }

  async function writeIndex(indexPath: string, index: TaskFlowIndex): Promise<void> {
    await writeJsonFileAtomic(indexPath, index);
  }

  function localIndexPathForSnapshot(snapshotPath: string): string {
    return path.join(path.dirname(snapshotPath), "index.json");
  }

  function eventLogPathForSnapshot(snapshotPath: string, taskFlowId: string): string {
    return path.join(path.dirname(snapshotPath), "events", `${taskFlowId}.jsonl`);
  }

  async function readGlobalIndex(): Promise<TaskFlowIndex> {
    return await readJsonFile(paths.globalIndexPath, emptyIndex());
  }

  async function upsertLocalIndexEntry(params: {
    indexPath: string;
    taskFlow: TaskFlow;
    snapshotPath: string;
  }): Promise<void> {
    await withFileLock(params.indexPath, LOCK_OPTIONS, async () => {
      const index = await readIndex(params.indexPath);
      index.taskFlows[params.taskFlow.id] = toIndexEntry(params.taskFlow, params.snapshotPath);
      await writeIndex(params.indexPath, index);
    });
  }

  async function updateGlobalIndex(taskFlow: TaskFlow, snapshotPath: string): Promise<void> {
    await withFileLock(paths.globalIndexPath, LOCK_OPTIONS, async () => {
      const index = await readGlobalIndex();
      index.taskFlows[taskFlow.id] = toIndexEntry(taskFlow, snapshotPath);
      await writeJsonFileAtomic(paths.globalIndexPath, index);
    });
  }

  async function readSnapshot(snapshotPath: string): Promise<TaskFlowReadResult> {
    try {
      const snapshot = await readJsonFile<TaskFlow | null>(snapshotPath, null);
      if (!snapshot?.id || !Array.isArray(snapshot.items)) {
        return makeError("corrupt_snapshot", `TaskFlow snapshot is corrupt: ${snapshotPath}`);
      }
      return {
        status: "success",
        taskFlowId: snapshot.id,
        revision: snapshot.revision,
        snapshot,
        markdown: renderTaskFlowMarkdown(snapshot),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return makeError("not_found", "TaskFlow not found");
      }
      return makeError("corrupt_snapshot", err instanceof Error ? err.message : String(err));
    }
  }

  async function commitTaskFlow(params: {
    taskFlow: TaskFlow;
    snapshotPath: string;
    localIndexPath: string;
    changedItems: string[];
    operation: string;
    actorSessionKey?: string;
  }): Promise<TaskFlowWriteSuccess> {
    const { taskFlow, snapshotPath, localIndexPath, changedItems, operation, actorSessionKey } =
      params;
    const warnings: TaskFlowWarning[] = [];

    await writeJsonFileAtomic(snapshotPath, taskFlow);
    await upsertLocalIndexEntry({ indexPath: localIndexPath, taskFlow, snapshotPath });
    await updateGlobalIndex(taskFlow, snapshotPath);

    try {
      await appendEvent(eventLogPathForSnapshot(snapshotPath, taskFlow.id), {
        taskFlowId: taskFlow.id,
        revision: taskFlow.revision,
        operation,
        changedItemIds: changedItems,
        actorSessionKey,
        createdAt: taskFlow.updatedAt,
      });
    } catch (err) {
      warnings.push("audit_event_append_failed");
      addAuditEventGap(taskFlow, taskFlow.revision, taskFlow.revision, nowIso());
      await writeJsonFileAtomic(snapshotPath, taskFlow);
      log.warn(
        `failed to append TaskFlow audit event for ${taskFlow.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const result = buildSuccess(taskFlow, changedItems, warnings);
    if (options.onCommitted) {
      try {
        await options.onCommitted({
          snapshot: taskFlow,
          operation,
          changedItems,
          warnings,
          markdown: result.markdown,
          actorSessionKey,
        });
      } catch (err) {
        log.warn(
          `TaskFlow onCommitted hook failed for ${taskFlow.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return result;
  }

  async function createTaskFlow(params: CreateTaskFlowParams): Promise<TaskFlowWriteResult> {
    return await withFileLock(paths.localIndexPath, LOCK_OPTIONS, async () => {
      const localIndex = await readLocalIndex();
      const foreground = findForegroundEntry(localIndex, params.ownerSessionKey);
      if (foreground) {
        return makeForegroundConflict(foreground);
      }

      const scope = params.scope ?? "local";
      if (scope !== "shared" && (params.permissions ?? []).length > 0) {
        return makeError("invalid_operation", "permissions can only be seeded on shared TaskFlows");
      }
      const createdAt = nowIso();
      const taskFlowId = taskFlowIdFactory();
      const taskFlow: TaskFlow = {
        id: taskFlowId,
        scope,
        agentId: params.agentId,
        ownerSessionKey: params.ownerSessionKey,
        title: params.title.trim(),
        status: "active",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        items: (params.items ?? []).map((item) => normalizeItem(item, itemIdFactory, createdAt)),
        subscribers: (params.subscribers ?? []).map((subscriber) =>
          normalizeSubscriber(subscriber, createdAt),
        ),
        permissions: (params.permissions ?? []).map((permission) =>
          normalizePermission(permission, createdAt),
        ),
      };

      return await commitTaskFlow({
        taskFlow,
        snapshotPath: paths.snapshotPath(taskFlow.id),
        localIndexPath: paths.localIndexPath,
        changedItems: taskFlow.items.map((item) => item.id),
        operation: "create",
        actorSessionKey: params.ownerSessionKey,
      });
    });
  }

  async function locateTaskFlow(
    params: ReadTaskFlowParams,
  ): Promise<TaskFlowIndexEntry | TaskFlowError> {
    if (params.taskFlowId) {
      const globalIndex = await readGlobalIndex();
      const entry = globalIndex.taskFlows[params.taskFlowId];
      return entry ?? makeError("not_found", "TaskFlow not found");
    }

    const localIndex = await readLocalIndex();
    const foreground = findForegroundEntry(localIndex, params.sessionKey);
    return foreground ?? makeError("not_found", "No foreground TaskFlow for this session");
  }

  async function readTaskFlow(params: ReadTaskFlowParams): Promise<TaskFlowReadResult> {
    const located = await locateTaskFlow(params);
    if (located.status === "error") {
      return located;
    }
    const read = await readSnapshot(located.snapshotPath);
    if (read.status !== "success") {
      return read;
    }
    if (!hasLivePermission(read.snapshot, params.sessionKey, "read")) {
      return makeError("forbidden", "TaskFlow access denied");
    }
    return read;
  }

  async function applyTaskFlowOperation(
    params: ApplyTaskFlowOperationParams,
  ): Promise<TaskFlowWriteResult> {
    if (!isTaskFlowApplyOperation(params.operation)) {
      return makeError("invalid_operation", `unsupported operation: ${String(params.operation)}`);
    }
    if (
      params.operation === "set_item_status" &&
      params.status !== undefined &&
      !isTaskFlowItemStatus(params.status)
    ) {
      return makeError("invalid_operation", `unsupported item status: ${String(params.status)}`);
    }
    const itemInputError = validateItemInputs(params.items);
    if (itemInputError) {
      return itemInputError;
    }

    const readParams = {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      taskFlowId: params.taskFlowId,
    };
    const located = await locateTaskFlow(readParams);
    if (located.status === "error") {
      return located;
    }
    return await withFileLock(located.snapshotPath, LOCK_OPTIONS, async () => {
      const read = await readSnapshot(located.snapshotPath);
      if (read.status !== "success") {
        return read;
      }
      const taskFlow = read.snapshot;
      if (
        !hasWriteAccess({
          taskFlow,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          operation: params,
        })
      ) {
        return makeError("forbidden", "TaskFlow access denied");
      }
      const affectedItemIds = params.itemId
        ? [params.itemId]
        : (params.items?.flatMap((item) => item.id ?? []) ?? []);
      if (params.expectedRevision !== undefined && params.expectedRevision !== taskFlow.revision) {
        return makeRevisionConflict({
          taskFlow,
          expectedRevision: params.expectedRevision,
          affectedItemIds,
        });
      }

      const localIndexPath = localIndexPathForSnapshot(located.snapshotPath);

      const applyAndCommit = async () => {
        if (params.operation === "resume_taskflow") {
          const localIndex = await readIndex(localIndexPath);
          const foreground = findForegroundEntry(localIndex, taskFlow.ownerSessionKey);
          if (foreground && foreground.taskFlowId !== taskFlow.id) {
            return makeForegroundConflict(foreground);
          }
        }

        const applied = applyOperationToSnapshot({
          taskFlow,
          operation: params,
          nowIso: nowIso(),
          itemIdFactory,
        });
        if (applied.error) {
          return applied.error;
        }

        return await commitTaskFlow({
          taskFlow,
          snapshotPath: located.snapshotPath,
          localIndexPath,
          changedItems: applied.changedItems,
          operation: params.operation,
          actorSessionKey: params.sessionKey,
        });
      };

      if (params.operation === "resume_taskflow") {
        return await withFileLock(localIndexPath, LOCK_OPTIONS, applyAndCommit);
      }
      return await applyAndCommit();
    });
  }

  async function grantAccess(params: GrantTaskFlowAccessParams): Promise<TaskFlowWriteResult> {
    const located = await locateTaskFlow({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      taskFlowId: params.taskFlowId,
    });
    if (located.status === "error") {
      return located;
    }
    return await withFileLock(located.snapshotPath, LOCK_OPTIONS, async () => {
      const read = await readSnapshot(located.snapshotPath);
      if (read.status !== "success") {
        return read;
      }
      const taskFlow = read.snapshot;
      if (!isGrantor(taskFlow, params.sessionKey, params.targetSessionKey)) {
        return makeError("forbidden", "TaskFlow access denied");
      }
      if (taskFlow.scope !== "shared") {
        return makeError(
          "invalid_operation",
          "Only shared TaskFlows can be granted to other sessions",
        );
      }
      const updatedAt = nowIso();
      const existing = taskFlow.permissions.find(
        (permission) => permission.sessionKey === params.targetSessionKey && !permission.revokedAt,
      );
      if (existing) {
        existing.access = params.access;
        existing.expiresAt = params.expiresAt;
      } else {
        taskFlow.permissions.push({
          sessionKey: params.targetSessionKey,
          access: params.access,
          grantedBySessionKey: params.sessionKey,
          grantedAt: updatedAt,
          expiresAt: params.expiresAt,
        });
      }
      taskFlow.revision += 1;
      taskFlow.updatedAt = updatedAt;
      return await commitTaskFlow({
        taskFlow,
        snapshotPath: located.snapshotPath,
        localIndexPath: localIndexPathForSnapshot(located.snapshotPath),
        changedItems: [],
        operation: "grant_access",
        actorSessionKey: params.sessionKey,
      });
    });
  }

  async function revokeAccessForSession(
    params: RevokeTaskFlowAccessForSessionParams,
  ): Promise<RevokeTaskFlowAccessForSessionResult> {
    const targetSessionKey = params.targetSessionKey.trim();
    if (!targetSessionKey) {
      return makeError("invalid_operation", "targetSessionKey required");
    }

    const globalIndex = await readGlobalIndex();
    const entries = Object.values(globalIndex.taskFlows).filter(
      (entry) => !params.taskFlowId || entry.taskFlowId === params.taskFlowId,
    );
    const revokedTaskFlowIds: string[] = [];

    for (const entry of entries) {
      await withFileLock(entry.snapshotPath, LOCK_OPTIONS, async () => {
        const read = await readSnapshot(entry.snapshotPath);
        if (read.status !== "success") {
          return;
        }
        const taskFlow = read.snapshot;
        const permission = taskFlow.permissions.find(
          (candidate) => candidate.sessionKey === targetSessionKey && !candidate.revokedAt,
        );
        if (!permission) {
          return;
        }

        const updatedAt = nowIso();
        permission.revokedAt = updatedAt;
        permission.revokedReason = params.revokeReason;
        taskFlow.revision += 1;
        taskFlow.updatedAt = updatedAt;
        const committed = await commitTaskFlow({
          taskFlow,
          snapshotPath: entry.snapshotPath,
          localIndexPath: localIndexPathForSnapshot(entry.snapshotPath),
          changedItems: [],
          operation: "revoke_access",
          actorSessionKey: params.requesterSessionKey,
        });
        if (committed.status === "success") {
          revokedTaskFlowIds.push(taskFlow.id);
        }
      });
    }

    return { status: "success", revokedTaskFlowIds };
  }

  async function listForegroundTaskFlows(ownerSessionKey: string): Promise<TaskFlow[]> {
    const localIndex = await readLocalIndex();
    const entries = Object.values(localIndex.taskFlows).filter(
      (entry) => entry.ownerSessionKey === ownerSessionKey && isForeground(entry.status),
    );
    const snapshots: TaskFlow[] = [];
    for (const entry of entries) {
      const read = await readSnapshot(entry.snapshotPath);
      if (read.status === "success") {
        snapshots.push(read.snapshot);
      }
    }
    return snapshots;
  }

  async function listParkedTaskFlows(ownerSessionKey: string): Promise<TaskFlow[]> {
    const localIndex = await readLocalIndex();
    const entries = Object.values(localIndex.taskFlows).filter(
      (entry) => entry.ownerSessionKey === ownerSessionKey && entry.status === "parked",
    );
    const snapshots: TaskFlow[] = [];
    for (const entry of entries) {
      const read = await readSnapshot(entry.snapshotPath);
      if (read.status === "success") {
        snapshots.push(read.snapshot);
      }
    }
    return snapshots;
  }

  return {
    paths: paths,
    createTaskFlow,
    readTaskFlow,
    applyTaskFlowOperation,
    grantAccess,
    revokeAccessForSession,
    listForegroundTaskFlows,
    listParkedTaskFlows,
  };
}
