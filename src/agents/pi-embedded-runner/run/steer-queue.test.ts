import { describe, expect, it, vi } from "vitest";
import { createEmbeddedSteerQueue } from "./steer-queue.js";

describe("createEmbeddedSteerQueue", () => {
  it("drains messages accepted after pi-agent-core's last internal poll", async () => {
    const queued: string[] = [];
    const processed: string[] = [];
    const agent = {
      steer: vi.fn((text: string) => queued.push(text)),
      hasQueuedMessages: vi.fn(() => queued.length > 0),
      onSteerAccepted: vi.fn(),
      continue: vi.fn(async () => {
        const text = queued.shift();
        if (text) {
          processed.push(text);
        }
      }),
    };
    const steerQueue = createEmbeddedSteerQueue(agent);

    expect(steerQueue.queue("late steer")).toBe(true);
    await steerQueue.drainAfterPrompt();

    expect(processed).toEqual(["late steer"]);
    expect(agent.onSteerAccepted).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledOnce();
    expect(steerQueue.queue("after close")).toBe(false);
    expect(agent.onSteerAccepted).toHaveBeenCalledOnce();
  });

  it("keeps accepting while a continuation is running, then closes atomically", async () => {
    const queued = ["first"];
    let injected = false;
    let steerQueue: ReturnType<typeof createEmbeddedSteerQueue>;
    const agent = {
      steer: vi.fn((text: string) => queued.push(text)),
      hasQueuedMessages: vi.fn(() => queued.length > 0),
      continue: vi.fn(async () => {
        queued.shift();
        if (!injected && queued.length === 0) {
          injected = true;
          expect(steerQueue.queue("second")).toBe(true);
        }
      }),
    };
    steerQueue = createEmbeddedSteerQueue(agent);

    await steerQueue.drainAfterPrompt();

    expect(agent.continue).toHaveBeenCalledTimes(2);
    expect(steerQueue.queue("after close")).toBe(false);
  });

  it("stops accepting when the prompt rejects", async () => {
    const promptError = new Error("prompt failed");
    const agent = {
      steer: vi.fn(),
      hasQueuedMessages: vi.fn(() => false),
      continue: vi.fn(async () => {}),
    };
    const steerQueue = createEmbeddedSteerQueue(agent);

    await expect(steerQueue.runPrompt(() => Promise.reject(promptError))).rejects.toBe(promptError);

    expect(agent.continue).not.toHaveBeenCalled();
    expect(steerQueue.queue("after prompt failure")).toBe(false);
  });

  it("stops accepting when a continuation rejects", async () => {
    const continueError = new Error("continue failed");
    const queued = ["first"];
    const agent = {
      steer: vi.fn((text: string) => queued.push(text)),
      hasQueuedMessages: vi.fn(() => queued.length > 0),
      continue: vi.fn(async () => {
        queued.shift();
        throw continueError;
      }),
    };
    const steerQueue = createEmbeddedSteerQueue(agent);

    await expect(steerQueue.runPrompt(async () => {})).rejects.toBe(continueError);

    expect(agent.continue).toHaveBeenCalledOnce();
    expect(steerQueue.queue("after continue failure")).toBe(false);
  });
});
