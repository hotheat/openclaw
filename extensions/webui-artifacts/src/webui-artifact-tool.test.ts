import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_SESSION_LIMIT_CODE,
  ArtifactApiError,
  type ArtifactInitInput,
  type ArtifactInitResult,
  type ArtifactTransport,
  type ArtifactUploadInput,
} from "./artifact-client.js";
import {
  ARTIFACT_SESSION_LIMIT_MESSAGE,
  MAX_ARTIFACT_BYTES,
  createUploadCounter,
  createWebuiArtifactTool,
} from "./webui-artifact-tool.js";

const tempDirs: string[] = [];
const target: ArtifactInitResult["upload"] = {
  url: "https://oss.invalid/presigned",
  headers: {
    "Content-MD5": "md5",
    "Content-Type": "text/plain",
    "x-oss-meta-sha256": "sha256",
  },
};

class FakeArtifactTransport implements ArtifactTransport {
  initInputs: ArtifactInitInput[] = [];
  uploaded = Buffer.alloc(0);
  completed: string[] = [];
  aborted: string[] = [];
  initError?: Error;
  uploadError?: Error;

  async init(input: ArtifactInitInput): Promise<ArtifactInitResult> {
    this.initInputs.push(input);
    if (this.initError) {
      throw this.initError;
    }
    return { artifactId: "artifact_1", upload: target };
  }

  async upload(input: ArtifactUploadInput): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    this.uploaded = Buffer.concat(chunks);
    if (this.uploadError) {
      throw this.uploadError;
    }
  }

  async complete(artifactId: string): Promise<void> {
    this.completed.push(artifactId);
  }

  async abort(artifactId: string): Promise<void> {
    this.aborted.push(artifactId);
  }
}

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "webui-artifacts-"));
  tempDirs.push(workspace);
  return workspace;
}

