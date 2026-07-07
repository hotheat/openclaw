import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type {
  TaskFlow,
  TaskFlowItem,
  TaskFlowItemStatus,
  TaskFlowSubscriber,
} from "../../../src/agents/taskflow/types.js";
import type { PluginHookTaskFlowUpdatedEvent } from "../../../src/plugins/types.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";

export type TaskFlowStreamingSession = {
  start: (
    receiveId: string,
    receiveIdType?: ReturnType<typeof resolveReceiveIdType>,
  ) => Promise<void>;
  update: (text: string) => Promise<void>;
  close: (text?: string) => Promise<void>;
  isActive: () => boolean;
};

export type TaskFlowFeishuPublisherParams = {
  cfg?: ClawdbotConfig;
  createSession?: (subscriber: TaskFlowSubscriber) => TaskFlowStreamingSession;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

function subscriberKey(taskFlowId: string, subscriber: TaskFlowSubscriber, receiveId: string) {
  return `${taskFlowId}:${subscriber.accountId ?? "default"}:${receiveId}`;
}

function resolveReceiveId(subscriber: TaskFlowSubscriber): string | null {
  return subscriber.chatId?.trim() || subscriber.to?.trim() || null;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "canceled";
}

const FEISHU_STATUS_MARKER: Record<TaskFlowItemStatus, string> = {
  pending: "○",
  in_progress: "⏳",
  completed: "✅",
  blocked: "⚠️",
  canceled: "✕",
};

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderTaskFlowItemTree(items: TaskFlowItem[], parentId: string | undefined, depth = 0) {
  const lines: string[] = [];
  const children = items.filter((item) => item.parentId === parentId);
  for (const item of children) {
    const marker = FEISHU_STATUS_MARKER[item.status] ?? FEISHU_STATUS_MARKER.pending;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${marker} ${cleanLine(item.title)}`);
    lines.push(...renderTaskFlowItemTree(items, item.id, depth + 1));
  }
  return lines;
}

function renderTaskFlowHeading(taskFlow: TaskFlow): string {
  switch (taskFlow.status) {
    case "completed":
      return "## Completed TaskFlow";
    case "canceled":
      return "## Canceled TaskFlow";
    case "parked":
      return "## Parked TaskFlow";
    case "blocked":
      return "## Blocked TaskFlow";
    default:
      return "## Active TaskFlow";
  }
}

function renderFeishuTaskFlowMarkdown(taskFlow: TaskFlow): string {
  const lines = [
    renderTaskFlowHeading(taskFlow),
    "",
    `TaskFlow: ${taskFlow.id}`,
    `Title: ${cleanLine(taskFlow.title)}`,
    `Revision: ${taskFlow.revision}`,
    `Status: ${taskFlow.status}`,
    "",
    ...renderTaskFlowItemTree(taskFlow.items, undefined),
  ];
  return lines.join("\n").trimEnd();
}

function renderTaskFlowCardMarkdown(event: PluginHookTaskFlowUpdatedEvent): string {
  const markdown = renderFeishuTaskFlowMarkdown(event.snapshot);
  if (event.snapshot.status === "parked") {
    return `**状态：已挂起**\n\n${markdown}`;
  }
  return markdown;
}

export class TaskFlowFeishuPublisher {
  private readonly sessions = new Map<string, TaskFlowStreamingSession>();
  private readonly lastDeliveredRevision = new Map<string, number>();
  private readonly params: TaskFlowFeishuPublisherParams;

  constructor(params: TaskFlowFeishuPublisherParams) {
    this.params = params;
  }

  private createSession(subscriber: TaskFlowSubscriber): TaskFlowStreamingSession | null {
    if (this.params.createSession) {
      return this.params.createSession(subscriber);
    }
    if (!this.params.cfg) {
      return null;
    }
    const account = resolveFeishuAccount({ cfg: this.params.cfg, accountId: subscriber.accountId });
    if (!account.appId || !account.appSecret) {
      return null;
    }
    return new FeishuStreamingSession(
      createFeishuClient(account),
      { appId: account.appId, appSecret: account.appSecret, domain: account.domain },
      this.params.log,
    );
  }

  async publish(
    event: Pick<PluginHookTaskFlowUpdatedEvent, "snapshot" | "markdown">,
  ): Promise<void> {
    for (const subscriber of event.snapshot.subscribers) {
      if (subscriber.channel !== "feishu") {
        continue;
      }
      const receiveId = resolveReceiveId(subscriber);
      if (!receiveId) {
        continue;
      }
      const key = subscriberKey(event.snapshot.id, subscriber, receiveId);
      const lastRevision = this.lastDeliveredRevision.get(key) ?? 0;
      if (lastRevision >= event.snapshot.revision) {
        continue;
      }

      try {
        let session = this.sessions.get(key);
        if (!session) {
          session = this.createSession(subscriber) ?? undefined;
          if (!session) {
            continue;
          }
          this.sessions.set(key, session);
        }
        const markdown = renderTaskFlowCardMarkdown(event as PluginHookTaskFlowUpdatedEvent);
        if (!session.isActive()) {
          await session.start(receiveId, resolveReceiveIdType(receiveId));
        }
        if (isTerminalStatus(event.snapshot.status)) {
          await session.close(markdown);
          this.sessions.delete(key);
        } else {
          await session.update(markdown);
        }
        this.lastDeliveredRevision.set(key, event.snapshot.revision);
      } catch (err) {
        this.params.error?.(
          `feishu taskflow progress failed for ${event.snapshot.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
