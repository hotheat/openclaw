import { createHash } from "node:crypto";
import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import {
  applyQueueRuntimeSettings,
  applyQueueDropPolicy,
  beginQueueDrain,
  buildCollectPrompt,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../utils/queue-helpers.js";
import {
  scrubSubagentHandoffText,
  type SubagentHandoffAnnounceView,
} from "./subagent-handoff-announce.js";

export type AnnounceQueueItem = {
  // Stable announce identity shared by direct + queued delivery paths.
  // Optional for backward compatibility with previously queued items.
  announceId?: string;
  prompt: string;
  summaryLine?: string;
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
  runChannel?: string;
  deliver?: boolean;
  waitForFinal?: boolean;
  completion?: {
    label: string;
    status: "succeeded" | "failed" | "unknown";
    result: string;
    resultRef?: {
      id: string;
      sessionKey: string;
    };
    handoff?: SubagentHandoffAnnounceView;
    remainingActive: number;
    instruction: string;
    deliveryInstruction?: string;
  };
  deliveryReceipt?: AnnounceDeliveryReceipt;
};

function scrubCompletionLabel(label: string): string {
  return scrubSubagentHandoffText(label, []) ?? "subagent task";
}

export type AnnounceQueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  lossless?: boolean;
  beforeDrain?: (items: AnnounceQueueItem[]) => Promise<void>;
};

export type AnnounceEnqueueOutcome = "accepted" | "duplicate" | "rejected";

export type AnnounceDeliveryReceipt = {
  promise: Promise<AnnounceDeliveryOutcome>;
  resolve: (outcome: AnnounceDeliveryOutcome) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
};

export type AnnounceDeliveryOutcome = {
  contentComplete: boolean;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  lossless: boolean;
  droppedCount: number;
  summaryLines: string[];
  beforeDrain?: (items: AnnounceQueueItem[]) => Promise<void>;
  send: (item: AnnounceQueueItem) => Promise<void>;
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();
const MAX_COMPLETION_LABEL_CHARS = 120;
const MAX_COMPLETION_RESULT_CHARS = 2_000;
const MAX_COMPLETION_RESULTS_CHARS = 12_000;
const MAX_COMPLETION_ARTIFACTS = 20;
const MAX_COMPLETION_ARTIFACT_CHARS = 12_000;

export function resetAnnounceQueuesForTests() {
  // Test isolation: other suites may leave a draining queue behind in the worker.
  // Clearing the map alone isn't enough because drain loops capture `queue` by reference.
  for (const queue of ANNOUNCE_QUEUES.values()) {
    for (const item of queue.items) {
      rejectDeliveryReceipt(item, new Error("announce queue reset for test"));
    }
    queue.items.length = 0;
    queue.summaryLines.length = 0;
    queue.droppedCount = 0;
    queue.lastEnqueuedAt = 0;
  }
  ANNOUNCE_QUEUES.clear();
}

export function getAnnounceQueueSizeForTests(key: string): number {
  return ANNOUNCE_QUEUES.get(key)?.items.length ?? 0;
}

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    existing.beforeDrain = settings.beforeDrain ?? existing.beforeDrain;
    existing.lossless = settings.lossless ?? existing.lossless;
    existing.send = send;
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    lossless: settings.lossless ?? false,
    droppedCount: 0,
    summaryLines: [],
    beforeDrain: settings.beforeDrain,
    send,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function hasAnnounceCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  return hasCrossChannelItems(items, (item) => {
    if (!item.origin) {
      return {};
    }
    if (!item.originKey) {
      return { cross: true };
    }
    return { key: item.originKey };
  });
}

function createDeliveryReceipt(): AnnounceDeliveryReceipt {
  let resolvePromise = (_outcome: AnnounceDeliveryOutcome) => {};
  let rejectPromise = (_reason: unknown) => {};
  const receipt: AnnounceDeliveryReceipt = {
    promise: new Promise<AnnounceDeliveryOutcome>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (outcome) => {
      if (receipt.settled) {
        return;
      }
      receipt.settled = true;
      resolvePromise(outcome);
    },
    reject: (reason) => {
      if (receipt.settled) {
        return;
      }
      receipt.settled = true;
      rejectPromise(reason);
    },
    settled: false,
  };
  return receipt;
}

