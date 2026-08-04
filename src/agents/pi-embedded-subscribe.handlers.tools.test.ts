import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";
import { hashToolCall } from "./tool-loop-detection.js";

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<typeof vi.fn>;
} {
  const onBlockReplyFlush = vi.fn();
  const warn = vi.fn();
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      onBlockReplyFlush,
      onAgentEvent: undefined,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      toolSummaryById: new Set<string>(),
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      successfulUserFacingDeliveries: 0,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush };
}

function createSchemaValidationResult(field = "content", issue = "must have required property") {
  return {
    content: [
      {
        type: "text",
        text:
          issue === "invalid"
            ? `Validation failed for tool "write":\n  - ${field}: invalid value\n\nReceived arguments: {}`
            : `Validation failed for tool "write":\n  - ${field}: must have required property '${field}'\n\nReceived arguments: {}`,
      },
    ],
    details: {},
  };
}

describe("handleToolExecutionStart read path checks", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { file_path: "/tmp/example.txt" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: {},
    };

    await handleToolExecutionStart(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("read tool called without path");
  });
});

describe("handleToolExecutionEnd schema validation loop tracking", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  it("records schema validation errors from tool events and emits warning at the third non-required failure", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    const { ctx } = createTestContext();
    ctx.params.sessionKey = "agent:main:test";
    ctx.params.config = { tools: { loopDetection: { enabled: true } } };

    try {
      for (let i = 0; i < 3; i += 1) {
        const toolCallId = `tool-schema-${i}`;
        await handleToolExecutionStart(ctx, {
          type: "tool_execution_start",
          toolName: "write",
          toolCallId,
          args: i === 1 ? { path: "/tmp/out.txt" } : {},
        });
        await handleToolExecutionEnd(ctx, {
          type: "tool_execution_end",
          toolName: "write",
          toolCallId,
          isError: true,
          result: createSchemaValidationResult("content", "invalid"),
        });
      }
    } finally {
      stop();
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(
      expect.objectContaining({
        toolName: "write",
        level: "warning",
        action: "warn",
        detector: "schema_validation_error_repeat",
        count: 3,
      }),
    );
  });

  it("steers without aborting on the third repeated missing-required schema failure", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    const { ctx } = createTestContext();
    const steer = vi.fn().mockResolvedValue(undefined);
    const abortRun = vi.fn();
    ctx.params.sessionKey = "agent:main:test";
    ctx.params.config = { tools: { loopDetection: { enabled: true } } };
    ctx.params.session = { steer } as never;
    ctx.params.abortRun = abortRun;

    try {
      for (let i = 0; i < 3; i += 1) {
        const toolCallId = `tool-schema-critical-${i}`;
        await handleToolExecutionStart(ctx, {
          type: "tool_execution_start",
          toolName: "write",
          toolCallId,
          args: i % 2 === 0 ? {} : { path: "/tmp/out.txt" },
        });
        await handleToolExecutionEnd(ctx, {
          type: "tool_execution_end",
          toolName: "write",
          toolCallId,
          isError: true,
          result: createSchemaValidationResult(),
        });
      }
    } finally {
      stop();
    }

    const warningEvents = emitted.filter((evt) => evt.level === "warning");
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]).toEqual(
      expect.objectContaining({
        toolName: "write",
        level: "warning",
        action: "warn",
        detector: "schema_validation_error_repeat",
        count: 3,
      }),
    );
    expect(steer).toHaveBeenCalledTimes(1);
    expect(String(steer.mock.calls[0]?.[0] ?? "")).toContain("tool-loop protection triggered");
    expect(String(steer.mock.calls[0]?.[0] ?? "")).toContain("write");
    expect(String(steer.mock.calls[0]?.[0] ?? "")).toContain("will be aborted");
    expect(abortRun).not.toHaveBeenCalled();
  });

  it("aborts and steers when the same missing-required schema failure repeats after repair warning", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    const { ctx } = createTestContext();
    const steer = vi.fn().mockResolvedValue(undefined);
    const abortRun = vi.fn();
    ctx.params.sessionKey = "agent:main:test";
    ctx.params.config = { tools: { loopDetection: { enabled: true } } };
    ctx.params.session = { steer } as never;
    ctx.params.abortRun = abortRun;

    try {
      for (let i = 0; i < 4; i += 1) {
        const toolCallId = `tool-schema-critical-${i}`;
        await handleToolExecutionStart(ctx, {
          type: "tool_execution_start",
          toolName: "write",
          toolCallId,
          args: i % 2 === 0 ? {} : { path: "/tmp/out.txt" },
        });
        await handleToolExecutionEnd(ctx, {
          type: "tool_execution_end",
          toolName: "write",
          toolCallId,
          isError: true,
          result: createSchemaValidationResult(),
        });
      }
    } finally {
      stop();
    }

    const warningEvents = emitted.filter((evt) => evt.level === "warning");
    const criticalEvents = emitted.filter((evt) => evt.level === "critical");
    expect(warningEvents).toHaveLength(1);
    expect(criticalEvents).toHaveLength(1);
    expect(criticalEvents[0]).toEqual(
      expect.objectContaining({
        toolName: "write",
        level: "critical",
        action: "block",
        detector: "schema_validation_error_repeat",
        count: 4,
      }),
    );
    expect(steer).toHaveBeenCalledTimes(2);
    expect(abortRun).toHaveBeenCalledTimes(1);
    const abortReason = abortRun.mock.calls[0]?.[0];
    expect(abortReason).toBeInstanceOf(Error);
    expect(String((abortReason as Error).message)).toContain("after a repair warning");
  });

  it("does not mix start data across runs with the same toolCallId", async () => {
    const { ctx } = createTestContext();
    ctx.params.sessionKey = "agent:main:test";
    ctx.params.config = {};
    const toolCallId = "reused-tool-call";

    ctx.params.runId = "run-a";
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "write",
      toolCallId,
      args: { path: "/tmp/a.txt" },
    });

    ctx.params.runId = "run-b";
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "write",
      toolCallId,
      args: { path: "/tmp/b.txt" },
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "write",
      toolCallId,
      isError: true,
      result: createSchemaValidationResult(),
    });

    const state = getDiagnosticSessionState({
      sessionKey: ctx.params.sessionKey,
      sessionId: ctx.params.sessionKey,
    });
    const recorded = state.toolCallHistory?.at(-1);
    expect(recorded?.argsHash).toBe(hashToolCall("write", { path: "/tmp/b.txt" }));
    expect(recorded?.argsHash).not.toBe(hashToolCall("write", { path: "/tmp/a.txt" }));
  });
});

