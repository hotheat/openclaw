const MB = 1024 * 1024;

export const FEISHU_INBOUND_RESOURCE_LIMIT_MB = 100;
export const FEISHU_OUTBOUND_FILE_LIMIT_MB = 30;
export const FEISHU_OUTBOUND_IMAGE_LIMIT_MB = 10;

export type FeishuMediaDirection = "inbound" | "outbound";
export type FeishuMediaKind = "image" | "file";

export type FeishuMediaLimitConfig = {
  mediaMaxMb?: number;
  inboundMediaMaxMb?: number;
  outboundFileMaxMb?: number;
  outboundImageMaxMb?: number;
};

export class FeishuMediaLimitError extends Error {
  public readonly direction: FeishuMediaDirection;
  public readonly kind: FeishuMediaKind;
  public readonly limitMb: number;
  public readonly actualMb?: number;

  constructor(params: {
    direction: FeishuMediaDirection;
    kind: FeishuMediaKind;
    limitMb: number;
    actualMb?: number;
    cause?: unknown;
  }) {
    const subject = params.kind === "image" ? "图片" : "文件";
    const actual = typeof params.actualMb === "number" ? `，当前约 ${params.actualMb}MB` : "";
    const message =
      params.direction === "inbound"
        ? `${subject}超过入站上限 ${params.limitMb}MB${actual}，请压缩后重发。`
        : `${subject}超过飞书发送上限 ${params.limitMb}MB${actual}，请压缩后再发送。`;
    super(message, { cause: params.cause instanceof Error ? params.cause : undefined });
    this.name = "FeishuMediaLimitError";
    this.direction = params.direction;
    this.kind = params.kind;
    this.limitMb = params.limitMb;
    this.actualMb = params.actualMb;
  }
}

export function bytesToMbCeil(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / MB));
}

export function mbToBytes(mb: number): number {
  return mb * MB;
}

export function resolveFeishuInboundLimitBytes(config?: FeishuMediaLimitConfig): number {
  const configuredLimitMb = config?.inboundMediaMaxMb ?? config?.mediaMaxMb;
  return mbToBytes(
    Math.min(
      configuredLimitMb ?? FEISHU_INBOUND_RESOURCE_LIMIT_MB,
      FEISHU_INBOUND_RESOURCE_LIMIT_MB,
    ),
  );
}

export function resolveFeishuOutboundLimitBytes(params: {
  config?: FeishuMediaLimitConfig;
  kind: FeishuMediaKind;
}): number {
  const platformLimitMb =
    params.kind === "image" ? FEISHU_OUTBOUND_IMAGE_LIMIT_MB : FEISHU_OUTBOUND_FILE_LIMIT_MB;
  const configuredLimitMb =
    params.kind === "image"
      ? (params.config?.outboundImageMaxMb ?? params.config?.mediaMaxMb)
      : (params.config?.outboundFileMaxMb ?? params.config?.mediaMaxMb);
  return mbToBytes(Math.min(configuredLimitMb ?? platformLimitMb, platformLimitMb));
}

export function isFeishuMediaLimitError(err: unknown): err is FeishuMediaLimitError {
  return err instanceof FeishuMediaLimitError;
}

export function maybeCreateInboundLimitError(params: {
  err: unknown;
  kind: FeishuMediaKind;
  limitBytes: number;
}): FeishuMediaLimitError | null {
  if (isFeishuMediaLimitError(params.err)) {
    return params.err;
  }
  const text = String(params.err);
  const looksLikeLocalLimit = /Media exceeds \d+MB limit/i.test(text);
  const looksLikeFeishuDownloadLimit =
    text.includes("234037") || /Downloaded file size exceeds limit/i.test(text);
  if (!looksLikeLocalLimit && !looksLikeFeishuDownloadLimit) {
    return null;
  }
  return new FeishuMediaLimitError({
    direction: "inbound",
    kind: params.kind,
    limitMb: bytesToMbCeil(params.limitBytes),
    cause: params.err,
  });
}
