import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createDiagnosticsLangfuseRuntime } from "./src/service.js";

const runtime = createDiagnosticsLangfuseRuntime();

const plugin = {
  id: "diagnostics-langfuse",
  name: "Diagnostics Langfuse",
  description: "Export native agent traces to Langfuse",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(runtime.service);
    api.registerAgentTraceSink(runtime.sink);
  },
};

export default plugin;
