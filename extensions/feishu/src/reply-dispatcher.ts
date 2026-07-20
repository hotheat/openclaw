import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession, isRetryableFeishuStreamingError } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

const STREAMING_CLOSE_RETRY_DELAYS_MS = [100, 300];

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function appendStreamingText(current: string, next: string): string {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  const separator = current.endsWith("\n") || next.startsWith("\n") ? "" : "\n\n";
  return `${current}${separator}${next}`;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
};

export type FeishuReplyFinalizeResult = {
  status: "not-streaming" | "streamed" | "fallback-card" | "fallback-message";
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";
  const blockStreamingEnabled = account.config?.blockStreaming !== false;

  let streaming: FeishuStreamingSession | null = null;
  let deliveredText = "";
  let previewText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingClosePromise: Promise<FeishuReplyFinalizeResult> | null = null;

  const sendCardReply = async (text: string): Promise<void> => {
    let first = true;
    for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
      await sendMarkdownCardFeishu({
        cfg,
        to: chatId,
        text: chunk,
        replyToMessageId,
        mentions: first ? mentionTargets : undefined,
        accountId,
      });
      first = false;
    }
  };

  const sendPlainReply = async (text: string): Promise<void> => {
    const converted = core.channel.text.convertMarkdownTables(text, tableMode);
    let first = true;
    for (const chunk of core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode)) {
      await sendMessageFeishu({
        cfg,
        to: chatId,
        text: chunk,
        replyToMessageId,
        mentions: first ? mentionTargets : undefined,
        accountId,
      });
      first = false;
    }
  };

  const resetStreamingState = () => {
    streaming = null;
    streamingStartPromise = null;
    deliveredText = "";
    previewText = "";
    lastPartial = "";
  };

  const closeStreamingWithRetry = async (
    session: FeishuStreamingSession,
    text: string,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await session.close(text);
        return;
      } catch (error) {
        const retryDelay = STREAMING_CLOSE_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !isRetryableFeishuStreamingError(error)) {
          throw error;
        }
        params.runtime.error?.(
          `feishu[${account.accountId}]: streaming finalization attempt ${attempt + 1} failed; retrying in ${retryDelay}ms: ${String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId));
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = (): Promise<FeishuReplyFinalizeResult> => {
    if (streamingClosePromise) {
      return streamingClosePromise;
    }
    const closePromise = (async (): Promise<FeishuReplyFinalizeResult> => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      const activeStreaming = streaming?.isActive() ? streaming : null;
      if (!activeStreaming) {
        resetStreamingState();
        return { status: "not-streaming" };
      }

      const finalText = deliveredText || previewText;
      let streamingText = finalText;
      if (mentionTargets?.length) {
        streamingText = buildMentionedCardContent(mentionTargets, streamingText);
      }

      try {
        await closeStreamingWithRetry(activeStreaming, streamingText);
        resetStreamingState();
        return { status: "streamed" };
      } catch (streamingError) {
        params.runtime.error?.(
          `feishu[${account.accountId}]: streaming finalization failed; falling back to a static card: ${String(streamingError)}`,
        );

        if (!finalText.trim()) {
          throw new AggregateError(
            [streamingError],
            "Feishu streaming reply failed without final text for fallback delivery",
          );
        }

        try {
          await sendCardReply(finalText);
          resetStreamingState();
          return { status: "fallback-card" };
        } catch (cardError) {
          params.runtime.error?.(
            `feishu[${account.accountId}]: static card fallback failed; falling back to a plain message: ${String(cardError)}`,
          );
          try {
            await sendPlainReply(finalText);
            resetStreamingState();
            return { status: "fallback-message" };
          } catch (messageError) {
            params.runtime.error?.(
              `feishu[${account.accountId}]: plain message fallback failed: ${String(messageError)}`,
            );
            throw new AggregateError(
              [streamingError, cardError, messageError],
              "Feishu streaming reply and fallback delivery failed",
            );
          }
        }
      }
    })().finally(() => {
      streamingClosePromise = null;
    });
    streamingClosePromise = closePromise;
    return closePromise;
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        if (!text.trim()) {
          return;
        }

        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        if ((info?.kind === "block" || info?.kind === "final") && streamingEnabled && useCard) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        if (streaming?.isActive()) {
          if (info?.kind === "block" || info?.kind === "final") {
            deliveredText = appendStreamingText(deliveredText, text);
          }
          return;
        }

        if (useCard) {
          await sendCardReply(text);
        } else {
          await sendPlainReply(text);
        }
      },
      onError: (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        typingCallbacks.onIdle?.();
      },
      onIdle: () => {
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      disableBlockStreaming: blockStreamingEnabled ? false : true,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text || payload.text === lastPartial) {
              return;
            }
            const text = payload.text;
            lastPartial = text;
            previewText = text;
            partialUpdateQueue = partialUpdateQueue
              .then(async () => {
                if (streamingStartPromise) {
                  await streamingStartPromise;
                }
                if (streaming?.isActive()) {
                  await streaming.update(text);
                }
              })
              .catch((error) => {
                params.runtime.error?.(
                  `feishu[${account.accountId}]: streaming update failed: ${String(error)}`,
                );
              });
          }
        : undefined,
    },
    markDispatchIdle,
    finalize: closeStreaming,
  };
}
