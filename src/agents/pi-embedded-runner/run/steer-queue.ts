type SteerQueueAgent = {
  steer: (text: string) => void;
  hasQueuedMessages: () => boolean;
  onSteerAccepted?: () => void;
  continue: () => Promise<void>;
};

type AwaitOperation = <T>(operation: Promise<T>) => Promise<T>;

export function createEmbeddedSteerQueue(agent: SteerQueueAgent) {
  let accepting = true;
  let closed = false;

  const close = () => {
    closed = true;
    accepting = false;
  };

  const drainAfterPrompt = async (): Promise<void> => {
    try {
      while (true) {
        // Close acceptance before inspecting the queue so a successful steer
        // cannot land between the last queue poll and run teardown.
        accepting = false;
        if (closed || !agent.hasQueuedMessages()) {
          return;
        }
        accepting = true;
        await agent.continue();
      }
    } finally {
      close();
    }
  };

  return {
    queue(text: string): boolean {
      if (!accepting) {
        return false;
      }
      agent.steer(text);
      agent.onSteerAccepted?.();
      return true;
    },

    async runPrompt(
      prompt: () => Promise<void>,
      awaitOperation: AwaitOperation = (operation) => operation,
    ): Promise<void> {
      try {
        await awaitOperation(prompt());
        await awaitOperation(drainAfterPrompt());
      } finally {
        close();
      }
    },

    drainAfterPrompt,
    close,
  };
}
