import type { StructuredMemoryCategory } from "./types.js";

export const DEFAULT_EMPTY_SECTION_LINE = "- 无可靠新增项。";
export const STRUCTURED_MEMORY_START = "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->";
export const STRUCTURED_MEMORY_END = "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->";
export const MIN_FACT_CONFIDENCE = 0.7;
export const MIN_CORRECTION_CONFIDENCE = 0.95;
export const MAX_LONG_TERM_FACTS = 100;
export const EMPTY_SUMMARY_PLACEHOLDER = "_unset_";

export const DAILY_SUMMARY_SECTION_HEADINGS = [
  "### 最终结论",
  "### 已验证有效的方法",
  "### 稳定约束 / 用户偏好 / 重要决策",
  "### 待继续事项",
  "### 稳定失败教训",
];

export const STRUCTURED_MEMORY_CATEGORIES = new Set<StructuredMemoryCategory>([
  "preference",
  "knowledge",
  "context",
  "behavior",
  "goal",
  "correction",
]);
