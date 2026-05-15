import { describe, expect, it } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { waitForAgentJob } from "./agent-job.js";

describe("waitForAgentJob with delayed terminal lifecycle", () => {
  it("does not resolve on start alone when terminal attempt lifecycle is suppressed", async () => {
    const runId = `run-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 200 });

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 100 } });

    const early = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 40)),
    ]);

    expect(early).toBe("pending");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 150 },
    });

    const snapshot = await waitPromise;
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.endedAt).toBe(150);
  });

  it("resolves from a later terminal lifecycle after a completion-contract early return path", async () => {
    const runId = `run-contract-early-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 500 });

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 200 } });

    const early = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 40)),
    ]);
    expect(early).toBe("pending");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 200, endedAt: 260 },
    });

    const snapshot = await waitPromise;
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.startedAt).toBe(200);
    expect(snapshot?.endedAt).toBe(260);
  });
});
