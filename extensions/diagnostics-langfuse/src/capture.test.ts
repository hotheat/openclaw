import { describe, expect, it } from "vitest";
import {
  captureGenerationEnd,
  captureGenerationStart,
  captureToolEnd,
  captureToolStart,
} from "./capture.js";

describe("Langfuse capture policy", () => {
  it("safe mode keeps structure but drops prompt and tool payloads", () => {
    const generation = captureGenerationStart(
      {
        provider: "openai",
        model: "gpt-5.1",
        systemPrompt: "secret system",
        prompt: "full prompt",
        historyMessages: [{ role: "user", content: "history" }],
        imagesCount: 1,
      },
      "safe",
    );
    const tool = captureToolStart(
      {
        toolName: "sessions_spawn",
        toolCallId: "tool-1",
        params: { message: "research task" },
      },
      "safe",
    );

    expect(generation.input).toBeUndefined();
    expect(generation.metadata).toMatchObject({
      provider: "openai",
      model: "gpt-5.1",
      promptChars: 11,
      historyMessages: 1,
      imagesCount: 1,
    });
    expect(tool.input).toBeUndefined();
    expect(tool.metadata).toMatchObject({
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      paramKeys: ["message"],
    });
  });

  it("llm_text captures model text but still summarizes tool payloads", () => {
    expect(
      captureGenerationStart(
        {
          provider: "openai",
          model: "gpt-5.1",
          prompt: "full prompt",
          historyMessages: [],
          imagesCount: 0,
        },
        "llm_text",
      ).input,
    ).toMatchObject({ prompt: "full prompt" });
    expect(captureGenerationEnd({ assistantTexts: ["answer"] }, "llm_text").output).toEqual([
      "answer",
    ]);
    expect(captureToolEnd({ result: { secret: "value" } }, "llm_text").output).toBeUndefined();
  });

  it("full mode formats generation input as replayable messages", () => {
    expect(
      captureGenerationStart(
        {
          provider: "openai",
          model: "gpt-5.1",
          systemPrompt: "system",
          prompt: "current user",
          historyMessages: [
            { role: "user", content: "previous user" },
            { role: "assistant", content: "previous assistant" },
          ],
          imagesCount: 0,
        },
        "full",
      ).input,
    ).toMatchObject({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "previous user" },
        { role: "assistant", content: "previous assistant" },
        { role: "user", content: "current user" },
      ],
    });
  });

  it("full mode captures masked tool payloads", () => {
    expect(
      captureToolStart(
        {
          toolName: "exec",
          toolCallId: "tool-1",
          params: { command: "echo hi", token: "secret" },
        },
        "full",
      ).input,
    ).toEqual({ command: "echo hi", token: "[redacted]" });
  });

  it("full mode formats tool output with ToolMessage semantics", () => {
    expect(
      captureToolEnd(
        {
          result: {
            content: [{ type: "text", text: "done" }],
            details: { ok: true },
          },
        },
        "full",
        { toolName: "exec", toolCallId: "tool-1" },
      ).output,
    ).toMatchObject({
      outputMessage: {
        role: "tool",
        tool_call_id: "tool-1",
        name: "exec",
        content: [{ type: "text", text: "done" }],
        status: "success",
      },
    });
  });

  it("safe mode keeps sessions_spawn locator fields only", () => {
    expect(
      captureToolEnd(
        {
          result: {
            runId: "child-run",
            childSessionKey: "agent:researcher:child",
            task: "full task text",
            secret: "value",
          },
        },
        "safe",
        "sessions_spawn",
      ).output,
    ).toEqual({
      runId: "child-run",
      childSessionKey: "agent:researcher:child",
    });
  });
});
