import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";
import { MAX_CHAT_ATTACHMENTS } from "../chat-attachment-limits.js";
import {
  formatValidationErrors,
  ProtocolSchemas,
  validateAgentParams,
  validateChatSendParams,
  validateSubagentsListParams,
  validateSubagentsListResult,
} from "./index.js";

const makeError = (overrides: Partial<ErrorObject>): ErrorObject => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("formatValidationErrors", () => {
  it("returns unknown validation error when missing errors", () => {
    expect(formatValidationErrors(undefined)).toBe("unknown validation error");
    expect(formatValidationErrors(null)).toBe("unknown validation error");
  });

  it("returns unknown validation error when errors list is empty", () => {
    expect(formatValidationErrors([])).toBe("unknown validation error");
  });

  it("formats additionalProperties at root", () => {
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at root: unexpected property 'token'");
  });

  it("formats additionalProperties with instancePath", () => {
    const err = makeError({
      keyword: "additionalProperties",
      instancePath: "/auth",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at /auth: unexpected property 'token'");
  });

  it("formats message with path for other errors", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err])).toBe("at /auth: must have required property 'token'");
  });

  it("de-dupes repeated entries", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err, err])).toBe(
      "at /auth: must have required property 'token'",
    );
  });
});

describe("subagents protocol", () => {
  it("registers strict params and result schemas", () => {
    expect(ProtocolSchemas.SubagentsListParams).toBeDefined();
    expect(ProtocolSchemas.SubagentsListResult).toBeDefined();
    expect(validateSubagentsListParams({ requesterSessionKey: "agent:main:main" })).toBe(true);
    expect(
      validateSubagentsListParams({ requesterSessionKey: "agent:main:main", extra: true }),
    ).toBe(false);
    expect(validateSubagentsListParams({})).toBe(false);
  });

  it("accepts the narrow public DTO and rejects internal fields", () => {
    const result = {
      runs: [
        {
          runId: "run-1",
          childSessionKey: "agent:worker:subagent:child-1",
          label: "worker",
          sessionLabel: "research",
          model: "provider/model",
          spawnMode: "run",
          createdAt: 1,
          startedAt: 2,
          endedAt: 3,
          status: "ok",
        },
      ],
    };
    expect(validateSubagentsListResult(result)).toBe(true);
    expect(
      validateSubagentsListResult({
        runs: [{ ...result.runs[0], task: "private task" }],
      }),
    ).toBe(false);
    expect(
      validateSubagentsListResult({
        runs: [{ ...result.runs[0], status: "done" }],
      }),
    ).toBe(false);
  });
});

describe("attachment protocol", () => {
  const inlineAttachment = {
    type: "image",
    mimeType: "image/png",
    fileName: "dot.png",
    content: "AAAA",
  };

  it("accepts typed attachments and rejects unknown fields", () => {
    const chatParams = {
      sessionKey: "agent:main:main",
      message: "inspect",
      attachments: [inlineAttachment],
      idempotencyKey: "chat-1",
    };
    expect(validateChatSendParams(chatParams)).toBe(true);
    expect(
      validateChatSendParams({
        ...chatParams,
        attachments: [{ ...inlineAttachment, unexpected: true }],
      }),
    ).toBe(false);
    expect(
      validateAgentParams({
        message: "inspect",
        attachments: [inlineAttachment],
        idempotencyKey: "agent-1",
      }),
    ).toBe(true);

    const workspaceAttachment = {
      type: "workspace_file",
      workspacePath: "uploads/webchat/chat-1/report.pdf",
      sizeBytes: 1,
      sha256: "a".repeat(64),
    };
    expect(validateChatSendParams({ ...chatParams, attachments: [workspaceAttachment] })).toBe(
      true,
    );
    expect(
      validateAgentParams({
        message: "inspect",
        attachments: [workspaceAttachment],
        idempotencyKey: "agent-2",
      }),
    ).toBe(false);
  });

  it("rejects attachment arrays over the protocol limit", () => {
    const attachments = Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, () => inlineAttachment);
    expect(
      validateChatSendParams({
        sessionKey: "agent:main:main",
        message: "inspect",
        attachments,
        idempotencyKey: "chat-2",
      }),
    ).toBe(false);
    expect(
      validateAgentParams({ message: "inspect", attachments, idempotencyKey: "agent-2" }),
    ).toBe(false);
  });
});
