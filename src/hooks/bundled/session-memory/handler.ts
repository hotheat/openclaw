import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import { runEmbeddedPiAgent } from "../../../agents/pi-embedded.js";
import { acquireSessionWriteLock } from "../../../agents/session-write-lock.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { withFileLock } from "../../../infra/file-lock.js";
import { formatZonedTimestamp } from "../../../infra/format-time/format-datetime.ts";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HookHandler } from "../../hooks.js";
import {
  resolveSessionMemoryHookConfig,
  resolveSessionMemoryLlmOverrides,
  resolveSessionMemoryLlmTimeoutMs,
} from "./llm-config.js";
import {
  buildLongTermMemoryPrompt,
  buildSummaryPrompt,
  buildSummaryWriteDecisionPrompt,
} from "./prompts.js";
import {
  applyStructuredMemoryPatch,
  extractStructuredMemoryPatchJson,
  isStructuredMemoryPatchEmpty,
} from "./structured-memory-patch.js";
import {
  isStructuredMemoryStateEmpty,
  mergeStructuredMemoryContent,
  parseStructuredMemoryState,
  renderStructuredMemoryState,
} from "./structured-memory-render.js";
import {
  buildFallbackSummaryBody,
  hasReliableSummaryAdditions,
  normalizeStructuredSummary,
} from "./summary-markdown.js";
import { resolveSummaryInput } from "./transcript-input.js";
import type {
  SessionMemoryLlmOverrides,
  StructuredMemoryPatch,
  StructuredMemoryState,
} from "./types.js";

const log = createSubsystemLogger("hooks/session-memory");

const DEFAULT_MESSAGE_COUNT = 15;
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const MEMORY_FILE_LOCK_LLM_CALL_BUDGET = 5;
const MEMORY_FILE_LOCK_TIMEOUT_BUFFER_MS = 30_000;
const MEMORY_FILE_LOCK_OPTIONS = {
  stale: 30_000,
  retries: {
    retries: 60,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 250,
  },
} as const;

export type SessionMemoryCaptureParams = {
  cfg?: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  sessionFile?: string;
  timestamp: Date;
  source?: string;
};

export type SessionMemoryCaptureResult = {
  memoryFilePath: string;
  sessionContent: string | null;
  status: "written" | "skipped-empty" | "skipped-missing-source";
};

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function extractTextPayload(payloads: unknown): string | null {
  if (!Array.isArray(payloads)) {
    return null;
  }
  const match = payloads.find(
    (payload) => typeof (payload as { text?: unknown })?.text === "string",
  ) as { text?: string } | undefined;
  const text = match?.text?.trim();
  return text || null;
}

type SummaryWriteDecision = {
  shouldWriteDailyNote: boolean;
  containsDurableMemory?: boolean;
  containsOnlyOperationalNoise?: boolean;
  reason?: string;
};

