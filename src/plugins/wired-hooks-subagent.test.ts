/**
 * Test: subagent_spawning, subagent_delivery_target, subagent_spawned & subagent_ended hook wiring
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("subagent hook runner methods", () => {
  const handoff = {
    mode: "export-file" as const,
    quality: {
      gate: "unmanaged" as const,
      verificationStatus: "unknown" as const,
      deliveryStatus: "unmanaged" as const,
    },
    artifacts: [{ relativePath: "artifacts/imports/researcher/run-1/report.md" }],
    omittedArtifactCount: 0,
  };
  const baseRequester = {
    channel: "discord",
    accountId: "work",
    to: "channel:123",
    threadId: "456",
  };

  const baseSubagentCtx = {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
  };

  it("runSubagentSpawning invokes registered subagent_spawning hooks", async () => {
    const handler = vi.fn(async () => ({ status: "ok", threadBindingReady: true as const }));
    const registry = createMockPluginRegistry([{ hookName: "subagent_spawning", handler }]);
    const runner = createHookRunner(registry);
    const event = {
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "research",
      mode: "session" as const,
      requester: baseRequester,
      threadRequested: true,
    };
    const ctx = {
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
    };

    const result = await runner.runSubagentSpawning(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("runSubagentSpawned invokes registered subagent_spawned hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "subagent_spawned", handler }]);
    const runner = createHookRunner(registry);
    const event = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "research",
      mode: "run" as const,
      requester: baseRequester,
      threadRequested: true,
    };

    await runner.runSubagentSpawned(event, baseSubagentCtx);

    expect(handler).toHaveBeenCalledWith(event, baseSubagentCtx);
  });

  it("runSubagentHandoffStaging merges policy results by source path", async () => {
    const high = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          requesterRelativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
      stagedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          relativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
      rejections: [],
      failures: [],
    }));
    const low = vi.fn(async () => ({
      policyStatus: "unavailable" as const,
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          requesterRelativePath: "duplicate/report.md",
          profileId: "researcher-export",
          deliveryPolicy: "auto" as const,
        },
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/data.csv",
          requesterRelativePath: "artifacts/imports/researcher/run-1/data.csv",
        },
      ],
      stagedArtifacts: [],
      rejections: [{ code: "plugin:test-prefix", message: "duplicate rejection" }],
      failures: [],
    }));
    const registry = createMockPluginRegistry([
      { hookName: "subagent_handoff_staging", handler: high, priority: 10 },
      { hookName: "subagent_handoff_staging", handler: low, priority: 1 },
    ]);
    const runner = createHookRunner(registry);
    const event = {
      runId: "run-1",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:main",
      content: "<SUBAGENT_HANDOFF>{}</SUBAGENT_HANDOFF>",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
    };

    const result = await runner.runSubagentHandoffStaging(event, baseSubagentCtx);

    expect(high).toHaveBeenCalledWith(event, baseSubagentCtx);
    expect(low).toHaveBeenCalledWith(event, baseSubagentCtx);
    expect(result).toEqual({
      policyStatus: "evaluated",
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          requesterRelativePath: "artifacts/imports/researcher/run-1/report.md",
          profileId: "researcher-export",
          deliveryPolicy: "auto",
        },
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/data.csv",
          requesterRelativePath: "artifacts/imports/researcher/run-1/data.csv",
        },
      ],
      stagedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          relativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
      rejections: [{ code: "plugin:test-prefix", message: "duplicate rejection" }],
      failures: [],
    });
  });

  it("runSubagentHandoffStaging records thrown hook failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("stager crashed");
    });
    const fallback = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          requesterRelativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_staging", handler, priority: 100 },
        { hookName: "subagent_handoff_staging", handler: fallback, priority: 0 },
      ]),
    );
    const result = await runner.runSubagentHandoffStaging(
      {
        runId: "run-1",
        childSessionKey: "agent:researcher:subagent:child",
        requesterSessionKey: "agent:main:main",
        content: "result",
        handoff,
        handoffAt: 1,
        childWorkspaceDir: "/workspace-researcher",
        requesterWorkspaceDir: "/workspace-main",
        deliveryEligible: true,
      },
      baseSubagentCtx,
    );

    expect(result).toEqual({
      policyStatus: "evaluated",
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          requesterRelativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [
        {
          code: "hook-error",
          message: "test-plugin: Error: stager crashed",
        },
      ],
    });
  });

  it("runSubagentHandoffStaging preserves another plugin's acceptance after a staging failure", async () => {
    const sourceRelativePath = "artifacts/imports/researcher/run-1/report.md";
    const failed = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [],
      stagedArtifacts: [],
      rejections: [],
      failures: [
        {
          sourceRelativePath,
          code: "staging-failed",
          message: "source file is unavailable",
        },
      ],
    }));
    const accepted = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [
        {
          sourceRelativePath,
          requesterRelativePath: sourceRelativePath,
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_staging", handler: failed, priority: 100 },
        { hookName: "subagent_handoff_staging", handler: accepted, priority: 0 },
      ]),
    );

    const result = await runner.runSubagentHandoffStaging(
      {
        runId: "run-1",
        childSessionKey: "agent:researcher:subagent:child",
        requesterSessionKey: "agent:main:main",
        content: "result",
        handoff,
        handoffAt: 1,
        childWorkspaceDir: "/workspace-researcher",
        requesterWorkspaceDir: "/workspace-main",
        deliveryEligible: true,
      },
      baseSubagentCtx,
    );

    expect(result?.acceptedArtifacts).toEqual([
      {
        sourceRelativePath,
        requesterRelativePath: sourceRelativePath,
      },
    ]);
    expect(result?.stagedArtifacts).toEqual([]);
    expect(result?.failures).toEqual([
      {
        sourceRelativePath,
        code: "staging-failed",
        message: "source file is unavailable",
      },
    ]);
  });

  it("runSubagentHandoffStaging stops dispatch after the staging signal aborts", async () => {
    const controller = new AbortController();
    const high = vi.fn(async () => {
      controller.abort(new Error("timeout"));
      return {
        policyStatus: "evaluated" as const,
        acceptedArtifacts: [],
        stagedArtifacts: [],
        rejections: [],
        failures: [],
      };
    });
    const low = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_staging", handler: high, priority: 100 },
        { hookName: "subagent_handoff_staging", handler: low, priority: 0 },
      ]),
    );

    const result = await runner.runSubagentHandoffStaging(
      {
        runId: "run-1",
        childSessionKey: "agent:researcher:subagent:child",
        requesterSessionKey: "agent:main:main",
        content: "result",
        handoff,
        handoffAt: 1,
        childWorkspaceDir: "/workspace-researcher",
        requesterWorkspaceDir: "/workspace-main",
        deliveryEligible: true,
        signal: controller.signal,
      },
      baseSubagentCtx,
    );

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("runSubagentHandoffStaging stops lower-priority side effects after a terminal result", async () => {
    const terminal = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [],
      stagedArtifacts: [],
      rejections: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          code: "stale-handoff",
          message: "A newer handoff already owns the requester state",
        },
      ],
      failures: [],
      haltRemainingHandlers: true,
    }));
    const lowerPriorityCopy = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          requesterRelativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_staging", handler: terminal, priority: 200 },
        { hookName: "subagent_handoff_staging", handler: lowerPriorityCopy, priority: 100 },
      ]),
    );

    const result = await runner.runSubagentHandoffStaging(
      {
        runId: "run-stale",
        childSessionKey: "agent:researcher:subagent:child",
        requesterSessionKey: "agent:main:main",
        content: "result",
        handoff,
        handoffAt: 1,
        childWorkspaceDir: "/workspace-researcher",
        requesterWorkspaceDir: "/workspace-main",
        deliveryEligible: true,
      },
      baseSubagentCtx,
    );

    expect(terminal).toHaveBeenCalledTimes(1);
    expect(lowerPriorityCopy).not.toHaveBeenCalled();
    expect(result?.acceptedArtifacts).toEqual([]);
    expect(result?.haltRemainingHandlers).toBe(true);
  });

  it("runSubagentHandoffStaging clears earlier acceptance only for an explicit terminal result", async () => {
    const sourceRelativePath = "artifacts/imports/researcher/run-1/report.md";
    const accepted = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [
        {
          sourceRelativePath,
          requesterRelativePath: sourceRelativePath,
        },
      ],
      stagedArtifacts: [],
      rejections: [],
      failures: [],
    }));
    const terminal = vi.fn(async () => ({
      policyStatus: "evaluated" as const,
      acceptedArtifacts: [],
      stagedArtifacts: [],
      rejections: [],
      failures: [{ code: "state-persist-failed", message: "state write failed" }],
      haltRemainingHandlers: true,
    }));
    const skipped = vi.fn();
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_staging", handler: accepted, priority: 200 },
        { hookName: "subagent_handoff_staging", handler: terminal, priority: 100 },
        { hookName: "subagent_handoff_staging", handler: skipped, priority: 0 },
      ]),
    );

    const result = await runner.runSubagentHandoffStaging(
      {
        runId: "run-terminal",
        childSessionKey: "agent:researcher:subagent:child",
        requesterSessionKey: "agent:main:main",
        content: "result",
        handoff,
        handoffAt: 1,
        childWorkspaceDir: "/workspace-researcher",
        requesterWorkspaceDir: "/workspace-main",
        deliveryEligible: true,
      },
      baseSubagentCtx,
    );

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
    expect(result?.acceptedArtifacts).toEqual([]);
    expect(result?.failures).toEqual([
      { code: "state-persist-failed", message: "state write failed" },
    ]);
    expect(result?.haltRemainingHandlers).toBe(true);
  });

  it("runSubagentHandoffDelivery invokes registered delivery hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "subagent_handoff_delivery", handler }]);
    const runner = createHookRunner(registry);
    const event = {
      runId: "run-1",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:webchat:client:chat",
      content: "result",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
      artifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          relativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
    };

    await runner.runSubagentHandoffDelivery(event, baseSubagentCtx);

    expect(handler).toHaveBeenCalledWith(event, baseSubagentCtx);
  });

  it("runSubagentHandoffDelivery returns structured failures from handlers and thrown errors", async () => {
    const reported = vi.fn(async () => ({
      handled: false,
      deliveredArtifacts: [],
      failures: [{ relativePath: "report.md", message: "upload failed" }],
    }));
    const thrown = vi.fn(async () => {
      throw new Error("transport hung");
    });
    const registry = createMockPluginRegistry([
      { hookName: "subagent_handoff_delivery", handler: reported, priority: 10 },
      { hookName: "subagent_handoff_delivery", handler: thrown, priority: 1 },
    ]);
    const runner = createHookRunner(registry);
    const event = {
      runId: "run-1",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:webchat:client:chat",
      content: "result",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
      artifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          relativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
    };

    const result = await runner.runSubagentHandoffDelivery(event, baseSubagentCtx);

    expect(result?.handled).toBe(false);
    expect(result?.deliveredArtifacts).toEqual([]);
    expect(result?.failures).toEqual([
      { relativePath: "report.md", message: "upload failed" },
      { message: "test-plugin: Error: transport hung" },
    ]);
  });

  it("treats a legacy failure-only delivery result as unhandled", async () => {
    const legacy = vi.fn(async () => ({
      failures: [{ relativePath: "report.md", message: "legacy upload failed" }],
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([{ hookName: "subagent_handoff_delivery", handler: legacy }]),
    );
    const event = {
      runId: "run-legacy",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:webchat:client:chat",
      content: "result",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
      artifacts: [
        {
          sourceRelativePath: "report.md",
          relativePath: "report.md",
        },
      ],
    };

    const result = await runner.runSubagentHandoffDelivery(event, baseSubagentCtx);

    expect(result).toEqual({
      handled: false,
      deliveredArtifacts: [],
      failures: [{ relativePath: "report.md", message: "legacy upload failed" }],
    });
  });

  it("runSubagentHandoffDelivery stops after the signal aborts", async () => {
    const controller = new AbortController();
    const aborting = vi.fn(async () => {
      controller.abort(new Error("delivery cancelled"));
      return {
        handled: true,
        deliveredArtifacts: [],
        failures: [{ message: "discarded after abort" }],
      };
    });
    const lowerPrioritySideEffect = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "subagent_handoff_delivery", handler: aborting, priority: 10 },
      {
        hookName: "subagent_handoff_delivery",
        handler: lowerPrioritySideEffect,
        priority: 1,
      },
    ]);
    const runner = createHookRunner(registry);
    const event = {
      runId: "run-aborted",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:webchat:client:chat",
      content: "result",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
      signal: controller.signal,
      artifacts: [
        {
          sourceRelativePath: "artifacts/imports/researcher/run-1/report.md",
          relativePath: "artifacts/imports/researcher/run-1/report.md",
        },
      ],
    };

    const result = await runner.runSubagentHandoffDelivery(event, baseSubagentCtx);

    expect(aborting).toHaveBeenCalledTimes(1);
    expect(lowerPrioritySideEffect).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("runSubagentHandoffDelivery stops after one channel adapter handles the event", async () => {
    const handled = vi.fn(async () => ({
      handled: true,
      deliveredArtifacts: ["report.md"],
      failures: [],
    }));
    const duplicateAdapter = vi.fn();
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_delivery", handler: handled, priority: 10 },
        {
          hookName: "subagent_handoff_delivery",
          handler: duplicateAdapter,
          priority: 1,
        },
      ]),
    );
    const event = {
      runId: "run-handled",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:webchat:client:chat",
      content: "result",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
      artifacts: [
        {
          sourceRelativePath: "report.md",
          relativePath: "report.md",
        },
      ],
    };

    const result = await runner.runSubagentHandoffDelivery(event, baseSubagentCtx);

    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: ["report.md"],
      failures: [],
    });
    expect(duplicateAdapter).not.toHaveBeenCalled();
  });

  it("continues past an unhandled adapter before assigning delivery ownership", async () => {
    const skipped = vi.fn(async () => ({
      handled: false,
      deliveredArtifacts: [],
      failures: [],
    }));
    const handled = vi.fn(async () => ({
      handled: true,
      deliveredArtifacts: ["report.md"],
      failures: [],
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "subagent_handoff_delivery", handler: skipped, priority: 10 },
        { hookName: "subagent_handoff_delivery", handler: handled, priority: 1 },
      ]),
    );
    const event = {
      runId: "run-fallback-adapter",
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:main:webchat:client:chat",
      content: "result",
      handoff,
      handoffAt: 1,
      childWorkspaceDir: "/workspace-researcher",
      requesterWorkspaceDir: "/workspace-main",
      deliveryEligible: true,
      artifacts: [
        {
          sourceRelativePath: "report.md",
          relativePath: "report.md",
        },
      ],
    };

    const result = await runner.runSubagentHandoffDelivery(event, baseSubagentCtx);

    expect(skipped).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: ["report.md"],
      failures: [],
    });
  });

  it("runSubagentDeliveryTarget invokes registered subagent_delivery_target hooks", async () => {
    const handler = vi.fn(async () => ({
      origin: {
        channel: "discord" as const,
        accountId: "work",
        to: "channel:777",
        threadId: "777",
      },
    }));
    const registry = createMockPluginRegistry([{ hookName: "subagent_delivery_target", handler }]);
    const runner = createHookRunner(registry);
    const event = {
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: baseRequester,
      childRunId: "run-1",
      spawnMode: "session" as const,
      expectsCompletionMessage: true,
    };

    const result = await runner.runSubagentDeliveryTarget(event, baseSubagentCtx);

    expect(handler).toHaveBeenCalledWith(event, baseSubagentCtx);
    expect(result).toEqual({
      origin: {
        channel: "discord",
        accountId: "work",
        to: "channel:777",
        threadId: "777",
      },
    });
  });

  it("runSubagentDeliveryTarget returns undefined when no matching hooks are registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);
    const result = await runner.runSubagentDeliveryTarget(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: baseRequester,
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      baseSubagentCtx,
    );
    expect(result).toBeUndefined();
  });

  it("runSubagentEnded invokes registered subagent_ended hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "subagent_ended", handler }]);
    const runner = createHookRunner(registry);
    const event = {
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent" as const,
      reason: "subagent-complete",
      sendFarewell: true,
      accountId: "work",
      runId: "run-1",
      outcome: "ok" as const,
    };

    await runner.runSubagentEnded(event, baseSubagentCtx);

    expect(handler).toHaveBeenCalledWith(event, baseSubagentCtx);
  });

  it("hasHooks returns true for registered subagent hooks", () => {
    const registry = createMockPluginRegistry([
      { hookName: "subagent_spawning", handler: vi.fn() },
      { hookName: "subagent_delivery_target", handler: vi.fn() },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("subagent_spawning")).toBe(true);
    expect(runner.hasHooks("subagent_delivery_target")).toBe(true);
    expect(runner.hasHooks("subagent_spawned")).toBe(false);
    expect(runner.hasHooks("subagent_ended")).toBe(false);
  });
});
