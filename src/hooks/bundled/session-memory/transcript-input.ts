import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../../../config/sessions.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import type { ResearcherExportSummary } from "./types.js";

const log = createSubsystemLogger("hooks/session-memory");

type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const trimmed = record.text.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function isOperationalTranscriptLine(line: string, role: TranscriptMessage["role"]): boolean {
  if (role !== "assistant") {
    return false;
  }
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/^connection error(?:\b|[:：\s]|$)/.test(normalized)) {
    return true;
  }
  if (
    /^(?:retrying|retry|timed out|timeout|agent was busy|busy)(?:\b|[:：\s]|$)/.test(normalized)
  ) {
    return true;
  }
  if (/^(?:连接错误|连接异常|连接失败|连接超时|排队|重试)(?:[:：\s]|$)/.test(normalized)) {
    return true;
  }
  if (
    /^(?:发送文件|发送附件|重新发送|outbox|libreoffice|依赖缺失|安装失败|module not found|command not found)(?:[:：\s]|$)/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function sanitizeTranscriptText(text: string, role: TranscriptMessage["role"]): string {
  return text
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, "")
    .replace(/<SUBAGENT_HANDOFF>[\s\S]*?<\/SUBAGENT_HANDOFF>/gi, "")
    .replace(/\[UNTRUSTED DATA[\s\S]*?\[END UNTRUSTED DATA\]/gi, "")
    .replace(/^Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/gim, "")
    .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```/gim, "")
    .replace(/^reply(?:ed)? json:\s*```json[\s\S]*?```/gim, "")
    .replace(/^System:\s*\[[^\n]*\][^\n]*\n?/gm, "")
    .replace(/^assistant:\s*\{[\s\S]*?\}\s*$/gim, "")
    .replace(/^\[Image\]\s*$/gm, "")
    .replace(/^User text:\s*$/gm, "")
    .replace(/^Description:\s*$/gm, "")
    .replace(/^\[Queued messages while agent was busy\]\s*$/gm, "")
    .replace(/^Queued messages?:[\s\S]*?(?=\n{2,}|$)/gim, "")
    .replace(/^---\s*$/gm, "")
    .split(/\r?\n/)
    .filter((line) => !isOperationalTranscriptLine(line, role))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractResearcherExportsFromText(text: string): ResearcherExportSummary[] {
  if (!text.includes("<SUBAGENT_HANDOFF>")) {
    return [];
  }

  const results: ResearcherExportSummary[] = [];
  const handoffPattern = /<SUBAGENT_HANDOFF>\s*([\s\S]*?)\s*<\/SUBAGENT_HANDOFF>/g;
  for (const match of text.matchAll(handoffPattern)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as {
        mode?: unknown;
        summary?: unknown;
        export?: { path?: unknown; title?: unknown };
      };
      if (parsed.mode !== "export-file") {
        continue;
      }
      const exportPath =
        typeof parsed.export?.path === "string"
          ? parsed.export.path.trim().replace(/\\/g, "/")
          : "";
      if (!exportPath || exportPath.startsWith("/") || exportPath.startsWith("..")) {
        continue;
      }
      const description =
        (typeof parsed.summary === "string" && parsed.summary.trim()) ||
        (typeof parsed.export?.title === "string" && parsed.export.title.trim()) ||
        "Research deliverable exported.";
      results.push({
        exportPath,
        description,
      });
    } catch {
      continue;
    }
  }
  return results;
}

function dedupeResearcherExports(items: ResearcherExportSummary[]): ResearcherExportSummary[] {
  const seen = new Set<string>();
  const deduped: ResearcherExportSummary[] = [];
  for (const item of items) {
    const key = `${item.exportPath}\n${item.description}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function readSessionSummaryInput(
  sessionFilePath: string,
  messageCount: number,
): Promise<{
  transcript: string | null;
  researcherExports: ResearcherExportSummary[];
  sourceFound: boolean;
}> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const messages: TranscriptMessage[] = [];
    const researcherExports: ResearcherExportSummary[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          type?: unknown;
          message?: { role?: unknown; content?: unknown };
        };
        if (entry.type !== "message" || !entry.message) {
          continue;
        }
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") {
          continue;
        }

        const rawText = extractTextFromMessageContent(entry.message.content);
        if (!rawText) {
          continue;
        }

        if (role === "assistant") {
          researcherExports.push(...extractResearcherExportsFromText(rawText));
        }
        if (role === "user" && hasInterSessionUserProvenance(entry.message)) {
          continue;
        }

        const sanitized = sanitizeTranscriptText(rawText, role);
        if (!sanitized) {
          continue;
        }
        if (role === "user" && sanitized.startsWith("/")) {
          continue;
        }

        messages.push({ role, text: sanitized });
      } catch {
        continue;
      }
    }

    const transcript = messages
      .slice(-messageCount)
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n\n");
    return {
      transcript: transcript || null,
      researcherExports: dedupeResearcherExports(researcherExports),
      sourceFound: true,
    };
  } catch {
    return { transcript: null, researcherExports: [], sourceFound: false };
  }
}

function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const baseFromReset = params.currentSessionFile
      ? stripResetSuffix(path.basename(params.currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }

      const resetPrefix = `${canonicalFile}.reset.`;
      const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();
      if (resetCandidates.length > 0) {
        return path.join(params.sessionsDir, resetCandidates[resetCandidates.length - 1]);
      }
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}

export async function resolveSummaryInput(params: {
  workspaceDir: string;
  agentId?: string;
  currentSessionFile?: string;
  sessionId?: string;
  messageCount: number;
}): Promise<{
  transcript: string | null;
  researcherExports: ResearcherExportSummary[];
  sourceFound: boolean;
}> {
  let currentSessionFile = params.currentSessionFile;

  if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
    const sessionsDirs = new Set<string>();
    if (currentSessionFile) {
      sessionsDirs.add(path.dirname(currentSessionFile));
    }
    sessionsDirs.add(resolveSessionTranscriptsDirForAgent(params.agentId));
    sessionsDirs.add(path.join(params.workspaceDir, "sessions"));

    for (const sessionsDir of sessionsDirs) {
      const recoveredSessionFile = await findPreviousSessionFile({
        sessionsDir,
        currentSessionFile,
        sessionId: params.sessionId,
      });
      if (!recoveredSessionFile) {
        continue;
      }
      currentSessionFile = recoveredSessionFile;
      break;
    }
  }

  if (!currentSessionFile) {
    return { transcript: null, researcherExports: [], sourceFound: false };
  }

  const primary = await readSessionSummaryInput(currentSessionFile, params.messageCount);
  if (primary.transcript) {
    return primary;
  }

  try {
    const dir = path.dirname(currentSessionFile);
    const base = path.basename(currentSessionFile);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    const fallback = await readSessionSummaryInput(latestResetPath, params.messageCount);
    if (fallback.transcript) {
      log.debug("Loaded session summary input from reset fallback", {
        currentSessionFile,
        latestResetPath,
      });
      return fallback;
    }
    return {
      transcript: primary.transcript ?? fallback.transcript,
      researcherExports: dedupeResearcherExports([
        ...primary.researcherExports,
        ...fallback.researcherExports,
      ]),
      sourceFound: primary.sourceFound || fallback.sourceFound,
    };
  } catch {
    return primary;
  }
}