function extractJsonObjectText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function parseSummaryWriteDecision(raw: string | null): SummaryWriteDecision | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(extractJsonObjectText(raw)) as Partial<SummaryWriteDecision>;
    if (typeof parsed.shouldWriteDailyNote !== "boolean") {
      return null;
    }
    return {
      shouldWriteDailyNote: parsed.shouldWriteDailyNote,
      containsDurableMemory:
        typeof parsed.containsDurableMemory === "boolean"
          ? parsed.containsDurableMemory
          : undefined,
      containsOnlyOperationalNoise:
        typeof parsed.containsOnlyOperationalNoise === "boolean"
          ? parsed.containsOnlyOperationalNoise
          : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

async function generateStructuredSummary(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  llmOverrides?: SessionMemoryLlmOverrides;
  llmTimeoutMs: number;
  transcript: string | null;
  source: string;
  sessionId?: string;
  generatedAt: string;
}): Promise<string> {
  if (!params.cfg) {
    return normalizeStructuredSummary({
      rawSummary: null,
      generatedAt: params.generatedAt,
      source: params.source,
      sessionId: params.sessionId,
      researcherExports: [],
    });
  }

  let tempSessionFile: string | null = null;
  try {
    const agentDir = resolveAgentDir(params.cfg, params.agentId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-summary-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const result = await runEmbeddedPiAgent({
      sessionId: `memory-summary-${Date.now()}`,
      sessionKey: "temp:memory-summary",
      agentId: params.agentId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir,
      config: params.cfg,
      provider: params.llmOverrides?.provider,
      model: params.llmOverrides?.model,
      prompt: buildSummaryPrompt({
        transcript: params.transcript,
        generatedAt: params.generatedAt,
        source: params.source,
        sessionId: params.sessionId,
      }),
      timeoutMs: params.llmTimeoutMs,
      runId: `memory-summary-${Date.now()}`,
    });

    return extractTextPayload(result.payloads) || buildFallbackSummaryBody();
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`failed to generate structured memory summary: ${message}`);
    return buildFallbackSummaryBody();
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

async function generateSummaryWriteDecision(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  llmOverrides?: SessionMemoryLlmOverrides;
  llmTimeoutMs: number;
  transcript: string | null;
  summaryBlock: string;
  source: string;
  sessionId?: string;
  generatedAt: string;
}): Promise<SummaryWriteDecision | null> {
  if (!params.cfg) {
    return null;
  }

  let tempSessionFile: string | null = null;
  try {
    const agentDir = resolveAgentDir(params.cfg, params.agentId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-decision-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const result = await runEmbeddedPiAgent({
      sessionId: `memory-write-decision-${Date.now()}`,
      sessionKey: "temp:memory-write-decision",
      agentId: params.agentId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir,
      config: params.cfg,
      provider: params.llmOverrides?.provider,
      model: params.llmOverrides?.model,
      prompt: buildSummaryWriteDecisionPrompt({
        summaryBlock: params.summaryBlock,
        transcript: params.transcript,
        generatedAt: params.generatedAt,
        source: params.source,
        sessionId: params.sessionId,
      }),
      timeoutMs: params.llmTimeoutMs,
      runId: `memory-write-decision-${Date.now()}`,
    });

    return parseSummaryWriteDecision(extractTextPayload(result.payloads));
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`failed to judge structured memory summary: ${message}`);
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

async function generateLongTermMemoryPatch(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  llmOverrides?: SessionMemoryLlmOverrides;
  llmTimeoutMs: number;
  currentMemory: StructuredMemoryState;
  summaryBlock: string;
  transcript: string | null;
  source: string;
  sessionId?: string;
  generatedAt: string;
}): Promise<StructuredMemoryPatch | null> {
  if (!params.cfg) {
    return null;
  }

  let tempSessionFile: string | null = null;
  try {
    const agentDir = resolveAgentDir(params.cfg, params.agentId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-longterm-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const result = await runEmbeddedPiAgent({
      sessionId: `memory-longterm-${Date.now()}`,
      sessionKey: "temp:memory-longterm",
      agentId: params.agentId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir,
      config: params.cfg,
      provider: params.llmOverrides?.provider,
      model: params.llmOverrides?.model,
      prompt: buildLongTermMemoryPrompt({
        currentMemory: params.currentMemory,
        summaryBlock: params.summaryBlock,
        generatedAt: params.generatedAt,
        source: params.source,
        sessionId: params.sessionId,
      }),
      timeoutMs: params.llmTimeoutMs,
      runId: `memory-longterm-${Date.now()}`,
    });

    return extractStructuredMemoryPatchJson(extractTextPayload(result.payloads));
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`failed to generate long-term memory patch: ${message}`);
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

async function appendSummaryBlock(params: {
  memoryFilePath: string;
  block: string;
}): Promise<void> {
  await withFileLock(params.memoryFilePath, MEMORY_FILE_LOCK_OPTIONS, async () => {
    let existing = "";
    try {
      existing = await fs.readFile(params.memoryFilePath, "utf-8");
    } catch {
      existing = "";
    }
    const separator = existing.trim().length > 0 ? "\n\n" : "";
    await fs.writeFile(
      params.memoryFilePath,
      `${existing.trimEnd()}${separator}${params.block}`,
      "utf-8",
    );
  });
}

function resolveLongTermMemoryLockTiming(llmTimeoutMs: number): {
  staleMs: number;
  timeoutMs: number;
  maxHoldMs: number;
} {
  const boundedLlmTimeoutMs =
    typeof llmTimeoutMs === "number" && Number.isFinite(llmTimeoutMs) && llmTimeoutMs > 0
      ? Math.floor(llmTimeoutMs)
      : DEFAULT_LLM_TIMEOUT_MS;
  const staleMs = Math.max(
    MEMORY_FILE_LOCK_OPTIONS.stale,
    boundedLlmTimeoutMs * MEMORY_FILE_LOCK_LLM_CALL_BUDGET + MEMORY_FILE_LOCK_TIMEOUT_BUFFER_MS,
  );
  const timeoutMs = staleMs + MEMORY_FILE_LOCK_TIMEOUT_BUFFER_MS;
  return {
    staleMs,
    timeoutMs,
    maxHoldMs: timeoutMs,
  };
}

async function updateLongTermMemory(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  llmOverrides?: SessionMemoryLlmOverrides;
  llmTimeoutMs: number;
  transcript: string | null;
  summaryBlock: string;
  generatedAt: string;
  source: string;
  sessionId?: string;
}): Promise<void> {
  const memoryFilePath = path.join(params.workspaceDir, "MEMORY.md");
  const lockTiming = resolveLongTermMemoryLockTiming(params.llmTimeoutMs);
  const lock = await acquireSessionWriteLock({
    sessionFile: memoryFilePath,
    timeoutMs: lockTiming.timeoutMs,
    staleMs: lockTiming.staleMs,
    maxHoldMs: lockTiming.maxHoldMs,
    allowReentrant: false,
  });
  try {
    let existingContent = "";
    try {
      existingContent = await fs.readFile(memoryFilePath, "utf-8");
    } catch {
      existingContent = "";
    }

    const currentState = parseStructuredMemoryState(existingContent);
    const patch = await generateLongTermMemoryPatch({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      llmOverrides: params.llmOverrides,
      llmTimeoutMs: params.llmTimeoutMs,
      currentMemory: currentState,
      summaryBlock: params.summaryBlock,
      transcript: params.transcript,
      generatedAt: params.generatedAt,
      source: params.source,
      sessionId: params.sessionId,
    });
    if (isStructuredMemoryPatchEmpty(patch)) {
      return;
    }

    const nextState = await applyStructuredMemoryPatch({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      llmOverrides: params.llmOverrides,
      llmTimeoutMs: params.llmTimeoutMs,
      current: currentState,
      patch: patch!,
      generatedAt: params.generatedAt,
      source: params.source,
      sessionId: params.sessionId,
    });
    if (isStructuredMemoryStateEmpty(nextState)) {
      return;
    }

    const renderedBlock = renderStructuredMemoryState(nextState);
    const mergedContent = mergeStructuredMemoryContent(existingContent, renderedBlock);
    await fs.writeFile(memoryFilePath, mergedContent, "utf-8");
  } finally {
    await lock.release();
  }
}

export async function captureSessionToMemory(
  params: SessionMemoryCaptureParams,
): Promise<SessionMemoryCaptureResult | null> {
  try {
    const cfg = params.cfg;
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const hookConfig = resolveSessionMemoryHookConfig(cfg);
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : DEFAULT_MESSAGE_COUNT;
    const llmOverrides = resolveSessionMemoryLlmOverrides({
      cfg,
      agentId,
      hookConfig,
    });
    const llmTimeoutMs = resolveSessionMemoryLlmTimeoutMs({
      hookConfig,
      defaultTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    });

    const { transcript, researcherExports, sourceFound } = await resolveSummaryInput({
      workspaceDir,
      agentId,
      currentSessionFile: params.sessionFile,
      sessionId: params.sessionId,
      messageCount,
    });

    const source = params.source || "unknown";
    const timestampMs = params.timestamp.getTime();
    const userTimezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStr = formatDateStampInTimezone(timestampMs, userTimezone);
    const generatedAt =
      formatZonedTimestamp(new Date(timestampMs), {
        timeZone: userTimezone,
        displaySeconds: true,
      }) ?? params.timestamp.toISOString();
    const memoryFilePath = path.join(memoryDir, `${dateStr}.md`);

    if (!transcript && researcherExports.length === 0) {
      log.info(`Skipped empty structured session summary for ${params.sessionId ?? "unknown"}`);
      return {
        memoryFilePath,
        sessionContent: transcript,
        status: sourceFound ? "skipped-empty" : "skipped-missing-source",
      };
    }

    const summaryBody = await generateStructuredSummary({
      cfg,
      agentId,
      workspaceDir,
      llmOverrides,
      llmTimeoutMs,
      transcript,
      source,
      sessionId: params.sessionId,
      generatedAt,
    });

    const summaryBlock = normalizeStructuredSummary({
      rawSummary: summaryBody,
      generatedAt,
      source,
      sessionId: params.sessionId,
      researcherExports,
    });

    const writeDecision =
      researcherExports.length > 0
        ? ({ shouldWriteDailyNote: true } satisfies SummaryWriteDecision)
        : await generateSummaryWriteDecision({
            cfg,
            agentId,
            workspaceDir,
            llmOverrides,
            llmTimeoutMs,
            transcript,
            summaryBlock,
            source,
            sessionId: params.sessionId,
            generatedAt,
          });
    const shouldWriteDailyNote =
      writeDecision?.shouldWriteDailyNote ?? hasReliableSummaryAdditions(summaryBlock);

    if (!shouldWriteDailyNote) {
      log.info(`Skipped empty structured session summary for ${params.sessionId ?? "unknown"}`);
      return { memoryFilePath, sessionContent: transcript, status: "skipped-empty" };
    }

    await appendSummaryBlock({
      memoryFilePath,
      block: summaryBlock,
    });

    await updateLongTermMemory({
      cfg,
      agentId,
      workspaceDir,
      llmOverrides,
      llmTimeoutMs,
      transcript,
      summaryBlock,
      generatedAt,
      source,
      sessionId: params.sessionId,
    });

    log.info(`Structured session summary saved to ${memoryFilePath.replace(os.homedir(), "~")}`);
    return { memoryFilePath, sessionContent: transcript, status: "written" };
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
    return null;
  }
}

const saveSessionToMemory: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "reset") {
    return;
  }

  log.debug(`Hook triggered for ${event.action} command`);

  const context = event.context || {};
  const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
    string,
    unknown
  >;

  await captureSessionToMemory({
    cfg: context.cfg as OpenClawConfig | undefined,
    sessionKey: event.sessionKey,
    sessionId: sessionEntry.sessionId as string | undefined,
    sessionFile: sessionEntry.sessionFile as string | undefined,
    source: event.action,
    timestamp: new Date(event.timestamp),
  });
};

export default saveSessionToMemory;