describe("handleToolExecutionEnd cron.add commitment tracking", () => {
  it("increments successfulCronAdds when cron add succeeds", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        isError: false,
        result: { details: { status: "ok" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(1);
  });

  it("does not increment successfulCronAdds when cron add fails", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        isError: true,
        result: { details: { status: "error" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(0);
  });
});

describe("handleToolExecutionEnd user-facing delivery tracking", () => {
  it("tracks successful tools declared as user-facing deliveries", async () => {
    const { ctx } = createTestContext();
    ctx.params.toolMetadataByName = new Map([
      ["webui_artifact_publish", { sideEffect: "mutating", deliveryEffect: "user_facing" }],
    ]);

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "webui_artifact_publish",
      toolCallId: "tool-artifact-1",
      args: { filePath: "report.pdf" },
    } as ToolExecutionStartEvent);
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "webui_artifact_publish",
      toolCallId: "tool-artifact-1",
      isError: false,
      result: { details: { artifactId: "artifact-1" } },
    } as ToolExecutionEndEvent);

    expect(ctx.state.successfulUserFacingDeliveries).toBe(1);
  });

  it("does not track failed user-facing delivery tools", async () => {
    const { ctx } = createTestContext();
    ctx.params.toolMetadataByName = new Map([
      ["webui_artifact_publish", { sideEffect: "mutating", deliveryEffect: "user_facing" }],
    ]);

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "webui_artifact_publish",
      toolCallId: "tool-artifact-2",
      args: { filePath: "report.pdf" },
    } as ToolExecutionStartEvent);
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "webui_artifact_publish",
      toolCallId: "tool-artifact-2",
      isError: true,
      result: { details: { status: "error" } },
    } as ToolExecutionEndEvent);

    expect(ctx.state.successfulUserFacingDeliveries).toBe(0);
  });
});

