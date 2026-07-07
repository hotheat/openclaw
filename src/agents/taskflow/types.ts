export const TASK_FLOW_SCOPES = ["local", "shared"] as const;
export const TASK_FLOW_STATUSES = ["active", "blocked", "parked", "completed", "canceled"] as const;
export const TASK_FLOW_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "canceled",
] as const;
export const TASK_FLOW_ACCESSES = ["read", "write_assigned", "write_all"] as const;

export type TaskFlowScope = (typeof TASK_FLOW_SCOPES)[number];
export type TaskFlowStatus = (typeof TASK_FLOW_STATUSES)[number];
export type TaskFlowItemStatus = (typeof TASK_FLOW_ITEM_STATUSES)[number];
export type TaskFlowAccess = (typeof TASK_FLOW_ACCESSES)[number];

export type TaskFlowEvidence = {
  kind: string;
  value: string;
  metadata?: Record<string, unknown>;
};

export type TaskFlowSubscriber = {
  channel: string;
  accountId?: string;
  to?: string;
  chatId?: string;
  threadId?: string | number;
  replyToMessageId?: string | number;
  createdAt: string;
  lastDeliveredRevision?: number;
  metadata?: Record<string, unknown>;
};

export type TaskFlowPermission = {
  sessionKey: string;
  access: TaskFlowAccess;
  grantedBySessionKey: string;
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedReason?: "subagent_ended" | "manual" | "expired" | "session_deleted";
};

export type TaskFlowItem = {
  id: string;
  title: string;
  status: TaskFlowItemStatus;
  parentId?: string;
  assigneeAgentId?: string;
  sourceSessionKey?: string;
  evidence?: TaskFlowEvidence[];
  createdAt: string;
  updatedAt: string;
};

export type TaskFlow = {
  id: string;
  scope: TaskFlowScope;
  agentId: string;
  ownerSessionKey: string;
  title: string;
  status: TaskFlowStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  parkedAt?: string;
  parkedReason?: string;
  activeItemId?: string;
  items: TaskFlowItem[];
  subscribers: TaskFlowSubscriber[];
  permissions: TaskFlowPermission[];
  metadata?: {
    orphanedAt?: string;
    auditEventGaps?: { fromRevision: number; toRevision: number; detectedAt: string }[];
    [key: string]: unknown;
  };
};

export type TaskFlowItemInput = {
  id?: string;
  title: string;
  status?: TaskFlowItemStatus;
  parentId?: string;
  assigneeAgentId?: string;
  sourceSessionKey?: string;
  evidence?: TaskFlowEvidenceInput[];
};

export type TaskFlowEvidenceInput = {
  kind?: string;
  value: string;
  metadata?: Record<string, unknown>;
};

export type TaskFlowSubscriberInput = {
  channel: string;
  accountId?: string;
  to?: string;
  chatId?: string;
  threadId?: string | number;
  replyToMessageId?: string | number;
  metadata?: Record<string, unknown>;
};

export type TaskFlowPermissionInput = {
  sessionKey: string;
  access: TaskFlowAccess;
  grantedBySessionKey: string;
  expiresAt?: string;
};

export type TaskFlowWarning = "audit_event_append_failed";

export type TaskFlowWriteSuccess = {
  status: "success";
  taskFlowId: string;
  revision: number;
  snapshot: TaskFlow;
  markdown: string;
  changedItems: string[];
  warnings?: TaskFlowWarning[];
};

export type TaskFlowReadSuccess = {
  status: "success";
  taskFlowId: string;
  revision: number;
  snapshot: TaskFlow;
  markdown: string;
};

export type TaskFlowRevisionConflict = {
  status: "conflict";
  code: "revision_conflict";
  taskFlowId: string;
  expectedRevision: number;
  actualRevision: number;
  affectedItemIds: string[];
  message: string;
};

export type TaskFlowForegroundConflict = {
  status: "conflict";
  code: "foreground_conflict";
  taskFlowId: string;
  ownerSessionKey: string;
  message: string;
};

export type TaskFlowError = {
  status: "error";
  code: "not_found" | "forbidden" | "corrupt_snapshot" | "invalid_operation";
  message: string;
};

export type TaskFlowWriteResult =
  | TaskFlowWriteSuccess
  | TaskFlowRevisionConflict
  | TaskFlowForegroundConflict
  | TaskFlowError;

export type TaskFlowReadResult = TaskFlowReadSuccess | TaskFlowError;