function createTool(
  workspaceDir: string,
  client: FakeArtifactTransport,
  afterScan?: (realPath: string) => Promise<void>,
) {
  return createWebuiArtifactTool({
    client,
    sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
    workspaceDir,
    afterScan: afterScan ? (opened) => afterScan(opened.realPath) : undefined,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("webui_artifact_publish", () => {
  it("hashes and uploads the same file handle and passes toolCallId as sourceToolCallId", async () => {
    const workspace = await makeWorkspace();
    const content = Buffer.from("artifact content\n");
    await fs.writeFile(path.join(workspace, "report.txt"), content);
    const client = new FakeArtifactTransport();
    const tool = createTool(workspace, client);

    const result = await tool.execute("call_1", {
      filePath: "report.txt",
      caption: "Report",
    });

    expect(client.initInputs).toEqual([
      {
        sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        md5Base64: createHash("md5").update(content).digest("base64"),
        sourceToolCallId: "call_1",
      },
    ]);
    expect(client.uploaded).toEqual(content);
    expect(client.completed).toEqual(["artifact_1"]);
    expect(client.aborted).toEqual([]);
    expect(result.details).toEqual({
      artifactId: "artifact_1",
      fileName: "report.txt",
      contentType: "text/plain",
      sizeBytes: content.byteLength,
      caption: "Report",
    });
    expect(JSON.stringify(result)).not.toContain(workspace);
    expect(JSON.stringify(result)).not.toContain(target.url);
  });

  it.each([
    ["script.sh", "application/x-sh"],
    ["program.exe", "application/x-msdownload"],
  ])("declares blocked executable MIME for %s", async (fileName, expectedMime) => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, fileName), "payload");
    const client = new FakeArtifactTransport();

    await createTool(workspace, client).execute("call_1", { filePath: fileName });

    expect(client.initInputs[0]?.contentType).toBe(expectedMime);
  });

  it("does not let a download filename downgrade a blocked source MIME", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "script.sh"), "echo test\n");
    const client = new FakeArtifactTransport();

    await createTool(workspace, client).execute("call_1", {
      filePath: "script.sh",
      filename: "report.txt",
    });

    expect(client.initInputs[0]?.fileName).toBe("report.txt");
    expect(client.initInputs[0]?.contentType).toBe("application/x-sh");
  });

  it("detects an executable signature even when the source extension looks safe", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "report.txt"), "MZpayload");
    const client = new FakeArtifactTransport();

    await createTool(workspace, client).execute("call_1", { filePath: "report.txt" });

    expect(client.initInputs[0]?.contentType).toBe("application/x-msdownload");
  });

  it("declares an executable extensionless file as application/x-executable", async () => {
    const workspace = await makeWorkspace();
    const filePath = path.join(workspace, "program");
    await fs.writeFile(filePath, "payload");
    await fs.chmod(filePath, 0o755);
    const client = new FakeArtifactTransport();

    await createTool(workspace, client).execute("call_1", { filePath: "program" });

    expect(client.initInputs[0]?.contentType).toBe("application/x-executable");
  });

  it("returns the stable quota message for a nested 409 code", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "report.txt"), "content");
    const client = new FakeArtifactTransport();
    client.initError = new ArtifactApiError("init", 409, ARTIFACT_SESSION_LIMIT_CODE);

    await expect(
      createTool(workspace, client).execute("call_1", { filePath: "report.txt" }),
    ).rejects.toThrow(ARTIFACT_SESSION_LIMIT_MESSAGE);
  });

  it("best-effort aborts after upload failure without leaking the underlying error", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "report.txt"), "content");
    const client = new FakeArtifactTransport();
    client.uploadError = new Error(
      `failed at ${target.url} with service-key and ${path.join(workspace, "report.txt")}`,
    );

    const promise = createTool(workspace, client).execute("call_1", {
      filePath: "report.txt",
    });
    await expect(promise).rejects.toThrow(
      "Artifact publish failed (artifactId=artifact_1, phase=upload)",
    );
    await expect(promise).rejects.not.toThrow(/service-key|oss\.invalid|webui-artifacts-/);
    expect(client.aborted).toEqual(["artifact_1"]);
  });

  it.each(["../outside.txt", "."])("rejects a non-file workspace path: %s", async (filePath) => {
    const workspace = await makeWorkspace();
    const client = new FakeArtifactTransport();

    await expect(createTool(workspace, client).execute("call_1", { filePath })).rejects.toThrow(
      /regular file within the current workspace/,
    );
    expect(client.initInputs).toEqual([]);
  });

  it("rejects a symlink escape", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideFile, path.join(workspace, "link.txt"));
    const client = new FakeArtifactTransport();

    await expect(
      createTool(workspace, client).execute("call_1", { filePath: "link.txt" }),
    ).rejects.toThrow(/regular file within the current workspace/);
    expect(client.initInputs).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO special file", async () => {
    const workspace = await makeWorkspace();
    execFileSync("mkfifo", [path.join(workspace, "artifact.pipe")]);
    const client = new FakeArtifactTransport();

    await expect(
      createTool(workspace, client).execute("call_1", { filePath: "artifact.pipe" }),
    ).rejects.toThrow(/regular file within the current workspace/);
    expect(client.initInputs).toEqual([]);
  });

  it("rejects a sparse file above 100 MB before scanning", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "large.bin"), "");
    await fs.truncate(path.join(workspace, "large.bin"), MAX_ARTIFACT_BYTES + 1);
    const client = new FakeArtifactTransport();

    await expect(
      createTool(workspace, client).execute("call_1", { filePath: "large.bin" }),
    ).rejects.toThrow(/100 MB limit/);
    expect(client.initInputs).toEqual([]);
  });

  it("rejects rename-and-replace after scanning while keeping the original handle", async () => {
    const workspace = await makeWorkspace();
    const filePath = path.join(workspace, "report.txt");
    await fs.writeFile(filePath, "original");
    const client = new FakeArtifactTransport();
    const tool = createTool(workspace, client, async (realPath) => {
      await fs.rename(realPath, `${realPath}.old`);
      await fs.writeFile(realPath, "replaced");
    });

    await expect(tool.execute("call_1", { filePath: "report.txt" })).rejects.toThrow(
      /changed while it was being scanned/,
    );
    expect(client.initInputs).toEqual([]);
  });
});

it.skipIf(process.platform === "win32")("publishes a hardlinked workspace file", async () => {
  const workspace = await makeWorkspace();
  const source = path.join(workspace, "source.txt");
  await fs.writeFile(source, "artifact");
  await fs.link(source, path.join(workspace, "hardlink.txt"));
  const client = new FakeArtifactTransport();

  await createTool(workspace, client).execute("call_1", { filePath: "hardlink.txt" });

  expect(client.uploaded.toString("utf8")).toBe("artifact");
  expect(client.completed).toEqual(["artifact_1"]);
});

describe("artifact upload byte counter", () => {
  it("rejects bytes beyond the declared size", async () => {
    const counted = Readable.from([Buffer.from("ab"), Buffer.from("cd")]).pipe(
      createUploadCounter(3),
    );
    const consume = async () => {
      for await (const _chunk of counted) {
        // Consume the stream so Transform errors surface.
      }
    };

    await expect(consume()).rejects.toThrow(/exceeded the declared size/);
  });

  it("rejects a short upload", async () => {
    const counted = Readable.from([Buffer.from("ab")]).pipe(createUploadCounter(3));
    const consume = async () => {
      for await (const _chunk of counted) {
        // Consume the stream so Transform errors surface.
      }
    };

    await expect(consume()).rejects.toThrow(/did not match the declared size/);
  });
});
