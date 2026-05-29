import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("artifact-jobs");
const JOB_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const DEFAULT_EXPORT_DIR = "artifacts/imports";

const ArtifactJobsToolSchema = Type.Object({
  action: Type.String(),
  kind: Type.Optional(Type.String()),
  jobId: Type.Optional(Type.String()),
  sourcePath: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  box: Type.Optional(Type.String()),
  data: Type.Optional(Type.Any()),
  exportTo: Type.Optional(Type.String()),
});

type ArtifactJobToolOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  requesterAgentId?: string;
};

type ArtifactJobOutput = {
  name?: string;
  path?: string;
  rawPath?: string;
  exportedPath?: string;
  mimeType?: string;
  [key: string]: unknown;
};

type ArtifactJobResult = {
  status?: string;
  outputs?: ArtifactJobOutput[];
  [key: string]: unknown;
};

function stateArtifactRoot(cfg?: OpenClawConfig): string {
  return path.resolve(
    cfg?.tools?.artifactJobs?.root?.trim() || path.join(resolveStateDir(), "artifacts", "jobs"),
  );
}

function assertSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!JOB_SEGMENT_RE.test(trimmed)) {
    throw new ToolInputError(`${label} is invalid`);
  }
  return trimmed;
}

function assertSafeFileName(value: string): string {
  const name = value.trim();
  if (!name || name !== path.basename(name) || name === "." || name === "..") {
    throw new ToolInputError("name is invalid");
  }
  return name;
}

function ensureInsideRoot(target: string, root: string, message: string): string {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new ToolInputError(message);
  }
  return resolved;
}

function jobPaths(cfg: OpenClawConfig | undefined, jobIdRaw: string) {
  const [kindRaw, idRaw] = jobIdRaw.includes("/") ? jobIdRaw.split("/", 2) : ["ppt", jobIdRaw];
  const kind = assertSegment(kindRaw ?? "", "kind");
  const jobId = assertSegment(idRaw ?? "", "jobId");
  const root = stateArtifactRoot(cfg);
  const kindDir = ensureInsideRoot(path.join(root, kind), root, "job path escapes artifact root");
  const jobDir = ensureInsideRoot(path.join(kindDir, jobId), kindDir, "job path escapes kind root");
  return {
    root,
    kind,
    jobId,
    jobDir,
    inboxDir: path.join(jobDir, "inbox"),
    outboxDir: path.join(jobDir, "outbox"),
    manifestPath: path.join(jobDir, "manifest.json"),
    resultPath: path.join(jobDir, "result.json"),
    metaPath: path.join(jobDir, "meta.json"),
  };
}

async function resolveJobPaths(cfg: OpenClawConfig | undefined, jobIdRaw: string) {
  if (jobIdRaw.includes("/")) {
    return jobPaths(cfg, jobIdRaw);
  }
  const jobId = assertSegment(jobIdRaw, "jobId");
  const root = stateArtifactRoot(cfg);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_SEGMENT_RE.test(entry.name)) {
        continue;
      }
      const candidate = jobPaths(cfg, `${entry.name}/${jobId}`);
      try {
        const stat = await fs.stat(candidate.jobDir);
        if (stat.isDirectory()) {
          return candidate;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  return jobPaths(cfg, `ppt/${jobId}`);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ToolInputError(`${path.basename(filePath)} not found`);
    }
    throw err;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function realpathOrResolve(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

async function resolveAllowedSourceRoots(params: ArtifactJobToolOptions): Promise<string[]> {
  const configured = params.config?.tools?.artifactJobs?.allowedSourceRoots ?? [];
  const roots = [
    ...configured,
    ...(params.workspaceDir ? [params.workspaceDir] : []),
    path.join(resolveStateDir(), "media"),
    stateArtifactRoot(params.config),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = await realpathOrResolve(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

async function assertSourceAllowed(
  sourcePath: string,
  opts: ArtifactJobToolOptions,
): Promise<string> {
  const realSource = await fs.realpath(sourcePath);
  const roots = await resolveAllowedSourceRoots(opts);
  for (const root of roots) {
    if (realSource === root || realSource.startsWith(root + path.sep)) {
      return realSource;
    }
  }
  throw new ToolInputError("sourcePath is not under an allowed source root");
}

async function requireExistingJob(paths: ReturnType<typeof jobPaths>): Promise<void> {
  try {
    const stat = await fs.stat(paths.jobDir);
    if (!stat.isDirectory()) {
      throw new ToolInputError("jobId is not a directory");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolInputError("jobId not found");
    }
    throw err;
  }
}

function normalizeResult(data: unknown): ArtifactJobResult {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as ArtifactJobResult)
    : { status: "success" };
}

async function listBoxFiles(
  paths: ReturnType<typeof jobPaths>,
  box: string,
): Promise<ArtifactJobOutput[]> {
  const boxName = box === "outbox" ? "outbox" : box === "inbox" ? "inbox" : "";
  if (!boxName) {
    throw new ToolInputError("box must be inbox or outbox");
  }
  const dir = boxName === "outbox" ? paths.outboxDir : paths.inboxDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dir, entry.name),
    }));
}

