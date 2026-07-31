import { BLUEBUBBLES_GROUP_ACTIONS } from "../../channels/plugins/bluebubbles-actions.js";
import {
  listChannelMessageActions,
  supportsChannelMessageButtons,
  supportsChannelMessageButtonsForChannel,
  supportsChannelMessageCards,
  supportsChannelMessageCardsForChannel,
} from "../../channels/plugins/message-actions.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { stripReasoningTagsFromText } from "../../shared/text/reasoning-tags.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { listChannelSupportedActions } from "../channel-tools.js";
import { isParentWebchatSessionContext } from "../session-surface.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { resolveGatewayOptions } from "./gateway.js";
import { MessageToolSchema, buildMessageToolSchemaFromActions } from "./message-tool-schema.js";

const WEBCHAT_FILE_DELIVERY_ERROR =
  "WebChat file delivery must use webui_artifact_publish; message is only for explicit external channel targets.";
const MESSAGE_MEDIA_KEYS = ["media", "path", "filePath", "mediaUrls"] as const;
const EXPLICIT_TARGET_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "sendWithEffect",
  "sendAttachment",
  "reply",
  "thread-reply",
  "broadcast",
]);

function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return EXPLICIT_TARGET_ACTIONS.has(action);
}

type MessageToolOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  sandboxRoot?: string;
  requireExplicitTarget?: boolean;
  requesterSenderId?: string;
};

function resolveMessageToolSchemaActions(params: {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
  currentChannelId?: string;
}): string[] {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    const scopedActions = filterActionsForContext({
      actions: listChannelSupportedActions({
        cfg: params.cfg,
        channel: currentChannel,
      }),
      channel: currentChannel,
      currentChannelId: params.currentChannelId,
    });
    const withSend = new Set<string>(["send", ...scopedActions]);
    return Array.from(withSend);
  }
  const actions = listChannelMessageActions(params.cfg);
  return actions.length > 0 ? actions : ["send"];
}

function resolveIncludeComponents(params: {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
}): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    return currentChannel === "discord";
  }
  // Components are currently Discord-specific.
  return listChannelSupportedActions({ cfg: params.cfg, channel: "discord" }).length > 0;
}

function buildMessageToolSchema(params: {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
  currentChannelId?: string;
}) {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  const actions = resolveMessageToolSchemaActions(params);
  const includeButtons = currentChannel
    ? supportsChannelMessageButtonsForChannel({ cfg: params.cfg, channel: currentChannel })
    : supportsChannelMessageButtons(params.cfg);
  const includeCards = currentChannel
    ? supportsChannelMessageCardsForChannel({ cfg: params.cfg, channel: currentChannel })
    : supportsChannelMessageCards(params.cfg);
  const includeComponents = resolveIncludeComponents(params);
  return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
    includeButtons,
    includeCards,
    includeComponents,
  });
}

function ensureMessagePluginRegistry(params: { cfg: OpenClawConfig; workspaceDir?: string }) {
  if (params.cfg.plugins?.enabled === false) {
    return;
  }
  loadOpenClawPlugins({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
}

function resolveCurrentToolChannel(raw?: string) {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function injectCurrentToolChannel(
  params: Record<string, unknown>,
  currentChannelProvider?: string,
) {
  const explicitChannel = readStringParam(params, "channel");
  if (explicitChannel) {
    return;
  }
  const currentChannel = resolveCurrentToolChannel(currentChannelProvider);
  if (currentChannel) {
    params.channel = currentChannel;
  }
}

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeAccountId(trimmed);
}

function filterActionsForContext(params: {
  actions: ChannelMessageActionName[];
  channel?: string;
  currentChannelId?: string;
}): ChannelMessageActionName[] {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel !== "bluebubbles") {
    return params.actions;
  }
  const currentChannelId = params.currentChannelId?.trim();
  if (!currentChannelId) {
    return params.actions;
  }
  const normalizedTarget =
    normalizeTargetForProvider(channel, currentChannelId) ?? currentChannelId;
  const lowered = normalizedTarget.trim().toLowerCase();
  const isGroupTarget =
    lowered.startsWith("chat_guid:") ||
    lowered.startsWith("chat_id:") ||
    lowered.startsWith("chat_identifier:") ||
    lowered.startsWith("group:");
  if (isGroupTarget) {
    return params.actions;
  }
  return params.actions.filter((action) => !BLUEBUBBLES_GROUP_ACTIONS.has(action));
}

function buildMessageToolDescription(options?: {
  config?: OpenClawConfig;
  currentChannel?: string;
  currentChannelId?: string;
}): string {
  const baseDescription = "Send, delete, and manage messages via channel plugins.";
  if (normalizeMessageChannel(options?.currentChannel) === "webchat") {
    return `${baseDescription} In WebUI, publish files to the current browser with webui_artifact_publish. Use message only with an explicit deliverable external channel and real target.`;
  }

  // If we have a current channel, show only its supported actions
  if (options?.currentChannel) {
    const channelActions = filterActionsForContext({
      actions: listChannelSupportedActions({
        cfg: options.config,
        channel: options.currentChannel,
      }),
      channel: options.currentChannel,
      currentChannelId: options.currentChannelId,
    });
    if (channelActions.length > 0) {
      // Always include "send" as a base action
      const allActions = new Set(["send", ...channelActions]);
      const actionList = Array.from(allActions).toSorted().join(", ");
      return `${baseDescription} Current channel (${options.currentChannel}) supports: ${actionList}.`;
    }
  }

  // Fallback to generic description with all configured actions
  if (options?.config) {
    const actions = listChannelMessageActions(options.config);
    if (actions.length > 0) {
      return `${baseDescription} Supports actions: ${actions.join(", ")}.`;
    }
  }

  return `${baseDescription} Supports actions: send, delete, react, poll, pin, threads, and more.`;
}

function hasMessageMedia(params: Record<string, unknown>): boolean {
  const hasExplicitMedia = MESSAGE_MEDIA_KEYS.some((key) => {
    const value = params[key];
    return typeof value === "string"
      ? value.trim().length > 0
      : Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim());
  });
  if (hasExplicitMedia) {
    return true;
  }
  const message = readStringParam(params, "message", { trim: false });
  return Boolean(message && splitMediaFromOutput(message).mediaUrls?.length);
}

