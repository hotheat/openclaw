import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openFileWithinRoot } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuSubagentHandoffDeliveryHandler } from "./subagent-handoff-delivery.js";

const temporaryDirectories: string[] = [];

async function createWorkspaceArtifact(relativePath: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-handoff-"));
  temporaryDirectories.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, path.dirname(relativePath)), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, relativePath), "artifact\n", "utf8");
  return workspaceDir;
}

function createEvent(params: {
  workspaceDir: string;
  channel?: string;
  to?: string;
  relativePaths: string[];
  includeFileName?: boolean;
}) {
  return {
    runId: "run-1",
    childSessionKey: "agent:researcher:subagent:child",
    requesterSessionKey: "agent:feishu-ou_1:feishu:direct:ou_1",
    content: "done",
    handoff: {
      mode: "export-file" as const,
      quality: {
        gate: "unmanaged" as const,
        verificationStatus: "unknown" as const,
        deliveryStatus: "unmanaged" as const,
      },
      artifacts: params.relativePaths.map((relativePath) => ({ relativePath })),
      omittedArtifactCount: 0,
    },
    handoffAt: 1,
    childWorkspaceDir: "/workspace-researcher",
    requesterWorkspaceDir: params.workspaceDir,
    requesterOrigin: {
      channel: params.channel,
      to: params.to,
      accountId: "work",
      threadId: "om_parent",
    },
    deliveryEligible: true,
    artifacts: params.relativePaths.map((relativePath) => ({
      sourceRelativePath: relativePath,
      relativePath,
      ...(params.includeFileName === false ? {} : { fileName: path.posix.basename(relativePath) }),
      deliveryPolicy: "auto" as const,
    })),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Feishu subagent handoff delivery", () => {
  it("sends requester-workspace artifacts to the current Feishu target", async () => {
    const relativePath = "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx";
    const workspaceDir = await createWorkspaceArtifact(relativePath);
    const sendMedia = vi.fn(async () => ({ messageId: "om_sent", chatId: "ou_1" }));
    const handler = createFeishuSubagentHandoffDeliveryHandler({
      cfg: {} as never,
      sendMedia,
    });

    const result = await handler(
      createEvent({
        workspaceDir,
        channel: "feishu",
        to: "feishu:ou_1",
        relativePaths: [relativePath],
        includeFileName: false,
      }),
      {},
    );

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ou_1",
        fileName: "nsclc-pd1-response.pptx",
        replyToMessageId: "om_parent",
        accountId: "work",
        mediaBuffer: Buffer.from("artifact\n"),
      }),
    );
    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: [relativePath],
      failures: [],
    });
  });

  it("reads from the verified handle when the artifact path is replaced", async () => {
    const relativePath = "artifacts/exports/feishu/run-1/report.md";
    const workspaceDir = await createWorkspaceArtifact(relativePath);
    const artifactPath = path.join(workspaceDir, relativePath);
    const movedPath = path.join(workspaceDir, "original.md");
    const sendMedia = vi.fn(async () => ({ messageId: "om_sent", chatId: "ou_1" }));
    const openFile = vi.fn(async (params: Parameters<typeof openFileWithinRoot>[0]) => {
      const opened = await openFileWithinRoot(params);
      await fs.rename(artifactPath, movedPath);
      await fs.writeFile(artifactPath, "replacement\n", "utf8");
      return opened;
    });
    const handler = createFeishuSubagentHandoffDeliveryHandler({
      cfg: {} as never,
      sendMedia,
      openFile,
    });

    const result = await handler(
      createEvent({
        workspaceDir,
        channel: "feishu",
        to: "ou_1",
        relativePaths: [relativePath],
      }),
      {},
    );

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaBuffer: Buffer.from("artifact\n"),
      }),
    );
    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: [relativePath],
      failures: [],
    });
  });

  it("rejects artifacts above the configured outbound limit before reading", async () => {
    const relativePath = "artifacts/exports/feishu/run-1/report.md";
    const readFile = vi.fn();
    const close = vi.fn(async () => {});
    const sendMedia = vi.fn();
    const handler = createFeishuSubagentHandoffDeliveryHandler({
      cfg: {
        channels: {
          feishu: {
            outboundFileMaxMb: 1,
          },
        },
      } as never,
      sendMedia,
      openFile: vi.fn(async () => ({
        handle: { readFile, close } as never,
        realPath: "/workspace-main/report.md",
        stat: { size: 2 * 1024 * 1024 } as never,
      })),
    });

    const result = await handler(
      createEvent({
        workspaceDir: "/workspace-main",
        channel: "feishu",
        to: "ou_1",
        relativePaths: [relativePath],
      }),
      {},
    );

    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: [],
      failures: [
        {
          relativePath,
          message: "文件超过飞书发送上限 1MB，当前约 2MB，请压缩后再发送。",
        },
      ],
    });
  });

  it("returns undefined for non-Feishu requester origins", async () => {
    const sendMedia = vi.fn();
    const handler = createFeishuSubagentHandoffDeliveryHandler({
      cfg: {} as never,
      sendMedia,
    });

    const result = await handler(
      createEvent({
        workspaceDir: "/workspace-main",
        channel: "webchat",
        to: "ou_1",
        relativePaths: ["artifacts/report.md"],
      }),
      {},
    );

    expect(result).toBeUndefined();
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("reports only failed artifacts during partial delivery", async () => {
    const firstPath = "artifacts/exports/feishu/run-1/report.md";
    const secondPath = "artifacts/exports/feishu/run-1/data.csv";
    const workspaceDir = await createWorkspaceArtifact(firstPath);
    await fs.writeFile(path.join(workspaceDir, secondPath), "data\n", "utf8");
    const sendMedia = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "om_sent", chatId: "ou_1" })
      .mockRejectedValueOnce(new Error("upload failed"));
    const handler = createFeishuSubagentHandoffDeliveryHandler({
      cfg: {} as never,
      sendMedia,
    });

    const result = await handler(
      createEvent({
        workspaceDir,
        channel: "feishu",
        to: "ou_1",
        relativePaths: [firstPath, secondPath],
      }),
      {},
    );

    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: [firstPath],
      failures: [{ relativePath: secondPath, message: "upload failed" }],
    });
  });

  it("claims Feishu delivery and reports every artifact when the target is missing", async () => {
    const handler = createFeishuSubagentHandoffDeliveryHandler({
      cfg: {} as never,
      sendMedia: vi.fn(),
    });
    const relativePath = "artifacts/exports/feishu/run-1/report.md";

    const result = await handler(
      createEvent({
        workspaceDir: "/workspace-main",
        channel: "feishu",
        relativePaths: [relativePath],
      }),
      {},
    );

    expect(result).toEqual({
      handled: true,
      deliveredArtifacts: [],
      failures: [
        {
          relativePath,
          message: "Feishu artifact delivery target is unavailable",
        },
      ],
    });
  });
});