describe("messaging tool media URL tracking", () => {
  it("tracks media arg from messaging tool as pending", async () => {
    const { ctx } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m1",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-m1")).toEqual(["file:///img.jpg"]);
  });

  it("commits pending media URL on tool success", async () => {
    const { ctx } = createTestContext();

    // Simulate start
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    // Simulate successful end
    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2",
      isError: false,
      result: { ok: true },
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toContain("file:///img.jpg");
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m2")).toBe(false);
  });

  it("commits mediaUrls from tool result payload", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2b",
      args: { action: "send", to: "channel:123", content: "hi" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2b",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
          },
        ],
      },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual([
      "file:///img-a.jpg",
      "file:///img-b.jpg",
    ]);
  });

  it("trims messagingToolSentMediaUrls to 200 on commit (FIFO)", async () => {
    const { ctx } = createTestContext();

    // Replace mock with a real trim that replicates production cap logic.
    const MAX = 200;
    ctx.trimMessagingToolSent = () => {
      if (ctx.state.messagingToolSentTexts.length > MAX) {
        const overflow = ctx.state.messagingToolSentTexts.length - MAX;
        ctx.state.messagingToolSentTexts.splice(0, overflow);
        ctx.state.messagingToolSentTextsNormalized.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentTargets.length > MAX) {
        const overflow = ctx.state.messagingToolSentTargets.length - MAX;
        ctx.state.messagingToolSentTargets.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentMediaUrls.length > MAX) {
        const overflow = ctx.state.messagingToolSentMediaUrls.length - MAX;
        ctx.state.messagingToolSentMediaUrls.splice(0, overflow);
      }
    };

    // Pre-fill with 200 URLs (url-0 .. url-199)
    for (let i = 0; i < 200; i++) {
      ctx.state.messagingToolSentMediaUrls.push(`file:///img-${i}.jpg`);
    }
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);

    // Commit one more via start → end
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-cap",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img-new.jpg" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-cap",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    // Should be capped at 200, oldest removed, newest appended.
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);
    expect(ctx.state.messagingToolSentMediaUrls[0]).toBe("file:///img-1.jpg");
    expect(ctx.state.messagingToolSentMediaUrls[199]).toBe("file:///img-new.jpg");
    expect(ctx.state.messagingToolSentMediaUrls).not.toContain("file:///img-0.jpg");
  });

  it("discards pending media URL on tool error", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m3",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m3",
      isError: true,
      result: "Error: failed",
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(0);
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m3")).toBe(false);
  });
});

describe("lastToolError retention", () => {
  it("retains non-mutating tool errors after later successful read-only calls", async () => {
    const { ctx } = createTestContext();
    ctx.state.lastToolError = {
      toolName: "web_search",
      meta: "query: ezh1/2",
      error: "fetch failed",
      mutatingAction: false,
    };
    ctx.state.toolMetaById.set("tool-keep", {
      meta: "query: ezh1/2",
      mutatingAction: false,
      userFacingDelivery: false,
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "web_search",
      toolCallId: "tool-keep",
      isError: false,
      result: { details: { status: "ok" } },
    });

    expect(ctx.state.lastToolError).toEqual(
      expect.objectContaining({
        toolName: "web_search",
        error: "fetch failed",
      }),
    );
  });

  it("clears mutating tool errors when the same action succeeds", async () => {
    const { ctx } = createTestContext();
    ctx.state.lastToolError = {
      toolName: "write",
      meta: "/tmp/report.md",
      error: "permission denied",
      mutatingAction: true,
      actionFingerprint: "tool=write|path=/tmp/report.md",
    };
    ctx.state.toolMetaById.set("tool-clear", {
      meta: "/tmp/report.md",
      mutatingAction: true,
      actionFingerprint: "tool=write|path=/tmp/report.md",
      userFacingDelivery: false,
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "tool-clear",
      isError: false,
      result: { details: { status: "ok" } },
    });

    expect(ctx.state.lastToolError).toBeUndefined();
  });

  it("clears a failed message media send after a corrected-path retry succeeds", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-message-failed",
      args: {
        action: "send",
        channel: "feishu",
        filePath: "/tmp/report.html",
      },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-message-failed",
      isError: true,
      result: "Error: Feishu media send failed",
    });

    expect(ctx.state.lastToolError).toEqual(
      expect.objectContaining({
        toolName: "message",
        mutatingAction: true,
      }),
    );

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-message-recovered",
      args: {
        action: "send",
        channel: "feishu",
        filePath: "/workspace/.outbox/report.html",
      },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-message-recovered",
      isError: false,
      result: {
        channel: "feishu",
        result: {
          messageId: "om_test",
        },
      },
    });

    expect(ctx.state.lastToolError).toBeUndefined();
  });
});
