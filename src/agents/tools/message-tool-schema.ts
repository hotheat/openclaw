import { Type } from "@sinclair/typebox";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../channels/plugins/types.js";
import { channelTargetSchema, channelTargetsSchema, stringEnum } from "../schema/typebox.js";

function buildRoutingSchema() {
  return {
    channel: Type.Optional(Type.String()),
    target: Type.Optional(channelTargetSchema({ description: "Target channel/user id or name." })),
    targets: Type.Optional(channelTargetsSchema()),
    accountId: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
  };
}

const discordComponentEmojiSchema = Type.Object({
  name: Type.String(),
  id: Type.Optional(Type.String()),
  animated: Type.Optional(Type.Boolean()),
});

const discordComponentOptionSchema = Type.Object({
  label: Type.String(),
  value: Type.String(),
  description: Type.Optional(Type.String()),
  emoji: Type.Optional(discordComponentEmojiSchema),
  default: Type.Optional(Type.Boolean()),
});

const discordComponentButtonSchema = Type.Object({
  label: Type.String(),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger", "link"])),
  url: Type.Optional(Type.String()),
  emoji: Type.Optional(discordComponentEmojiSchema),
  disabled: Type.Optional(Type.Boolean()),
  allowedUsers: Type.Optional(
    Type.Array(
      Type.String({
        description: "Discord user ids or names allowed to interact with this button.",
      }),
    ),
  ),
});

const discordComponentSelectSchema = Type.Object({
  type: Type.Optional(stringEnum(["string", "user", "role", "mentionable", "channel"])),
  placeholder: Type.Optional(Type.String()),
  minValues: Type.Optional(Type.Number()),
  maxValues: Type.Optional(Type.Number()),
  options: Type.Optional(Type.Array(discordComponentOptionSchema)),
});

const discordComponentBlockSchema = Type.Object({
  type: Type.String(),
  text: Type.Optional(Type.String()),
  texts: Type.Optional(Type.Array(Type.String())),
  accessory: Type.Optional(
    Type.Object({
      type: Type.String(),
      url: Type.Optional(Type.String()),
      button: Type.Optional(discordComponentButtonSchema),
    }),
  ),
  spacing: Type.Optional(stringEnum(["small", "large"])),
  divider: Type.Optional(Type.Boolean()),
  buttons: Type.Optional(Type.Array(discordComponentButtonSchema)),
  select: Type.Optional(discordComponentSelectSchema),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String(),
        description: Type.Optional(Type.String()),
        spoiler: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
  file: Type.Optional(Type.String()),
  spoiler: Type.Optional(Type.Boolean()),
});

const discordComponentModalFieldSchema = Type.Object({
  type: Type.String(),
  name: Type.Optional(Type.String()),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(discordComponentOptionSchema)),
  minValues: Type.Optional(Type.Number()),
  maxValues: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Number()),
  maxLength: Type.Optional(Type.Number()),
  style: Type.Optional(stringEnum(["short", "paragraph"])),
});

const discordComponentModalSchema = Type.Object({
  title: Type.String(),
  triggerLabel: Type.Optional(Type.String()),
  triggerStyle: Type.Optional(stringEnum(["primary", "secondary", "success", "danger", "link"])),
  fields: Type.Array(discordComponentModalFieldSchema),
});

const discordComponentMessageSchema = Type.Object(
  {
    text: Type.Optional(Type.String()),
    reusable: Type.Optional(
      Type.Boolean({
        description: "Allow components to be used multiple times until they expire.",
      }),
    ),
    container: Type.Optional(
      Type.Object({
        accentColor: Type.Optional(Type.String()),
        spoiler: Type.Optional(Type.Boolean()),
      }),
    ),
    blocks: Type.Optional(Type.Array(discordComponentBlockSchema)),
    modal: Type.Optional(discordComponentModalSchema),
  },
  {
    description:
      "Discord components v2 payload. Set reusable=true to keep buttons, selects, and forms active until expiry.",
  },
);

function buildSendSchema(options: {
  includeButtons: boolean;
  includeCards: boolean;
  includeComponents: boolean;
}) {
  const props: Record<string, unknown> = {
    message: Type.Optional(Type.String()),
    effectId: Type.Optional(
      Type.String({
        description: "Message effect name/id for sendWithEffect (e.g., invisible ink).",
      }),
    ),
    effect: Type.Optional(
      Type.String({ description: "Alias for effectId (e.g., invisible-ink, balloons)." }),
    ),
    media: Type.Optional(
      Type.String({
        description: "Media URL or local path. data: URLs are not supported here, use buffer.",
      }),
    ),
    filename: Type.Optional(Type.String()),
    buffer: Type.Optional(
      Type.String({
        description: "Base64 payload for attachments (optionally a data: URL).",
      }),
    ),
    contentType: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    asVoice: Type.Optional(Type.Boolean()),
    silent: Type.Optional(Type.Boolean()),
    quoteText: Type.Optional(
      Type.String({ description: "Quote text for Telegram reply_parameters" }),
    ),
    bestEffort: Type.Optional(Type.Boolean()),
    gifPlayback: Type.Optional(Type.Boolean()),
    buttons: Type.Optional(
      Type.Array(
        Type.Array(
          Type.Object({
            text: Type.String(),
            callback_data: Type.String(),
            style: Type.Optional(stringEnum(["danger", "success", "primary"])),
          }),
        ),
        {
          description: "Telegram inline keyboard buttons (array of button rows)",
        },
      ),
    ),
    card: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: "Adaptive Card JSON object (when supported by the channel)",
        },
      ),
    ),
    components: Type.Optional(discordComponentMessageSchema),
  };
  if (!options.includeButtons) {
    delete props.buttons;
  }
  if (!options.includeCards) {
    delete props.card;
  }
  if (!options.includeComponents) {
    delete props.components;
  }
  return props;
}

