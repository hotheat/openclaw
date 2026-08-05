const WEB_SEARCH_TOOL_NAME = "web_search";
const EXEC_TOOL_NAME = "exec";

const VALID_SEARCH_LANGS = new Set([
  "ar",
  "eu",
  "bn",
  "bg",
  "ca",
  "zh-hans",
  "zh-hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "en-gb",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "is",
  "it",
  "jp",
  "kn",
  "ko",
  "lv",
  "lt",
  "ms",
  "ml",
  "mr",
  "nb",
  "pl",
  "pt-br",
  "pt-pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
]);

const DEFAULT_SEARCH_LANG_ALIASES = Object.freeze({
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-sg": "zh-hans",
  "zh-hans": "zh-hans",
  "zh-tw": "zh-hant",
  "zh-hk": "zh-hant",
  "zh-mo": "zh-hant",
  "zh-hant": "zh-hant",
  "en-us": "en",
  "en-gb": "en-gb",
});

const DEFAULT_UI_LANG_ALIASES = Object.freeze({
  en: "en-US",
  "en-us": "en-US",
  "en-gb": "en-GB",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
  "zh-hant": "zh-TW",
  ja: "ja-JP",
  "ja-jp": "ja-JP",
  ko: "ko-KR",
  "ko-kr": "ko-KR",
  fr: "fr-FR",
  "fr-fr": "fr-FR",
  de: "de-DE",
  "de-de": "de-DE",
  es: "es-ES",
  "es-es": "es-ES",
  pt: "pt-PT",
  "pt-pt": "pt-PT",
  "pt-br": "pt-BR",
});

function normalizeKey(value) {
  return String(value).trim().replace(/_/g, "-").toLowerCase();
}

function mergeAliasMap(defaults, overrides) {
  const map = { ...defaults };
  if (!overrides || typeof overrides !== "object") return map;

  for (const [rawKey, rawValue] of Object.entries(overrides)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    map[normalizeKey(rawKey)] = rawValue.trim();
  }
  return map;
}

function normalizeSearchLang(value, aliases) {
  if (typeof value !== "string") return null;
  const key = normalizeKey(value);
  if (!key) return null;
  const aliased = aliases[key];
  if (aliased) return aliased;
  if (VALID_SEARCH_LANGS.has(key)) return key;
  return null;
}

function normalizeUiLang(value, aliases) {
  if (typeof value !== "string") return null;
  const key = normalizeKey(value);
  if (!key) return null;
  const aliased = aliases[key];
  if (aliased) return aliased;

  if (/^[a-z]{2,3}-[a-z]{2}$/i.test(key)) {
    const [lang, region] = key.split("-");
    return `${lang.toLowerCase()}-${region.toUpperCase()}`;
  }

  return null;
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isFeishuAgentContext(ctx) {
  const agentId = asString(ctx?.agentId).toLowerCase();
  return agentId.startsWith("feishu-");
}

function isHelpOnlyCommand(command) {
  return /(^|\s)(--help|-h)(\s|$)/.test(command);
}

function isBlockedOpenClawMessageSend(command) {
  const trimmed = asString(command);
  if (!trimmed || isHelpOnlyCommand(trimmed)) return false;

  const openclawCliRe = /\bopenclaw\b(?:\s+--[A-Za-z0-9._-]+(?:[=\s]+\S+)*)*\s+\bmessage\s+send\b/i;
  if (openclawCliRe.test(trimmed)) return true;

  const nodeOpenclawCliRe =
    /\bnode\b[\s\S]{0,300}?\bopenclaw(?:\.mjs|\/dist\/index\.js)\b[\s\S]{0,120}?\bmessage\s+send\b/i;
  return nodeOpenclawCliRe.test(trimmed);
}

module.exports = function register(api) {
  api.on("before_tool_call", async (event, ctx) => {
    if (!event || !event.toolName) return;

    if (event.toolName === EXEC_TOOL_NAME) {
      const execGuardConfig = api.pluginConfig?.execMessaging || {};
      if (execGuardConfig.enabled !== false && isFeishuAgentContext(ctx)) {
        const params = event.params && typeof event.params === "object" ? event.params : {};
        const command = asString(params.command || params.cmd);
        if (isBlockedOpenClawMessageSend(command)) {
          return {
            block: true,
            blockReason:
              execGuardConfig.blockMessage ||
              "Feishu 会话中禁止通过 exec 调用 openclaw message send；请使用 message 工具，让 outbox/router 接管发送。",
          };
        }
      }
      return;
    }

    if (event.toolName !== WEB_SEARCH_TOOL_NAME) return;

    const params = event.params && typeof event.params === "object" ? event.params : null;
    if (!params) return;

    const webSearchConfig = api.pluginConfig?.webSearch || api.pluginConfig || {};
    if (webSearchConfig.enabled === false) return;

    const searchLangAliases = mergeAliasMap(
      DEFAULT_SEARCH_LANG_ALIASES,
      webSearchConfig.searchLangAliases,
    );
    const uiLangAliases = mergeAliasMap(DEFAULT_UI_LANG_ALIASES, webSearchConfig.uiLangAliases);

    const nextParams = { ...params };
    const patched = [];

    if (typeof params.search_lang === "string") {
      const normalized = normalizeSearchLang(params.search_lang, searchLangAliases);
      if (normalized && normalized !== params.search_lang) {
        nextParams.search_lang = normalized;
        patched.push(`search_lang=${normalized}`);
      } else if (!normalized && webSearchConfig.dropInvalidSearchLang !== false) {
        delete nextParams.search_lang;
        patched.push("search_lang=<removed>");
      }
    }

    if (typeof params.ui_lang === "string") {
      const normalized = normalizeUiLang(params.ui_lang, uiLangAliases);
      if (normalized && normalized !== params.ui_lang) {
        nextParams.ui_lang = normalized;
        patched.push(`ui_lang=${normalized}`);
      } else if (!normalized && webSearchConfig.dropInvalidUiLang !== false) {
        delete nextParams.ui_lang;
        patched.push("ui_lang=<removed>");
      }
    }

    if (patched.length === 0) return;

    api.logger.info?.(`tool-request-guard: normalized web_search params: ${patched.join(", ")}`);
    return { params: nextParams };
  });
};
