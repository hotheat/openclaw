import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createInlineCodeState } from "../markdown/code-spans.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

export function sanitizeAbortedAssistantMessage(
  message: AssistantAgentMessage,
  reason: string,
): AssistantAgentMessage {
  message.content = [];
  message.stopReason = "error";
  message.errorMessage = `Upstream assistant stream was aborted after exceeding the ${reason} safety limit.`;
  return message;
}

export function clearAssistantMessageBuffers(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.deltaBuffer = "";
  ctx.state.blockBuffer = "";
  ctx.blockChunker?.reset();
  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();
  ctx.state.lastStreamedAssistant = undefined;
  ctx.state.lastStreamedAssistantCleaned = undefined;
  ctx.state.reasoningStreamOpen = false;
}
