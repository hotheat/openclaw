import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { stripOpenClawPrivateFields } from "../sessions/webchat-attachment-refs.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

describe("guardSessionManager integration", () => {
  it("is a no-op for non-WebChat messages without refs", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const message = { role: "user", content: "plain channel message" } as AgentMessage;
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(message);

    const persisted = sm.getEntries().find((entry) => entry.type === "message");
    expect(persisted?.type === "message" ? persisted.message : undefined).toEqual(message);
  });

  it("preserves marker content when private ref preparation fails", () => {
    const brokenRefs = new Proxy(
      [{ attachmentId: "53ff15ed-8063-42a2-a589-032f2874738f", ordinal: 0 }],
      {
        get(target, property, receiver) {
          if (property === "0") {
            throw new Error("metadata unavailable");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const sm = guardSessionManager(SessionManager.inMemory(), {
      webchatAttachmentRefs: brokenRefs,
    });
    const marker =
      "[media attached: uploads/webchat/chat_1/53ff15ed-8063-42a2-a589-032f2874738f-file.png]";
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    expect(() => appendMessage({ role: "user", content: marker } as AgentMessage)).not.toThrow();

    const persisted = sm.getEntries().find((entry) => entry.type === "message");
    expect(JSON.stringify(persisted)).toContain(marker);
    expect(JSON.stringify(persisted)).not.toContain("__openclaw");
  });

  it("persists WebChat refs once and keeps them after reopening the session", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-refs-"));
    try {
      const sm = guardSessionManager(SessionManager.create(tempDir, tempDir), {
        webchatAttachmentRefs: [
          { attachmentId: "53ff15ed-8063-42a2-a589-032f2874738f", ordinal: 0 },
        ],
      });
      const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
      appendMessage({ role: "user", content: "first" } as AgentMessage);
      appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      } as AgentMessage);
      appendMessage({ role: "user", content: "steer" } as AgentMessage);
      expect(JSON.stringify(sm.getEntries())).toContain("__openclaw");

      const sessionFile = sm.getSessionFile();
      if (!sessionFile) {
        throw new Error("expected persisted session file");
      }
      const reopened = SessionManager.open(sessionFile);
      const persistedMessages = fs
        .readFileSync(sessionFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type?: string;
              message?: AgentMessage & { __openclaw?: unknown };
            },
        )
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      expect(persistedMessages[0]?.__openclaw).toEqual({
        attachments: [{ attachmentId: "53ff15ed-8063-42a2-a589-032f2874738f", ordinal: 0 }],
      });
      expect(persistedMessages[1]?.__openclaw).toBeUndefined();
      const reloadedContext = reopened.buildSessionContext().messages;
      expect(JSON.stringify(reloadedContext)).toContain("__openclaw");
      expect(JSON.stringify(stripOpenClawPrivateFields(reloadedContext))).not.toContain(
        "__openclaw",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists synthetic toolResult before subsequent assistant message", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "followup" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(sanitizeToolUseResultPairing(messages).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});