function resolveDeliveryReceipt(item: AnnounceQueueItem, outcome: AnnounceDeliveryOutcome): void {
  item.deliveryReceipt?.resolve(outcome);
}

function rejectDeliveryReceipt(item: AnnounceQueueItem, reason: unknown): void {
  item.deliveryReceipt?.reject(reason);
}

function rejectQueuedDeliveryReceipts(
  queue: AnnounceQueueState,
  items: AnnounceQueueItem[],
  reason: unknown,
): number {
  const receiptedItems = items.filter((item) => item.deliveryReceipt);
  for (const item of receiptedItems) {
    rejectDeliveryReceipt(item, reason);
  }
  removeQueueItems(queue, receiptedItems);
  return receiptedItems.length;
}

function removeQueueItems(queue: AnnounceQueueState, items: AnnounceQueueItem[]): void {
  const removed = new Set(items);
  const kept = queue.items.filter((item) => !removed.has(item));
  queue.items.splice(0, queue.items.length, ...kept);
}

function resolveCompletionGroupKey(item: AnnounceQueueItem, index: number): string {
  if (item.originKey) {
    return `origin:${item.originKey}`;
  }
  return `unkeyed:${item.announceId ?? `${item.sessionKey}:${item.enqueuedAt}`}:${index}`;
}

function groupCompletionItems(items: AnnounceQueueItem[]): AnnounceQueueItem[][] {
  const groups = new Map<string, AnnounceQueueItem[]>();
  items.forEach((item, index) => {
    const key = resolveCompletionGroupKey(item, index);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  });
  return [...groups.values()];
}

function buildCompletionBatchAnnounceId(items: AnnounceQueueItem[]): string | undefined {
  if (items.length === 1) {
    return items[0]?.announceId;
  }
  const identities = items
    .map((item) => item.announceId ?? `${item.sessionKey}:${item.enqueuedAt}`)
    .toSorted();
  const originKey = items[0]?.originKey ?? "unkeyed";
  const digest = createHash("sha256")
    .update(`${originKey}\n${identities.join("\n")}`)
    .digest("hex")
    .slice(0, 32);
  return `completion-batch:${digest}`;
}

async function drainCompletionGroups(params: {
  queue: AnnounceQueueState;
  items: AnnounceQueueItem[];
  summary?: string;
  key: string;
}): Promise<void> {
  const groups = groupCompletionItems(params.items);
  for (const group of groups) {
    const built = buildCompletionAnnounceBatch(
      group,
      groups.length === 1 ? params.summary : undefined,
    );
    const last = group.at(-1);
    if (!built || !last) {
      continue;
    }
    try {
      await params.queue.send({
        ...last,
        announceId: buildCompletionBatchAnnounceId(group),
        prompt: built.prompt,
        deliveryReceipt: undefined,
      });
    } catch (err) {
      const hasReceipts = group.every((item) => item.deliveryReceipt);
      if (!hasReceipts) {
        throw err;
      }
      for (const item of group) {
        rejectDeliveryReceipt(item, err);
      }
      removeQueueItems(params.queue, group);
      defaultRuntime.error?.(
        `completion announce delivery failed for ${params.key}: ${String(err)}`,
      );
      continue;
    }
    for (const item of group) {
      resolveDeliveryReceipt(item, {
        contentComplete: !built.incompleteItems.has(item),
      });
    }
    removeQueueItems(params.queue, group);
  }
}

function compactCompletionResult(result: string, limit = MAX_COMPLETION_RESULT_CHARS): string {
  const trimmed = result.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  const truncationMarker = "\n...[result truncated]...\n";
  if (limit <= truncationMarker.length) {
    return trimmed.slice(0, limit);
  }
  const contentChars = limit - truncationMarker.length;
  const tailChars = Math.min(500, Math.floor(contentChars / 4));
  const headChars = contentChars - tailChars;
  return `${trimmed.slice(0, headChars).trimEnd()}${truncationMarker}${trimmed.slice(-tailChars).trimStart()}`;
}

