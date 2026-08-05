import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const SubagentRunStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("timeout"),
  Type.Literal("unknown"),
]);

export const SubagentRunSchema = Type.Object(
  {
    runId: NonEmptyString,
    childSessionKey: NonEmptyString,
    sourceToolCallId: Type.Optional(NonEmptyString),
    label: Type.Optional(NonEmptyString),
    sessionLabel: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    spawnMode: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("session")])),
    createdAt: Type.Integer({ minimum: 0 }),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    status: SubagentRunStatusSchema,
  },
  { additionalProperties: false },
);

export const SubagentsListParamsSchema = Type.Object(
  {
    requesterSessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SubagentsListResultSchema = Type.Object(
  {
    runs: Type.Array(SubagentRunSchema),
  },
  { additionalProperties: false },
);
