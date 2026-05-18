import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("GitHub Actions workflow runners", () => {
  it("does not require unavailable Blacksmith runners", async () => {
    const workflowsDir = path.resolve(process.cwd(), ".github", "workflows");
    const workflowFiles = (await readdir(workflowsDir)).filter((file) => file.endsWith(".yml"));

    const runsOnByFile = await Promise.all(
      workflowFiles.map(async (file) => {
        const content = await readFile(path.join(workflowsDir, file), "utf8");
        const runnerLabels = Array.from(
          content.matchAll(/runs-on:\s*([^\n]+)/g),
          (match) => match[1]?.trim() ?? "",
        );
        return { file, runnerLabels };
      }),
    );

    expect(runsOnByFile).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runnerLabels: expect.arrayContaining([expect.stringMatching(/blacksmith-/)]),
        }),
      ]),
    );
  });

  it("keeps pull request CI on a single make-driven lint/build/test flow", async () => {
    const ciWorkflowPath = path.resolve(process.cwd(), ".github", "workflows", "ci.yml");
    const content = await readFile(ciWorkflowPath, "utf8");

    expect(content).toMatch(/\n  lint:\n/);
    expect(content).toMatch(/name:\s+lint/);
    expect(content).toMatch(/run:\s+make lint/);

    expect(content).toMatch(/\n  build:\n/);
    expect(content).toMatch(/name:\s+build/);
    expect(content).toMatch(/run:\s+make build/);

    expect(content).toMatch(/\n  test:\n/);
    expect(content).toMatch(/name:\s+test/);
    expect(content).toMatch(/run:\s+make test/);
    expect(content).toMatch(/needs:\s*\n\s+- lint\s*\n\s+- build/);

    expect(content).not.toMatch(/matrix:\s*\n/);
    expect(content).not.toMatch(/run-test-fast-shard/);
    expect(content).not.toMatch(/name:\s+check/);
    expect(content).not.toMatch(/name:\s+test-browser/);
    expect(content).not.toMatch(/name:\s+test-embedded/);
    expect(content).not.toMatch(/name:\s+test-triggers/);
    expect(content).not.toMatch(/name:\s+test-web-auto-reply/);
    expect(content).not.toMatch(/name:\s+test-doctor/);
    expect(content).not.toMatch(/name:\s+test-telegram-media/);
  });

  it("keeps the CI Makefile targets mapped to the intended pnpm commands", async () => {
    const makefilePath = path.resolve(process.cwd(), "Makefile");
    const content = await readFile(makefilePath, "utf8");

    expect(content).toMatch(/\.PHONY:\s+lint build test/);
    expect(content).toMatch(/lint:\n\tpnpm check/);
    expect(content).toMatch(/build:\n\tpnpm build\n\tpnpm smoke:build\n\tpnpm ui:build/);
    expect(content).toMatch(/test:\n\tpnpm test\n/);
  });

  it("includes a Codex review workflow for pull requests", async () => {
    const workflowPath = path.resolve(process.cwd(), ".github", "workflows", "codex-review.yml");
    const content = await readFile(workflowPath, "utf8");

    expect(content).toMatch(/name: Codex Review/);
    expect(content).toMatch(/pull_request:/);
    expect(content).toMatch(/CODEX_TOKEN/);
    expect(content).toMatch(/\.github\/codex\/prompts\/review\.md/);
    expect(content).toMatch(/codex exec/);
    expect(content).toMatch(/--model gpt-5\.4/);
    expect(content).toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
    expect(content).toMatch(
      /PR_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    );
    expect(content).not.toMatch(/curl -fsSL .*install-codex\.sh/);
    expect(content).toMatch(/CODEX_VERSION:\s*\d+\.\d+\.\d+/);
    expect(content).toMatch(/npm install --global .*@openai\/codex@\$\{CODEX_VERSION\}/);
    expect(content).toMatch(/github\.rest\.issues\.listComments/);
    expect(content).toMatch(/github\.rest\.issues\.updateComment/);
    expect(content).toMatch(/const marker = ['"]<!-- codex-review -->['"]/);
  });

  it("includes an OpenClaw-specific Codex review prompt", async () => {
    const promptPath = path.resolve(process.cwd(), ".github", "codex", "prompts", "review.md");
    const content = await readFile(promptPath, "utf8");

    expect(content).toMatch(/OpenClaw/i);
    expect(content).toMatch(/plugin/i);
    expect(content).toMatch(/routing/i);
    expect(content).toMatch(/Output format/i);
  });
});
