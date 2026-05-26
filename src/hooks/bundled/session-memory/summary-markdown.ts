import {
  DAILY_SUMMARY_SECTION_HEADINGS,
  DEFAULT_EMPTY_SECTION_LINE,
  EMPTY_SUMMARY_PLACEHOLDER,
} from "./constants.js";
import type { ResearcherExportSummary } from "./types.js";

function buildFallbackSummaryBody(): string {
  return DEFAULT_EMPTY_SECTION_LINE;
}

const LEGACY_SUMMARY_HEADING_TARGETS = new Map<string, string>([
  ["### 当前主问题 / 当天主线", "### 最终结论"],
  ["### 主要任务推进", "### 最终结论"],
  ["### 正向进展 / 已验证有效", "### 已验证有效的方法"],
  ["### 用户偏好", "### 稳定约束 / 用户偏好 / 重要决策"],
  ["### 自定义需求", "### 稳定约束 / 用户偏好 / 重要决策"],
  ["### 重要决策", "### 稳定约束 / 用户偏好 / 重要决策"],
  ["### 未完成事项", "### 待继续事项"],
  ["### 失败经验 / 反模式", "### 稳定失败教训"],
  ["### 负向反馈 / 失败信号", "### 稳定失败教训"],
  ["### 风险 / 注意点", "### 稳定失败教训"],
]);

function resolveSummaryHeadingTarget(line: string): string | null {
  const heading = line.trim();
  if (DAILY_SUMMARY_SECTION_HEADINGS.includes(heading)) {
    return heading;
  }
  return LEGACY_SUMMARY_HEADING_TARGETS.get(heading) ?? null;
}

function ensureSummarySections(body: string): string {
  const trimmed = body.trim();
  const sectionLines = new Map<string, string[]>();
  let currentHeading: string | null = null;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = resolveSummaryHeadingTarget(line);
    if (heading) {
      currentHeading = heading;
      if (!sectionLines.has(heading)) {
        sectionLines.set(heading, []);
      }
      continue;
    }
    if (line.startsWith("### ")) {
      currentHeading = null;
      continue;
    }
    if (!currentHeading || !line) {
      continue;
    }
    sectionLines.get(currentHeading)?.push(line);
  }

  const sections = DAILY_SUMMARY_SECTION_HEADINGS.map((heading) => {
    const lines = sectionLines.get(heading) ?? [];
    if (lines.length === 0) {
      return null;
    }
    const hasReliableContent = lines.some((line) => !isEmptySummaryContentLine(line));
    if (!hasReliableContent) {
      return null;
    }
    return `${heading}\n${lines.join("\n")}`;
  }).filter((section): section is string => Boolean(section));
  return sections.length > 0 ? sections.join("\n\n") : DEFAULT_EMPTY_SECTION_LINE;
}

export function normalizeStructuredSummary(params: {
  rawSummary: string | null;
  generatedAt: string;
  source: string;
  sessionId?: string;
  researcherExports: ResearcherExportSummary[];
}): string {
  let body = (params.rawSummary ?? "").trim();
  body = body.replace(/^## Daily Structured Summary\s*/i, "").trimStart();
  body = body.replace(/^- \*\*Generated At\*\*:.*$/gim, "");
  body = body.replace(/^- \*\*Source\*\*:.*$/gim, "");
  body = body.replace(/^- \*\*Source Sessions\*\*:.*$/gim, "");
  body = body.trim();
  if (!body) {
    body = buildFallbackSummaryBody();
  } else {
    body = ensureSummarySections(body);
  }

  const parts = [
    "## Daily Structured Summary",
    "",
    `- **Generated At**: ${params.generatedAt}`,
    `- **Source**: ${params.source}`,
    `- **Source Sessions**: ${params.sessionId ?? "unknown"}`,
    "",
    body,
  ];

  if (params.researcherExports.length > 0 && !/###\s*Researcher 产物/i.test(body)) {
    parts.push("", "### Researcher 产物");
    for (const item of params.researcherExports) {
      parts.push(`- \`${item.exportPath}\` — ${item.description}`);
    }
  }

  return `${parts.join("\n").trim()}\n`;
}

function isEmptySummaryContentLine(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/[。.!！]+$/g, "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized === "无可靠新增项" ||
    normalized === "none" ||
    normalized === "n/a" ||
    normalized === EMPTY_SUMMARY_PLACEHOLDER
  );
}

function isOperationalNoiseSummaryContentLine(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/[。.!！]+$/g, "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return true;
  }
  if (
    /用户.*(?:要求|明确|需要|让).*(?:排查|调试|debug|修复)/.test(normalized) ||
    /策略|改为|以后|必须|偏好|要求|规则|约束|都要|不要/.test(normalized)
  ) {
    return false;
  }
  if (/heartbeat|heart_?beat_ok|心跳/.test(normalized)) {
    return true;
  }
  if (/无主动用户请求|例行检查|定期轮询|daily-rollover/.test(normalized)) {
    return true;
  }
  if (/queued messages|agent was busy|^busy(?:\b|[:：\s]|$)|排队/.test(normalized)) {
    return true;
  }
  if (
    /(?:retry|retries|重试).*(?:失败|无法|error|错误|连接|超时)|(?:连接超时|timed out).*(?:失败|无法|重试|retry)?/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /(?:发送文件|发送附件|重新发送|outbox|libreoffice|依赖缺失|安装失败).*(?:失败|缺失|重试|过程|无法|错误|error)?/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /connection error|连接错误|连接异常|连接失败|连接不稳定|上游连接|(?:基础设施|网关|网络|服务).*(?:不稳定|异常|错误|失败)/.test(
    normalized,
  );
}

function isDurableSummaryContentLine(line: string): boolean {
  if (isEmptySummaryContentLine(line)) {
    return false;
  }
  return !isOperationalNoiseSummaryContentLine(line);
}

export function hasReliableSummaryAdditions(summaryBlock: string): boolean {
  const contentLines = summaryBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line)
    .filter((line) => !line.startsWith("## Daily Structured Summary"))
    .filter((line) => !line.startsWith("### "))
    .filter((line) => !/^- \*\*(Generated At|Source|Source Sessions)\*\*:/i.test(line));

  return contentLines.some((line) => isDurableSummaryContentLine(line));
}

export { buildFallbackSummaryBody, isDurableSummaryContentLine };
