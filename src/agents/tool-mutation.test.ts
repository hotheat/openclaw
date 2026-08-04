import { describe, expect, it } from "vitest";
import {
  buildToolActionFingerprint,
  buildToolMutationState,
  isLikelyMutatingToolName,
  isMutatingToolCall,
  isSameToolMutationAction,
} from "./tool-mutation.js";

describe("tool mutation helpers", () => {
  it("treats session_status as mutating only when model override is provided", () => {
    expect(isMutatingToolCall("session_status", { sessionKey: "agent:main:main" })).toBe(false);
    expect(
      isMutatingToolCall("session_status", {
        sessionKey: "agent:main:main",
        model: "openai/gpt-4o",
      }),
    ).toBe(true);
  });

  it("builds stable fingerprints for mutating calls and omits read-only calls", () => {
    const writeFingerprint = buildToolActionFingerprint(
      "write",
      { path: "/tmp/demo.txt", id: 42 },
      "write /tmp/demo.txt",
    );
    expect(writeFingerprint).toContain("tool=write");
    expect(writeFingerprint).toContain("path=/tmp/demo.txt");
    expect(writeFingerprint).toContain("id=42");
    expect(writeFingerprint).not.toContain("meta=write /tmp/demo.txt");

    const metaOnlyFingerprint = buildToolActionFingerprint("exec", { command: "ls -la" }, "ls -la");
    expect(metaOnlyFingerprint).toContain("tool=exec");
    expect(metaOnlyFingerprint).toContain("meta=ls -la");

    const readFingerprint = buildToolActionFingerprint("read", { path: "/tmp/demo.txt" });
    expect(readFingerprint).toBeUndefined();
  });

  it("exposes mutation state for downstream payload rendering", () => {
    expect(
      buildToolMutationState("message", { action: "send", to: "telegram:1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("browser", { action: "list" }).mutatingAction).toBe(false);
  });

  it("matches message media retries when only the local file path changes", () => {
    const failed = buildToolActionFingerprint("message", {
      action: "send",
      channel: "feishu",
      target: "oc_test",
      filePath: "/tmp/report.html",
    });
    const recovered = buildToolActionFingerprint("message", {
      action: "send",
      channel: "feishu",
      target: "oc_test",
      filePath: "/workspace/.outbox/report.html",
    });
    const otherTarget = buildToolActionFingerprint("message", {
      action: "send",
      channel: "feishu",
      target: "oc_other",
      filePath: "/workspace/.outbox/report.html",
    });
    const textOnly = buildToolActionFingerprint("message", {
      action: "send",
      channel: "feishu",
      target: "oc_test",
      message: "report delivered",
    });

    expect(failed).toBe(recovered);
    expect(failed).toContain("delivery=media");
    expect(failed).not.toContain("filepath=");
    expect(otherTarget).not.toBe(failed);
    expect(textOnly).not.toBe(failed);
  });

  it("uses action-level metadata before the tool default", () => {
    const metadata = {
      sideEffect: "mutating" as const,
      sideEffectByAction: {
        read: "read_only" as const,
        list_blocks: "read_only" as const,
      },
    };

    expect(isMutatingToolCall("feishu_doc", { action: "read" }, metadata)).toBe(false);
    expect(isMutatingToolCall("feishu_doc", { action: "list-blocks" }, metadata)).toBe(false);
    expect(isMutatingToolCall("feishu_doc", { action: "write" }, metadata)).toBe(true);
    expect(isMutatingToolCall("feishu_doc", { action: "unknown" }, metadata)).toBe(true);
  });

  it("matches tool actions by fingerprint and fails closed on asymmetric data", () => {
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/b" },
      ),
    ).toBe(false);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write" },
      ),
    ).toBe(false);
  });

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });
});
