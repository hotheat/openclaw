import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

type ImageContentBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
};

type TextContentBlock = {
  type: "text";
  text: string;
};

type ModelWithImageLimit = Model<Api> & {
  maxImagesPerPrompt?: unknown;
};

export function resolveMaxImagesPerPrompt(model: Model<Api>): number | undefined {
  const raw = (model as ModelWithImageLimit).maxImagesPerPrompt;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return undefined;
  }
  return raw;
}

function isImageContentBlock(block: unknown): block is ImageContentBlock {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function makeOmittedImageText(block: ImageContentBlock): TextContentBlock {
  const mime =
    typeof block.mimeType === "string" && block.mimeType.trim() ? block.mimeType : "image";
  return {
    type: "text",
    text: `[image omitted from model context: ${mime}; reason=maxImagesPerPrompt]`,
  };
}

export function limitImagesPerPromptInMessages(
  messages: AgentMessage[],
  maxImagesPerPrompt: number | undefined,
): { messages: AgentMessage[]; omitted: number; kept: number } {
  if (maxImagesPerPrompt === undefined) {
    return { messages, omitted: 0, kept: 0 };
  }

  const imageRefs: Array<{ messageIndex: number; blockIndex: number }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const content = (messages[messageIndex] as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      if (isImageContentBlock(content[blockIndex])) {
        imageRefs.push({ messageIndex, blockIndex });
      }
    }
  }

  const omitCount = Math.max(0, imageRefs.length - maxImagesPerPrompt);
  if (omitCount === 0) {
    return { messages, omitted: 0, kept: imageRefs.length };
  }

  const omitKeys = new Set(
    imageRefs.slice(0, omitCount).map((ref) => `${ref.messageIndex}:${ref.blockIndex}`),
  );
  const nextMessages = messages.map((message, messageIndex) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return message;
    }

    let changed = false;
    const nextContent = content.map((block, blockIndex) => {
      if (!omitKeys.has(`${messageIndex}:${blockIndex}`) || !isImageContentBlock(block)) {
        return block;
      }
      changed = true;
      return makeOmittedImageText(block);
    });

    return changed ? ({ ...message, content: nextContent } as AgentMessage) : message;
  });

  return {
    messages: nextMessages,
    omitted: omitCount,
    kept: imageRefs.length - omitCount,
  };
}
