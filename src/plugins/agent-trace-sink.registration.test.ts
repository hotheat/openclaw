import { describe, expect, it, vi } from "vitest";
import type { AgentTraceSink } from "../agents/tracing/types.js";
import { createPluginRegistry, type PluginRecord } from "./registry.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createPluginRecord(): PluginRecord {
  return {
    id: "diagnostics-langfuse",
    name: "Diagnostics Langfuse",
    version: "test",
    description: "test",
    source: "/tmp/diagnostics-langfuse/index.ts",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    agentTraceSinks: 0,
    configSchema: false,
  };
}

describe("plugin agent trace sink registration", () => {
  it("adds registered sinks to the plugin registry", () => {
    const controller = createPluginRegistry({
      logger: createLogger(),
      runtime: {} as never,
    });
    const record = createPluginRecord();
    const sink: AgentTraceSink = {
      startRun: vi.fn(),
    };

    const api = controller.createApi(record, { config: {} });
    api.registerAgentTraceSink(sink);

    expect(record.agentTraceSinks).toBe(1);
    expect(controller.registry.agentTraceSinks).toEqual([
      {
        pluginId: "diagnostics-langfuse",
        sink,
        source: "/tmp/diagnostics-langfuse/index.ts",
      },
    ]);
  });
});
