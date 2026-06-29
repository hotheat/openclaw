const test = require("node:test");
const assert = require("node:assert/strict");

const register = require("../index.js");

function createHarness(pluginConfig) {
  let beforeToolCall = null;
  const api = {
    pluginConfig,
    logger: {
      info() {},
      warn() {},
    },
    on(eventName, handler) {
      assert.equal(eventName, "before_tool_call");
      beforeToolCall = handler;
    },
  };
  register(api);
  assert.ok(beforeToolCall, "plugin should register before_tool_call handler");
  return beforeToolCall;
}

test("patches legacy researcher Feishu handoff bundle", async () => {
  const invoke = createHarness({});
  const task = [
    "Research goal: demo",
    "Allowed handoff: inline",
    "Preferred handoff: inline",
    "Delivery channel: none",
    "Delivery peer: none",
    "Export location: none",
  ].join("\n");

  const result = await invoke(
    {
      toolName: "sessions_spawn",
      params: {
        agentId: "researcher",
        task,
      },
    },
    { agentId: "feishu-ou_test123" },
  );

  assert.ok(result);
  const nextTask = result.params.task;
  assert.match(nextTask, /Allowed handoff: inline \| hybrid \| export-file/);
  assert.match(nextTask, /Preferred handoff: auto/);
  assert.match(nextTask, /Delivery channel: feishu/);
  assert.match(nextTask, /Delivery peer: direct ou_test123/);
  assert.match(nextTask, /Export location: artifacts\/exports\/feishu\/researcher-/);
  assert.doesNotMatch(nextTask, /File delivery rule:/);
  assert.equal(result.params.completionDelivery, "parent");
});

test("appends missing Feishu handoff metadata", async () => {
  const invoke = createHarness({});
  const result = await invoke(
    {
      toolName: "sessions_spawn",
      params: {
        agentId: "researcher",
        task: "Research goal: demo\nQuestions/Dimensions: x",
      },
    },
    { agentId: "feishu-group-oc_group123" },
  );

  assert.ok(result);
  const nextTask = result.params.task;
  assert.match(nextTask, /Allowed handoff: inline \| hybrid \| export-file/);
  assert.match(nextTask, /Delivery peer: group oc_group123/);
  assert.doesNotMatch(nextTask, /File delivery rule:/);
  assert.equal(result.params.completionDelivery, "parent");
});

test("sets parent completion delivery for explicit non-legacy researcher handoff metadata", async () => {
  const invoke = createHarness({});
  const task = [
    "Research goal: demo",
    "Allowed handoff: inline | hybrid | export-file",
    "Preferred handoff: auto",
    "Delivery channel: feishu",
    "Delivery peer: direct ou_test123",
    "Export location: artifacts/exports/feishu/custom/",
  ].join("\n");

  const result = await invoke(
    {
      toolName: "sessions_spawn",
      params: {
        agentId: "researcher",
        task,
      },
    },
    { agentId: "feishu-ou_test123" },
  );

  assert.ok(result);
  assert.equal(result.params.task, undefined);
  assert.equal(result.params.completionDelivery, "parent");
});

test("preserves explicit parent completion delivery for non-legacy researcher handoff metadata", async () => {
  const invoke = createHarness({});
  const task = [
    "Research goal: demo",
    "Allowed handoff: inline | hybrid | export-file",
    "Preferred handoff: auto",
    "Delivery channel: feishu",
    "Delivery peer: direct ou_test123",
    "Export location: artifacts/exports/feishu/custom/",
  ].join("\n");

  const result = await invoke(
    {
      toolName: "sessions_spawn",
      params: {
        agentId: "researcher",
        task,
        completionDelivery: "parent",
      },
    },
    { agentId: "feishu-ou_test123" },
  );

  assert.equal(result, undefined);
});

test("preserves explicit direct completion delivery for non-legacy researcher handoff metadata", async () => {
  const invoke = createHarness({});
  const task = [
    "Research goal: demo",
    "Allowed handoff: inline | hybrid | export-file",
    "Preferred handoff: auto",
    "Delivery channel: feishu",
    "Delivery peer: direct ou_test123",
    "Export location: artifacts/exports/feishu/custom/",
  ].join("\n");

  const result = await invoke(
    {
      toolName: "sessions_spawn",
      params: {
        agentId: "researcher",
        task,
        completionDelivery: "direct",
      },
    },
    { agentId: "feishu-ou_test123" },
  );

  assert.equal(result, undefined);
});

test("respects explicit disable token", async () => {
  const invoke = createHarness({});
  const task = [
    "Research goal: demo",
    "Feishu researcher delegation guard: disable",
    "Allowed handoff: inline",
    "Preferred handoff: inline",
  ].join("\n");

  const result = await invoke(
    {
      toolName: "sessions_spawn",
      params: {
        agentId: "researcher",
        task,
      },
    },
    { agentId: "feishu-ou_test123" },
  );

  assert.equal(result, undefined);
});
