import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

export function estimateAgentMessageTokens(message: AgentMessage): number {
  try {
    return estimateTokens(message);
  } catch {
    try {
      return Math.ceil(JSON.stringify(message).length / 4);
    } catch {
      return 256;
    }
  }
}

export function estimateAgentMessagesTokens(messages: AgentMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateAgentMessageTokens(message);
  }
  return Math.ceil(tokens);
}
