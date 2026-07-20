import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { materializeChatAttachment } from "./chat-attachment-materialize.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

const temporaryDirectories: string[] = [];

async function createWorkspaceConfig(): Promise<{ cfg: OpenClawConfig; workspaceDir: string }> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-materialize-"));
  temporaryDirectories.push(workspaceDir);
  return {
    workspaceDir,
    cfg: {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    },
  };
}

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("materializeChatAttachment", () => {
  it("rejects the removed WebUI session namespace", async () => {
    const { cfg } = await createWorkspaceConfig();

    await expect(
      materializeChatAttachment({
        cfg,
        input: {
          sessionKey: "agent:main:webui:namespace:chat_test",
          artifactId: "artifact-legacy",
          fileName: "legacy.txt",
          contentType: "text/plain",
          sizeBytes: 1,
          sha256: createHash("sha256").update("x").digest("hex"),
          downloadUrl: "https://oss.example.test/legacy.txt",
        },
      }),
    ).rejects.toThrow(/parent WebChat session/);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("streams a verified object into the Agent workspace", async () => {
    const { cfg, workspaceDir } = await createWorkspaceConfig();
    const payload = Buffer.from("uploaded report");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(payload, { status: 200 }),
      finalUrl: "https://oss.example.test/report.pdf",
      release,
    });

    const input = {
      sessionKey: "agent:main:webchat:namespace:chat_test",
      artifactId: "artifact-123",
      fileName: "报告 2026.pdf",
      contentType: "application/pdf",
      sizeBytes: payload.length,
      sha256,
      downloadUrl: "https://oss.example.test/report.pdf?signature=secret",
    };
    const result = await materializeChatAttachment({ cfg, input });
    const reused = await materializeChatAttachment({ cfg, input });

    const targetPath = path.join(workspaceDir, result.workspacePath);
    expect(result.workspacePath).toBe(
      path.join("uploads", "webchat", "chat_test", "artifact-123-报告-2026.pdf"),
    );
    expect(await fs.readFile(targetPath)).toEqual(payload);
    expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o600);
    expect(reused).toEqual(result);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an artifact ID collision without replacing the existing file", async () => {
    const { cfg, workspaceDir } = await createWorkspaceConfig();
    const existingPayload = Buffer.from("original report");
    const replacementPayload = Buffer.from("replacement report");
    const relativePath = path.join("uploads", "webchat", "chat_test", "artifact-123-report.txt");
    const targetPath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, existingPayload);

    await expect(
      materializeChatAttachment({
        cfg,
        input: {
          sessionKey: "agent:main:webchat:namespace:chat_test",
          artifactId: "artifact-123",
          fileName: "report.txt",
          contentType: "text/plain",
          sizeBytes: replacementPayload.length,
          sha256: createHash("sha256").update(replacementPayload).digest("hex"),
          downloadUrl: "https://oss.example.test/report.txt",
        },
      }),
    ).rejects.toThrow(/already exists/i);

    expect(await fs.readFile(targetPath)).toEqual(existingPayload);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("rejects an integrity mismatch and removes the temporary file", async () => {
    const { cfg, workspaceDir } = await createWorkspaceConfig();
    const payload = Buffer.from("tampered");
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(payload, { status: 200 }),
      finalUrl: "https://oss.example.test/tampered.txt",
      release: async () => undefined,
    });

    await expect(
      materializeChatAttachment({
        cfg,
        input: {
          sessionKey: "agent:main:webchat:namespace:chat_test",
          artifactId: "artifact-456",
          fileName: "tampered.txt",
          contentType: "text/plain",
          sizeBytes: payload.length,
          sha256: "0".repeat(64),
          downloadUrl: "https://oss.example.test/tampered.txt",
        },
      }),
    ).rejects.toThrow(/integrity/i);

    const targetDir = path.join(workspaceDir, "uploads", "webchat", "chat_test");
    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it("rejects a session directory symlink that leaves the workspace", async () => {
    const { cfg, workspaceDir } = await createWorkspaceConfig();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-materialize-outside-"));
    temporaryDirectories.push(outsideDir);
    const uploadRoot = path.join(workspaceDir, "uploads", "webchat");
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.symlink(outsideDir, path.join(uploadRoot, "chat_test"));

    await expect(
      materializeChatAttachment({
        cfg,
        input: {
          sessionKey: "agent:main:webchat:namespace:chat_test",
          artifactId: "artifact-789",
          fileName: "escape.txt",
          contentType: "text/plain",
          sizeBytes: 1,
          sha256: createHash("sha256").update("x").digest("hex"),
          downloadUrl: "https://oss.example.test/escape.txt",
        },
      }),
    ).rejects.toThrow(/outside/i);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
