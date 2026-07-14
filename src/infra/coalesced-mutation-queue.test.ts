import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoalescedMutationQueue } from "./coalesced-mutation-queue.js";

describe("coalesced mutation queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the drain timer referenced while a mutation is pending", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const queue = createCoalescedMutationQueue<Record<string, number>, undefined>({
      coalesceMs: 5,
      load: async () => ({}),
      save: async () => {},
      withLock: async (_filePath, fn) => await fn(),
      clone: (store) => structuredClone(store),
    });

    const pending = queue.enqueue("sessions.json", (store) => {
      store.value = 1;
      return store.value;
    });
    const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;

    expect(timer?.hasRef()).toBe(true);
    await expect(pending).resolves.toBe(1);
  });

  it("rejects every successful mutation in a batch when persistence fails", async () => {
    const persistenceError = new Error("save failed");
    const queue = createCoalescedMutationQueue<Record<string, number>, undefined>({
      coalesceMs: 0,
      load: async () => ({}),
      save: async () => {
        throw persistenceError;
      },
      withLock: async (_filePath, fn) => await fn(),
      clone: (store) => structuredClone(store),
    });

    const first = queue.enqueue("sessions.json", (store) => {
      store.first = 1;
      return "first";
    });
    const second = queue.enqueue("sessions.json", (store) => {
      store.second = 2;
      return "second";
    });

    await expect(Promise.all([first, second])).rejects.toBe(persistenceError);
  });
});
