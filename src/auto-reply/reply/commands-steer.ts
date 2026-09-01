import { steerEmbeddedPiRunAllowPending } from "../../agents/pi-embedded-runner/runs.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

export function parseSteerCommand(commandBodyNormalized: string): string | null {
  const match = commandBodyNormalized.match(/^\/steer(?:\s|$)/i);
  if (!match) {
    return null;
  }
  return commandBodyNormalized.slice(match[0].length).trim();
}

function extractSteerMessage(rawBody?: string): string | undefined {
  const trimmed = rawBody?.trim() ?? "";
  const prefix = trimmed.match(/^\/steer(?=$|\s|:)/i);
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix[0].length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.trim() || undefined;
}

function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

export const handleSteerCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  if (parseSteerCommand(params.command.commandBodyNormalized) === null) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /steer from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const message = extractSteerMessage(
    params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
  );
  if (!message) {
    return stopWithText("Usage: /steer <message>");
  }

  const sessionId = params.sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return stopWithText("当前会话不可引导。");
  }

  const result = steerEmbeddedPiRunAllowPending(sessionId, message);
  const channel = params.command.channel || params.provider || "unknown";
  logVerbose(
    `Current session steer: sessionId=${sessionId} channel=${channel} status=${result.status} ${
      result.status === "accepted" ? `mode=${result.mode}` : `reason=${result.reason}`
    }`,
  );

  if (result.status === "accepted") {
    return stopWithText(
      result.mode === "steered" ? "已注入当前运行。" : "已排队，将在运行启动时注入。",
    );
  }

  switch (result.reason) {
    case "run_inactive":
      return stopWithText("当前没有可引导的运行。直接发送消息即可开始新回合。");
    case "not_streaming":
      return stopWithText("当前运行暂时不能接收引导，请稍后重试。");
    case "compacting":
      return stopWithText("当前会话正在压缩上下文，暂时不能接收引导。");
  }
};
