import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSummaryInput } from "./transcript-input.js";

describe("resolveSummaryInput transcript sanitization", () => {
  let tmpRoot = "";

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  async function writeSession(messages: Array<{ role: "user" | "assistant"; content: string }>) {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-input-"));
    const sessionFile = path.join(tmpRoot, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      messages
        .map((message) =>
          JSON.stringify({
            type: "message",
            message: {
              role: message.role,
              content: message.content,
            },
          }),
        )
        .join("\n"),
      "utf-8",
    );
    return sessionFile;
  }

  it("keeps normal user content that mentions presentation and document terms", async () => {
    const sessionFile = await writeSession([
      { role: "user", content: "以后 PPT 都要横版，不要竖版。" },
      { role: "user", content: "Word 报告要保留修订痕迹。" },
    ]);

    const input = await resolveSummaryInput({
      workspaceDir: tmpRoot,
      currentSessionFile: sessionFile,
      messageCount: 10,
    });

    expect(input.transcript).toContain("以后 PPT 都要横版，不要竖版。");
    expect(input.transcript).toContain("Word 报告要保留修订痕迹。");
  });

  it("keeps normal user content that mentions retry busy and timeout", async () => {
    const sessionFile = await writeSession([
      { role: "user", content: "busy 状态下不要自动 retry。" },
      { role: "user", content: "timeout 预算配置为 60 秒。" },
    ]);

    const input = await resolveSummaryInput({
      workspaceDir: tmpRoot,
      currentSessionFile: sessionFile,
      messageCount: 10,
    });

    expect(input.transcript).toContain("busy 状态下不要自动 retry。");
    expect(input.transcript).toContain("timeout 预算配置为 60 秒。");
  });

  it("still drops explicit transport markers", async () => {
    const sessionFile = await writeSession([
      { role: "assistant", content: "[Queued messages while agent was busy]" },
      { role: "assistant", content: "Connection error after retries." },
      { role: "assistant", content: "正常结论保留。" },
    ]);

    const input = await resolveSummaryInput({
      workspaceDir: tmpRoot,
      currentSessionFile: sessionFile,
      messageCount: 10,
    });

    expect(input.transcript).not.toContain("[Queued messages while agent was busy]");
    expect(input.transcript).not.toContain("Connection error after retries.");
    expect(input.transcript).toContain("正常结论保留。");
  });
});
