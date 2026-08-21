import path from "node:path";
import { readRecentTranscriptRecords } from "../../sessions/bounded-transcript.js";

// Default required files — constants, extensible to config later
const DEFAULT_REQUIRED_READS: Array<string | RegExp> = [
  "WORKFLOW_AUTO.md",
  /memory\/\d{4}-\d{2}-\d{2}\.md/, // daily memory files
];
const READ_TOOL_BLOCK_TYPES = new Set(["toolcall", "tool_use", "tool_call"]);

/**
 * Audit whether agent read required startup files after compaction.
 * Returns list of missing file patterns.
 */
export function auditPostCompactionReads(
  readFilePaths: string[],
  workspaceDir: string,
  requiredReads: Array<string | RegExp> = DEFAULT_REQUIRED_READS,
): { passed: boolean; missingPatterns: string[] } {
  const normalizedReads = readFilePaths.map((p) => path.resolve(workspaceDir, p));
  const missingPatterns: string[] = [];

  for (const required of requiredReads) {
    if (typeof required === "string") {
      const requiredResolved = path.resolve(workspaceDir, required);
      const found = normalizedReads.some((r) => r === requiredResolved);
      if (!found) {
        missingPatterns.push(required);
      }
    } else {
      // RegExp — match against relative paths from workspace
      const found = readFilePaths.some((p) => {
        const rel = path.relative(workspaceDir, path.resolve(workspaceDir, p));
        // Normalize to forward slashes for cross-platform RegExp matching
        const normalizedRel = rel.split(path.sep).join("/");
        return required.test(normalizedRel);
      });
      if (!found) {
        missingPatterns.push(required.source);
      }
    }
  }

  return { passed: missingPatterns.length === 0, missingPatterns };
}

/**
 * Read messages from a session JSONL file.
 * Returns messages from the last N lines (default 100).
 */
export async function readSessionMessages(
  sessionFile: string,
  maxRecords = 100,
): Promise<Array<{ role?: string; content?: unknown }>> {
  const records = await readRecentTranscriptRecords(sessionFile, maxRecords);
  const messages: Array<{ role?: string; content?: unknown }> = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const entry = record as Record<string, unknown>;
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
      continue;
    }
    messages.push(entry.message as { role?: string; content?: unknown });
  }
  return messages;
}

/**
 * Extract file paths from Read tool calls in agent messages.
 * Looks for tool_use blocks with name="read" and extracts path/file_path args.
 */
export function extractReadPaths(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }
    for (const value of msg.content) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const block = value as Record<string, unknown>;
      const type = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
      if (!READ_TOOL_BLOCK_TYPES.has(type)) {
        continue;
      }
      const name = typeof block.name === "string" ? block.name.trim().toLowerCase() : "";
      if (name !== "read") {
        continue;
      }
      const argumentsValue = block.arguments ?? block.input;
      if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
        continue;
      }
      const argumentsRecord = argumentsValue as Record<string, unknown>;
      const filePath = argumentsRecord.path ?? argumentsRecord.file_path;
      if (typeof filePath === "string") {
        paths.push(filePath);
      }
    }
  }
  return paths;
}

/** Format the audit warning message */
export function formatAuditWarning(missingPatterns: string[]): string {
  const fileList = missingPatterns.map((p) => `  - ${p}`).join("\n");
  return (
    "⚠️ Post-Compaction Audit: The following required startup files were not read after context reset:\n" +
    fileList +
    "\n\nPlease read them now using the Read tool before continuing. " +
    "This ensures your operating protocols are restored after memory compaction."
  );
}