function isExplicitFeishuTarget(params: Record<string, unknown>): boolean {
  if (normalizeMessageChannel(readStringParam(params, "channel")) !== "feishu") {
    return false;
  }
  const target = readStringParam(params, "target") ?? readStringParam(params, "to");
  return /^(?:user:ou_[A-Za-z0-9_-]+|chat:oc_[A-Za-z0-9_-]+)$/.test(target ?? "");
}

function assertWebchatMessageBoundary(
  params: Record<string, unknown>,
  options: MessageToolOptions | undefined,
  action: ChannelMessageActionName,
): void {
  if (
    !isParentWebchatSessionContext({
      channel: options?.currentChannelProvider,
      sessionKey: options?.agentSessionKey,
    })
  ) {
    return;
  }
  const channel = normalizeMessageChannel(readStringParam(params, "channel"));
  if (channel === "webchat") {
    throw new Error(
      "message channel webchat is not deliverable; reply in the current session or use webui_artifact_publish for files.",
    );
  }
  const target = readStringParam(params, "target") ?? readStringParam(params, "to");
  if (target?.trim().toLowerCase() === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT) {
    throw new Error("gateway-client is a Gateway client identity, not a message target.");
  }
  if (action === "send" && hasMessageMedia(params) && !isExplicitFeishuTarget(params)) {
    throw new Error(WEBCHAT_FILE_DELIVERY_ERROR);
  }
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  const constructionConfig = options?.config;
  if (constructionConfig) {
    ensureMessagePluginRegistry({
      cfg: constructionConfig,
      workspaceDir: options?.workspaceDir,
    });
  }
  const schema = constructionConfig
    ? buildMessageToolSchema({
        cfg: constructionConfig,
        currentChannelProvider: options.currentChannelProvider,
        currentChannelId: options.currentChannelId,
      })
    : MessageToolSchema;
  const description = buildMessageToolDescription({
    config: constructionConfig,
    currentChannel: options?.currentChannelProvider,
    currentChannelId: options?.currentChannelId,
  });

  return {
    label: "Message",
    name: "message",
    description,
    parameters: schema,
    execute: async (_toolCallId, args, signal) => {
      // Check if already aborted before doing any work
      if (signal?.aborted) {
        const err = new Error("Message send aborted");
        err.name = "AbortError";
        throw err;
      }
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };

      // Strip reasoning tags from text fields — models may include <think>…</think>
      // in tool arguments, and the messaging tool send path has no other tag filtering.
      for (const field of ["text", "content", "message", "caption"]) {
        if (typeof params[field] === "string") {
          params[field] = stripReasoningTagsFromText(params[field]);
        }
      }

      const cfg = options?.config ?? loadConfig();
      if (!constructionConfig) {
        ensureMessagePluginRegistry({
          cfg,
          workspaceDir: options?.workspaceDir,
        });
      }
      injectCurrentToolChannel(params, options?.currentChannelProvider);
      const action = readStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      assertWebchatMessageBoundary(params, options, action);
      const requireExplicitTarget = options?.requireExplicitTarget === true;
      if (requireExplicitTarget && actionNeedsExplicitTarget(action)) {
        const explicitTarget =
          (typeof params.target === "string" && params.target.trim().length > 0) ||
          (typeof params.to === "string" && params.to.trim().length > 0) ||
          (typeof params.channelId === "string" && params.channelId.trim().length > 0) ||
          (Array.isArray(params.targets) &&
            params.targets.some((value) => typeof value === "string" && value.trim().length > 0));
        if (!explicitTarget) {
          throw new Error(
            "Explicit message target required for this run. Provide target/targets (and channel when needed).",
          );
        }
      }

      const accountId = readStringParam(params, "accountId") ?? agentAccountId;
      if (accountId) {
        params.accountId = accountId;
      }

      const gatewayResolved = resolveGatewayOptions({
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
      });
      const gateway = {
        url: gatewayResolved.url,
        token: gatewayResolved.token,
        timeoutMs: gatewayResolved.timeoutMs,
        clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        clientDisplayName: "agent",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      };

      const toolContext =
        options?.currentChannelId ||
        options?.currentChannelProvider ||
        options?.currentThreadTs ||
        options?.replyToMode ||
        options?.hasRepliedRef
          ? {
              currentChannelId: options?.currentChannelId,
              currentChannelProvider: options?.currentChannelProvider,
              currentThreadTs: options?.currentThreadTs,
              replyToMode: options?.replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;

      const result = await runMessageAction({
        cfg,
        action,
        params,
        defaultAccountId: accountId ?? undefined,
        requesterSenderId: options?.requesterSenderId,
        gateway,
        toolContext,
        sessionKey: options?.agentSessionKey,
        agentId: options?.agentSessionKey
          ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg })
          : undefined,
        sandboxRoot: options?.sandboxRoot,
        abortSignal: signal,
      });

      const toolResult = getToolResult(result);
      if (toolResult) {
        return toolResult;
      }
      return jsonResult(result.payload);
    },
  };
}
