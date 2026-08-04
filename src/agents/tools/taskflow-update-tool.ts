import { Type } from "@sinclair/typebox";
import { DEFAULT_ACCOUNT_ID, parseAgentSessionKey } from "../../routing/session-key.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { dispatchTaskFlowCommitHook } from "../taskflow/store-hook.js";
import {
  createTaskFlowStore,
  TASK_FLOW_APPLY_OPERATIONS,
  type ApplyTaskFlowOperationParams,
  type CreateTaskFlowParams,
} from "../taskflow/store.js";
import { TASK_FLOW_ITEM_STATUSES, TASK_FLOW_SCOPES } from "../taskflow/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, ToolInputError } from "./common.js";
import {
  resolveTaskFlowToolContext,
  type TaskFlowToolContextOptions,
} from "./taskflow-tool-context.js";

const TaskFlowItemInputSchema = Type.Object({
  id: Type.Optional(Type.String()),
  title: Type.String(),
  status: optionalStringEnum(TASK_FLOW_ITEM_STATUSES),
  parentId: Type.Optional(Type.String()),
  assigneeAgentId: Type.Optional(Type.String()),
  sourceSessionKey: Type.Optional(Type.String()),
  evidence: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Optional(Type.String()),
        value: Type.String(),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
    ),
  ),
});

