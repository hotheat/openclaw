function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRequesterChannel(event) {
  const declared = asTrimmedString(event?.requesterOrigin?.channel).toLowerCase();
  const sessionKey = asTrimmedString(event?.requesterSessionKey).toLowerCase();
  if ((declared === "internal" || !declared) && sessionKey.includes(":webchat:")) {
    return "webchat";
  }
  if (declared) return declared;
  return sessionKey.includes(":feishu:") ? "feishu" : "";
}

function resolveDeliveryPolicy(profile, event) {
  const channel = resolveRequesterChannel(event);
  const channelPolicy = profile?.channelPolicies?.[channel];
  if (
    channelPolicy === ARTIFACT_DELIVERY_POLICIES.AUTO ||
    channelPolicy === ARTIFACT_DELIVERY_POLICIES.CONFIRMATION
  ) {
    return channelPolicy;
  }
  return profile?.deliveryPolicy === ARTIFACT_DELIVERY_POLICIES.CONFIRMATION
    ? ARTIFACT_DELIVERY_POLICIES.CONFIRMATION
    : ARTIFACT_DELIVERY_POLICIES.AUTO;
}

module.exports = {
  resolveDeliveryPolicy,
  resolveRequesterChannel,
};
const { ARTIFACT_DELIVERY_POLICIES } = require("./artifact-handoff-contract.js");
