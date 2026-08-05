const { normalizeRelativePath } = require("./artifact-profiles.js");
const {
  deriveExplicitWorkspaceDir,
  deriveWorkspaceDir,
  escapeRegex,
} = require("./runtime-context.js");

const HANDOFF_BLOCK_PATTERN = /\s*<SUBAGENT_HANDOFF>\s*[\s\S]*?\s*<\/SUBAGENT_HANDOFF>\s*/gi;
const EXPORT_PATH_TERMINATORS = new Set([
  "`",
  '"',
  "'",
  "“",
  "”",
  "‘",
  "’",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  ",",
  "，",
  "、",
  "。",
  ";",
  "；",
  ":",
  "：",
  "!",
  "！",
  "?",
  "？",
  "=",
  "|",
  "*",
]);
const TRAILING_EXPORT_PATH_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

function isWhitespaceCharacter(value) {
  return Boolean(value) && value.trim() === "";
}

function isExportPathStartBoundary(text, start) {
  if (start === 0) return true;
  const previous = text[start - 1];
  if (previous === "`" || isWhitespaceCharacter(previous)) return true;
  return !/[A-Za-z0-9_.\/\\-]/.test(previous);
}

function isExportPathTerminator(value) {
  return !value || isWhitespaceCharacter(value) || EXPORT_PATH_TERMINATORS.has(value);
}

function trimTrailingPathPunctuation(text, start, end) {
  let nextEnd = end;
  while (nextEnd > start && TRAILING_EXPORT_PATH_PUNCTUATION.has(text[nextEnd - 1])) {
    nextEnd -= 1;
  }
  return nextEnd;
}

function resolveMarkdownLinkBounds(text, pathStart, pathEnd) {
  if (text[pathStart - 1] !== "(" || text[pathEnd] !== ")" || text[pathStart - 2] !== "]") {
    return null;
  }
  const labelStart = text.lastIndexOf("[", pathStart - 2);
  if (labelStart < 0 || text.slice(labelStart, pathStart - 2).includes("\n")) return null;
  return {
    start: labelStart > 0 && text[labelStart - 1] === "!" ? labelStart - 1 : labelStart,
    end: pathEnd + 1,
  };
}

function readArtifactPathMention(text, pathStart) {
  const prefix = "artifacts";
  if (!isExportPathStartBoundary(text, pathStart) || text[pathStart + prefix.length] !== "/") {
    return null;
  }

  const isCodeSpan = text[pathStart - 1] === "`";
  let pathEnd;
  let replacementStart = pathStart;
  let replacementEnd;
  if (isCodeSpan) {
    pathEnd = text.indexOf("`", pathStart);
    if (pathEnd < 0 || text.slice(pathStart, pathEnd).includes("\n")) return null;
    replacementStart = pathStart - 1;
    replacementEnd = pathEnd + 1;
  } else {
    pathEnd = pathStart + prefix.length + 1;
    while (pathEnd < text.length && !isExportPathTerminator(text[pathEnd])) pathEnd += 1;
    pathEnd = trimTrailingPathPunctuation(text, pathStart, pathEnd);
    replacementEnd = pathEnd;
    const markdownBounds = resolveMarkdownLinkBounds(text, pathStart, pathEnd);
    if (markdownBounds) {
      replacementStart = markdownBounds.start;
      replacementEnd = markdownBounds.end;
    }
  }

  return normalizeRelativePath(text.slice(pathStart, pathEnd))
    ? { replacementStart, replacementEnd }
    : null;
}

function sanitizeArtifactPathMentions(text) {
  const chunks = [];
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const pathStart = text.indexOf("artifacts", searchFrom);
    if (pathStart < 0) break;
    const mention = readArtifactPathMention(text, pathStart);
    if (!mention) {
      searchFrom = pathStart + "artifacts".length;
      continue;
    }
    chunks.push(text.slice(cursor, mention.replacementStart), "《文件》");
    cursor = mention.replacementEnd;
    searchFrom = mention.replacementEnd;
  }
  return chunks.length > 0 ? chunks.join("") + text.slice(cursor) : text;
}

function sanitizeWorkspacePaths(text, ctx, api) {
  let next = text;
  const candidates = [deriveExplicitWorkspaceDir(ctx), deriveWorkspaceDir(ctx, api)].filter(
    Boolean,
  );
  for (const workspaceDir of new Set(candidates)) {
    const pattern = new RegExp(
      `${escapeRegex(workspaceDir)}(?:[\\\\/][^\\s"'\\x60<>()[\\]{}]+)+`,
      "g",
    );
    next = next.replace(pattern, "《文件》");
  }
  next = next.replace(
    /(?:\/[^\s"'`<>()[\]{}]+)*\/workspace(?:-[^\s\/"'`<>()[\]{}]+)?(?:\/[^\s"'`<>()[\]{}]+)+/g,
    "《文件》",
  );
  return next;
}

function sanitizeOutgoingText(text, ctx, api) {
  if (typeof text !== "string") return null;
  let next = text.replace(HANDOFF_BLOCK_PATTERN, "\n");
  if (api.pluginConfig?.removeExportPathFromBody !== false) {
    next = sanitizeWorkspacePaths(next, ctx, api);
    next = sanitizeArtifactPathMentions(next);
  }
  next = next
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return next === text ? null : next;
}

module.exports = {
  sanitizeOutgoingText,
};