const TaskFlowSubscriberInputSchema = Type.Object({
  channel: Type.String(),
  accountId: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  chatId: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  replyToMessageId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TASK_FLOW_UPDATE_OPERATIONS = ["create", ...TASK_FLOW_APPLY_OPERATIONS] as const;

const TaskFlowUpdateToolSchema = Type.Object({
  operation: stringEnum(TASK_FLOW_UPDATE_OPERATIONS),
  taskFlowId: Type.Optional(Type.String()),
  expectedRevision: Type.Optional(Type.Number()),
  title: Type.Optional(Type.String()),
  scope: Type.Optional(optionalStringEnum(TASK_FLOW_SCOPES)),
  items: Type.Optional(Type.Array(TaskFlowItemInputSchema)),
  itemId: Type.Optional(Type.String()),
  status: optionalStringEnum(TASK_FLOW_ITEM_STATUSES),
  evidence: Type.Optional(
    Type.Object({
      kind: Type.Optional(Type.String()),
      value: Type.String(),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  ),
  subscriber: Type.Optional(TaskFlowSubscriberInputSchema),
  reason: Type.Optional(Type.String()),
  targetSessionKey: Type.Optional(Type.String()),
});

type TaskFlowToolOptions = TaskFlowToolContextOptions & {
  now?: () => Date;
  idFactory?: () => string;
};

const FEISHU_TOPIC_OR_THREAD_SESSION_RE = /:topic:|:thread:/i;

function readItemsParam(params: Record<string, unknown>) {
  const raw = params.items;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("items must be an array");
  }
  return raw as ApplyTaskFlowOperationParams["items"];
}

function isFeishuTopicOrThreadSession(sessionKey: string | undefined): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const parts = parsed?.rest.split(":").filter(Boolean) ?? [];
  return (
    parts.some((part) => part.toLowerCase() === "feishu") &&
    Boolean(parsed && FEISHU_TOPIC_OR_THREAD_SESSION_RE.test(parsed.rest))
  );
}

function isFeishuSubscriberInput(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const channel = (value as { channel?: unknown }).channel;
  return typeof channel === "string" && channel.trim().toLowerCase() === "feishu";
}

function resolveDefaultFeishuSubscriber(
  sessionKey: string | undefined,
): NonNullable<CreateTaskFlowParams["subscribers"]>[number] | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const parts = parsed?.rest.split(":").filter(Boolean) ?? [];
  const feishuIndex = parts.findIndex((part) => part.toLowerCase() === "feishu");
  if (feishuIndex < 0) {
    return undefined;
  }

  // Topic/thread-scoped Feishu sessions cannot yet receive streaming progress
  // cards in-thread (FeishuStreamingSession has no root_id reply support).
  // Auto-subscribing would route the card into the parent chat and breach the
  // topic isolation the user configured, so we decline to auto-subscribe.
  // Explicit subscribe_channel has the same delivery limitation and should not
  // be used for topic sessions until in-thread delivery is implemented.
  if (isFeishuTopicOrThreadSession(sessionKey)) {
    return undefined;
  }

  const afterChannel = parts.slice(feishuIndex + 1);
  let accountId = DEFAULT_ACCOUNT_ID;
  const kindIndex = afterChannel.findIndex((part) => {
    const normalized = part.toLowerCase();
    return normalized === "direct" || normalized === "dm" || normalized === "group";
  });
  if (kindIndex < 0) {
    return undefined;
  }
  if (kindIndex > 0) {
    accountId = afterChannel.slice(0, kindIndex).join(":").trim() || DEFAULT_ACCOUNT_ID;
  }

  const kind = afterChannel[kindIndex]?.toLowerCase();
  const id = afterChannel
    .slice(kindIndex + 1)
    .join(":")
    .trim();
  if (!id) {
    return undefined;
  }

  if (kind === "group") {
    return { channel: "feishu", accountId, chatId: id };
  }
  return { channel: "feishu", accountId, to: id };
}

export function createTaskFlowUpdateTool(options: TaskFlowToolOptions): AnyAgentTool {
  return {
    label: "TaskFlow",
    name: "taskflow_update",
    sideEffect: "mutating",
    description:
      "Create or update the persistent TaskFlow for multi-step work. Use expectedRevision; on revision_conflict call taskflow_read, merge, then retry.",
    parameters: TaskFlowUpdateToolSchema,
    execute: async (_toolCallId, args) => {
      const ctx = resolveTaskFlowToolContext(options);
      if (!ctx.sessionKey?.trim()) {
        throw new ToolInputError("sessionKey required");
      }
      const params = args as Record<string, unknown>;
      const operation = readStringParam(params, "operation", { required: true });
      const store = createTaskFlowStore({
        agentDir: ctx.agentDir,
        stateDir: ctx.stateDir,
        now: options.now,
        idFactory: options.idFactory,
        onCommitted: dispatchTaskFlowCommitHook,
      });

      if (operation === "create") {
        const title = readStringParam(params, "title", { required: true });
        const scope = params.scope === "shared" ? "shared" : "local";
        const defaultSubscriber =
          scope === "local" ? resolveDefaultFeishuSubscriber(ctx.sessionKey) : undefined;
        const result = await store.createTaskFlow({
          agentId: ctx.agentId,
          ownerSessionKey: ctx.sessionKey,
          title,
          scope,
          items: readItemsParam(params),
          subscribers: defaultSubscriber ? [defaultSubscriber] : undefined,
        });
        return jsonResult(result);
      }

      if (
        operation === "subscribe_channel" &&
        isFeishuTopicOrThreadSession(ctx.sessionKey) &&
        isFeishuSubscriberInput(params.subscriber)
      ) {
        return jsonResult({
          status: "error",
          code: "invalid_operation",
          message:
            "Feishu TaskFlow progress subscriptions are not supported for topic/thread sessions",
        });
      }

      const result = await store.applyTaskFlowOperation({
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        taskFlowId: readStringParam(params, "taskFlowId"),
        expectedRevision: readNumberParam(params, "expectedRevision", { integer: true }),
        operation: operation as ApplyTaskFlowOperationParams["operation"],
        items: readItemsParam(params),
        itemId: readStringParam(params, "itemId"),
        status: readStringParam(params, "status") as ApplyTaskFlowOperationParams["status"],
        evidence: params.evidence as ApplyTaskFlowOperationParams["evidence"],
        subscriber: params.subscriber as ApplyTaskFlowOperationParams["subscriber"],
        reason: readStringParam(params, "reason"),
        targetSessionKey: readStringParam(params, "targetSessionKey"),
      });
      return jsonResult(result);
    },
  };
}