function compactCompletionLabel(label: string): string {
  const cleaned = label.replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_COMPLETION_LABEL_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_COMPLETION_LABEL_CHARS - 3).trimEnd()}...`;
}

type CompletionAnnounceBatch = {
  prompt: string;
  incompleteItems: Set<AnnounceQueueItem>;
};

function buildCompletionAnnounceBatch(
  items: AnnounceQueueItem[],
  queueSummary?: string,
): CompletionAnnounceBatch | undefined {
  const completionItems = items.flatMap((item) =>
    item.completion
      ? [
          {
            source: item,
            value: {
              ...item.completion,
              label: compactCompletionLabel(item.completion.label),
            },
          },
        ]
      : [],
  );
  if (completionItems.length !== items.length || completionItems.length === 0) {
    return undefined;
  }

  const completions = completionItems.map(({ value }) => value);

  const latest = completions.at(-1);
  if (!latest) {
    return undefined;
  }
  const succeeded = completions.filter((item) => item.status === "succeeded").length;
  const failed = completions.filter((item) => item.status === "failed").length;
  const unknown = completions.length - succeeded - failed;
  const labels = completions.map((item) => scrubCompletionLabel(item.label)).join(", ");
  const lines = [
    "[Subagent completion summary]",
    `Completed: ${labels}`,
    `Succeeded: ${succeeded}`,
    `Failed: ${failed}`,
  ];
  if (unknown > 0) {
    lines.push(`Unknown: ${unknown}`);
  }
  lines.push(`Active: ${latest.remainingActive}`);
  if (queueSummary?.trim()) {
    lines.push("", queueSummary.trim());
  }

  const results: Array<{
    source: AnnounceQueueItem;
    value: (typeof completions)[number] & { result: string };
  }> = [];
  const omitted: typeof completionItems = [];
  const incompleteItems = new Set<AnnounceQueueItem>();
  let remainingResultChars = MAX_COMPLETION_RESULTS_CHARS;
  for (const item of completionItems) {
    const rawResult = item.value.result.trim();
    if (!rawResult || rawResult === "(no output)") {
      continue;
    }
    if (remainingResultChars <= 0) {
      omitted.push(item);
      incompleteItems.add(item.source);
      continue;
    }
    const resultLimit = Math.min(MAX_COMPLETION_RESULT_CHARS, remainingResultChars);
    const result = compactCompletionResult(rawResult, resultLimit);
    if (rawResult.length > resultLimit) {
      incompleteItems.add(item.source);
    }
    results.push({ source: item.source, value: { ...item.value, result } });
    remainingResultChars -= result.length;
  }
  if (results.length > 0) {
    lines.push("", "Results:");
    for (const item of results) {
      lines.push(
        `- ${scrubCompletionLabel(item.value.label)} [${item.value.status}]`,
        item.value.result,
      );
      if (incompleteItems.has(item.source)) {
        lines.push("  Truncated: true");
        if (item.value.resultRef?.sessionKey) {
          lines.push(`  Result session: ${item.value.resultRef.sessionKey}`);
          lines.push(`  Result ref: ${item.value.resultRef.id}`);
        }
      }
    }
  }
  const artifactLines: string[] = [];
  let artifactChars = 0;
  let includedArtifacts = 0;
  let omittedArtifacts = 0;
  let includesWarningArtifact = false;
  for (const item of completionItems) {
    const omittedArtifactCount = Math.max(0, item.value.handoff?.omittedArtifactCount ?? 0);
    if (omittedArtifactCount > 0) {
      omittedArtifacts += omittedArtifactCount;
      incompleteItems.add(item.source);
    }
  }
  for (const item of completionItems) {
    const taskLabel = scrubCompletionLabel(item.value.label);
    for (const artifact of item.value.handoff?.deliverableArtifacts ?? []) {
      if (artifact.deliveryStatus === "warning") {
        includesWarningArtifact = true;
      }
      const block = [
        `- ${taskLabel}: ${artifact.relativePath}`,
        `  Delivery: ${artifact.deliveryStatus}`,
        `  Verification: ${artifact.verificationStatus}`,
        ...(artifact.deliveryStatus === "warning"
          ? [`  Verification details: ${artifact.verificationSummary || "not provided"}`]
          : []),
        ...(artifact.title ? [`  Title: ${artifact.title}`] : []),
        ...(artifact.mimeType ? [`  MIME: ${artifact.mimeType}`] : []),
      ];
      const blockChars = block.join("\n").length;
      if (
        includedArtifacts >= MAX_COMPLETION_ARTIFACTS ||
        artifactChars + blockChars > MAX_COMPLETION_ARTIFACT_CHARS
      ) {
        omittedArtifacts += 1;
        incompleteItems.add(item.source);
        continue;
      }
      artifactLines.push(...block);
      artifactChars += blockChars;
      includedArtifacts += 1;
    }
  }
  const blockedLines: string[] = [];
  for (const item of completionItems) {
    const blocked = item.value.handoff?.blocked;
    if (!blocked) {
      continue;
    }
    const taskLabel = scrubCompletionLabel(item.value.label);
    blockedLines.push(
      `- Task: ${taskLabel}`,
      `  Reason: ${blocked.reason}`,
      ...(blocked.verificationSummary
        ? [`  Verification details: ${blocked.verificationSummary}`]
        : []),
    );
  }
  if (artifactLines.length > 0) {
    lines.push("", "Deliverable artifacts:", ...artifactLines);
  }
  if (blockedLines.length > 0) {
    lines.push(
      "",
      "Blocked handoff:",
      ...blockedLines,
      "Instruction: Inform the user that the artifact cannot be delivered. Do not offer sending or expose workspace paths.",
    );
  }
  const deliveryIssueLines: string[] = [];
  for (const item of completionItems) {
    const taskLabel = scrubCompletionLabel(item.value.label);
    for (const issue of item.value.handoff?.deliveryIssues ?? []) {
      deliveryIssueLines.push(`- ${taskLabel} [${issue.kind}]: ${issue.reason}`);
    }
  }
  if (deliveryIssueLines.length > 0) {
    lines.push("", "Artifact delivery issues:", ...deliveryIssueLines);
  }
  if (omittedArtifacts > 0) {
    lines.push("", `Omitted artifacts: ${omittedArtifacts}`);
  }
  if (omitted.length > 0) {
    lines.push("", "Omitted results:");
    for (const item of omitted) {
      lines.push(`- [${item.value.status}] Truncated: true`);
      if (item.value.resultRef?.sessionKey) {
        lines.push(`  Result session: ${item.value.resultRef.sessionKey}`);
        lines.push(`  Result ref: ${item.value.resultRef.id}`);
      }
    }
  }
  if (incompleteItems.size > 0) {
    lines.push(
      "",
      "Recovery: page sessions_history for each result session with its resultRef and contentOffset=0, then continue at nextContentOffset until contentHasMore=false.",
    );
  }
  if (latest.instruction.trim()) {
    lines.push("", latest.instruction.trim());
  }
  if (includesWarningArtifact) {
    lines.push(
      "",
      "Warning delivery requirement: when sending an artifact marked warning, explicitly tell the user that verification failed and include the verification details above. Do not describe it as verified or fully passed.",
    );
  }
  const deliveryInstruction = completionItems.findLast((item) =>
    item.value.deliveryInstruction?.trim(),
  )?.value.deliveryInstruction;
  if (artifactLines.length > 0 && deliveryInstruction?.trim()) {
    lines.push("", deliveryInstruction.trim());
  }
  return { prompt: lines.join("\n"), incompleteItems };
}

export function buildCompletionAnnouncePrompt(
  items: AnnounceQueueItem[],
  queueSummary?: string,
): string | undefined {
  return buildCompletionAnnounceBatch(items, queueSummary)?.prompt;
}

function scheduleAnnounceDrain(key: string) {
  const queue = beginQueueDrain(ANNOUNCE_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      for (;;) {
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForQueueDebounce(queue);
        if (queue.beforeDrain) {
          const items = queue.items.slice();
          try {
            await queue.beforeDrain(items);
          } catch (err) {
            if (rejectQueuedDeliveryReceipts(queue, items, err) === 0) {
              throw err;
            }
            defaultRuntime.error?.(`announce queue pre-drain failed for ${key}: ${String(err)}`);
            continue;
          }
          await waitForQueueDebounce(queue);
        }
        if (queue.mode === "collect") {
          const isCompletionBatch =
            queue.items.length > 0 && queue.items.every((item) => item.completion);
          if (isCompletionBatch) {
            const items = queue.items.slice();
            const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
            await drainCompletionGroups({ queue, items, summary, key });
            if (summary) {
              clearQueueSummaryState(queue);
            }
            continue;
          }
          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel: hasAnnounceCrossChannelItems(queue.items),
            items: queue.items,
            run: async (item) => await queue.send(item),
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
          const prompt =
            buildCompletionAnnouncePrompt(items, summary) ??
            buildCollectPrompt({
              title: "[Queued announce messages while agent was busy]",
              items,
              summary,
              renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
            });
          const last = items.at(-1);
          if (!last) {
            break;
          }
          await queue.send({ ...last, prompt });
          queue.items.splice(0, items.length);
          if (summary) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
        if (summaryPrompt) {
          if (
            !(await drainNextQueueItem(
              queue.items,
              async (item) => await queue.send({ ...item, prompt: summaryPrompt }),
            ))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, async (item) => await queue.send(item)))) {
          break;
        }
      }
    } catch (err) {
      // Keep items in queue and retry after debounce; avoid hot-loop retries.
      queue.lastEnqueuedAt = Date.now();
      defaultRuntime.error?.(`announce queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

