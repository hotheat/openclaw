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

test("normalizes common web_search language aliases", async () => {
  const invoke = createHarness({});
  const result = await invoke({
    toolName: "web_search",
    params: {
      query: "eed inhibitor",
      search_lang: "zh",
      ui_lang: "en",
    },
  });

  assert.ok(result);
  assert.equal(result.params.search_lang, "zh-hans");
  assert.equal(result.params.ui_lang, "en-US");
});

test("normalizes locale-like variants for web_search language params", async () => {
  const invoke = createHarness({});
  const result = await invoke({
    toolName: "web_search",
    params: {
      query: "eed inhibitor",
      search_lang: "ZH_tw",
      ui_lang: "zh_hant",
    },
  });

  assert.ok(result);
  assert.equal(result.params.search_lang, "zh-hant");
  assert.equal(result.params.ui_lang, "zh-TW");
});

test("removes unsupported web_search language params by default", async () => {
  const invoke = createHarness({});
  const result = await invoke({
    toolName: "web_search",
    params: {
      query: "eed inhibitor",
      search_lang: "not-a-lang",
      ui_lang: "not-a-locale",
    },
  });

  assert.ok(result);
  assert.deepEqual(result.params, {
    query: "eed inhibitor",
  });
});

test("preserves valid web_search language params", async () => {
  const invoke = createHarness({});
  const result = await invoke({
    toolName: "web_search",
    params: {
      query: "eed inhibitor",
      search_lang: "en",
      ui_lang: "zh-CN",
    },
  });

  assert.equal(result, undefined);
});

test("can keep invalid params when dropping is disabled", async () => {
  const invoke = createHarness({
    webSearch: {
      dropInvalidSearchLang: false,
      dropInvalidUiLang: false,
    },
  });
  const result = await invoke({
    toolName: "web_search",
    params: {
      query: "eed inhibitor",
      search_lang: "not-a-lang",
      ui_lang: "not-a-locale",
    },
  });

  assert.equal(result, undefined);
});

test("ignores non-web_search tools", async () => {
  const invoke = createHarness({});
  const result = await invoke({
    toolName: "message",
    params: {
      text: "demo",
    },
  });

  assert.equal(result, undefined);
});

test("blocks exec openclaw message send in feishu agent contexts", async () => {
  const invoke = createHarness({});
  const result = await invoke(
    {
      toolName: "exec",
      params: {
        command: "openclaw message send --channel feishu --target user:ou_test --message 'hi'",
      },
    },
    { agentId: "feishu-ou_test" },
  );

  assert.deepEqual(result, {
    block: true,
    blockReason:
      "Feishu 会话中禁止通过 exec 调用 openclaw message send；请使用 message 工具，让 outbox/router 接管发送。",
  });
});

test("allows exec openclaw message send outside feishu agent contexts", async () => {
  const invoke = createHarness({});
  const result = await invoke(
    {
      toolName: "exec",
      params: {
        command: "openclaw message send --channel telegram --target @demo --message 'hi'",
      },
    },
    { agentId: "researcher" },
  );

  assert.equal(result, undefined);
});

test("allows help-only exec openclaw message send commands", async () => {
  const invoke = createHarness({});
  const result = await invoke(
    {
      toolName: "exec",
      params: {
        command: "openclaw message send --help",
      },
    },
    { agentId: "feishu-ou_test" },
  );

  assert.equal(result, undefined);
});
