const test = require("node:test");
const assert = require("node:assert/strict");

const register = require("../index.js");

function createHarness(pluginConfig = {}) {
  const handlers = new Map();
  const logs = {
    info: [],
    warn: [],
    debug: [],
  };
  const api = {
    pluginConfig,
    logger: {
      info(message) {
        logs.info.push(message);
      },
      warn(message) {
        logs.warn.push(message);
      },
      debug(message) {
        logs.debug.push(message);
      },
    },
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
  };
  register(api);

  function call(name, event, ctx) {
    const fn = handlers.get(name);
    assert.ok(fn, `missing hook: ${name}`);
    return fn(event, ctx);
  }

  return { handlers, logs, call };
}

function persistFailure(h, overrides = {}, ctx = { sessionKey: "sess-1" }) {
  h.call(
    "tool_result_persist",
    {
      toolName: "web_search",
      toolCallId: "tc_1",
      isSynthetic: false,
      message: {
        role: "toolResult",
        toolName: "web_search",
        isError: true,
        content: [{ type: "text", text: "provider timeout" }],
      },
      ...overrides,
    },
    ctx,
  );
}

test("registers logging hooks without prompt or message recovery hooks", () => {
  const h = createHarness({ enabled: true });

  assert.deepEqual([...h.handlers.keys()].sort(), [
    "after_tool_call",
    "session_end",
    "tool_result_persist",
  ]);
  assert.equal(h.handlers.has("before_prompt_build"), false);
  assert.equal(h.handlers.has("before_message_write"), false);
});

test("tool_result_persist records a failed tool result without changing messages", () => {
  const h = createHarness({ enabled: true });

  persistFailure(h);

  assert.equal(h.logs.warn.length, 1);
  assert.match(h.logs.warn[0], /latched failure/);
  assert.match(h.logs.warn[0], /scope=session:sess-1/);
  assert.match(h.logs.warn[0], /tool=web_search/);
  assert.match(h.logs.warn[0], /error=toolResult\.isError=true/);
});

test("successful retry clears the matching failure latch and logs recovery once", () => {
  const h = createHarness({ enabled: true });
  persistFailure(h, { toolCallId: "tc_2" }, { sessionKey: "sess-2" });

  const recoveryEvent = {
    toolName: "web_search",
    result: { status: "ok" },
  };
  h.call("after_tool_call", recoveryEvent, { sessionKey: "sess-2" });
  h.call("after_tool_call", recoveryEvent, { sessionKey: "sess-2" });

  assert.equal(h.logs.info.length, 1);
  assert.match(h.logs.info[0], /reason=tool_recovered:web_search/);
});

test("successful message delivery clears previous tool failure latch", () => {
  const h = createHarness({ enabled: true });
  persistFailure(
    h,
    {
      toolCallId: "tc_delivery_recovery",
    },
    { sessionKey: "sess-delivery-recovery" },
  );

  h.call(
    "after_tool_call",
    {
      toolName: "message",
      result: { status: "success" },
    },
    { sessionKey: "sess-delivery-recovery" },
  );

  assert.equal(h.logs.info.length, 1);
  assert.match(h.logs.info[0], /reason=delivery_tool_succeeded:message/);
});

test("after_tool_call without session scope does not break; persist hook still latches", () => {
  const h = createHarness({ enabled: true });

  h.call(
    "after_tool_call",
    {
      toolName: "web_search",
      error: "network fail",
    },
    {},
  );

  persistFailure(
    h,
    {
      toolCallId: "tc_3",
      message: {
        role: "toolResult",
        toolName: "web_search",
        isError: true,
        content: [{ type: "text", text: "network fail" }],
      },
    },
    { sessionKey: "sess-3" },
  );

  assert.equal(h.logs.debug.length, 1);
  assert.match(h.logs.debug[0], /missing session scope/);
  assert.equal(h.logs.warn.length, 1);
  assert.match(h.logs.warn[0], /scope=session:sess-3/);
  assert.match(h.logs.warn[0], /tool=web_search/);
});
