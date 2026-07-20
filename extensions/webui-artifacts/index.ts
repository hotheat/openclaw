import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../../src/plugins/types.js";
import { ArtifactClient } from "./src/artifact-client.js";
import { createWebuiArtifactTool, publishWorkspaceArtifact } from "./src/webui-artifact-tool.js";

type WebchatArtifactsConfig = {
  endpoint?: string;
  apiKey?: string;
};

function resolvePluginConfig(api: OpenClawPluginApi): WebchatArtifactsConfig {
  const endpoint =
    typeof api.pluginConfig?.endpoint === "string" ? api.pluginConfig.endpoint.trim() : "";
  const apiKey = typeof api.pluginConfig?.apiKey === "string" ? api.pluginConfig.apiKey.trim() : "";
  return { endpoint, apiKey };
}

export function isParentWebchatToolContext(ctx: OpenClawPluginToolContext): boolean {
  const messageChannel = ctx.messageChannel?.trim().toLowerCase();
  if (messageChannel !== "webchat" && messageChannel !== "internal") {
    return false;
  }
  const parts = ctx.sessionKey?.split(":") ?? [];
  return (
    parts.length === 5 &&
    parts[0] === "agent" &&
    Boolean(parts[1]) &&
    parts[2] === "webchat" &&
    Boolean(parts[3]) &&
    Boolean(parts[4])
  );
}

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const config = resolvePluginConfig(api);
      if (
        !isParentWebchatToolContext(ctx) ||
        !ctx.workspaceDir?.trim() ||
        !config.endpoint ||
        !config.apiKey
      ) {
        return null;
      }
      return createWebuiArtifactTool({
        client: new ArtifactClient(config),
        sessionKey: ctx.sessionKey!,
        workspaceDir: ctx.workspaceDir,
      }) as AnyAgentTool;
    },
    { names: ["webui_artifact_publish"] },
  );

  api.on("subagent_handoff_delivery", async (event) => {
    const config = resolvePluginConfig(api);
    const messageChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    const sessionParts = event.requesterSessionKey.split(":");
    const isWebChatSession =
      sessionParts.length === 5 &&
      sessionParts[0] === "agent" &&
      Boolean(sessionParts[1]) &&
      sessionParts[2] === "webchat" &&
      Boolean(sessionParts[3]) &&
      Boolean(sessionParts[4]);
    const isCompatibleChannel =
      !messageChannel || messageChannel === "webchat" || messageChannel === "internal";
    if (!isWebChatSession || !isCompatibleChannel || !config.endpoint || !config.apiKey) return;

    const client = new ArtifactClient(config);
    const failures: Array<{ relativePath: string; message: string }> = [];
    for (const [index, artifact] of event.artifacts.entries()) {
      try {
        await publishWorkspaceArtifact({
          client,
          sessionKey: event.requesterSessionKey,
          workspaceDir: event.requesterWorkspaceDir,
          filePath: artifact.relativePath,
          filename: artifact.fileName,
          caption: artifact.title,
          sourceId: `subagent-handoff:${event.runId}:${index}`,
          signal: event.signal,
        });
      } catch (error) {
        failures.push({
          relativePath: artifact.relativePath,
          message: error instanceof Error ? error.message : "artifact publish failed",
        });
      }
    }
    return failures.length > 0 ? { failures } : undefined;
  });
}
