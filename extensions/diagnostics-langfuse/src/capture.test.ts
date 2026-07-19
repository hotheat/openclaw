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
        skillName: "research",
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
      skillName: "research",
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

  it("llm_text summarizes Pi toolCall/toolResult payloads in generation input", () => {
    const captured = captureGenerationStart(
      {
        provider: "openai",
        model: "gpt-5.1",
        historyMessages: [],
        inputMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "checking" },
              {
                type: "toolCall",
                id: "call-1",
                name: "read_file",
                arguments: { path: "/etc/secrets", token: "FULL-TOOL-ARGS" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            content: [
              { type: "text", text: "FULL-TOOL-RESULT" },
              { type: "image", data: "BASE64-IMAGE-DATA", mimeType: "image/png" },
            ],
            isError: false,
          },
        ],
        imagesCount: 1,
        roundIndex: 2,
      },
      "llm_text",
    );
    const messages = (captured.input as { messages: unknown[] }).messages;
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "toolCall",
            id: "call-1",
            name: "read_file",
            argumentsType: "object",
            argumentsLength: expect.any(Number),
            argumentsKeys: ["path", "token"],
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        contentItems: 2,
        textChars: "FULL-TOOL-RESULT".length,
        imageCount: 1,
        imageDataChars: "BASE64-IMAGE-DATA".length,
        status: "success",
      },
    ]);
    expect(JSON.stringify(captured.input)).not.toContain("FULL-TOOL-ARGS");
    expect(JSON.stringify(captured.input)).not.toContain("FULL-TOOL-RESULT");
    expect(JSON.stringify(captured.input)).not.toContain("BASE64-IMAGE-DATA");
    expect(captured.metadata).toMatchObject({
      historyMessages: 0,
      inputMessages: 2,
      roundIndex: 2,
    });
  });

  it("llm_text preserves user text but summarizes image data", () => {
    const captured = captureGenerationStart(
      {
        provider: "openai",
        model: "gpt-5.1",
        historyMessages: [],
        inputMessages: [
          {
            role: "user",
            content: [
              { type: "text", text: "compare these" },
              { type: "image", data: "USER-IMAGE-BASE64", mimeType: "image/png" },
            ],
          },
        ],
        imagesCount: 1,
        roundIndex: 1,
      },
      "llm_text",
    );
    expect(captured).toMatchObject({
      input: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "compare these" },
              {
                type: "image",
                mimeType: "image/png",
                dataLength: "USER-IMAGE-BASE64".length,
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(captured.input)).not.toContain("USER-IMAGE-BASE64");
  });

  it("captures final generation classification", () => {
    expect(
      captureGenerationEnd(
        {
          assistantTexts: ["answer"],
          roundIndex: 3,
          finishReason: "stop",
          responseKind: "final",
          isFinal: true,
        },
        "llm_text",
      ),
    ).toMatchObject({
      output: ["answer"],
      metadata: {
        roundIndex: 3,
        finishReason: "stop",
        responseKind: "final",
        isFinal: true,
      },
    });
  });

  it("captures pure Pi tool-call generation output by capture mode", () => {
    const lastAssistant = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          arguments: {
            path: "/private/data",
            token: "FULL-TOOL-ARGS",
          },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.1",
      stopReason: "toolUse",
      timestamp: 1,
    };
    const event = {
      assistantTexts: [],
      lastAssistant,
      finishReason: "toolUse",
      responseKind: "tool_call" as const,
      isFinal: false,
    };

    const llmText = captureGenerationEnd(event, "llm_text");
    expect(llmText.output).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          argumentsType: "object",
          argumentsLength: expect.any(Number),
          argumentsKeys: ["path", "token"],
        },
      ],
    });
    expect(JSON.stringify(llmText.output)).not.toContain("FULL-TOOL-ARGS");
    expect(llmText.metadata).toMatchObject({
      assistantTextCount: 0,
      responseKind: "tool_call",
    });

    expect(captureGenerationEnd(event, "full").output).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          arguments: {
            path: "/private/data",
            token: "[redacted]",
          },
        },
      ],
      stopReason: "toolUse",
    });
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

  it("full mode does not append a prompt already present in history", () => {
    const currentUser = {
      role: "user",
      content: [{ type: "text", text: "current user" }],
      timestamp: 2,
    };
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
            currentUser,
          ],
          historyIncludesPrompt: true,
          inputMessages: [currentUser],
          imagesCount: 0,
        },
        "full",
      ).input,
    ).toMatchObject({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "previous user" },
        { role: "assistant", content: "previous assistant" },
        currentUser,
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
