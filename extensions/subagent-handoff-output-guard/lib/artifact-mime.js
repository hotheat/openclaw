const path = require("node:path");

const MIME_TYPES_BY_EXTENSION = Object.freeze({
  ".pdf": ["application/pdf"],
  ".ofd": ["application/ofd"],
  ".csv": ["text/csv"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".xls": ["application/vnd.ms-excel"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".doc": ["application/msword"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".html": ["text/html"],
  ".htm": ["text/html"],
  ".rtf": ["application/rtf", "text/rtf"],
  ".txt": ["text/plain"],
  ".text": ["text/plain"],
  ".log": ["text/plain"],
  ".md": ["text/markdown"],
  ".markdown": ["text/markdown"],
  ".json": ["application/json"],
  ".jsonl": ["application/jsonlines", "application/x-ndjson"],
  ".jpeg": ["image/jpeg"],
  ".jpg": ["image/jpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"],
  ".bmp": ["image/bmp"],
  ".tif": ["image/tiff"],
  ".tiff": ["image/tiff"],
  ".svg": ["image/svg+xml"],
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
  ".mp3": ["audio/mpeg"],
  ".wav": ["audio/wav", "audio/x-wav"],
  ".m4a": ["audio/mp4", "audio/x-m4a"],
  ".flac": ["audio/flac", "audio/x-flac"],
  ".aac": ["audio/aac"],
  ".ogg": ["audio/ogg", "application/ogg"],
  ".mp4": ["video/mp4"],
  ".webm": ["video/webm"],
  ".avi": ["video/x-msvideo"],
  ".mov": ["video/quicktime"],
  ".mkv": ["video/x-matroska"],
});

const CFB_CONTAINER_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);
const TEXT_LIKE_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".htm",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".markdown",
  ".rtf",
  ".text",
  ".txt",
]);

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMimeType(value) {
  return asTrimmedString(value).split(";", 1)[0].trim().toLowerCase();
}

function normalizeExtension(value) {
  const extension = path.posix.extname(asTrimmedString(value)).toLowerCase();
  return extension;
}

function resolveExpectedMimeTypes(value) {
  return MIME_TYPES_BY_EXTENSION[normalizeExtension(value)] || [];
}

function mimeMatchesExtension(value, mimeType) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const expectedMimeTypes = resolveExpectedMimeTypes(value);
  return (
    expectedMimeTypes.length === 0 ||
    (normalizedMimeType && expectedMimeTypes.includes(normalizedMimeType))
  );
}

function detectedMimeMatchesExtension(value, mimeType) {
  const extension = normalizeExtension(value);
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!normalizedMimeType) return true;
  if (mimeMatchesExtension(value, normalizedMimeType)) return true;
  return CFB_CONTAINER_EXTENSIONS.has(extension) && normalizedMimeType === "application/x-cfb";
}

function requiresDetectedMime(value) {
  const extension = normalizeExtension(value);
  return resolveExpectedMimeTypes(value).length > 0 && !TEXT_LIKE_EXTENSIONS.has(extension);
}

module.exports = {
  MIME_TYPES_BY_EXTENSION,
  detectedMimeMatchesExtension,
  mimeMatchesExtension,
  normalizeMimeType,
  requiresDetectedMime,
  resolveExpectedMimeTypes,
};