function buildReactionSchema() {
  return {
    messageId: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    remove: Type.Optional(Type.Boolean()),
    targetAuthor: Type.Optional(Type.String()),
    targetAuthorUuid: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
  };
}

function buildFetchSchema() {
  return {
    limit: Type.Optional(Type.Number()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
    around: Type.Optional(Type.String()),
    fromMe: Type.Optional(Type.Boolean()),
    includeArchived: Type.Optional(Type.Boolean()),
  };
}

function buildPollSchema() {
  return {
    pollQuestion: Type.Optional(Type.String()),
    pollOption: Type.Optional(Type.Array(Type.String())),
    pollDurationHours: Type.Optional(Type.Number()),
    pollMulti: Type.Optional(Type.Boolean()),
  };
}

function buildChannelTargetSchema() {
  return {
    channelId: Type.Optional(
      Type.String({ description: "Channel id filter (search/thread list/event create)." }),
    ),
    channelIds: Type.Optional(
      Type.Array(Type.String({ description: "Channel id filter (repeatable)." })),
    ),
    guildId: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    authorId: Type.Optional(Type.String()),
    authorIds: Type.Optional(Type.Array(Type.String())),
    roleId: Type.Optional(Type.String()),
    roleIds: Type.Optional(Type.Array(Type.String())),
    participant: Type.Optional(Type.String()),
  };
}

function buildStickerSchema() {
  return {
    emojiName: Type.Optional(Type.String()),
    stickerId: Type.Optional(Type.Array(Type.String())),
    stickerName: Type.Optional(Type.String()),
    stickerDesc: Type.Optional(Type.String()),
    stickerTags: Type.Optional(Type.String()),
  };
}

function buildThreadSchema() {
  return {
    threadName: Type.Optional(Type.String()),
    autoArchiveMin: Type.Optional(Type.Number()),
  };
}

function buildEventSchema() {
  return {
    query: Type.Optional(Type.String()),
    eventName: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    endTime: Type.Optional(Type.String()),
    desc: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    durationMin: Type.Optional(Type.Number()),
    until: Type.Optional(Type.String()),
  };
}

function buildModerationSchema() {
  return {
    reason: Type.Optional(Type.String()),
    deleteDays: Type.Optional(Type.Number()),
  };
}

function buildGatewaySchema() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  };
}

function buildPresenceSchema() {
  return {
    activityType: Type.Optional(
      Type.String({
        description: "Activity type: playing, streaming, listening, watching, competing, custom.",
      }),
    ),
    activityName: Type.Optional(
      Type.String({
        description: "Activity name shown in sidebar (e.g. 'with fire'). Ignored for custom type.",
      }),
    ),
    activityUrl: Type.Optional(
      Type.String({
        description:
          "Streaming URL (Twitch or YouTube). Only used with streaming type; may not render for bots.",
      }),
    ),
    activityState: Type.Optional(
      Type.String({
        description:
          "State text. For custom type this is the status text; for others it shows in the flyout.",
      }),
    ),
    status: Type.Optional(
      Type.String({ description: "Bot status: online, dnd, idle, invisible." }),
    ),
  };
}

function buildChannelManagementSchema() {
  return {
    name: Type.Optional(Type.String()),
    type: Type.Optional(Type.Number()),
    parentId: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    position: Type.Optional(Type.Number()),
    nsfw: Type.Optional(Type.Boolean()),
    rateLimitPerUser: Type.Optional(Type.Number()),
    categoryId: Type.Optional(Type.String()),
    clearParent: Type.Optional(
      Type.Boolean({
        description: "Clear the parent/category when supported by the provider.",
      }),
    ),
  };
}

function buildMessageToolSchemaProps(options: {
  includeButtons: boolean;
  includeCards: boolean;
  includeComponents: boolean;
}) {
  return {
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildReactionSchema(),
    ...buildFetchSchema(),
    ...buildPollSchema(),
    ...buildChannelTargetSchema(),
    ...buildStickerSchema(),
    ...buildThreadSchema(),
    ...buildEventSchema(),
    ...buildModerationSchema(),
    ...buildGatewaySchema(),
    ...buildChannelManagementSchema(),
    ...buildPresenceSchema(),
  };
}

export function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: { includeButtons: boolean; includeCards: boolean; includeComponents: boolean },
) {
  const props = buildMessageToolSchemaProps(options);
  return Type.Object({
    action: stringEnum(actions),
    ...props,
  });
}

export const MessageToolSchema = buildMessageToolSchemaFromActions(CHANNEL_MESSAGE_ACTION_NAMES, {
  includeButtons: true,
  includeCards: true,
  includeComponents: true,
});
