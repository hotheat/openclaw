import path from "node:path";
import type {
  SubagentHandoffDeliveryStatus,
  SubagentHandoffGate,
  SubagentHandoffVerificationStatus,
} from "./subagent-handoff-contract.js";

const HANDOFF_OPEN_TAG = "<SUBAGENT_HANDOFF>";
const HANDOFF_CLOSE_TAG = "</SUBAGENT_HANDOFF>";
const HANDOFF_OPEN_TAG_LOWER = HANDOFF_OPEN_TAG.toLowerCase();
const HANDOFF_CLOSE_TAG_LOWER = HANDOFF_CLOSE_TAG.toLowerCase();
const HANDOFF_BLOCK_PATTERN = /<SUBAGENT_HANDOFF>\s*([\s\S]*?)\s*<\/SUBAGENT_HANDOFF>/gi;
const MAX_HANDOFF_ARTIFACTS = 20;
const MAX_PATH_CHARS = 1_024;
const MAX_METADATA_CHARS = 512;

export type SubagentHandoffQuality = {
  gate: SubagentHandoffGate;
  verificationStatus: SubagentHandoffVerificationStatus;
  verificationSummary?: string;
  deliveryStatus: SubagentHandoffDeliveryStatus;
};

export type SubagentHandoffArtifact = {
  relativePath: string;
  fileName?: string;
  title?: string;
  mimeType?: string;
};

export type ParsedSubagentHandoff = {
  mode?: "inline" | "export-file";
  summary?: string;
  quality: SubagentHandoffQuality;
  artifacts: SubagentHandoffArtifact[];
  omittedArtifactCount: number;
};

export type AnalyzedSubagentHandoff = {
  didFindHandoff: boolean;
  strippedContent: string;
  handoff?: ParsedSubagentHandoff;
};

function readTrimmedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, maxChars);
}

function normalizeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PATH_CHARS || trimmed.includes("\0")) {
    return undefined;
  }
  const raw = trimmed.replaceAll("\\", "/");
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    return undefined;
  }
  const normalized = path.posix.normalize(raw);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized.replace(/^\.\/+/, "");
}

function normalizeVerificationStatus(value: unknown): SubagentHandoffVerificationStatus {
  const normalized = readTrimmedString(value, 32)?.toLowerCase();
  return normalized === "passed" || normalized === "failed" ? normalized : "unknown";
}

function normalizeQuality(record: Record<string, unknown>): SubagentHandoffQuality {
  const hasVerificationField = Object.hasOwn(record, "verification");
  const hasDeliveryField = Object.hasOwn(record, "delivery");
  const gate = hasVerificationField || hasDeliveryField ? "managed" : "unmanaged";
  const verification =
    record.verification && typeof record.verification === "object"
      ? (record.verification as Record<string, unknown>)
      : undefined;
  const delivery =
    record.delivery && typeof record.delivery === "object"
      ? (record.delivery as Record<string, unknown>)
      : undefined;
  const verificationStatus = normalizeVerificationStatus(verification?.status);
  const verificationSummary = readTrimmedString(verification?.summary, MAX_METADATA_CHARS);

  if (gate === "unmanaged") {
    return {
      gate,
      verificationStatus,
      verificationSummary,
      deliveryStatus: "unmanaged",
    };
  }

  const declaredDelivery = readTrimmedString(delivery?.status, 32)?.toLowerCase();
  let deliveryStatus: SubagentHandoffQuality["deliveryStatus"] = "blocked";
  if (declaredDelivery === "blocked") {
    deliveryStatus = "blocked";
  } else if (
    verificationStatus === "passed" &&
    (!hasDeliveryField || declaredDelivery === "ready")
  ) {
    deliveryStatus = "ready";
  } else if (
    verificationStatus === "failed" &&
    declaredDelivery === "warning" &&
    verificationSummary
  ) {
    deliveryStatus = "warning";
  }

  return {
    gate,
    verificationStatus,
    verificationSummary,
    deliveryStatus,
  };
}

function normalizeArtifact(value: unknown): SubagentHandoffArtifact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const relativePath = normalizeRelativePath(record.path);
  if (!relativePath) {
    return undefined;
  }
  return {
    relativePath,
    fileName: readTrimmedString(record.fileName, MAX_METADATA_CHARS),
    title: readTrimmedString(record.title, MAX_METADATA_CHARS),
    mimeType: readTrimmedString(record.mime ?? record.mimeType, MAX_METADATA_CHARS),
  };
}

function parseHandoffRecord(value: unknown): ParsedSubagentHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode === "inline" || record.mode === "export-file" ? record.mode : undefined;
  if (Object.hasOwn(record, "mode") && !mode) {
    return undefined;
  }
  const candidates =
    mode === "inline"
      ? []
      : [
          record.export,
          ...(Array.isArray(record.exports) ? record.exports : []),
          ...(Array.isArray(record.artifacts) ? record.artifacts : []),
        ];
  const artifacts: SubagentHandoffArtifact[] = [];
  const seenPaths = new Set<string>();
  let omittedArtifactCount = 0;
  for (const candidate of candidates) {
    const artifact = normalizeArtifact(candidate);
    if (!artifact || seenPaths.has(artifact.relativePath)) {
      continue;
    }
    seenPaths.add(artifact.relativePath);
    if (artifacts.length >= MAX_HANDOFF_ARTIFACTS) {
      omittedArtifactCount += 1;
      continue;
    }
    artifacts.push(artifact);
  }
  return {
    mode,
    summary: readTrimmedString(record.summary, MAX_METADATA_CHARS),
    quality: normalizeQuality(record),
    artifacts,
    omittedArtifactCount,
  };
}

function parseHandoffPayload(payload: string): ParsedSubagentHandoff | undefined {
  const trimmed = payload.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return parseHandoffRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function parseSubagentHandoffBlocks(content: string): ParsedSubagentHandoff[] {
  const handoffs: ParsedSubagentHandoff[] = [];
  for (const match of content.matchAll(HANDOFF_BLOCK_PATTERN)) {
    const handoff = parseHandoffPayload(match[1] ?? "");
    if (handoff) {
      handoffs.push(handoff);
    }
  }
  return handoffs;
}

export function analyzeSubagentHandoff(content: string): AnalyzedSubagentHandoff {
  const lowerContent = content.toLowerCase();
  const openIndex = lowerContent.lastIndexOf(HANDOFF_OPEN_TAG_LOWER);
  if (openIndex < 0) {
    return {
      didFindHandoff: false,
      strippedContent: content.trim(),
    };
  }
  const payloadStart = openIndex + HANDOFF_OPEN_TAG.length;
  const closeIndex = lowerContent.indexOf(HANDOFF_CLOSE_TAG_LOWER, payloadStart);
  if (closeIndex < 0) {
    return {
      didFindHandoff: false,
      strippedContent: content.trim(),
    };
  }
  const strippedContent = stripSubagentHandoff(content);
  if (content.slice(closeIndex + HANDOFF_CLOSE_TAG.length).trim()) {
    return {
      didFindHandoff: true,
      strippedContent,
    };
  }
  return {
    didFindHandoff: true,
    strippedContent,
    handoff: parseHandoffPayload(content.slice(payloadStart, closeIndex)),
  };
}

export function parseSubagentHandoff(content: string): ParsedSubagentHandoff | undefined {
  return analyzeSubagentHandoff(content).handoff;
}

export function stripSubagentHandoff(content: string): string {
  return content
    .replace(HANDOFF_BLOCK_PATTERN, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
