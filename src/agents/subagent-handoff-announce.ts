import path from "node:path";
import type { PluginHookAcceptedArtifact, PluginHookStagedArtifact } from "../plugins/types.js";
import type {
  ParsedSubagentHandoff,
  SubagentHandoffArtifact,
  SubagentHandoffQuality,
} from "./subagent-handoff.js";

export type SubagentHandoffAnnounceArtifact = SubagentHandoffArtifact & {
  relativePath: string;
  profileId?: string;
  deliveryPolicy?: "auto" | "confirmation";
  verificationStatus: SubagentHandoffQuality["verificationStatus"];
  verificationSummary?: string;
  deliveryStatus: "unmanaged" | "ready" | "warning";
};

export type SubagentHandoffDeliveryIssue = {
  kind: "policy-rejected" | "policy-unavailable" | "staging-failed";
  reason: string;
};

export type SubagentHandoffAnnounceView = {
  summary?: string;
  quality: SubagentHandoffQuality;
  deliverableArtifacts: SubagentHandoffAnnounceArtifact[];
  blocked?: {
    reason: string;
    verificationSummary?: string;
  };
  deliveryIssues: SubagentHandoffDeliveryIssue[];
  omittedArtifactCount: number;
};

function normalizeSafeRelativePath(value: string): string | undefined {
  const raw = value.trim().replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    return undefined;
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized.replace(/^\.\/+/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDocumentationFieldReference(source: string, offset: number, rawValue: string): boolean {
  const value = rawValue
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  if (!["field", "property", "parameter", "setting", "option", "header"].includes(value)) {
    return false;
  }
  const prefix = source.slice(Math.max(0, offset - 80), offset);
  return /\b(?:document|describe|explain|mention|reference)\s+(?:the\s+)?$/i.test(prefix);
}

function scrubAssignedFields(value: string, fieldNames: string, replacement: string): string {
  const pattern = new RegExp(
    `["']?\\b(?:${fieldNames})["']?\\s*([:=])\\s*("[^"]*"|'[^']*'|[^\\s,;\`"'<>()[\\]{}]+)`,
    "gi",
  );
  return value.replace(pattern, (match, separator: string, rawValue: string, offset: number) => {
    const quoted = rawValue.startsWith('"') || rawValue.startsWith("'");
    return separator === ":" && !quoted && isDocumentationFieldReference(value, offset, rawValue)
      ? match
      : replacement;
  });
}

export function scrubSubagentHandoffText(
  value: string | undefined,
  paths: string[],
): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  let scrubbed = value.trim();
  const exactPaths = [...new Set(paths.map((item) => item.trim()).filter(Boolean))].toSorted(
    (left, right) => right.length - left.length,
  );
  for (const exactPath of exactPaths) {
    for (const candidate of [
      exactPath,
      exactPath.replaceAll("\\", "/"),
      exactPath.replaceAll("/", "\\"),
    ]) {
      scrubbed = scrubbed.replace(new RegExp(escapeRegExp(candidate), "g"), "[artifact path]");
    }
  }
  scrubbed = scrubAssignedFields(
    scrubAssignedFields(scrubbed, "token|apiKey|secretKey", "[credential]"),
    "artifactId|artifact_id|objectKey|object_key|fileKey|file_key",
    "[internal id]",
  )
    .replace(/\bhttps?:\/\/[^\s`"'<>]+/gi, "[url]")
    .replace(
      /\bAuthorization\s*:\s*Bearer\s+(?:"[^"]*"|'[^']*'|[^\s,;`"'<>()[\]{}]+)/gi,
      "Authorization: [credential]",
    )
    .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s,;`"'<>()[\]{}]+)/gi, "[credential]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[credential]")
    .replace(
      /(^|[\s`"'(])(?:artifacts|workspace(?:-[A-Za-z0-9._-]+)?)[\\/][^\s`"'<>)]*/gim,
      "$1[artifact path]",
    )
    .replace(
      /(?:[A-Za-z]:[\\/]|\/home\/|\/Users\/|\/var\/|\/tmp\/)[^\s`"'<>)]*/g,
      "[workspace path]",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
  return scrubbed || undefined;
}

function buildPathCorpus(params: {
  handoff: ParsedSubagentHandoff;
  acceptedArtifacts: PluginHookAcceptedArtifact[];
  stagedArtifacts: PluginHookStagedArtifact[];
  workspacePaths?: string[];
}): string[] {
  const artifactPaths = params.handoff.artifacts.map((artifact) => artifact.relativePath);
  const workspacePaths = params.workspacePaths ?? [];
  return [
    ...artifactPaths,
    ...params.acceptedArtifacts.flatMap((artifact) => [
      artifact.sourceRelativePath,
      artifact.requesterRelativePath,
    ]),
    ...params.stagedArtifacts.flatMap((artifact) => [
      artifact.sourceRelativePath,
      artifact.relativePath,
    ]),
    ...workspacePaths.flatMap((workspacePath) =>
      artifactPaths.map((artifactPath) => path.resolve(workspacePath, artifactPath)),
    ),
  ];
}

export function buildRequesterVisibleAcceptedArtifacts(params: {
  handoff: ParsedSubagentHandoff;
  acceptedArtifacts: PluginHookAcceptedArtifact[];
  stagedArtifacts: PluginHookStagedArtifact[];
}): PluginHookStagedArtifact[] {
  const sourceArtifacts = new Map(
    params.handoff.artifacts.map((artifact) => [artifact.relativePath, artifact] as const),
  );
  const stagedBySource = new Map(
    params.stagedArtifacts.map((artifact) => [artifact.sourceRelativePath, artifact] as const),
  );
  const visible: PluginHookStagedArtifact[] = [];
  const seenSources = new Set<string>();
  for (const accepted of params.acceptedArtifacts) {
    if (seenSources.has(accepted.sourceRelativePath)) {
      continue;
    }
    const source = sourceArtifacts.get(accepted.sourceRelativePath);
    const requesterRelativePath = normalizeSafeRelativePath(accepted.requesterRelativePath);
    if (!source || !requesterRelativePath) {
      continue;
    }
    seenSources.add(accepted.sourceRelativePath);
    const staged = stagedBySource.get(accepted.sourceRelativePath);
    visible.push({
      sourceRelativePath: accepted.sourceRelativePath,
      relativePath: requesterRelativePath,
      fileName: staged?.fileName ?? source.fileName,
      title: staged?.title ?? source.title,
      mimeType: staged?.mimeType ?? source.mimeType,
      profileId: staged?.profileId ?? accepted.profileId,
      deliveryPolicy: staged?.deliveryPolicy ?? accepted.deliveryPolicy,
    });
  }
  return visible;
}

export function buildSubagentHandoffAnnounceView(params: {
  handoff: ParsedSubagentHandoff;
  acceptedArtifacts: PluginHookAcceptedArtifact[];
  stagedArtifacts: PluginHookStagedArtifact[];
  deliveryIssues?: SubagentHandoffDeliveryIssue[];
  workspacePaths?: string[];
}): SubagentHandoffAnnounceView {
  const pathCorpus = buildPathCorpus(params);
  const quality: SubagentHandoffQuality = {
    ...params.handoff.quality,
    verificationSummary: scrubSubagentHandoffText(
      params.handoff.quality.verificationSummary,
      pathCorpus,
    ),
  };
  const summary = scrubSubagentHandoffText(params.handoff.summary, pathCorpus);
  const deliveryStatus = quality.deliveryStatus === "blocked" ? undefined : quality.deliveryStatus;
  const visibleAccepted = deliveryStatus ? buildRequesterVisibleAcceptedArtifacts(params) : [];
  const sourceArtifacts = new Map(
    params.handoff.artifacts.map((artifact) => [artifact.relativePath, artifact] as const),
  );
  const deliverableArtifacts: SubagentHandoffAnnounceArtifact[] = [];
  if (deliveryStatus) {
    for (const artifact of visibleAccepted) {
      const source = sourceArtifacts.get(artifact.sourceRelativePath);
      if (!source) {
        continue;
      }
      deliverableArtifacts.push({
        relativePath: artifact.relativePath,
        fileName: artifact.fileName,
        title: scrubSubagentHandoffText(artifact.title, pathCorpus),
        mimeType: artifact.mimeType,
        profileId: artifact.profileId,
        deliveryPolicy: artifact.deliveryPolicy,
        verificationStatus: quality.verificationStatus,
        verificationSummary: quality.verificationSummary,
        deliveryStatus,
      });
    }
  }
  return {
    summary,
    quality,
    deliverableArtifacts,
    blocked:
      quality.deliveryStatus === "blocked"
        ? {
            reason:
              summary ??
              (quality.verificationStatus === "failed"
                ? "Artifact verification failed."
                : "Artifact delivery was blocked by the quality gate."),
            verificationSummary: quality.verificationSummary,
          }
        : undefined,
    deliveryIssues: (params.deliveryIssues ?? []).map((issue) => ({
      kind: issue.kind,
      reason:
        scrubSubagentHandoffText(issue.reason, pathCorpus) ??
        "Artifact delivery could not be completed.",
    })),
    omittedArtifactCount: params.handoff.omittedArtifactCount,
  };
}
