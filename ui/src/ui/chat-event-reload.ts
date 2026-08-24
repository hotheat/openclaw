import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  return payload?.state === "final";
}
