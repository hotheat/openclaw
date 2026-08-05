const path = require("node:path");
const {
  ARTIFACT_DELIVERY_POLICIES,
  ARTIFACT_PROFILE_IDS,
  HANDOFF_ISSUE_CODES,
} = require("./artifact-handoff-contract.js");
const { mimeMatchesExtension, normalizeMimeType } = require("./artifact-mime.js");

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DEFAULT_MAX_ARTIFACT_BYTES = 30 * 1024 * 1024;
const DEFAULT_ARTIFACT_PROFILES = [
  {
    id: ARTIFACT_PROFILE_IDS.RESEARCHER_EXPORT,
    prefix: path.posix.join("artifacts", "exports", "feishu"),
    producerAgentIds: ["researcher"],
    allowedExtensions: [".md"],
    allowedMimeTypes: ["text/markdown"],
    maxArtifacts: 1,
    maxBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    requireAsciiSlugBasename: true,
    requireFileNameMatchPath: true,
    deliveryPolicy: ARTIFACT_DELIVERY_POLICIES.AUTO,
  },
  {
    id: ARTIFACT_PROFILE_IDS.PPTX_GENERATOR,
    prefix: path.posix.join("artifacts", "pptx-generator"),
    allowedExtensions: [".pptx"],
    allowedMimeTypes: [PPTX_MIME],
    maxArtifacts: 1,
    maxBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    requireAsciiSlugBasename: true,
    requireFileNameMatchPath: true,
    deliveryPolicy: ARTIFACT_DELIVERY_POLICIES.AUTO,
  },
  {
    id: ARTIFACT_PROFILE_IDS.PPTX_RESTYLE,
    prefix: path.posix.join("artifacts", "pptx-restyle"),
    allowedExtensions: [".pptx"],
    allowedMimeTypes: [PPTX_MIME],
    maxArtifacts: 1,
    maxBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    requireAsciiSlugBasename: true,
    requireFileNameMatchPath: true,
    deliveryPolicy: ARTIFACT_DELIVERY_POLICIES.AUTO,
  },
];

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value, transform = (item) => item) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(asTrimmedString).filter(Boolean).map(transform))];
}

function normalizeRelativePath(value) {
  const raw = asTrimmedString(value).replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    return "";
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return "";
  }
  return normalized;
}

function normalizeProfile(value) {
  const id = asTrimmedString(value?.id);
  const prefix = normalizeRelativePath(value?.prefix).replace(/\/+$/, "");
  if (!id || !prefix || value?.enabled === false) return null;
  const producerAgentIds = Array.isArray(value?.producerAgentIds)
    ? value.producerAgentIds.map(asTrimmedString).filter(Boolean)
    : [];
  const requiredBasename = asTrimmedString(value?.requiredBasename);
  const allowedExtensions = normalizeStringList(value?.allowedExtensions, (item) =>
    item.startsWith(".") ? item.toLowerCase() : `.${item.toLowerCase()}`,
  );
  const allowedMimeTypes = normalizeStringList(value?.allowedMimeTypes, (item) =>
    normalizeMimeType(item),
  );
  const maxArtifacts =
    Number.isInteger(value?.maxArtifacts) && value.maxArtifacts > 0 ? value.maxArtifacts : 0;
  const maxBytes = Number.isInteger(value?.maxBytes) && value.maxBytes > 0 ? value.maxBytes : 0;
  const deliveryPolicy =
    value?.deliveryPolicy === ARTIFACT_DELIVERY_POLICIES.CONFIRMATION
      ? ARTIFACT_DELIVERY_POLICIES.CONFIRMATION
      : ARTIFACT_DELIVERY_POLICIES.AUTO;
  const channelPolicies = {};
  if (value?.channelPolicies && typeof value.channelPolicies === "object") {
    for (const [channel, policy] of Object.entries(value.channelPolicies)) {
      const normalizedChannel = asTrimmedString(channel).toLowerCase();
      if (
        normalizedChannel &&
        (policy === ARTIFACT_DELIVERY_POLICIES.AUTO ||
          policy === ARTIFACT_DELIVERY_POLICIES.CONFIRMATION)
      ) {
        channelPolicies[normalizedChannel] = policy;
      }
    }
  }
  return {
    id,
    prefix,
    producerAgentIds,
    requiredBasename,
    allowedExtensions,
    allowedMimeTypes,
    maxArtifacts,
    maxBytes,
    requireAsciiSlugBasename: value?.requireAsciiSlugBasename === true,
    requireFileNameMatchPath: value?.requireFileNameMatchPath === true,
    deliveryPolicy,
    channelPolicies,
  };
}

function legacyProfiles(config) {
  const configuredPrefixes = Array.isArray(config?.exportPrefixes)
    ? config.exportPrefixes.map(normalizeRelativePath).filter(Boolean)
    : [];
  const configuredPrefix = normalizeRelativePath(config?.exportPrefix);
  const prefixes =
    configuredPrefixes.length > 0 ? configuredPrefixes : configuredPrefix ? [configuredPrefix] : [];
  return prefixes.map((prefix, index) => ({
    id: `legacy-export-${index + 1}`,
    prefix,
    producerAgentIds: [],
    requiredBasename: "",
    allowedExtensions: [],
    allowedMimeTypes: [],
    maxArtifacts: 0,
    maxBytes: 0,
    requireAsciiSlugBasename: false,
    requireFileNameMatchPath: false,
    deliveryPolicy: ARTIFACT_DELIVERY_POLICIES.AUTO,
    channelPolicies: {},
  }));
}

