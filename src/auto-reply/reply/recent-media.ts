import path from "node:path";
import type { SessionRecentMediaSnapshot } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
]);

const IMAGE_REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:image|picture|photo|screenshot|slide|ppt|chart|graph|figure|diagram|poster)\b/i,
  /(?:这|那|该|上|前)(?:张|个|页)?(?:图|图片|照片|截图|海报|幻灯片|页面|PPT)/u,
  /(?:图里|图上|图中的|图片里|图片上|上图|前图|上一页|这页)/u,
  /(?:解释|介绍|分析|解读|总结|描述|识别|提取|看懂|翻译).{0,12}(?:图|图片|照片|截图|海报|幻灯片|页面|PPT)/u,
];

type MediaEntry = {
  path: string;
  url?: string;
  type?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMediaType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.split(";")[0]?.trim().toLowerCase() : undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

function collectMediaEntries(ctx: MsgContext): MediaEntry[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : typeof ctx.MediaPath === "string" && ctx.MediaPath.trim().length > 0
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return [];
  }

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;

  return paths
    .map((entry, index) => ({
      path: entry?.trim() ?? "",
      url: normalizeOptionalString(urls?.[index] ?? (index === 0 ? ctx.MediaUrl : undefined)),
      type: normalizeMediaType(types?.[index] ?? (index === 0 ? ctx.MediaType : undefined)),
    }))
    .filter((entry) => entry.path.length > 0);
}

function isImageEntry(entry: MediaEntry): boolean {
  if (entry.type?.startsWith("image/")) {
    return true;
  }
  const ext = path.extname(entry.path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return true;
  }
  if (entry.url) {
    try {
      const url = new URL(entry.url);
      return IMAGE_EXTENSIONS.has(path.extname(url.pathname).toLowerCase());
    } catch {
      return IMAGE_EXTENSIONS.has(path.extname(entry.url).toLowerCase());
    }
  }
  return false;
}

function currentMessageText(ctx: MsgContext): string {
  return (
    ctx.BodyForCommands ??
    ctx.CommandBody ??
    ctx.RawBody ??
    ctx.BodyForAgent ??
    ctx.Body ??
    ""
  ).trim();
}

function referencesImage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return IMAGE_REFERENCE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function hasMediaAttachments(ctx: MsgContext): boolean {
  return Boolean(
    (Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0) ||
    (typeof ctx.MediaPath === "string" && ctx.MediaPath.trim().length > 0),
  );
}

function matchesSnapshotScope(ctx: MsgContext, snapshot: SessionRecentMediaSnapshot): boolean {
  const snapshotSender = normalizeOptionalString(snapshot.senderId);
  const currentSender = normalizeOptionalString(ctx.SenderId);
  if (snapshotSender || currentSender) {
    if (snapshotSender !== currentSender) {
      return false;
    }
  }

  const snapshotAccount = normalizeOptionalString(snapshot.accountId);
  const currentAccount = normalizeOptionalString(ctx.AccountId);
  if (snapshotAccount || currentAccount) {
    if (snapshotAccount !== currentAccount) {
      return false;
    }
  }

  const snapshotThread = normalizeThreadId(snapshot.threadId);
  const currentThread = normalizeThreadId(ctx.MessageThreadId);
  return snapshotThread === currentThread;
}

export function buildRecentImageSnapshot(
  ctx: MsgContext,
  capturedAt = Date.now(),
): SessionRecentMediaSnapshot | undefined {
  const imageEntries = collectMediaEntries(ctx).filter(isImageEntry);
  if (imageEntries.length === 0) {
    return undefined;
  }

  return {
    kind: "image",
    messageId: normalizeOptionalString(ctx.MessageSid),
    messageIdFull: normalizeOptionalString(ctx.MessageSidFull),
    senderId: normalizeOptionalString(ctx.SenderId),
    accountId: normalizeOptionalString(ctx.AccountId),
    threadId: normalizeThreadId(ctx.MessageThreadId),
    capturedAt,
    paths: imageEntries.map((entry) => entry.path),
    urls: imageEntries.some((entry) => entry.url)
      ? imageEntries.map((entry) => entry.url ?? entry.path)
      : undefined,
    types: imageEntries.some((entry) => entry.type)
      ? imageEntries.map((entry) => entry.type ?? "application/octet-stream")
      : undefined,
    pendingFollowup: true,
  };
}

export function shouldAttachRecentImageSnapshot(params: {
  ctx: MsgContext;
  snapshot?: SessionRecentMediaSnapshot;
}): boolean {
  const { ctx, snapshot } = params;
  if (!snapshot || snapshot.kind !== "image" || snapshot.paths.length === 0) {
    return false;
  }
  if (hasMediaAttachments(ctx)) {
    return false;
  }
  if (!matchesSnapshotScope(ctx, snapshot)) {
    return false;
  }

  const currentMessageId =
    normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid);
  if (
    currentMessageId &&
    (currentMessageId === snapshot.messageIdFull || currentMessageId === snapshot.messageId)
  ) {
    return false;
  }

  const replyTarget =
    normalizeOptionalString(ctx.ReplyToIdFull) ?? normalizeOptionalString(ctx.ReplyToId);
  if (
    replyTarget &&
    (replyTarget === snapshot.messageIdFull || replyTarget === snapshot.messageId)
  ) {
    return true;
  }

  const text = currentMessageText(ctx);
  if (!text) {
    return false;
  }
  if (text.startsWith("/")) {
    return false;
  }
  if (snapshot.pendingFollowup) {
    return true;
  }
  return referencesImage(text);
}

export function attachRecentImageSnapshot(params: {
  ctx: MsgContext;
  snapshot: SessionRecentMediaSnapshot;
}): SessionRecentMediaSnapshot {
  const { ctx, snapshot } = params;
  ctx.MediaPaths = [...snapshot.paths];
  ctx.MediaPath = snapshot.paths[0];

  if (snapshot.urls && snapshot.urls.length > 0) {
    ctx.MediaUrls = [...snapshot.urls];
    ctx.MediaUrl = snapshot.urls[0];
  }
  if (snapshot.types && snapshot.types.length > 0) {
    ctx.MediaTypes = [...snapshot.types];
    ctx.MediaType = snapshot.types[0];
  }

  return {
    ...snapshot,
    paths: [...snapshot.paths],
    urls: snapshot.urls ? [...snapshot.urls] : undefined,
    types: snapshot.types ? [...snapshot.types] : undefined,
    pendingFollowup: false,
  };
}
