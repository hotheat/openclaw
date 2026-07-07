import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { TaskFlowCommitEvent } from "./store.js";

/**
 * Default `onCommitted` for {@link createTaskFlowStore}: dispatches a single
 * `taskflow_updated` hook for every successfully committed TaskFlow revision.
 *
 * This lives outside `store.ts` so the store stays a pure persistence layer
 * (zero plugin imports). Wiring hook emission at the commit layer — rather than
 * in the `taskflow_update` tool — guarantees that auto-park (finalization),
 * shared grants (subagent spawn), and access revocation (lifecycle) also emit,
 * which they previously did not. The global hook runner is constructed with
 * `catchErrors: true`, and the store additionally swallows callback errors, so
 * a misbehaving consumer can never fail a write that already landed on disk.
 */
export async function dispatchTaskFlowCommitHook(event: TaskFlowCommitEvent): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("taskflow_updated")) {
    return;
  }
  await hookRunner.runTaskFlowUpdated(
    {
      taskFlowId: event.snapshot.id,
      revision: event.snapshot.revision,
      operation: event.operation,
      changedItems: event.changedItems,
      warnings: event.warnings,
      snapshot: event.snapshot,
      markdown: event.markdown,
    },
    {
      agentId: event.snapshot.agentId,
      sessionKey: event.actorSessionKey ?? event.snapshot.ownerSessionKey,
    },
  );
}