function resolveArtifactProfiles(config = {}) {
  const legacy = legacyProfiles(config);
  if (legacy.length > 0) return legacy;

  const profiles = new Map(
    DEFAULT_ARTIFACT_PROFILES.map((profile) => [profile.id, normalizeProfile(profile)]),
  );
  if (Array.isArray(config.artifactProfiles)) {
    for (const configured of config.artifactProfiles) {
      const id = asTrimmedString(configured?.id);
      if (!id) continue;
      if (configured?.enabled === false) {
        profiles.delete(id);
        continue;
      }
      const current = profiles.get(id) || {};
      const migratedConfigured = { ...configured };
      if (
        (id === ARTIFACT_PROFILE_IDS.PPTX_GENERATOR || id === ARTIFACT_PROFILE_IDS.PPTX_RESTYLE) &&
        asTrimmedString(migratedConfigured.requiredBasename) === "final.pptx"
      ) {
        migratedConfigured.requiredBasename = "";
      }
      const normalized = normalizeProfile({ ...current, ...migratedConfigured, id });
      if (normalized) profiles.set(id, normalized);
    }
  }
  return [...profiles.values()]
    .filter(Boolean)
    .sort((left, right) => right.prefix.length - left.prefix.length);
}

function parseAgentId(sessionKey) {
  const matched = asTrimmedString(sessionKey).match(/^agent:([^:]+)/);
  return matched ? matched[1] : "";
}

function isAsciiSlugBasename(fileName) {
  if (fileName !== fileName.toLowerCase()) return false;
  const extension = path.posix.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stem);
}

function evaluateArtifactProfile(params) {
  const normalizedPath = normalizeRelativePath(params.relativePath);
  if (!normalizedPath) {
    return {
      accepted: false,
      code: HANDOFF_ISSUE_CODES.UNSAFE_ARTIFACT_PATH,
      message: "Artifact path is not a safe requester-relative path",
    };
  }

  const profiles = resolveArtifactProfiles(params.config);
  const prefixMatches = profiles.filter(
    (profile) =>
      normalizedPath === profile.prefix || normalizedPath.startsWith(`${profile.prefix}/`),
  );
  if (prefixMatches.length === 0) {
    return {
      accepted: false,
      normalizedPath,
      code: HANDOFF_ISSUE_CODES.EXPORT_PREFIX_REJECTED,
      message: "Artifact path is outside configured delivery profiles",
    };
  }

  const childAgentId = parseAgentId(params.childSessionKey);
  const profile = prefixMatches.find(
    (candidate) =>
      candidate.producerAgentIds.length === 0 || candidate.producerAgentIds.includes(childAgentId),
  );
  if (!profile) {
    return {
      accepted: false,
      normalizedPath,
      code: HANDOFF_ISSUE_CODES.PRODUCER_AGENT_REJECTED,
      message: "Artifact producer does not match the configured delivery profile",
    };
  }
  if (
    profile.requiredBasename &&
    path.posix.basename(normalizedPath) !== profile.requiredBasename
  ) {
    return {
      accepted: false,
      normalizedPath,
      profile,
      code: HANDOFF_ISSUE_CODES.FILE_NAME_REJECTED,
      message: `Artifact profile ${profile.id} requires ${profile.requiredBasename}`,
    };
  }
  const basename = path.posix.basename(normalizedPath);
  const declaredFileName = asTrimmedString(params.fileName);
  if (profile.requireFileNameMatchPath && declaredFileName && declaredFileName !== basename) {
    return {
      accepted: false,
      normalizedPath,
      profile,
      code: HANDOFF_ISSUE_CODES.FILE_NAME_REJECTED,
      message: `Artifact profile ${profile.id} requires fileName to match the path basename`,
    };
  }
  if (profile.requireAsciiSlugBasename && !isAsciiSlugBasename(basename)) {
    return {
      accepted: false,
      normalizedPath,
      profile,
      code: HANDOFF_ISSUE_CODES.FILE_NAME_REJECTED,
      message: `Artifact profile ${profile.id} requires a lowercase ASCII kebab-case basename`,
    };
  }
  const extension = path.posix.extname(basename).toLowerCase();
  if (profile.allowedExtensions.length > 0 && !profile.allowedExtensions.includes(extension)) {
    return {
      accepted: false,
      normalizedPath,
      profile,
      code: HANDOFF_ISSUE_CODES.FILE_EXTENSION_REJECTED,
      message: `Artifact profile ${profile.id} does not allow ${extension || "extensionless"} files`,
    };
  }
  const mimeType = normalizeMimeType(params.mimeType);
  if (mimeType && !mimeMatchesExtension(basename, mimeType)) {
    return {
      accepted: false,
      normalizedPath,
      profile,
      code: HANDOFF_ISSUE_CODES.MIME_TYPE_REJECTED,
      message: `Artifact MIME type does not match ${extension || "extensionless"} files`,
    };
  }
  if (profile.allowedMimeTypes.length > 0 && !profile.allowedMimeTypes.includes(mimeType)) {
    return {
      accepted: false,
      normalizedPath,
      profile,
      code: HANDOFF_ISSUE_CODES.MIME_TYPE_REJECTED,
      message: `Artifact profile ${profile.id} requires an allowed MIME type`,
    };
  }
  return {
    accepted: true,
    normalizedPath,
    profile,
  };
}

module.exports = {
  DEFAULT_ARTIFACT_PROFILES,
  evaluateArtifactProfile,
  normalizeRelativePath,
  resolveArtifactProfiles,
};
