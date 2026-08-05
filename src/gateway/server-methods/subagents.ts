import {
  getSubagentSourceToolCallId,
  listSubagentRunsForRequester,
  type SubagentRunRecord,
} from "../../agents/subagent-registry.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../method-scopes.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type SubagentRun,
  type SubagentRunStatus,
  validateSubagentsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveSubagentRunStatus(run: SubagentRunRecord): SubagentRunStatus {
  if (typeof run.endedAt === "number") {
    return run.outcome?.status ?? "unknown";
  }
  if (typeof run.startedAt === "number") {
    return "running";
  }
  return "pending";
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function projectSubagentRun(run: SubagentRunRecord): SubagentRun {
  const projected: SubagentRun = {
    runId: run.runId,
    childSessionKey: run.childSessionKey,
    createdAt: run.createdAt,
    status: resolveSubagentRunStatus(run),
  };
  const sourceToolCallId = optionalNonEmptyString(getSubagentSourceToolCallId(run));
  if (sourceToolCallId) {
    projected.sourceToolCallId = sourceToolCallId;
  }
  const label = optionalNonEmptyString(run.label);
  const sessionLabel = optionalNonEmptyString(run.sessionLabel);
  const model = optionalNonEmptyString(run.model);
  if (label) {
    projected.label = label;
  }
  if (sessionLabel) {
    projected.sessionLabel = sessionLabel;
  }
  if (model) {
    projected.model = model;
  }
  if (run.spawnMode) {
    projected.spawnMode = run.spawnMode;
  }
  if (typeof run.startedAt === "number") {
    projected.startedAt = run.startedAt;
  }
  if (typeof run.endedAt === "number") {
    projected.endedAt = run.endedAt;
  }
  return projected;
}

export const subagentsHandlers: GatewayRequestHandlers = {
  "subagents.list": ({ params, client, respond, context }) => {
    if (!assertValidParams(params, validateSubagentsListParams, "subagents.list", respond)) {
      return;
    }
    const requesterSessionKey = params.requesterSessionKey.trim();
    if (!requesterSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "requesterSessionKey required"),
      );
      return;
    }

    const runs = listSubagentRunsForRequester(requesterSessionKey);
    const connId = client?.connId?.trim();
    const wantsToolEvents = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    );
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const canSubscribeToToolEvents = scopes.includes(WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE);
    if (connId && wantsToolEvents && canSubscribeToToolEvents) {
      for (const run of runs) {
        if (typeof run.endedAt !== "number") {
          context.registerToolEventRecipient(run.runId, connId);
        }
      }
    }

    respond(true, { runs: runs.map(projectSubagentRun) });
  },
};
