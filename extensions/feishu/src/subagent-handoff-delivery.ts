import path from "node:path";
import type {
  ClawdbotConfig,
  OpenResult,
  PluginHookHandlerMap,
  PluginHookSubagentHandoffDeliveryResult,
} from "openclaw/plugin-sdk";
import { root } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import {
  bytesToMbCeil,
  FeishuMediaLimitError,
  resolveFeishuOutboundLimitBytes,
} from "./media-limits.js";
import { isImageFileName, sendMediaFeishu } from "./media.js";

type SendMedia = typeof sendMediaFeishu;
type OpenRequesterArtifact = (params: {
  rootDir: string;
  relativePath: string;
}) => Promise<OpenResult>;

async function openRequesterArtifact(params: {
  rootDir: string;
  relativePath: string;
}): Promise<OpenResult> {
  return await (
    await root(params.rootDir)
  ).open(params.relativePath, {
    hardlinks: "allow",
    nonBlockingRead: true,
  });
}

function normalizeTarget(value: string | undefined): string {
  const target = value?.trim() ?? "";
  if (target.toLowerCase().startsWith("channel:")) {
    return target.slice("channel:".length).trim();
  }
  if (target.toLowerCase().startsWith("feishu:")) {
    return target.slice("feishu:".length).trim();
  }
  return target;
}

async function readRequesterArtifact(params: {
  workspaceDir: string;
  relativePath: string;
  kind: "image" | "file";
  maxBytes: number;
  openFile: OpenRequesterArtifact;
}): Promise<Buffer> {
  const opened = await params.openFile({
    rootDir: params.workspaceDir,
    relativePath: params.relativePath,
  });
  try {
    if (opened.stat.size > params.maxBytes) {
      throw new FeishuMediaLimitError({
        direction: "outbound",
        kind: params.kind,
        limitMb: bytesToMbCeil(params.maxBytes),
        actualMb: bytesToMbCeil(opened.stat.size),
      });
    }
    return await opened.handle.readFile();
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export function createFeishuSubagentHandoffDeliveryHandler(params: {
  cfg: ClawdbotConfig;
  sendMedia?: SendMedia;
  openFile?: OpenRequesterArtifact;
}): PluginHookHandlerMap["subagent_handoff_delivery"] {
  const sendMedia = params.sendMedia ?? sendMediaFeishu;
  const openFile = params.openFile ?? openRequesterArtifact;
  return async (event): Promise<PluginHookSubagentHandoffDeliveryResult | undefined> => {
    if (event.requesterOrigin?.channel?.trim().toLowerCase() !== "feishu") {
      return undefined;
    }

    const target = normalizeTarget(event.requesterOrigin.to);
    const deliveredArtifacts: string[] = [];
    const failures: NonNullable<PluginHookSubagentHandoffDeliveryResult["failures"]> = [];
    if (!target) {
      return {
        handled: true,
        deliveredArtifacts,
        failures: event.artifacts.map((artifact) => ({
          relativePath: artifact.relativePath,
          message: "Feishu artifact delivery target is unavailable",
        })),
      };
    }

    for (const artifact of event.artifacts) {
      if (event.signal?.aborted) {
        failures.push({
          relativePath: artifact.relativePath,
          message: "Feishu artifact delivery was cancelled",
        });
        continue;
      }
      try {
        const fileName = artifact.fileName ?? path.posix.basename(artifact.relativePath);
        const kind = isImageFileName(fileName) ? "image" : "file";
        const account = resolveFeishuAccount({
          cfg: params.cfg,
          accountId: event.requesterOrigin.accountId,
        });
        const mediaBuffer = await readRequesterArtifact({
          workspaceDir: event.requesterWorkspaceDir,
          relativePath: artifact.relativePath,
          kind,
          maxBytes: resolveFeishuOutboundLimitBytes({
            config: account.config,
            kind,
          }),
          openFile,
        });
        await sendMedia({
          cfg: params.cfg,
          to: target,
          mediaBuffer,
          fileName,
          replyToMessageId:
            typeof event.requesterOrigin.threadId === "string" &&
            event.requesterOrigin.threadId.startsWith("om_")
              ? event.requesterOrigin.threadId
              : undefined,
          accountId: event.requesterOrigin.accountId?.trim() || undefined,
        });
        deliveredArtifacts.push(artifact.relativePath);
      } catch (error) {
        failures.push({
          relativePath: artifact.relativePath,
          message: error instanceof Error ? error.message : "Feishu artifact delivery failed",
        });
      }
    }

    return {
      handled: true,
      deliveredArtifacts,
      failures,
    };
  };
}
