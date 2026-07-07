import type { TaskFlow, TaskFlowItem, TaskFlowItemStatus } from "./types.js";

const CHECKBOX_BY_STATUS: Record<TaskFlowItemStatus, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
  blocked: "!",
  canceled: "-",
};

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderEvidence(item: TaskFlowItem, depth: number): string[] {
  const evidence = item.evidence ?? [];
  if (evidence.length === 0) {
    return [];
  }
  const indent = "  ".repeat(depth + 1);
  return evidence.map((entry) => `${indent}Evidence: ${cleanLine(entry.value).slice(0, 240)}`);
}

function renderItemTree(items: TaskFlowItem[], parentId: string | undefined, depth = 0): string[] {
  const children = items.filter((item) => item.parentId === parentId);
  const lines: string[] = [];
  for (const item of children) {
    const indent = "  ".repeat(depth);
    const mark = CHECKBOX_BY_STATUS[item.status] ?? " ";
    lines.push(`${indent}- [${mark}] ${cleanLine(item.title)}`);
    lines.push(...renderEvidence(item, depth));
    lines.push(...renderItemTree(items, item.id, depth + 1));
  }
  return lines;
}

export function renderTaskFlowMarkdown(
  taskFlow: TaskFlow,
  options: { maxChars?: number; includeRules?: boolean } = {},
): string {
  const includeRules = options.includeRules ?? true;
  const lines = [
    "## Active TaskFlow",
    "",
    `TaskFlow: ${taskFlow.id}`,
    `Title: ${cleanLine(taskFlow.title)}`,
    `Revision: ${taskFlow.revision}`,
    `Status: ${taskFlow.status}`,
    "",
    ...renderItemTree(taskFlow.items, undefined),
  ];

  if (includeRules) {
    lines.push(
      "",
      "Rules:",
      "- Update this TaskFlow with taskflow_update when item status changes.",
      "- If taskflow_update returns revision_conflict, call taskflow_read, merge your intended change, then retry with the latest revision.",
    );
  }

  const rendered = lines.join("\n").trimEnd();
  const maxChars = options.maxChars;
  if (typeof maxChars === "number" && maxChars > 0 && rendered.length > maxChars) {
    return `${rendered.slice(0, Math.max(0, maxChars - 14)).trimEnd()}\n... truncated`;
  }
  return rendered;
}

export function renderParkedTaskFlowSummary(taskFlows: Pick<TaskFlow, "id">[]): string {
  if (taskFlows.length === 0) {
    return "";
  }
  return `## Parked TaskFlows\n\nParked: ${taskFlows.length} (${taskFlows
    .map((taskFlow) => taskFlow.id)
    .join(", ")}). Use taskflow_read to inspect or resume_taskflow to continue.`;
}
