import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AnnounceQueueItem,
  buildCompletionAnnouncePrompt,
  enqueueAnnounce,
  enqueueAnnounceWithReceipt,
  enqueueAnnounceWithOutcome,
  resetAnnounceQueuesForTests,
} from "./subagent-announce-queue.js";

function createRetryingSend() {
  const prompts: string[] = [];
  let attempts = 0;
  let resolved = false;
  let resolveSecondAttempt = () => {};
  const waitForSecondAttempt = new Promise<void>((resolve) => {
    resolveSecondAttempt = resolve;
  });

  const send = vi.fn(async (item: { prompt: string }) => {
    attempts += 1;
    prompts.push(item.prompt);
    if (attempts >= 2 && !resolved) {
      resolved = true;
      resolveSecondAttempt();
    }
    if (attempts === 1) {
      throw new Error("gateway timeout after 60000ms");
    }
  });

  return { send, prompts, waitForSecondAttempt };
}

describe("subagent-announce-queue", () => {
  afterEach(() => {
    resetAnnounceQueuesForTests();
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("distinguishes accepted, duplicate, and rejected enqueue outcomes", () => {
    vi.useFakeTimers();
    try {
      const settings = {
        mode: "followup" as const,
        debounceMs: 100,
        cap: 1,
        dropPolicy: "new" as const,
      };
      const send = vi.fn(async () => {});
      const first = {
        announceId: "announce:first",
        prompt: "first completion",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:main",
      };

      expect(
        enqueueAnnounceWithOutcome({ key: "announce:test:outcome", item: first, settings, send }),
      ).toBe("accepted");
      expect(
        enqueueAnnounceWithOutcome({ key: "announce:test:outcome", item: first, settings, send }),
      ).toBe("duplicate");
      expect(
        enqueueAnnounceWithOutcome({
          key: "announce:test:outcome",
          item: {
            announceId: "announce:second",
            prompt: "second completion",
            enqueuedAt: Date.now(),
            sessionKey: "agent:main:main",
          },
          settings,
          send,
        }),
      ).toBe("rejected");
    } finally {
      resetAnnounceQueuesForTests();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("[Queue overflow]");
    expect(sender.prompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("Queued #1");
    expect(sender.prompts[0]).toContain("queued item one");
    expect(sender.prompts[0]).toContain("Queued #2");
    expect(sender.prompts[0]).toContain("queued item two");
    expect(sender.prompts[1]).toContain("Queued #1");
    expect(sender.prompts[1]).toContain("queued item one");
    expect(sender.prompts[1]).toContain("Queued #2");
    expect(sender.prompts[1]).toContain("queued item two");
  });

  it("keeps completions queued while the current parent wake is running", async () => {
    let releaseFirstSend = () => {};
    const firstSendSettled = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const send = vi.fn(async () => {}).mockImplementationOnce(async () => await firstSendSettled);

    enqueueAnnounce({
      key: "completion:agent:main:main",
      item: {
        announceId: "announce:first",
        prompt: "",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:main",
        origin: { channel: "discord", to: "channel:first" },
        completion: {
          label: "AACR-071",
          status: "succeeded",
          result: "first completion",
          remainingActive: 1,
          instruction: "",
        },
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    enqueueAnnounce({
      key: "completion:agent:main:main",
      item: {
        announceId: "announce:second",
        prompt: "",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:main",
        origin: { channel: "slack", to: "channel:second" },
        completion: {
          label: "AACR-072",
          status: "succeeded",
          result: "second completion",
          remainingActive: 0,
          instruction: "",
        },
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    releaseFirstSend();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it("splits completion metadata by delivery origin", async () => {
    const send = vi.fn(async (_item: AnnounceQueueItem) => {});
    const enqueueCompletion = (params: {
      announceId: string;
      label: string;
      origin: { channel: string; to: string };
    }) =>
      enqueueAnnounce({
        key: "completion:agent:main:main",
        item: {
          announceId: params.announceId,
          prompt: "",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:main",
          origin: params.origin,
          completion: {
            label: params.label,
            status: "succeeded",
            result: `${params.label} complete`,
            remainingActive: 0,
            instruction: "",
          },
        },
        settings: { mode: "collect", debounceMs: 0 },
        send,
      });

    enqueueCompletion({
      announceId: "announce:discord",
      label: "AACR-075",
      origin: { channel: "discord", to: "channel:first" },
    });
    enqueueCompletion({
      announceId: "announce:slack",
      label: "AACR-076",
      origin: { channel: "slack", to: "channel:second" },
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    const discordCall = send.mock.calls.find(([item]) => item.origin?.channel === "discord")?.[0];
    const slackCall = send.mock.calls.find(([item]) => item.origin?.channel === "slack")?.[0];
    expect(discordCall?.prompt).toContain("Completed: AACR-075");
    expect(discordCall?.prompt).not.toContain("AACR-076");
    expect(slackCall?.prompt).toContain("Completed: AACR-076");
    expect(slackCall?.prompt).not.toContain("AACR-075");
  });

  it("coalesces completion metadata when the full delivery origin matches", async () => {
    const send = vi.fn(async (_item: AnnounceQueueItem) => {});
    for (const [announceId, label] of [
      ["announce:first", "AACR-077"],
      ["announce:second", "AACR-078"],
    ] as const) {
      enqueueAnnounce({
        key: "completion:agent:main:main",
        item: {
          announceId,
          prompt: "",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:main",
          origin: {
            channel: "discord",
            to: "channel:first",
            accountId: "acct-1",
            threadId: "thread-1",
          },
          completion: {
            label,
            status: "succeeded",
            result: `${label} complete`,
            remainingActive: 0,
            instruction: "",
          },
        },
        settings: { mode: "collect", debounceMs: 0 },
        send,
      });
    }

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send.mock.calls[0]?.[0].prompt).toContain("Completed: AACR-077, AACR-078");
    expect(send.mock.calls[0]?.[0].announceId).toMatch(/^completion-batch:/);
  });

  it("keeps completion items without a delivery origin isolated", async () => {
    const send = vi.fn(async (_item: AnnounceQueueItem) => {});
    for (const [announceId, label] of [
      ["announce:unkeyed-first", "AACR-079"],
      ["announce:unkeyed-second", "AACR-080"],
    ] as const) {
      enqueueAnnounce({
        key: "completion:agent:main:main",
        item: {
          announceId,
          prompt: "",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:main",
          completion: {
            label,
            status: "succeeded",
            result: `${label} complete`,
            remainingActive: 0,
            instruction: "",
          },
        },
        settings: { mode: "collect", debounceMs: 0 },
        send,
      });
    }

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(
      send.mock.calls
        .map(([item]) => item.announceId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["announce:unkeyed-first", "announce:unkeyed-second"]);
  });

  it("resolves every completion receipt only after the aggregate send succeeds", async () => {
    let releaseSend = () => {};
    const sendSettled = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send = vi.fn(async () => await sendSettled);
    const receipts = ["announce:receipt-a", "announce:receipt-b"].map((announceId) =>
      enqueueAnnounceWithReceipt({
        key: "completion:agent:main:main",
        item: {
          announceId,
          prompt: "",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:main",
          origin: { channel: "discord", to: "channel:first" },
          completion: {
            label: announceId,
            status: "succeeded",
            result: `${announceId} complete`,
            remainingActive: 0,
            instruction: "",
          },
        },
        settings: { mode: "collect", debounceMs: 0, lossless: true },
        send,
      }),
    );
    const delivered = vi.fn();
    for (const receipt of receipts) {
      void receipt.delivered.then(delivered);
    }

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(delivered).not.toHaveBeenCalled();

    releaseSend();
    const outcomes = await Promise.all(receipts.map((receipt) => receipt.delivered));
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([{ contentComplete: true }, { contentComplete: true }]);
  });

  it("rejects every completion receipt when the aggregate send fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("delivery failed");
    });
    const receipts = ["announce:failure-a", "announce:failure-b"].map((announceId) =>
      enqueueAnnounceWithReceipt({
        key: "completion:agent:main:main",
        item: {
          announceId,
          prompt: "",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:main",
          origin: { channel: "discord", to: "channel:first" },
          completion: {
            label: announceId,
            status: "failed",
            result: `${announceId} failed`,
            remainingActive: 0,
            instruction: "",
          },
        },
        settings: { mode: "collect", debounceMs: 0, lossless: true },
        send,
      }),
    );

    const outcomes = await Promise.allSettled(receipts.map((receipt) => receipt.delivered));
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a completion receipt when pre-drain preparation fails", async () => {
    const send = vi.fn(async () => {});
    const receipt = enqueueAnnounceWithReceipt({
      key: "completion:agent:main:main",
      item: {
        announceId: "announce:busy-timeout",
        prompt: "",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:main",
        completion: {
          label: "AACR-081",
          status: "succeeded",
          result: "complete",
          remainingActive: 0,
          instruction: "",
        },
      },
      settings: {
        mode: "collect",
        debounceMs: 0,
        lossless: true,
        beforeDrain: async () => {
          throw new Error("requester remained busy");
        },
      },
      send,
    });

    await expect(receipt.delivered).rejects.toThrow("requester remained busy");
    expect(send).not.toHaveBeenCalled();
  });

  it("deduplicates the same announce while it is pending or in flight", async () => {
    let releaseSend = () => {};
    const sendSettled = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send = vi.fn(async () => await sendSettled);
    const item = {
      announceId: "announce:duplicate",
      prompt: "completion",
      enqueuedAt: Date.now(),
      sessionKey: "agent:main:main",
    };

    expect(
      enqueueAnnounce({
        key: "completion:agent:main:main",
        item,
        settings: { mode: "collect", debounceMs: 0 },
        send,
      }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    expect(
      enqueueAnnounce({
        key: "completion:agent:main:main",
        item,
        settings: { mode: "collect", debounceMs: 0 },
        send,
      }),
    ).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    releaseSend();
  });

  it("caps aggregate completion result text", () => {
    const prompt = buildCompletionAnnouncePrompt(
      Array.from({ length: 10 }, (_, index) => ({
        prompt: "",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:main",
        completion: {
          label: `AACR-${index}-${"label".repeat(2_000)}`,
          status: "succeeded" as const,
          result: `${index}`.repeat(10_000),
          resultRef: { id: `result-${index}`, sessionKey: `agent:research:${index}` },
          remainingActive: 0,
          instruction: "",
        },
      })),
    );

    expect(prompt).toBeDefined();
    expect(prompt?.length).toBeLessThan(16_000);
    expect(prompt).toContain("Truncated: true");
    expect(prompt).toContain("Result session: agent:research:0");
    expect(prompt).toContain("Result ref: result-0");
    expect(prompt).toContain("continue at nextContentOffset until contentHasMore=false");
    expect(prompt).toContain("Omitted results:");
  });

  it("marks truncated completion receipts as incomplete", async () => {
    const receipt = enqueueAnnounceWithReceipt({
      key: "completion:agent:main:main",
      item: {
        announceId: "announce:truncated",
        prompt: "",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:main",
        origin: { channel: "discord", to: "channel:first" },
        completion: {
          label: "large result",
          status: "succeeded",
          result: "x".repeat(10_000),
          resultRef: { id: "result-large", sessionKey: "agent:research:large" },
          remainingActive: 0,
          instruction: "",
        },
      },
      settings: { mode: "collect", debounceMs: 0, lossless: true },
      send: vi.fn(async () => undefined),
    });

    await expect(receipt.delivered).resolves.toEqual({ contentComplete: false });
  });
});
