import {
  EMPTY_SUMMARY_PLACEHOLDER,
  STRUCTURED_MEMORY_CATEGORIES,
  STRUCTURED_MEMORY_END,
  STRUCTURED_MEMORY_START,
} from "./constants.js";
import type {
  StructuredMemoryCategory,
  StructuredMemoryState,
  StructuredMemorySummarySection,
} from "./types.js";

const USER_SECTION_LABELS: Array<{
  key: "workContext" | "personalContext" | "topOfMind";
  heading: string;
}> = [
  { key: "workContext", heading: "Work Context" },
  { key: "personalContext", heading: "Personal Context" },
  { key: "topOfMind", heading: "Top Of Mind" },
];

const HISTORY_SECTION_LABELS: Array<{
  key: "recentMonths" | "earlierContext" | "longTermBackground";
  heading: string;
}> = [
  { key: "recentMonths", heading: "Recent Months" },
  { key: "earlierContext", heading: "Earlier Context" },
  { key: "longTermBackground", heading: "Long-Term Background" },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeFactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function createEmptyStructuredMemoryState(): StructuredMemoryState {
  return {
    user: {
      workContext: { summary: "" },
      personalContext: { summary: "" },
      topOfMind: { summary: "" },
    },
    history: {
      recentMonths: { summary: "" },
      earlierContext: { summary: "" },
      longTermBackground: { summary: "" },
    },
    facts: [],
  };
}

function extractStructuredMemoryBlock(content: string): string | null {
  const pattern = new RegExp(
    `${escapeRegExp(STRUCTURED_MEMORY_START)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(STRUCTURED_MEMORY_END)}`,
    "m",
  );
  const match = content.match(pattern);
  return match?.[1]?.trim() || null;
}

function parseSummarySection(block: string, heading: string): StructuredMemorySummarySection {
  const pattern = new RegExp(
    `#### ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n#### |\\n### |$)`,
    "m",
  );
  const match = block.match(pattern);
  if (!match) {
    return { summary: "" };
  }
  const body = match[1] ?? "";
  const summaryRaw = body.match(/^- Summary:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const updatedAtRaw = body.match(/^- Updated At:\s*(.*)$/m)?.[1]?.trim() ?? "";
  return {
    summary: summaryRaw === EMPTY_SUMMARY_PLACEHOLDER ? "" : summaryRaw,
    updatedAt: updatedAtRaw || undefined,
  };
}

export function parseStructuredMemoryState(content: string): StructuredMemoryState {
  const block = extractStructuredMemoryBlock(content);
  if (!block) {
    return createEmptyStructuredMemoryState();
  }

  const state = createEmptyStructuredMemoryState();
  for (const section of USER_SECTION_LABELS) {
    state.user[section.key] = parseSummarySection(block, section.heading);
  }
  for (const section of HISTORY_SECTION_LABELS) {
    state.history[section.key] = parseSummarySection(block, section.heading);
  }

  const factsMatch = block.match(/### Facts\s*([\s\S]*)$/);
  const factsBody = factsMatch?.[1]?.trim() ?? "";
  const factBlocks = factsBody
    ? factsBody
        .split(/\n(?=#### )/g)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("#### "))
    : [];
  for (const factBlock of factBlocks) {
    const newlineIndex = factBlock.indexOf("\n");
    const idLine = newlineIndex === -1 ? factBlock : factBlock.slice(0, newlineIndex);
    const body = newlineIndex === -1 ? "" : factBlock.slice(newlineIndex + 1);
    const id = idLine.replace(/^####\s+/, "").trim();
    const category = body.match(/^- Category:\s*(.*)$/m)?.[1]?.trim();
    const contentValue = body.match(/^- Content:\s*(.*)$/m)?.[1]?.trim();
    const source = body.match(/^- Source:\s*(.*)$/m)?.[1]?.trim();
    if (
      !id ||
      !category ||
      !contentValue ||
      !source ||
      !STRUCTURED_MEMORY_CATEGORIES.has(category as StructuredMemoryCategory)
    ) {
      continue;
    }
    const confidenceRaw = Number(body.match(/^- Confidence:\s*(.*)$/m)?.[1]?.trim() ?? "");
    const createdAt = body.match(/^- Created At:\s*(.*)$/m)?.[1]?.trim();
    const updatedAt = body.match(/^- Updated At:\s*(.*)$/m)?.[1]?.trim();
    const sourceError = body.match(/^- Source Error:\s*(.*)$/m)?.[1]?.trim();
    const consolidationReason = body.match(/^- Consolidation Reason:\s*(.*)$/m)?.[1]?.trim();
    state.facts.push({
      id,
      category: category as StructuredMemoryCategory,
      content: contentValue,
      confidence: Number.isFinite(confidenceRaw) ? confidenceRaw : 0,
      createdAt: createdAt || updatedAt || "",
      updatedAt: updatedAt || createdAt || "",
      source,
      sourceError: sourceError || undefined,
      consolidationReason: consolidationReason || undefined,
    });
  }
  return state;
}

function renderSummarySection(summary: StructuredMemorySummarySection): string[] {
  const normalizedSummary = normalizeFactText(summary.summary);
  const lines = [`- Summary: ${normalizedSummary || EMPTY_SUMMARY_PLACEHOLDER}`];
  if (summary.updatedAt) {
    lines.push(`- Updated At: ${summary.updatedAt}`);
  }
  return lines;
}

export function renderStructuredMemoryState(state: StructuredMemoryState): string {
  const parts: string[] = [
    STRUCTURED_MEMORY_START,
    "## OpenClaw Structured Memory",
    "",
    "### User",
    "",
  ];

  for (const section of USER_SECTION_LABELS) {
    parts.push(`#### ${section.heading}`);
    parts.push(...renderSummarySection(state.user[section.key]));
    parts.push("");
  }

  parts.push("### History", "");
  for (const section of HISTORY_SECTION_LABELS) {
    parts.push(`#### ${section.heading}`);
    parts.push(...renderSummarySection(state.history[section.key]));
    parts.push("");
  }

  parts.push("### Facts", "");
  for (const fact of state.facts) {
    parts.push(`#### ${fact.id}`);
    parts.push(`- Category: ${fact.category}`);
    parts.push(`- Confidence: ${fact.confidence.toFixed(2)}`);
    parts.push(`- Content: ${fact.content}`);
    parts.push(`- Created At: ${fact.createdAt}`);
    parts.push(`- Updated At: ${fact.updatedAt}`);
    parts.push(`- Source: ${fact.source}`);
    if (fact.sourceError) {
      parts.push(`- Source Error: ${fact.sourceError}`);
    }
    if (fact.consolidationReason) {
      parts.push(`- Consolidation Reason: ${fact.consolidationReason}`);
    }
    parts.push("");
  }
  parts.push(STRUCTURED_MEMORY_END);
  return `${parts.join("\n").trim()}\n`;
}

export function mergeStructuredMemoryContent(existingContent: string, block: string): string {
  const trimmedBlock = block.trim();
  const pattern = new RegExp(
    `${escapeRegExp(STRUCTURED_MEMORY_START)}[\\s\\S]*?${escapeRegExp(STRUCTURED_MEMORY_END)}`,
    "m",
  );
  if (pattern.test(existingContent)) {
    return existingContent.replace(pattern, trimmedBlock).trimEnd() + "\n";
  }
  const trimmedExisting = existingContent.trimEnd();
  if (!trimmedExisting) {
    return `${trimmedBlock}\n`;
  }
  return `${trimmedExisting}\n\n${trimmedBlock}\n`;
}

export function structuredMemoryStateToPromptInput(
  state: StructuredMemoryState,
): Record<string, unknown> {
  return {
    user: state.user,
    history: state.history,
    facts: state.facts.map((fact) => ({
      id: fact.id,
      category: fact.category,
      confidence: fact.confidence,
      content: fact.content,
      sourceError: fact.sourceError,
      consolidationReason: fact.consolidationReason,
      source: fact.source,
      updatedAt: fact.updatedAt,
    })),
  };
}

export function isStructuredMemoryStateEmpty(state: StructuredMemoryState): boolean {
  const summaries = [
    state.user.workContext,
    state.user.personalContext,
    state.user.topOfMind,
    state.history.recentMonths,
    state.history.earlierContext,
    state.history.longTermBackground,
  ];
  return summaries.every((item) => !normalizeFactText(item.summary)) && state.facts.length === 0;
}
