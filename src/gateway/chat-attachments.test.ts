import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_WORKSPACE_ATTACHMENTS_TOTAL_BYTES,
} from "./chat-attachment-limits.js";
import {
  buildMessageWithAttachments,
  type ChatAttachment,
  parseMessageWithAttachments,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function parseWithWarnings(message: string, attachments: ChatAttachment[]) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
  });
  return { parsed, logs };
}

describe("buildMessageWithAttachments", () => {
  it("embeds a single image as data URL", () => {
    const msg = buildMessageWithAttachments("see this", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(msg).toContain("see this");
    expect(msg).toContain(`data:image/png;base64,${PNG_1x1}`);
    expect(msg).toContain("![dot.png]");
  });

  it("rejects non-image mime types", () => {
    const bad: ChatAttachment = {
      type: "file",
      mimeType: "application/pdf",
      fileName: "a.pdf",
      content: "AAA",
    };
    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/image/);
  });
});

describe("parseMessageWithAttachments", () => {
  it("resolves a workspace file without embedding base64", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-attachment-"));
    const payload = "%PDF-1.4\n";
    const relativePath = path.join("uploads", "webchat", "chat_test", "artifact-report.pdf");
    const filePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, payload);

    try {
      const parsed = await parseMessageWithAttachments(
        "summarize",
        [
          {
            type: "workspace_file",
            mimeType: "application/pdf",
            fileName: "report.pdf",
            workspacePath: relativePath,
            sizeBytes: 9,
            sha256: createHash("sha256").update(payload).digest("hex"),
          },
        ],
        { workspaceDir, webchatClientSessionId: "chat_test" },
      );

      expect(parsed.images).toEqual([]);
      expect(parsed.mediaPaths).toEqual([await fs.realpath(filePath)]);
      expect(parsed.mediaTypes).toEqual(["application/pdf"]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reuses workspace file validation for repeated paths", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-attachment-"));
    const payload = "shared attachment";
    const relativePath = path.join("uploads", "webchat", "chat_test", "artifact-shared.txt");
    const filePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, payload);
    const attachment: ChatAttachment = {
      type: "workspace_file",
      workspacePath: relativePath,
      sizeBytes: Buffer.byteLength(payload),
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
    const statSpy = vi.spyOn(fs, "stat");

    try {
      const parsed = await parseMessageWithAttachments("read", [attachment, attachment], {
        workspaceDir,
        webchatClientSessionId: "chat_test",
      });

      expect(parsed.mediaPaths).toEqual([await fs.realpath(filePath), await fs.realpath(filePath)]);
      expect(statSpy).toHaveBeenCalledOnce();
    } finally {
      statSpy.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects attachment count and workspace byte budgets before file access", async () => {
    const tooMany = Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, () => ({
      type: "image",
      content: PNG_1x1,
    }));
    await expect(parseMessageWithAttachments("read", tooMany)).rejects.toThrow(/count limit/i);

    const sha256 = "a".repeat(64);
    const firstSize = Math.floor(MAX_CHAT_WORKSPACE_ATTACHMENTS_TOTAL_BYTES / 2) + 1;
    await expect(
      parseMessageWithAttachments(
        "read",
        [
          {
            type: "workspace_file",
            workspacePath: "missing-a",
            sizeBytes: firstSize,
            sha256,
          },
          {
            type: "workspace_file",
            workspacePath: "missing-b",
            sizeBytes: firstSize,
            sha256,
          },
        ],
        { workspaceDir: "/missing", webchatClientSessionId: "chat_test" },
      ),
    ).rejects.toThrow(/total size limit/i);
  });

  it("rejects workspace files from another WebChat session upload directory", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-attachment-"));
    const payload = "secret";
    const relativePath = path.join("uploads", "webchat", "chat_b", "secret.txt");
    const filePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, payload);

    try {
      await expect(
        parseMessageWithAttachments(
          "read",
          [
            {
              type: "workspace_file",
              workspacePath: relativePath,
              sizeBytes: payload.length,
              sha256: createHash("sha256").update(payload).digest("hex"),
            },
          ],
          { workspaceDir, webchatClientSessionId: "chat_a" },
        ),
      ).rejects.toThrow(/not allowed/i);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace files with a mismatched SHA-256", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-attachment-"));
    const payload = "actual";
    const relativePath = path.join("uploads", "webchat", "chat_test", "artifact-report.txt");
    const filePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, payload);

    try {
      await expect(
        parseMessageWithAttachments(
          "read",
          [
            {
              type: "workspace_file",
              workspacePath: relativePath,
              sizeBytes: payload.length,
              sha256: createHash("sha256").update("expected").digest("hex"),
            },
          ],
          { workspaceDir, webchatClientSessionId: "chat_test" },
        ),
      ).rejects.toThrow(/metadata mismatch/i);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace files that resolve outside the Agent workspace", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-attachment-"));
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    const uploadDir = path.join(workspaceDir, "uploads", "webchat");
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await fs.symlink(outsideDir, path.join(uploadDir, "chat_test"));

    try {
      await expect(
        parseMessageWithAttachments(
          "read",
          [
            {
              type: "workspace_file",
              workspacePath: path.join("uploads", "webchat", "chat_test", "secret.txt"),
              sizeBytes: 6,
              sha256: createHash("sha256").update("secret").digest("hex"),
            },
          ],
          { workspaceDir, webchatClientSessionId: "chat_test" },
        ),
      ).rejects.toThrow(/unavailable/i);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("strips data URL prefix", async () => {
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: `data:image/png;base64,${PNG_1x1}`,
        },
      ],
      { log: { warn: () => {} } },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
  });

  it("sniffs mime when missing", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      {
        type: "image",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.message).toBe("see this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("drops non-image payloads and logs", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "file",
        mimeType: "image/png",
        fileName: "not-image.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/non-image/i);
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("drops unknown mime when sniff fails and logs", async () => {
    const unknown = Buffer.from("not an image").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      { type: "file", fileName: "unknown.bin", content: unknown },
    ]);
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/unable to detect image mime type/i);
  });

  it("keeps valid images and drops invalid ones", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
      {
        type: "file",
        mimeType: "image/png",
        fileName: "not-image.pdf",
        content: pdf,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs.some((l) => /non-image/i.test(l))).toBe(true);
  });
});

describe("shared attachment validation", () => {
  it("rejects invalid base64 content for both builder and parser", async () => {
    const bad: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "%not-base64%",
    };

    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/base64/i);
    await expect(
      parseMessageWithAttachments("x", [bad], { log: { warn: () => {} } }),
    ).rejects.toThrow(/base64/i);
  });

  it("rejects images over limit for both builder and parser without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => buildMessageWithAttachments("x", [att], { maxBytes: 16 })).toThrow(
        /exceeds size limit/i,
      );
      await expect(
        parseMessageWithAttachments("x", [att], { maxBytes: 16, log: { warn: () => {} } }),
      ).rejects.toThrow(/exceeds size limit/i);
      const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});