export function enqueueAnnounce(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): boolean {
  return enqueueAnnounceItem(params).outcome === "accepted";
}

export function enqueueAnnounceWithOutcome(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): AnnounceEnqueueOutcome {
  return enqueueAnnounceItem(params).outcome;
}

function enqueueAnnounceItem(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): { outcome: AnnounceEnqueueOutcome; item: AnnounceQueueItem } {
  const queue = getAnnounceQueue(params.key, params.settings, params.send);

  const existing = params.item.announceId
    ? queue.items.find((item) => item.announceId === params.item.announceId)
    : undefined;
  if (existing) {
    scheduleAnnounceDrain(params.key);
    return { outcome: "duplicate", item: existing };
  }

  queue.lastEnqueuedAt = Date.now();
  const shouldEnqueue =
    queue.lossless ||
    applyQueueDropPolicy({
      queue,
      summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
    });
  if (!shouldEnqueue) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
    }
    rejectDeliveryReceipt(params.item, new Error(`announce queue rejected item for ${params.key}`));
    return { outcome: "rejected", item: params.item };
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = params.item.originKey ?? deliveryContextKey(origin);
  const item = { ...params.item, origin, originKey };
  queue.items.push(item);
  scheduleAnnounceDrain(params.key);
  return { outcome: "accepted", item };
}

export function enqueueAnnounceWithReceipt(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): { enqueued: boolean; delivered: Promise<AnnounceDeliveryOutcome> } {
  const deliveryReceipt = createDeliveryReceipt();
  const result = enqueueAnnounceItem({
    ...params,
    item: {
      ...params.item,
      deliveryReceipt,
    },
  });
  const queuedReceipt = result.item.deliveryReceipt;
  if (!queuedReceipt) {
    deliveryReceipt.reject(new Error(`announce receipt unavailable for ${params.key}`));
    return { enqueued: result.outcome === "accepted", delivered: deliveryReceipt.promise };
  }
  if (queuedReceipt !== deliveryReceipt) {
    deliveryReceipt.resolve({ contentComplete: true });
  }
  return {
    enqueued: result.outcome === "accepted",
    delivered: queuedReceipt.promise,
  };
}
