import {
  DAILY_SUMMARY_SECTION_HEADINGS,
  DEFAULT_EMPTY_SECTION_LINE,
  EMPTY_SUMMARY_PLACEHOLDER,
} from "./constants.js";
import type { ResearcherExportSummary } from "./types.js";

function buildFallbackSummaryBody(): string {
  return DAILY_SUMMARY_SECTION_HEADINGS.map(
    (heading) => `${heading}\n${DEFAULT_EMPTY_SECTION_LINE}`,
  ).join("\n\n");
}

function ensureSummarySections(body: string): string {
  const trimmed = body.trim();
  const sections = DAILY_SUMMARY_SECTION_HEADINGS.map((heading) => {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nextHeadings = DAILY_SUMMARY_SECTION_HEADINGS.filter((candidate) => candidate !== heading)
      .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const pattern = nextHeadings
      ? new RegExp(`(${escapedHeading}[\\s\\S]*?)(?=\\n(?:${nextHeadings})\\n|$)`)
      : new RegExp(`(${escapedHeading}[\\s\\S]*)$`);
    const match = trimmed.match(pattern);
    if (!match?.[1]?.trim()) {
      return `${heading}\n${DEFAULT_EMPTY_SECTION_LINE}`;
    }
    return match[1].trim();
  });
  return sections.join("\n\n");
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

export function hasReliableSummaryAdditions(summaryBlock: string): boolean {
  const contentLines = summaryBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line)
    .filter((line) => !line.startsWith("## Daily Structured Summary"))
    .filter((line) => !line.startsWith("### "))
    .filter((line) => !/^- \*\*(Generated At|Source|Source Sessions)\*\*:/i.test(line));

  return contentLines.some((line) => !isEmptySummaryContentLine(line));
}

export { buildFallbackSummaryBody };
