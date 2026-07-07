import { randomUUID } from "node:crypto";

export function createTaskFlowId(): string {
  return `tf_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function createTaskFlowItemId(): string {
  return `item_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
