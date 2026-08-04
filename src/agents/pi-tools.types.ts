import type { AgentTool } from "@mariozechner/pi-agent-core";

export type ToolSideEffect = "read_only" | "mutating";

export type AgentToolMetadata = {
  ownerOnly?: boolean;
  sideEffect?: ToolSideEffect;
  sideEffectByAction?: Readonly<Record<string, ToolSideEffect>>;
  deliveryEffect?: "user_facing";
};

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyAgentTool = AgentTool<any, unknown> & AgentToolMetadata;
