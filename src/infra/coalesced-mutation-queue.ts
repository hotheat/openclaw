type MutationTask<TStore, TOptions> = {
  mutate: (store: TStore) => unknown;
  options?: TOptions;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
};

type PathQueue<TStore, TOptions> = {
  pending: Array<MutationTask<TStore, TOptions>>;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
};

export type CoalescedMutationQueue<TStore, TOptions> = {
  enqueue<T>(
    filePath: string,
    mutate: (store: TStore) => Promise<T> | T,
    options?: TOptions,
  ): Promise<T>;
  flush(filePath?: string): Promise<void>;
  clear(reason?: Error): void;
  size(): number;
};

export function createCoalescedMutationQueue<TStore, TOptions>(params: {
  coalesceMs: number;
  load: (filePath: string) => Promise<TStore>;
  save: (filePath: string, store: TStore, options: Array<TOptions | undefined>) => Promise<void>;
  withLock: <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;
  clone: (store: TStore) => TStore;
}): CoalescedMutationQueue<TStore, TOptions> {
  const queues = new Map<string, PathQueue<TStore, TOptions>>();
  const coalesceMs = Math.max(0, Math.floor(params.coalesceMs));

  const getOrCreateQueue = (filePath: string): PathQueue<TStore, TOptions> => {
    const existing = queues.get(filePath);
    if (existing) {
      return existing;
    }
    const created: PathQueue<TStore, TOptions> = { pending: [] };
    queues.set(filePath, created);
    return created;
  };

  const schedule = (filePath: string, queue: PathQueue<TStore, TOptions>) => {
    if (queue.timer || queue.inFlight || queue.pending.length === 0) {
      return;
    }
    queue.timer = setTimeout(() => {
      queue.timer = undefined;
      void startDrain(filePath);
    }, coalesceMs);
  };

  const processBatch = async (
    filePath: string,
    batch: Array<MutationTask<TStore, TOptions>>,
  ): Promise<void> => {
    const successful: Array<{
      task: MutationTask<TStore, TOptions>;
      result: unknown;
    }> = [];
    try {
      await params.withLock(filePath, async () => {
        let store: TStore = await params.load(filePath);

        for (const task of batch) {
          const candidate = params.clone(store);
          try {
            const result = await task.mutate(candidate);
            store = candidate;
            successful.push({ task, result });
          } catch (err) {
            task.settled = true;
            task.reject(err);
          }
        }

        if (successful.length === 0) {
          return;
        }

        await params.save(
          filePath,
          store,
          successful.map(({ task }) => task.options),
        );
      });
      for (const { task, result } of successful) {
        task.settled = true;
        task.resolve(result);
      }
    } catch (err) {
      for (const task of batch) {
        if (!task.settled) {
          task.settled = true;
          task.reject(err);
        }
      }
    }
  };

  function startDrain(filePath: string): Promise<void> {
    const queue = queues.get(filePath);
    if (!queue) {
      return Promise.resolve();
    }
    if (queue.inFlight) {
      return queue.inFlight;
    }
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = undefined;
    }
    const batch = queue.pending.splice(0);
    if (batch.length === 0) {
      queues.delete(filePath);
      return Promise.resolve();
    }

    const inFlight = processBatch(filePath, batch).finally(() => {
      queue.inFlight = undefined;
      if (queue.pending.length === 0) {
        queues.delete(filePath);
      } else {
        schedule(filePath, queue);
      }
    });
    queue.inFlight = inFlight;
    return inFlight;
  }

  return {
    enqueue<T>(
      filePath: string,
      mutate: (store: TStore) => Promise<T> | T,
      options?: TOptions,
    ): Promise<T> {
      if (!filePath || typeof filePath !== "string") {
        return Promise.reject(new Error("coalesced mutation path must be a non-empty string"));
      }
      const queue = getOrCreateQueue(filePath);
      const promise = new Promise<T>((resolve, reject) => {
        queue.pending.push({
          mutate,
          options,
          resolve: (value) => resolve(value as T),
          reject,
          settled: false,
        });
      });
      schedule(filePath, queue);
      return promise;
    },

    async flush(filePath?: string): Promise<void> {
      const paths = filePath ? [filePath] : [...queues.keys()];
      for (const currentPath of paths) {
        while (true) {
          const queue = queues.get(currentPath);
          if (!queue) {
            break;
          }
          if (queue.pending.length > 0 && !queue.inFlight) {
            void startDrain(currentPath);
          }
          if (queue.inFlight) {
            await queue.inFlight;
            continue;
          }
          break;
        }
      }
    },

    clear(reason = new Error("coalesced mutation queue cleared")): void {
      for (const [filePath, queue] of queues) {
        if (queue.timer) {
          clearTimeout(queue.timer);
          queue.timer = undefined;
        }
        for (const task of queue.pending.splice(0)) {
          task.settled = true;
          task.reject(reason);
        }
        if (!queue.inFlight) {
          queues.delete(filePath);
        }
      }
    },

    size(): number {
      return queues.size;
    },
  };
}
