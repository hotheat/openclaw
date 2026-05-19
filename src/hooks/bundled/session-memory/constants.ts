import type { StructuredMemoryCategory } from "./types.js";

export const DEFAULT_EMPTY_SECTION_LINE = "- 无可靠新增项。";
export const STRUCTURED_MEMORY_START = "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->";
export const STRUCTURED_MEMORY_END = "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->";
export const MIN_FACT_CONFIDENCE = 0.7;
export const MIN_CORRECTION_CONFIDENCE = 0.95;
export const MAX_LONG_TERM_FACTS = 100;
export const EMPTY_SUMMARY_PLACEHOLDER = "_unset_";

export const TASK_SUMMARY_SECTION_HEADINGS = [
  "### 当前主问题 / 当天主线",
  "### 主要任务推进",
  "### 负向反馈 / 失败信号",
  "### 改进方向",
  "### 正向进展 / 已验证有效",
];

export const SUMMARY_SECTION_HEADINGS = [
  "### 用户偏好",
  "### 自定义需求",
  "### 失败经验 / 反模式",
  "### 重要决策",
  "### 未完成事项",
  "### 风险 / 注意点",
];

export const DAILY_SUMMARY_SECTION_HEADINGS = [
  ...TASK_SUMMARY_SECTION_HEADINGS,
  ...SUMMARY_SECTION_HEADINGS,
];

export const STRUCTURED_MEMORY_CATEGORIES = new Set<StructuredMemoryCategory>([
  "preference",
  "knowledge",
  "context",
  "behavior",
  "goal",
  "correction",
]);
