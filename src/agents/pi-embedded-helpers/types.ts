export type EmbeddedContextFile = { path: string; content: string };

export type FailoverReason =
  | "auth"
  | "format"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "model_config"
  | "unknown";
