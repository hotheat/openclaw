import { listAgentIds, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { resolveSessionModelRef } from "../gateway/session-utils.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { agentCommand } from "./agent.js";
import { resolveSessionKeyForRequest } from "./agent/session.js";

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
};

const NO_GATEWAY_TIMEOUT_MS = 2_147_000_000;

export type AgentCliOpts = {
  message: string;
  agent?: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
};

function parseTimeoutSeconds(timeout?: string): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  const raw = Number.parseInt(String(timeout), 10);
  if (Number.isNaN(raw) || raw < 0) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  return raw;
}

function resolveGatewayAgentTimeout(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey?: string;
  sessionEntry?: Parameters<typeof resolveSessionModelRef>[1];
  timeout?: string;
}) {
  const timeoutOverrideSeconds = parseTimeoutSeconds(params.timeout);
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const { provider } = resolveSessionModelRef(params.cfg, params.sessionEntry, agentId);
  const runTimeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfg,
    provider,
    overrideSeconds: timeoutOverrideSeconds,
  });
  const timeoutSeconds = timeoutOverrideSeconds ?? Math.ceil(runTimeoutMs / 1000);
  const gatewayTimeoutMs =
    runTimeoutMs === NO_GATEWAY_TIMEOUT_MS
      ? NO_GATEWAY_TIMEOUT_MS
      : Math.min(NO_GATEWAY_TIMEOUT_MS, Math.max(10_000, runTimeoutMs + 30_000));
  return { timeoutSeconds, gatewayTimeoutMs };
}

function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const lines: string[] = [];
  if (payload.text) {
    lines.push(payload.text.trimEnd());
  }
  const mediaUrl =
    typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
      ? payload.mediaUrl.trim()
      : undefined;
  const media = payload.mediaUrls ?? (mediaUrl ? [mediaUrl] : []);
  for (const url of media) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n").trimEnd();
}

export async function agentViaGatewayCommand(opts: AgentCliOpts, runtime: RuntimeEnv) {
  const body = (opts.message ?? "").trim();
  if (!body) {
    throw new Error("Message (--message) is required");
  }
  if (!opts.to && !opts.sessionId && !opts.agent) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  const cfg = loadConfig();
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const sessionResolution = resolveSessionKeyForRequest({
    cfg,
    agentId,
    to: opts.to,
    sessionId: opts.sessionId,
  });
  const sessionKey = sessionResolution.sessionKey;
  const { timeoutSeconds, gatewayTimeoutMs } = resolveGatewayAgentTimeout({
    cfg,
    sessionKey,
    sessionEntry: sessionKey ? sessionResolution.sessionStore[sessionKey] : undefined,
    timeout: opts.timeout,
  });

  const channel = normalizeMessageChannel(opts.channel);
  const idempotencyKey = opts.runId?.trim() || randomIdempotencyKey();

  const response = await withProgress(
    {
      label: "Waiting for agent reply…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway<GatewayAgentResponse>({
        method: "agent",
        params: {
          message: body,
          agentId,
          to: opts.to,
          replyTo: opts.replyTo,
          sessionId: opts.sessionId,
          sessionKey,
          thinking: opts.thinking,
          deliver: Boolean(opts.deliver),
          channel,
          replyChannel: opts.replyChannel,
          replyAccountId: opts.replyAccount,
          timeout: timeoutSeconds,
          lane: opts.lane,
          extraSystemPrompt: opts.extraSystemPrompt,
          idempotencyKey,
        },
        expectFinal: true,
        timeoutMs: gatewayTimeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

  if (opts.json) {
    runtime.log(JSON.stringify(response, null, 2));
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (payloads.length === 0) {
    runtime.log(response?.summary ? String(response.summary) : "No reply from agent.");
    return response;
  }

  for (const payload of payloads) {
    const out = formatPayloadForLog(payload);
    if (out) {
      runtime.log(out);
    }
  }

  return response;
}

export async function agentCliCommand(opts: AgentCliOpts, runtime: RuntimeEnv, deps?: CliDeps) {
  const localOpts = {
    ...opts,
    agentId: opts.agent,
    replyAccountId: opts.replyAccount,
  };
  if (opts.local === true) {
    return await agentCommand(localOpts, runtime, deps);
  }

  try {
    return await agentViaGatewayCommand(opts, runtime);
  } catch (err) {
    runtime.error?.(`Gateway agent failed; falling back to embedded: ${String(err)}`);
    return await agentCommand(localOpts, runtime, deps);
  }
}
