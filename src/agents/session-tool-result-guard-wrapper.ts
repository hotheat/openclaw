import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  applyWebchatAttachmentRefsToUserMessage,
  normalizeWebchatAttachmentRefs,
  type WebchatAttachmentRef,
} from "../sessions/webchat-attachment-refs.js";
import { materializeAssistantErrorMessage } from "./pi-embedded-helpers/images.js";
import type { AgentToolMetadata } from "./pi-tools.types.js";
import {
  installSessionToolResultGuard,
  type PendingToolCall,
} from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => PendingToolCall[];
  /** Return pending calls before transcript repair clears them. */
  getPendingToolCalls?: () => PendingToolCall[];
  /** Replace transcript-derived mutation state with the parameters actually executed. */
  updatePendingToolCall?: (params: {
    toolCallId: string;
    toolName: string;
    toolParams: unknown;
    toolMetadata?: AgentToolMetadata;
  }) => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    webchatAttachmentRefs?: readonly WebchatAttachmentRef[];
    allowSyntheticToolResults?: boolean;
    allowedToolNames?: Iterable<string>;
    toolMetadataByName?: ReadonlyMap<string, AgentToolMetadata>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const beforeMessageWrite = hookRunner?.hasHooks("before_message_write")
    ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
        return hookRunner.runBeforeMessageWrite(event, {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
        });
      }
    : undefined;

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? // oxlint-disable-next-line typescript/no-explicit-any
      (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  let pendingWebchatAttachmentRefs: WebchatAttachmentRef[] | undefined;
  try {
    pendingWebchatAttachmentRefs = normalizeWebchatAttachmentRefs(opts?.webchatAttachmentRefs);
  } catch {
    pendingWebchatAttachmentRefs = undefined;
  }
  const transformMessageForPersistence = (message: AgentMessage): AgentMessage => {
    const normalized =
      message.role === "assistant" ? materializeAssistantErrorMessage(message) : message;
    const withProvenance = applyInputProvenanceToUserMessage(normalized, opts?.inputProvenance);
    if (withProvenance.role !== "user" || !pendingWebchatAttachmentRefs) {
      return withProvenance;
    }
    const refs = pendingWebchatAttachmentRefs;
    pendingWebchatAttachmentRefs = undefined;
    try {
      return applyWebchatAttachmentRefsToUserMessage(withProvenance, refs);
    } catch {
      return withProvenance;
    }
  };

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence,
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    allowedToolNames: opts?.allowedToolNames,
    toolMetadataByName: opts?.toolMetadataByName,
    beforeMessageWriteHook: beforeMessageWrite,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).getPendingToolCalls = guard.getPendingToolCalls;
  (sessionManager as GuardedSessionManager).updatePendingToolCall = guard.updatePendingToolCall;
  return sessionManager as GuardedSessionManager;
}
