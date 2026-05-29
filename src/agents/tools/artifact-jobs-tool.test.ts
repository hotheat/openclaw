import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createArtifactJobsTool } from "./artifact-jobs-tool.js";

describe("artifact_jobs", () => {
  let root: string;
  let artifactRoot: string;
  let workspaceDir: string;
  let mediaDir: string;
  let outsideDir: string;

  type ArtifactJobOutputDetails = {
    exportedPath?: string;
    [key: string]: unknown;
  };

  type ArtifactJobToolDetails = {
    jobId?: string;
    outputs?: ArtifactJobOutputDetails[];
    [key: string]: unknown;
  };

  function config(): OpenClawConfig {
    return {
      tools: {
        artifactJobs: {
          root: artifactRoot,
          allowedSourceRoots: [workspaceDir, mediaDir, artifactRoot],
        },
      },
    };
  }

  function tool() {
    return createArtifactJobsTool({
      config: config(),
      workspaceDir,
      requesterAgentId: "main",
    });
  }

  function details(result: { details?: unknown }): ArtifactJobToolDetails {
    expect(result.details).toEqual(expect.any(Object));
    return result.details as ArtifactJobToolDetails;
  }

  function stringValue(value: unknown): string {
    expect(typeof value).toBe("string");
    return value as string;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifact-jobs-"));
    artifactRoot = path.join(root, "artifacts", "jobs");
    workspaceDir = path.join(root, "workspace-main");
    mediaDir = path.join(root, "media");
    outsideDir = path.join(root, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stages inputs, records result, and exports outputs to the caller workspace", async () => {
    const source = path.join(workspaceDir, "source.pptx");
    await fs.writeFile(source, "pptx-input");

    const created = await tool().execute("call-create", { action: "create", kind: "ppt" });
    const jobId = stringValue(details(created).jobId);

    const attached = await tool().execute("call-attach", {
      action: "attach_file",
      jobId,
      sourcePath: source,
    });
    expect(details(attached)).toMatchObject({
      box: "inbox",
      name: "source.pptx",
    });

    await tool().execute("call-manifest", {
      action: "write_manifest",
      jobId,
      data: {
        operation: "otr_restyle_existing_pptx",
        inputs: ["source.pptx"],
      },
    });

    const outboxFile = path.join(artifactRoot, "ppt", jobId, "outbox", "final.pptx");
    await fs.writeFile(outboxFile, "pptx-output");
    await tool().execute("call-result", {
      action: "write_result",
      jobId,
      data: {
        status: "success",
        outputs: [{ name: "final.pptx", rawPath: outboxFile, mimeType: "application/pptx" }],
      },
    });

    const finalized = await tool().execute("call-finalize", {
      action: "finalize",
      jobId,
      exportTo: "caller_workspace",
    });

    const exportedPath = stringValue(details(finalized).outputs?.[0]?.exportedPath);
    expect(exportedPath).toBe(path.join(workspaceDir, "artifacts", "imports", jobId, "final.pptx"));
    await expect(fs.readFile(exportedPath, "utf8")).resolves.toBe("pptx-output");

    const result = await tool().execute("call-read-result", { action: "read_result", jobId });
    expect(details(result)).toMatchObject({
      status: "success",
      outputs: [
        {
          name: "final.pptx",
          rawPath: outboxFile,
          exportedPath,
        },
      ],
    });
  });

  it("rejects attaching files outside configured source roots", async () => {
    const source = path.join(outsideDir, "secret.pptx");
    await fs.writeFile(source, "secret");
    const created = await tool().execute("call-create", { action: "create", kind: "ppt" });
    const jobId = stringValue(details(created).jobId);

    await expect(
      tool().execute("call-attach", {
        action: "attach_file",
        jobId,
        sourcePath: source,
      }),
    ).rejects.toThrow("sourcePath is not under an allowed source root");
  });

  it("resolves bare job ids for non-ppt kinds", async () => {
    const created = await tool().execute("call-create-report", {
      action: "create",
      kind: "report",
    });
    const jobId = stringValue(details(created).jobId);

    await tool().execute("call-manifest-report", {
      action: "write_manifest",
      jobId,
      data: { operation: "draft_report" },
    });

    const manifest = await tool().execute("call-read-report", {
      action: "read_manifest",
      jobId,
    });

    expect(manifest.details).toEqual({ operation: "draft_report" });
  });
});
