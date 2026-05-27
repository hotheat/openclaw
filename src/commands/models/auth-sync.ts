import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  type AuthProfileCredential,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { ensurePiAuthJsonFromAuthProfiles } from "../../agents/pi-auth-json.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";

export type ModelsAuthSyncOptions = {
  provider?: string;
  profileId?: string;
  fromAgent?: string;
  toAgents?: string;
  json?: boolean;
};

type TargetAgent = {
  agentId: string;
  agentDir: string;
};

function credentialsEqual(a: AuthProfileCredential | undefined, b: AuthProfileCredential): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

function discoverAgentDirs(): TargetAgent[] {
  const agentsRoot = path.join(resolveStateDir(), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      agentId: entry.name,
      agentDir: path.join(agentsRoot, entry.name, "agent"),
    }))
    .filter((entry) => fs.existsSync(entry.agentDir));
}

function resolveTargets(params: {
  raw: string | undefined;
  cfg: ReturnType<typeof loadConfig>;
}): TargetAgent[] {
  const raw = params.raw?.trim() || "all";
  if (raw === "all") {
    return discoverAgentDirs();
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((agentId) => ({
      agentId,
      agentDir: resolveAgentDir(params.cfg, agentId),
    }));
}

function resolveSource(params: {
  cfg: ReturnType<typeof loadConfig>;
  rawAgent?: string;
}): TargetAgent {
  const agentId = params.rawAgent?.trim() || resolveDefaultAgentId(params.cfg);
  return {
    agentId,
    agentDir: resolveAgentDir(params.cfg, agentId),
  };
}

export async function modelsAuthSyncCommand(opts: ModelsAuthSyncOptions, runtime: RuntimeEnv) {
  const provider = normalizeProviderId(opts.provider?.trim() || "openai-codex");
  const profileId = opts.profileId?.trim() || `${provider}:default`;
  const cfg = loadConfig();
  const source = resolveSource({ cfg, rawAgent: opts.fromAgent });
  const sourceStore = ensureAuthProfileStore(source.agentDir, { allowKeychainPrompt: false });
  const sourceCredential = sourceStore.profiles[profileId];

  if (!sourceCredential) {
    throw new Error(`Auth profile "${profileId}" not found in ${source.agentDir}.`);
  }
  if (normalizeProviderId(sourceCredential.provider) !== provider) {
    throw new Error(
      `Auth profile "${profileId}" is for ${sourceCredential.provider}, not ${provider}.`,
    );
  }
  if (sourceCredential.type !== "oauth") {
    throw new Error(`Auth profile "${profileId}" is ${sourceCredential.type}, not oauth.`);
  }

  const targets = resolveTargets({ cfg, raw: opts.toAgents });
  let profileWritten = 0;
  let authJsonWritten = 0;
  let skipped = 0;

  for (const target of targets) {
    fs.mkdirSync(target.agentDir, { recursive: true, mode: 0o700 });
    const store = ensureAuthProfileStore(target.agentDir, { allowKeychainPrompt: false });
    const existing = store.profiles[profileId];
    let changed = false;

    if (!credentialsEqual(existing, sourceCredential)) {
      store.profiles[profileId] = { ...sourceCredential };
      saveAuthProfileStore(store, target.agentDir);
      profileWritten += 1;
      changed = true;
    }

    const authJsonResult = await ensurePiAuthJsonFromAuthProfiles(target.agentDir);
    if (authJsonResult.wrote) {
      authJsonWritten += 1;
      changed = true;
    }

    if (!changed) {
      skipped += 1;
    }
  }

  const summary = {
    provider,
    profileId,
    fromAgent: source.agentId,
    fromAgentDir: shortenHomePath(source.agentDir),
    toAgents: opts.toAgents?.trim() || "all",
    targets: targets.length,
    profileWritten,
    authJsonWritten,
    skipped,
  };

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
    return;
  }

  runtime.log(`Provider: ${summary.provider}`);
  runtime.log(`Profile: ${summary.profileId}`);
  runtime.log(`Source: ${summary.fromAgent} (${summary.fromAgentDir})`);
  runtime.log(`Targets: ${summary.targets}`);
  runtime.log(`Profiles written: ${summary.profileWritten}`);
  runtime.log(`auth.json written: ${summary.authJsonWritten}`);
  runtime.log(`Skipped: ${summary.skipped}`);
}
