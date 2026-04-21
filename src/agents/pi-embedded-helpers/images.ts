import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "../usage.js";
import { stripThoughtSignatures } from "./bootstrap.js";
import { formatRawAssistantErrorForUi } from "./errors.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isEmptyAssistantMessageContent(message: AssistantMessage): boolean {
  const content = message.content;
  if (content == null) {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type !== "text") {
      return false;
    }
    return typeof rec.text !== "string" || rec.text.trim().length === 0;
  });
}

function hasMeaningfulAssistantContent(content: AssistantMessage["content"]): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type !== "text") {
      return true;
    }
    return typeof rec.text === "string" && rec.text.trim().length > 0;
  });
}

export function normalizeSilentAssistantCompletionMessage(
  message: AssistantMessage,
): AssistantMessage {
  if (message.api !== "openai-responses" || message.stopReason !== "stop") {
    return message;
  }
  if (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0) {
    return message;
  }
  if (!isEmptyAssistantMessageContent(message)) {
    return message;
  }
  const usage = normalizeUsage(message.usage as UsageLike | undefined);
  if (hasNonzeroUsage(usage)) {
    return message;
  }
  return {
    ...message,
    stopReason: "error",
    errorMessage: "OpenAI Responses stream ended without response.completed or assistant output.",
  };
}

export function materializeAssistantErrorMessage(message: AssistantMessage): AssistantMessage {
  const normalized = normalizeSilentAssistantCompletionMessage(message);
  if (normalized.stopReason !== "error") {
    return normalized;
  }
  if (hasMeaningfulAssistantContent(normalized.content)) {
    return normalized;
  }
  return {
    ...normalized,
    content: [
      {
        type: "text",
        text: formatRawAssistantErrorForUi(normalized.errorMessage),
      },
    ] as typeof normalized.content,
  };
}

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: {
    sanitizeMode?: "full" | "images-only";
    sanitizeToolCallIds?: boolean;
    /**
     * Mode for tool call ID sanitization:
     * - "strict" (alphanumeric only)
     * - "strict9" (alphanumeric only, length 9)
     */
    toolCallIdMode?: ToolCallIdMode;
    preserveSignatures?: boolean;
    sanitizeThoughtSignatures?: {
      allowBase64Only?: boolean;
      includeCamelCase?: boolean;
    };
  } & ImageSanitizationLimits,
): Promise<AgentMessage[]> {
  const sanitizeMode = options?.sanitizeMode ?? "full";
  const allowNonImageSanitization = sanitizeMode === "full";
  const imageSanitization = {
    maxDimensionPx: options?.maxDimensionPx,
    maxBytes: options?.maxBytes,
  };
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (default max side 1200px).
  const sanitizedIds =
    allowNonImageSanitization && options?.sanitizeToolCallIds
      ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode)
      : messages;
  const out: AgentMessage[] = [];
  for (const msg of sanitizedIds) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = (await sanitizeContentBlocksImages(
        content,
        label,
        imageSanitization,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
          imageSanitization,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = normalizeSilentAssistantCompletionMessage(
        msg as Extract<AgentMessage, { role: "assistant" }>,
      );
      if (assistantMsg.stopReason === "error") {
        const content = assistantMsg.content;
        if (Array.isArray(content)) {
          const nextContent = (await sanitizeContentBlocksImages(
            content as unknown as ContentBlock[],
            label,
            imageSanitization,
          )) as unknown as typeof assistantMsg.content;
          out.push(materializeAssistantErrorMessage({ ...assistantMsg, content: nextContent }));
        } else {
          out.push(materializeAssistantErrorMessage(assistantMsg));
        }
        continue;
      }
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        if (!allowNonImageSanitization) {
          const nextContent = (await sanitizeContentBlocksImages(
            content as unknown as ContentBlock[],
            label,
            imageSanitization,
          )) as unknown as typeof assistantMsg.content;
          out.push({ ...assistantMsg, content: nextContent });
          continue;
        }
        const strippedContent = options?.preserveSignatures
          ? content // Keep signatures for Antigravity Claude
          : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini

        const filteredContent = strippedContent.filter((block) => {
          if (!block || typeof block !== "object") {
            return true;
          }
          const rec = block as { type?: unknown; text?: unknown };
          if (rec.type !== "text" || typeof rec.text !== "string") {
            return true;
          }
          return rec.text.trim().length > 0;
        });
        const finalContent = (await sanitizeContentBlocksImages(
          filteredContent as unknown as ContentBlock[],
          label,
          imageSanitization,
        )) as unknown as typeof assistantMsg.content;
        if (finalContent.length === 0) {
          continue;
        }
        out.push({ ...assistantMsg, content: finalContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
