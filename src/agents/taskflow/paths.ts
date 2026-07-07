import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

export type TaskFlowPathOptions = {
  agentDir: string;
  stateDir?: string;
};

export type TaskFlowPaths = {
  agentDir: string;
  stateDir: string;
  taskflowsDir: string;
  eventsDir: string;
  localIndexPath: string;
  globalTaskflowsDir: string;
  globalIndexPath: string;
  snapshotPath: (taskFlowId: string) => string;
  eventLogPath: (taskFlowId: string) => string;
};

export function resolveTaskFlowPaths(options: TaskFlowPathOptions): TaskFlowPaths {
  const agentDir = path.resolve(options.agentDir);
  const stateDir = path.resolve(options.stateDir ?? resolveStateDir(process.env));
  const taskflowsDir = path.join(agentDir, "taskflows");
  const eventsDir = path.join(taskflowsDir, "events");
  const globalTaskflowsDir = path.join(stateDir, "taskflows");
  return {
    agentDir,
    stateDir,
    taskflowsDir,
    eventsDir,
    localIndexPath: path.join(taskflowsDir, "index.json"),
    globalTaskflowsDir,
    globalIndexPath: path.join(globalTaskflowsDir, "index.json"),
    snapshotPath: (taskFlowId) => path.join(taskflowsDir, `${taskFlowId}.json`),
    eventLogPath: (taskFlowId) => path.join(eventsDir, `${taskFlowId}.jsonl`),
  };
}