async function finalizeToCallerWorkspace(params: {
  opts: ArtifactJobToolOptions;
  paths: ReturnType<typeof jobPaths>;
}): Promise<ArtifactJobResult> {
  const workspaceDir = params.opts.workspaceDir?.trim();
  if (!workspaceDir) {
    throw new ToolInputError("caller workspace is unavailable");
  }
  const exportDirName =
    params.opts.config?.tools?.artifactJobs?.exportDirName?.trim() || DEFAULT_EXPORT_DIR;
  const exportRoot = ensureInsideRoot(
    path.join(workspaceDir, exportDirName, params.paths.jobId),
    workspaceDir,
    "export path escapes caller workspace",
  );
  await fs.mkdir(exportRoot, { recursive: true });

  let result: ArtifactJobResult;
  try {
    result = normalizeResult(await readJsonFile(params.paths.resultPath));
  } catch (err) {
    if (!(err instanceof ToolInputError)) {
      throw err;
    }
    result = { status: "success" };
  }

  const rawOutputs =
    Array.isArray(result.outputs) && result.outputs.length > 0
      ? result.outputs
      : await listBoxFiles(params.paths, "outbox");
  const outputs: ArtifactJobOutput[] = [];
  for (const output of rawOutputs) {
    const rawPath = path.resolve(String(output.rawPath ?? output.path ?? ""));
    ensureInsideRoot(rawPath, params.paths.outboxDir, "output rawPath escapes job outbox");
    const name = assertSafeFileName(output.name ?? path.basename(rawPath));
    const exportedPath = path.join(exportRoot, name);
    await fs.copyFile(rawPath, exportedPath);
    outputs.push({
      ...output,
      name,
      rawPath,
      exportedPath,
    });
  }

  const nextResult = { ...result, outputs };
  await writeJsonFile(params.paths.resultPath, nextResult);
  return nextResult;
}

export function createArtifactJobsTool(opts: ArtifactJobToolOptions = {}): AnyAgentTool {
  return {
    label: "Artifact jobs",
    name: "artifact_jobs",
    description: "Create and manage artifact exchange jobs with controlled inbox/outbox staging.",
    parameters: ArtifactJobsToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      if (action === "create") {
        const kind = assertSegment(readStringParam(params, "kind") ?? "artifact", "kind");
        const jobId = randomUUID();
        const paths = jobPaths(opts.config, `${kind}/${jobId}`);
        log.info("artifact_jobs create started", { kind, jobId });
        await fs.mkdir(paths.inboxDir, { recursive: true });
        await fs.mkdir(paths.outboxDir, { recursive: true });
        const meta = {
          kind,
          jobId,
          createdAt: new Date().toISOString(),
          requesterAgentId: opts.requesterAgentId,
        };
        await writeJsonFile(paths.metaPath, meta);
        log.info("artifact_jobs create completed", { kind, jobId });
        return jsonResult({
          kind,
          jobId,
          jobKey: `${kind}/${jobId}`,
          jobDir: paths.jobDir,
          inbox: paths.inboxDir,
          outbox: paths.outboxDir,
        });
      }

      const jobId = readStringParam(params, "jobId", { required: true });
      const paths = await resolveJobPaths(opts.config, jobId);
      await requireExistingJob(paths);

      if (action === "attach_file") {
        const sourcePath = readStringParam(params, "sourcePath", { required: true });
        const realSource = await assertSourceAllowed(sourcePath, opts);
        const stat = await fs.stat(realSource);
        if (!stat.isFile()) {
          throw new ToolInputError("sourcePath must be a file");
        }
        const name = assertSafeFileName(
          readStringParam(params, "name") ?? path.basename(realSource),
        );
        const target = ensureInsideRoot(
          path.join(paths.inboxDir, name),
          paths.inboxDir,
          "target path escapes inbox",
        );
        await fs.copyFile(realSource, target, fsConstants.COPYFILE_EXCL);
        return jsonResult({
          jobId: paths.jobId,
          kind: paths.kind,
          box: "inbox",
          name,
          path: target,
        });
      }

      if (action === "write_manifest") {
        await writeJsonFile(paths.manifestPath, params.data ?? {});
        return jsonResult({ jobId: paths.jobId, kind: paths.kind, path: paths.manifestPath });
      }

      if (action === "read_manifest") {
        return jsonResult(await readJsonFile(paths.manifestPath));
      }

      if (action === "write_result") {
        await writeJsonFile(paths.resultPath, params.data ?? {});
        return jsonResult({ jobId: paths.jobId, kind: paths.kind, path: paths.resultPath });
      }

      if (action === "read_result") {
        return jsonResult(await readJsonFile(paths.resultPath));
      }

      if (action === "list_files") {
        const box = readStringParam(params, "box") ?? "outbox";
        return jsonResult({
          jobId: paths.jobId,
          kind: paths.kind,
          box,
          files: await listBoxFiles(paths, box),
        });
      }

      if (action === "finalize") {
        const exportTo = readStringParam(params, "exportTo") ?? "caller_workspace";
        if (exportTo !== "caller_workspace") {
          throw new ToolInputError("exportTo must be caller_workspace");
        }
        log.info("artifact_jobs finalize started", { kind: paths.kind, jobId: paths.jobId });
        const result = await finalizeToCallerWorkspace({ opts, paths });
        log.info("artifact_jobs finalize completed", { kind: paths.kind, jobId: paths.jobId });
        return jsonResult(result);
      }

      if (action === "cleanup") {
        await fs.rm(paths.jobDir, { recursive: true, force: true });
        return jsonResult({ jobId: paths.jobId, kind: paths.kind, cleaned: true });
      }

      throw new ToolInputError(`unknown artifact_jobs action: ${action}`);
    },
  };
}
