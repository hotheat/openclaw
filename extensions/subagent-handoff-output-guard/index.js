const { createConfirmationDelivery } = require("./lib/confirmation-delivery.js");
const { createHandoffStateStore } = require("./lib/handoff-state-store.js");
const { sanitizeOutgoingText } = require("./lib/output-sanitizer.js");
const { isEnabledForContext, normalizeChannels } = require("./lib/runtime-context.js");
const { createStagingPolicy } = require("./lib/staging-policy.js");

module.exports = function register(api) {
  const stateStore = createHandoffStateStore(api);
  const stagingPolicy = createStagingPolicy(api, stateStore);
  const confirmationDelivery = createConfirmationDelivery(api, stateStore);

  api.on("subagent_handoff_staging", stagingPolicy.preflightHandoff, { priority: 200 });

  api.on("subagent_handoff_staging", stagingPolicy.stageHandoffArtifacts, { priority: 100 });

  api.on("subagent_handoff_staging", stagingPolicy.stageHandoff, { priority: 0 });

  api.on("message_sending", async (event, ctx) => {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForContext(ctx, enabledChannels) || typeof event?.content !== "string") return;
    const content = sanitizeOutgoingText(event.content, ctx, api);
    return content === null ? undefined : { content };
  });

  api.on("before_prompt_build", async (_event, ctx) => {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForContext(ctx, enabledChannels)) return;
    return confirmationDelivery.beforePromptBuild(ctx);
  });

  api.on("before_tool_call", confirmationDelivery.beforeToolCall);
  api.on("after_tool_call", confirmationDelivery.afterToolCall);
};
